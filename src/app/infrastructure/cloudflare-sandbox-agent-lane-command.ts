import { z } from "zod";

import { AgentLaneIncompleteError } from "../application/ports.ts";
import { jsonOutputNormalizerNodeScript } from "./agent-lane-json-output.ts";
import { agentLanePackageMountWriterNodeScript } from "./agent-lane-package-mounts.ts";
import { agentLaneTokenCostAccountingNodeScript } from "./agent-lane-token-cost-accounting.ts";

/**
 * Pinned `@earendil-works/pi-coding-agent` version installed into the sandbox at
 * runtime. The deploy uses the stock public `cloudflare/sandbox` image (no custom
 * Dockerfile), so the agent CLI the old Dockerfile baked in is installed on first
 * use inside the lane instead. Keep in lockstep with the sandbox image tag in
 * wrangler.jsonc.
 */
export const PI_CODING_AGENT_VERSION = "0.78.0";

export interface SandboxCommandResult {
  readonly command: string;
  readonly duration: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly success: boolean;
  readonly timestamp: string;
}

export const SandboxLaneResultMarkerSchema = z.discriminatedUnion("status", [
  z.object({
    artifactCommitSha: z.string().min(1),
    receiptPath: z.string().min(1),
    status: z.literal("ok"),
  }),
  z.object({
    exitCode: z.number().int(),
    failingStep: z.string().nullable(),
    gitLogTail: z.string(),
    piStatus: z.number().int().nullable(),
    status: z.literal("error"),
    stderrTail: z.string(),
  }),
]);

export type SandboxLaneResultMarker = z.infer<
  typeof SandboxLaneResultMarkerSchema
>;

export const buildPiAgentLaneCommand = (): string => String.raw`set -eu
marker_emitted=0
current_step="init"
pi_status=""
hb_path="/workspace/.piwf-heartbeat"
: > "$hb_path" 2>/dev/null || true
# mark() records the step boundary into a heartbeat file BEFORE the step runs, so
# a step that wedges past the sandbox timeout is recoverable as the last line — the
# EXIT trap does not fire on timeout's SIGTERM, the heartbeat does not depend on it.
mark() {
  current_step="$1"
  printf '%s %s\n' "$(date +%s)" "$1" >> "$hb_path" 2>/dev/null || true
}
diagnostics_path="/workspace/.piwf-lane-diagnostics"
: > "$diagnostics_path" 2>/dev/null || true
# diag() records a structural/numeric fact (disk free, byte sizes, a write's exit
# code) into a SEPARATE channel from the heartbeat. The heartbeat carries the step
# SEQUENCE (the classifier parses its trailing token as the failing step — polluting
# it would break classification); the diagnostics file carries the CAUSE the
# executor folds into the blocker. A lane that aborts commits no receipt, so this
# best-effort file is the only surviving record of WHY a heavy step died.
diag() {
  printf '%s\n' "$1" >> "$diagnostics_path" 2>/dev/null || true
}
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Epoch captured at script start so pi-invoke can self-bound to the budget remaining
# before the whole-script timeout (see the pi-invoke step). Robust to the variable
# cold-install lead time that would otherwise steal pi's budget.
script_start_s="$(date +%s)"
agent_dir="/workspace/.pi/agent"
auth_path="$agent_dir/auth.json"
raw_output_path="/workspace/piwf-agent-lane-output-raw.txt"
stderr_path="/workspace/piwf-agent-lane-stderr.txt"
git_log_path="/workspace/piwf-agent-lane-git.log"
normalization_outcome_path="/workspace/piwf-agent-lane-output-normalization.json"
export raw_output_path stderr_path
export LANE_OUTPUT_NORMALIZATION_PATH="$normalization_outcome_path"
scrub_credentials() {
  sed -E 's#https://x:[^@]*@#https://x:***@#g'
}
emit_failure_marker() {
  exit_code=$?
  set +e
  if [ "$marker_emitted" = "1" ]; then
    return
  fi
  marker_emitted=1
  stderr_tail=""
  if [ -f "$stderr_path" ]; then
    stderr_tail="$(tail -c 2000 "$stderr_path" 2>/dev/null | scrub_credentials)"
  fi
  git_log_tail=""
  if [ -f "$git_log_path" ]; then
    git_log_tail="$(tail -c 2000 "$git_log_path" 2>/dev/null | scrub_credentials)"
  fi
  # The rich marker is built by node so the arbitrary stderr/git tails get safe
  # JSON-escaping. But node is the SAME thing that dies under the memory pressure
  # that breaks the lane (the O(n^2) normalize grind OOMs the lite instance) — so
  # the recovery path shared the failure mode of the failure it recovers, and the
  # planner got a blind "did not emit a result marker" with no cause. node now
  # touches a sentinel as its LAST act; if that sentinel is absent the node emit
  # failed, and a SHELL-ONLY fallback (printf builtin + tiny base64 coreutil, no
  # V8 heap) emits a minimal but VALID error marker carrying the failing step and
  # exit codes, so the cause always reaches the planner. (wound #23-A.)
  marker_ok_path="/workspace/.piwf-marker-ok"
  rm -f "$marker_ok_path" 2>/dev/null || true
  PIWF_FAIL_EXIT_CODE="$exit_code" \
  PIWF_FAIL_STEP="$current_step" \
  PIWF_FAIL_PI_STATUS="$pi_status" \
  PIWF_FAIL_STDERR_TAIL="$stderr_tail" \
  PIWF_FAIL_GIT_LOG_TAIL="$git_log_tail" \
  PIWF_MARKER_OK_PATH="$marker_ok_path" \
  node <<'NODE'
const piStatusRaw = process.env.PIWF_FAIL_PI_STATUS;
const payload = {
  status: "error",
  exitCode: Number(process.env.PIWF_FAIL_EXIT_CODE),
  failingStep: process.env.PIWF_FAIL_STEP || null,
  gitLogTail: process.env.PIWF_FAIL_GIT_LOG_TAIL || "",
  piStatus: piStatusRaw === undefined || piStatusRaw === "" ? null : Number(piStatusRaw),
  stderrTail: process.env.PIWF_FAIL_STDERR_TAIL || ""
};
process.stdout.write("\n__PIWF_AGENT_LANE_RESULT__:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
try { require("fs").writeFileSync(process.env.PIWF_MARKER_OK_PATH, "1"); } catch (error) {}
NODE
  if [ ! -f "$marker_ok_path" ]; then
    # node failed to emit (OOM / could not fork). Only known-safe fields are
    # interpolated — exit_code is numeric, current_step is a fixed step token, and
    # pi_status is a number or the literal null — so no JSON escaping is needed and
    # the payload is always valid. The degraded-recovery note rides in stderrTail
    # (a field the marker schema keeps) so selectLaneAbortDiagnostic surfaces it as
    # the blocker's primary cause instead of "did not emit a result marker".
    fallback_pi_status="$pi_status"
    if [ -z "$fallback_pi_status" ]; then
      fallback_pi_status="null"
    fi
    fallback_json="$(printf '{"status":"error","exitCode":%s,"failingStep":"%s","gitLogTail":"","piStatus":%s,"stderrTail":"[degraded recovery: node-based result marker emit failed (likely resource exhaustion); pi and git tails unavailable]"}' "$exit_code" "$current_step" "$fallback_pi_status")"
    fallback_b64="$(printf '%s' "$fallback_json" | base64 2>/dev/null | tr -d '\n')"
    if [ -n "$fallback_b64" ]; then
      printf '\n__PIWF_AGENT_LANE_RESULT__:%s\n' "$fallback_b64"
    fi
  fi
}
# The whole-script (MIDDLE) shell timeout reaps with SIGTERM, and a bare signal kills
# bash WITHOUT firing an EXIT-only trap — that is exactly how the tail-starvation case
# lost pi's stderr: pi self-bounds, the post-pi steps overrun the margin, the shell
# timeout SIGTERMs the script, and the blocker named a step with no cause. Trapping
# INT/TERM runs the same failure marker (which carries pi's stderr tail) and then exits
# so the outer wrapper completes and the marker reaches stdout before the server-side
# (OUTER) sandbox.exec timeout throws. The EXIT trap is the idempotent backstop; the
# marker_emitted guard makes the double-fire a no-op. (wound #22 Layer C.)
on_signal() {
  emit_failure_marker
  exit 143
}
trap on_signal INT TERM
trap emit_failure_marker EXIT
mark install-pi-agent
export PATH="/workspace/.npm-global/bin:$PATH"
if ! command -v pi >/dev/null 2>&1; then
  npm install -g --prefix /workspace/.npm-global --ignore-scripts @earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION} > "$stderr_path" 2>&1
fi
mkdir -p "$agent_dir/sessions"
mark prepare-auth
rm -rf /workspace/piwf-agent-lane
mkdir -p "$agent_dir"
printf '%s' "$PI_AUTH_JSON_B64" | base64 -d > "$auth_path"
chmod 600 "$auth_path"
mark clone-artifacts
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-agent-lane > "$git_log_path" 2>&1
cd /workspace/piwf-agent-lane
git config user.name "pi-workflow-agent-lane"
git config user.email "pi-workflow-agent-lane@example.invalid"
mark checkout-branch
if git show-ref --verify --quiet "refs/remotes/origin/$LANE_BRANCH"; then
  git checkout -B "$LANE_BRANCH" "origin/$LANE_BRANCH" >> "$git_log_path" 2>&1
else
  git checkout -B "$LANE_BRANCH" >> "$git_log_path" 2>&1
fi
mark mount-packages
node <<'NODE'
${agentLanePackageMountWriterNodeScript}
NODE
mkdir -p "$(dirname "$LANE_PROMPT_PATH")" "$(dirname "$LANE_OUTPUT_PATH")" "$(dirname "$LANE_TRANSCRIPT_PATH")" "$(dirname "$LANE_RECEIPT_PATH")"
cp "$LANE_PROMPT_SOURCE_PATH" "$LANE_PROMPT_PATH"
mark pi-invoke
# JSON lanes capture pi's machine event stream (--mode json), not its human text
# channel: text mode only echoes the final assistant message and goes silent when
# the run ends on a tool call, error, or abort — so a verifier/agentic JSON lane that
# scraped text mode would lose the verdict the agent produced on a tool turn. The
# normalizer reads the event stream's agent_end message to recover it.
#
# EXCLUDE the planner. --mode json streams EVERY lifecycle event (turn/message/token)
# to stdout, so the buffer grows with the model's internal iteration; text mode emits
# ONLY the final message no matter how much the model thinks. The planner is pure
# generation that ends on one plain assistant message — it has no tools (see the gate
# below) so it CANNOT end on a tool turn, the one ending text mode drops — so it has no
# reason to pay the event stream's cost and every reason to avoid it: under --mode json
# the planner's stream ballooned to the 64 MiB cap and ran away on FIVE consecutive live
# runs (a8bc84dc/f9a37a09/53cc30a4/fa5a3189, then c08aba9c WITH --no-tools), while the
# one run that reached "captured" (06-12, text mode) predates --mode json entirely. Mode
# — not tools — was the lone discriminator; --no-tools alone could not fix it. The
# normalizer is shape-driven (it falls back to a whole-buffer JSON scan when the output
# is not an event stream — see agent-lane-json-output.ts), so a text-mode planner
# blueprint normalizes exactly as it did on 06-12. (wound #32.)
pi_mode_args=""
if [ "$LANE_OUTPUT_MEDIA_TYPE" = "application/json" ] && [ "$LANE_KIND" != "planner" ]; then
  pi_mode_args="--mode json"
fi
# Least privilege at the CLI: the planner is pure generation that emits one JSON
# blueprint and needs nothing from the filesystem, so grant it zero tools. pi ships
# read/bash/edit/write ON by default; --no-tools removes them at the process boundary.
# Retained from wound #31, but its role is now correctly understood: it is NOT what stops
# the runaway — the --mode json gate above is (wound #32 proved --no-tools alone did not;
# run c08aba9c ran away WITH it). It is defense-in-depth that also makes text mode
# LOSSLESS for the planner: with no tools the planner CANNOT end on a tool turn (the one
# ending text mode drops), so its final blueprint always reaches stdout. Scoped to
# LANE_KIND=planner ONLY: worker/analysis/verifier lanes are source-grounded and MUST
# keep read/bash to inspect artifacts — disabling tools there would forge hollow captures
# (a verifier that reviews nothing). LANE_KIND is always set (lanes.ts), same as
# LANE_OUTPUT_MEDIA_TYPE above, so it is safe under set -u.
pi_tool_args=""
if [ "$LANE_KIND" = "planner" ]; then
  pi_tool_args="--no-tools"
fi
set +e
# Self-bound pi-invoke to the budget remaining before the whole-script timeout, minus
# a tail margin for the receipt/commit/push steps. Without this bound a hung model
# call (egress black-hole, auth-retry storm, runaway generation) rides until the outer
# timeout SIGTERMs the whole script — and SIGTERM skips the EXIT trap, so pi's stderr
# is never captured and the blocker names a step with no cause. A slow error is worse
# than a fast one: self-bounding converts a silent ride into a committed receipt that
# carries pi's stderr tail. The budget is computed from elapsed time (not a fixed
# value) so the variable cold-install lead time cannot starve or overrun it. (wound #22
# Layer B: planner sync-hang is a structural pi-invoke wedge.)
pi_elapsed_s=$(( $(date +%s) - script_start_s ))
pi_budget_s=$(( PIWF_COMMAND_TIMEOUT_SECONDS - pi_elapsed_s - PIWF_PI_INVOKE_TAIL_MARGIN_SECONDS ))
if [ "$pi_budget_s" -lt 1 ]; then
  pi_budget_s=1
fi
# Steady State at the SOURCE bucket. pi's raw stdout is the resource every later step
# accumulates from — normalize copies it, build-transcript samples it, build-receipt
# reads + hashes it. A runaway/looping model (amplified under --mode json, where every
# token and tool call is a stream event) emits an UNBOUNDED stream that fills the lite
# instance's small disk DURING the run, and wound #29's downstream caps cannot save it
# because the disk is already dead before they run (live a8bc84dc/53cc30a4:
# raw_output_bytes 1084434255 on a 1.81 GB disk left ~30 MB free → build-receipt's
# cp planner-blueprint ENOSPC, exit 143 — the lane burned 546s and committed nothing).
# Cap what reaches disk with head -c so the bucket can NEVER overflow: head closes the
# pipe at the cap, so pi takes SIGPIPE on its next write and a runaway is bounded in
# BOTH disk and wall-clock. PIPESTATUS[0] preserves pi's real exit (124 timeout / 0 ok)
# past head. The cap is generous (64 MiB — orders of magnitude over any real planner
# blueprint or event stream) so only the pathological runaway is ever truncated, and a
# capped run commits an honest status:"failed" receipt with the truncated head instead
# of cascading ENOSPC through every disk-touching step downstream.
# Bash brace param-expansion defaults collide with this String.raw template's JS
# interpolation, so default the (test-only) cap override under a brief set +u.
raw_output_cap_bytes=67108864
set +u
if [ -n "$PIWF_RAW_OUTPUT_CAP_BYTES" ]; then
  raw_output_cap_bytes="$PIWF_RAW_OUTPUT_CAP_BYTES"
fi
set -u
timeout "$pi_budget_s" pi --provider "$PI_PROVIDER" --model "$PI_MODEL" --no-session $pi_mode_args $pi_tool_args -p "$(cat "$LANE_PROMPT_PATH")" 2> "$stderr_path" | head -c "$raw_output_cap_bytes" > "$raw_output_path"
# Bare \$PIPESTATUS expands to the FIRST pipe element in bash — the left-of-pipe
# (timeout pi) exit. The braced array-index form collides with this String.raw
# template's JS interpolation (it throws "PIPESTATUS is not defined" at build time —
# even inside a comment), so the bare form is load-bearing here, NOT a style choice.
# It preserves pi's real exit (124 timeout / 141 SIGPIPE-on-cap / 0 ok) past head,
# which always exits 0.
pi_status=$PIPESTATUS
raw_output_capture_bytes="$(wc -c < "$raw_output_path" 2>/dev/null | tr -d '[:space:]')"
[ -n "$raw_output_capture_bytes" ] || raw_output_capture_bytes=0
if [ "$raw_output_capture_bytes" -ge "$raw_output_cap_bytes" ] 2>/dev/null; then
  printf '\n[pi-invoke output cap] pi raw output reached the %s-byte capture cap and was truncated — the agent produced a runaway/oversized stream. The full stream is intentionally discarded (retaining it would ENOSPC the lite instance disk and poison every downstream step); the committed receipt is status:"failed" with the truncated head.\n' "$raw_output_cap_bytes" >> "$stderr_path"
  diag "pi-invoke raw_output_capped: reached $raw_output_cap_bytes byte cap (runaway/oversized stream; full stream discarded to protect disk)"
  # Ride a bounded TAIL of the runaway out on the diag channel (which survives a SIGTERM
  # and reaches the operator blocker). The disk numbers proved THAT it ran away; this
  # shows WHAT. Sample the TAIL, not the head: the head of any capped stream is just the
  # clean preamble (session header, the prompt echo, the first turn) — identical on a
  # healthy run and a runaway, so it diagnoses nothing. The repeating unit that drove the
  # stream to the cap lives at the truncation boundary, so the last 4 KiB is where a
  # tool-call event loop reads differently from pure-generation repetition — settling the
  # next hypothesis from the blocker without another blind re-drive (observe, don't
  # stare). Last 4 KiB only; control chars flattened to spaces so it stays one diag line;
  # git creds scrubbed.
  runaway_tail_sample="$(tail -c 4096 "$raw_output_path" 2>/dev/null | tr '\n\r\t' '   ' | tr -cd '[:print:]' | scrub_credentials)"
  diag "pi-invoke raw_output_tail_sample (last 4096 bytes, sanitized): $runaway_tail_sample"
fi
if [ "$pi_status" -eq 124 ]; then
  printf '\n[pi-invoke self-bound] pi exceeded its %ss budget and was terminated by timeout; the heartbeat names pi-invoke as the wedge step.\n' "$pi_budget_s" >> "$stderr_path"
fi
set -e
mark normalize-output
# Normalization success is tracked separately from pi's exit status. A failed
# normalize is a real "agent produced no parseable verdict" signal recorded in
# the receipt's outputNormalization — it must NOT clobber pi_status, which would
# forge a non-zero exit and make a committed receipt look like an adapter outage.
output_normalized=1
# When normalization fails (or the lane output is not JSON) the raw pi output is
# copied verbatim to LANE_OUTPUT_PATH so the receipt still commits an honest
# status:"failed" with the real outputNormalization.reason (wound #23-B's promise).
# That recovery copy is itself fallible — an oversized raw output against a full
# lite-instance disk, or a missing source — and under 'set -eu' a BARE 'cp' that
# fails ABORTS the whole lane at exit 1 with the copy error written to the
# script's own stderr (an uncaptured channel). The blocker then fell back to the
# benign empty-repo clone log, the planner forged a blind 'adapter_unavailable',
# and the run was re-driven for 40 minutes against a deterministic failure
# (wound #25). Guard it: never abort, tee any failure into stderr_path so the
# marker is not blind, and guarantee LANE_OUTPUT_PATH exists for the downstream
# hash/add/commit steps so a failed normalize ALWAYS yields a committed receipt.
persist_unnormalized_output() {
  mkdir -p "$(dirname "$LANE_OUTPUT_PATH")" 2>>"$stderr_path" || true
  if ! cp "$raw_output_path" "$LANE_OUTPUT_PATH" 2>>"$stderr_path"; then
    printf '[agent-lane recovery] could not persist raw pi output to LANE_OUTPUT_PATH; see stderr tail for the copy failure\n' \
      > "$LANE_OUTPUT_PATH" 2>>"$stderr_path" || true
  fi
}
if [ "$LANE_OUTPUT_MEDIA_TYPE" = "application/json" ]; then
  # Self-bound the normalizer exactly like pi-invoke. It is the one heavy post-pi
  # step and was the ONLY one with no inner time bound. On a pathologically large or
  # truncated pi output the node normalizer grinds for minutes under memory pressure
  # on the lite instance (see agent-lane-json-output.ts — the O(n) scan budget bounds
  # CPU, not the readFileSync + split-into-array memory that drives the grind). bash
  # cannot service the MIDDLE whole-script 'timeout' SIGTERM while it is blocked on a
  # busy FOREGROUND 'node', so that grind rode PAST the recoverable SIGTERM into the
  # OUTER sandbox.exec SIGKILL — which fires no trap, emits no marker, and the planner
  # got a blind 'no result marker' with no cause (wound #26, observed live: an 872s
  # lane SIGKILLed at the 780s ceiling with the heartbeat frozen on normalize-output).
  # A real verdict normalizes in well under a second; cap the attempt small so a slow
  # normalize fails FAST with a NAMED reason and the recovery path commits an honest
  # status:"failed" receipt. SIGKILL (-s KILL), not the default TERM: a node wedged in
  # a synchronous parse/GC grind cannot service a TERM between event-loop ticks.
  rm -f "$LANE_OUTPUT_NORMALIZATION_PATH" 2>>"$stderr_path" || true
  normalize_elapsed_s=$(( $(date +%s) - script_start_s ))
  normalize_budget_s=$(( PIWF_COMMAND_TIMEOUT_SECONDS - normalize_elapsed_s - PIWF_NORMALIZE_TAIL_MARGIN_SECONDS ))
  if [ "$normalize_budget_s" -gt "$PIWF_NORMALIZE_MAX_SECONDS" ]; then
    normalize_budget_s="$PIWF_NORMALIZE_MAX_SECONDS"
  fi
  if [ "$normalize_budget_s" -lt 1 ]; then
    normalize_budget_s=1
  fi
  set +e
  timeout -s KILL "$normalize_budget_s" node <<'NODE'
${jsonOutputNormalizerNodeScript}
NODE
  normalize_status=$?
  set -e
  if [ "$normalize_status" -eq 0 ]; then
    output_normalized=1
  else
    output_normalized=0
    # A timeout/OOM SIGKILL aborts node BEFORE it records an outcome, so the outcome
    # file is absent; a normal parse failure (oversized/no_parseable/agent_error)
    # writes the file with its own reason. The build-receipt step DEFAULTS
    # outputNormalization to { normalized: true } and only overrides if this file
    # exists — so a killed normalize that left no file would forge a CLEAN receipt
    # over unnormalized output. Stamp the honest named cause from the shell ONLY when
    # node left no outcome behind, so a slow/killed normalize commits status:"failed"
    # with reason:"normalize_timeout" instead of going blind.
    if [ ! -s "$LANE_OUTPUT_NORMALIZATION_PATH" ]; then
      printf '{"normalized":false,"reason":"normalize_timeout","agentStopReason":null,"detail":"normalize-output exceeded its %ss budget (or was OOM-killed) and was terminated before recording an outcome; raw pi output was likely oversized or truncated."}\n' \
        "$normalize_budget_s" > "$LANE_OUTPUT_NORMALIZATION_PATH" 2>>"$stderr_path" || true
      printf '[normalize-output self-bound] node normalizer exceeded its %ss budget and was terminated (reason: normalize_timeout); the heartbeat names normalize-output as the wedge step.\n' \
        "$normalize_budget_s" >> "$stderr_path" 2>>"$stderr_path" || true
    fi
    persist_unnormalized_output
  fi
else
  persist_unnormalized_output
fi
export output_normalized
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mark build-transcript
# The transcript is a DEBUG artifact and must NEVER be load-bearing. Wounds #23/#25/
# #26 hardened normalize + persist against an oversized pi output on the lite
# instance's small disk, but build-transcript was the one heavy write left
# UNGUARDED: it re-concatenates raw_output (1x) AND LANE_OUTPUT_PATH (~1x when a
# failed normalize copied raw verbatim) into the transcript (~2x), so an oversized
# output peaks at ~4x on disk and the bare '> "$LANE_TRANSCRIPT_PATH"' redirect
# tripped ENOSPC under set -e — no marker, no receipt, the agent's 456s run burned
# (wound #29: the heartbeat named build-transcript across two live runs
# a8bc84dc + f9a37a09). Three coordinated guards: (1) announce disk + input byte
# sizes to the diagnostics channel BEFORE the write, so an abort here names its
# cause instead of going blind; (2) bound every section with head -c so the
# transcript can never balloon past an input (the full output is the committed
# output pin, not this debug file); (3) never let the write abort the lane, and
# guarantee the file EXISTS for the downstream hash so a failed write still commits
# an honest receipt.
# Bash brace param-expansion defaults collide with this String.raw template's JS
# interpolation, so default the (test-only) cap override under a brief set +u and
# keep every byte count a bare-var assignment with an explicit empty guard.
transcript_section_cap_bytes=262144
set +u
if [ -n "$PIWF_TRANSCRIPT_SECTION_CAP_BYTES" ]; then
  transcript_section_cap_bytes="$PIWF_TRANSCRIPT_SECTION_CAP_BYTES"
fi
set -u
raw_output_bytes="$(wc -c < "$raw_output_path" 2>/dev/null | tr -d '[:space:]')"
[ -n "$raw_output_bytes" ] || raw_output_bytes=unknown
lane_output_bytes="$(wc -c < "$LANE_OUTPUT_PATH" 2>/dev/null | tr -d '[:space:]')"
[ -n "$lane_output_bytes" ] || lane_output_bytes=unknown
stderr_bytes="$(wc -c < "$stderr_path" 2>/dev/null | tr -d '[:space:]')"
[ -n "$stderr_bytes" ] || stderr_bytes=unknown
diag "build-transcript disk: $(df -Pk /workspace 2>/dev/null | awk 'NR==2{print $4" KB free of "$2" KB"}' || printf 'unknown')"
diag "build-transcript raw_output_bytes: $raw_output_bytes"
diag "build-transcript lane_output_bytes: $lane_output_bytes"
diag "build-transcript stderr_bytes: $stderr_bytes"
diag "build-transcript section_cap_bytes: $transcript_section_cap_bytes"
# Bounded section writer: head -c the source into a capped preview with a
# truncation notice, never the whole (possibly multi-MB) file.
emit_capped_section() {
  printf '## %s\n\n' "$2"
  if [ -f "$1" ]; then
    head -c "$transcript_section_cap_bytes" "$1" 2>/dev/null || true
    section_bytes="$(wc -c < "$1" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$section_bytes" ] || section_bytes=0
    if [ "$section_bytes" -gt "$transcript_section_cap_bytes" ] 2>/dev/null; then
      printf '\n\n[transcript truncated: %s of %s bytes shown — the full output is the committed output pin, not this debug transcript]\n' \
        "$transcript_section_cap_bytes" "$section_bytes"
    fi
  fi
  printf '\n\n'
}
set +e
{
  printf '# Pi agent lane transcript\n\n'
  printf 'Run: %s\n' "$RUN_ID"
  printf 'Work item: %s\n' "$WORK_ITEM_ID"
  printf 'Lane: %s\n' "$LANE_ID"
  printf 'Trace: %s\n' "$WORKFLOW_TRACE_ID"
  printf 'Span: %s\n' "$WORKFLOW_SPAN_ID"
  printf 'Exit status: %s\n\n' "$pi_status"
  printf '## Mounted Packages\n\n'
  head -c "$transcript_section_cap_bytes" packages/pinned-packages.json 2>/dev/null || true
  printf '\n\n'
  emit_capped_section "$raw_output_path" "Raw Output"
  emit_capped_section "$LANE_OUTPUT_PATH" "Normalized Output"
  emit_capped_section "$stderr_path" "Stderr"
} > "$LANE_TRANSCRIPT_PATH" 2>/dev/null
transcript_write_status=$?
set -e
diag "build-transcript write_exit: $transcript_write_status"
# Debug-only: a failed/partial write must not abort the lane, but the hash step
# needs the file to EXIST. Guarantee a placeholder so a failed write still yields a
# committed receipt (honest status) instead of a blind no-marker abort.
if [ ! -f "$LANE_TRANSCRIPT_PATH" ]; then
  printf '[transcript unavailable: build-transcript write failed (exit %s); see lane diagnostics for disk/size state]\n' \
    "$transcript_write_status" > "$LANE_TRANSCRIPT_PATH" 2>/dev/null || true
fi
mark hash-artifacts
prompt_hash="$(sha256sum "$LANE_PROMPT_PATH" | awk '{print $1}')"
transcript_hash="$(sha256sum "$LANE_TRANSCRIPT_PATH" | awk '{print $1}')"
output_hash="$(sha256sum "$LANE_OUTPUT_PATH" | awk '{print $1}')"
package_mount_index_hash="$(sha256sum packages/pinned-packages.json | awk '{print $1}')"
package_mount_count="$(node <<'NODE'
const fs = require("fs");
const index = JSON.parse(fs.readFileSync("packages/pinned-packages.json", "utf8"));
process.stdout.write(String(index.mounts.length));
NODE
)"
export completed_at output_hash package_mount_count package_mount_index_hash pi_status prompt_hash started_at transcript_hash
mark build-receipt
node <<'NODE'
const fs = require("fs");
${agentLaneTokenCostAccountingNodeScript}
const outputRefs = JSON.parse(process.env.LANE_OUTPUT_ARTIFACT_REFS_JSON);
const accounting = parseAgentLaneTokenCostAccountingFromText([
  fs.readFileSync(process.env.raw_output_path, "utf8"),
  fs.readFileSync(process.env.stderr_path, "utf8")
].join("\n"));
let outputNormalization = { normalized: true, reason: null, agentStopReason: null };
const normalizationPath = process.env.LANE_OUTPUT_NORMALIZATION_PATH;
if (normalizationPath && fs.existsSync(normalizationPath)) {
  try {
    outputNormalization = JSON.parse(fs.readFileSync(normalizationPath, "utf8"));
  } catch {}
}
const piExitOk = Number(process.env.pi_status) === 0;
const laneCompleted = piExitOk && outputNormalization.normalized !== false;
const receipt = {
  completedAt: process.env.completed_at,
  kind: process.env.LANE_KIND,
  laneId: process.env.LANE_ID,
  outputPins: outputRefs.map((artifactRef) => ({
    artifactRef,
    hash: process.env.output_hash,
    mediaType: process.env.LANE_OUTPUT_MEDIA_TYPE
  })),
  outputRefs,
  packageMounts: {
    artifactRef: process.env.LANE_PACKAGE_MOUNT_INDEX_ARTIFACT_REF,
    hash: process.env.package_mount_index_hash,
    mediaType: "application/json",
    mountCount: Number(process.env.package_mount_count)
  },
  prompt: {
    artifactRef: process.env.LANE_PROMPT_ARTIFACT_REF,
    hash: process.env.prompt_hash,
    mediaType: "text/markdown"
  },
  outputNormalization: {
    normalized: outputNormalization.normalized !== false,
    reason: outputNormalization.reason ?? null,
    agentStopReason: outputNormalization.agentStopReason ?? null
  },
  realAgent: true,
  receiptRef: process.env.LANE_RECEIPT_ARTIFACT_REF,
  authLease: JSON.parse(process.env.LANE_AUTH_LEASE_JSON),
  redacted: true,
  runtime: process.env.LANE_RUNTIME,
  sandboxRef: process.env.LANE_SANDBOX_REF,
  startedAt: process.env.started_at,
  status: laneCompleted ? "completed" : "failed",
  ...(accounting === null ? {} : { tokenCostAccounting: accounting }),
  traceContext: JSON.parse(process.env.WORKFLOW_TRACE_CONTEXT_JSON),
  transcript: {
    artifactRef: process.env.LANE_TRANSCRIPT_ARTIFACT_REF,
    hash: process.env.transcript_hash,
    mediaType: "text/markdown"
  }
};
fs.writeFileSync(process.env.LANE_RECEIPT_PATH, JSON.stringify(receipt, null, 2) + "\n");
NODE
mark git-add
git add "$LANE_PROMPT_PATH" "$LANE_OUTPUT_PATH" "$LANE_TRANSCRIPT_PATH" "$LANE_RECEIPT_PATH" packages >> "$git_log_path" 2>&1
mark git-commit
if git diff --cached --quiet; then
  commit="$(git rev-parse HEAD)"
else
  git commit -m "agent lane: $LANE_ID $RUN_ID" >> "$git_log_path" 2>&1
  commit="$(git rev-parse HEAD)"
fi
mark git-push
git push origin HEAD:"refs/heads/$LANE_BRANCH" >> "$git_log_path" 2>&1
export commit
mark emit-marker
marker_emitted=1
node <<'NODE'
const payload = {
  status: "ok",
  artifactCommitSha: process.env.commit,
  receiptPath: process.env.LANE_RECEIPT_PATH
};
process.stdout.write("\n__PIWF_AGENT_LANE_RESULT__:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
NODE
exit "$pi_status"`;

export const tailForDiagnostic = (value: string): string =>
  value.length <= 1200 ? value : value.slice(-1200);

/**
 * Decode a base64 marker payload to a JSON value, returning `null` on any
 * malformed input (truncated base64, non-JSON bytes) so the caller can step to
 * the next marker instead of throwing on a corpse.
 */
const tryDecodeMarkerJson = (encoded: string): unknown => {
  try {
    return JSON.parse(atob(encoded));
  } catch {
    return null;
  }
};

export const parseLaneResultMarker = (
  result: SandboxCommandResult
): SandboxLaneResultMarker => {
  // Scan ALL marker occurrences and return the first that decodes + validates,
  // not merely the first that matches the prefix. A node emit that is OOM-killed
  // mid-stdout-write can leave a truncated `__PIWF_AGENT_LANE_RESULT__:<partial>`
  // line; the shell-only fallback then appends a VALID marker after it. A
  // first-match-only parse would lock onto the corpse and throw, masking the
  // recovered cause — so we step past unparseable markers to the good one.
  // (wound #23-A: recovery must survive the failure it recovers.)
  const markers = result.stdout.matchAll(
    /__PIWF_AGENT_LANE_RESULT__:([A-Za-z0-9+/=]+)/gu
  );
  let sawMarker = false;
  for (const marker of markers) {
    const [, encoded] = marker;
    if (encoded === undefined) {
      continue;
    }
    sawMarker = true;
    const parsed = SandboxLaneResultMarkerSchema.safeParse(
      tryDecodeMarkerJson(encoded)
    );
    if (parsed.success) {
      return parsed.data;
    }
  }

  throw new Error(
    `Cloudflare Sandbox lane ${sawMarker ? "emitted only unparseable result markers" : "did not emit a result marker"} (exit ${result.exitCode}). stdout tail: ${tailForDiagnostic(result.stdout) || "<empty>"} | stderr tail: ${tailForDiagnostic(result.stderr) || "<empty>"}`
  );
};

/**
 * Pick the diagnostic that names WHICH actor halted when a lane aborts.
 *
 * `stderrTail` is pi's own stderr (the agent's voice — including the
 * `[pi-invoke self-bound]` notice on a 124); `gitLogTail` is the clone log.
 * When pi RAN (`piStatus` is a number) pi's stderr is the cause and the clone
 * log is benign context — yet the old `gitLogTail || stderrTail` precedence
 * MASKED pi's stderr behind a "Cloning into… empty repository…" line, which is
 * exactly how wound #22's self-bound planner lost its voice in the blocker. So:
 * pi ran → lead with stderr, append the git log; pi never ran (a pre-pi
 * clone/checkout failure) → lead with the git log. The application itself has
 * to announce WHICH halted, not just THAT it halted.
 */
export const selectLaneAbortDiagnostic = (marker: {
  readonly gitLogTail: string;
  readonly piStatus: number | null;
  readonly stderrTail: string;
}): string => {
  const piRan = marker.piStatus !== null;
  const primary = piRan
    ? marker.stderrTail || marker.gitLogTail
    : marker.gitLogTail || marker.stderrTail;
  const appendGitLog =
    piRan && marker.stderrTail !== "" && marker.gitLogTail !== "";
  const suffix = appendGitLog ? ` [git log: ${marker.gitLogTail}]` : "";
  return `${primary === "" ? "no diagnostic output" : primary}${suffix}`;
};

/**
 * The ordered lane steps stamped into the `/workspace/.piwf-heartbeat` file by
 * `mark <step>` (plus the `init` start state and the unmarked `emit-marker` tail).
 * The heartbeat's last entry is the furthest step the lane reached before it
 * aborted — the single OBSERVABLE fact that distinguishes a pre-agent transport
 * outage from a lane-internal failure after the agent ran.
 */
export const LANE_STEP_SEQUENCE = [
  "init",
  "install-pi-agent",
  "prepare-auth",
  "clone-artifacts",
  "checkout-branch",
  "mount-packages",
  "pi-invoke",
  "normalize-output",
  "build-transcript",
  "hash-artifacts",
  "build-receipt",
  "git-add",
  "git-commit",
  "git-push",
  "emit-marker",
] as const;

/**
 * Did the lane reach the agent invocation (`pi-invoke`) or any later step?
 *
 * `true` is proof the agent demonstrably RAN inside a reachable sandbox: a
 * genuine transport outage (sandbox unreachable, image un-pullable, clone
 * failing) freezes the heartbeat at an EARLIER step and never gets here. An
 * unknown step token (not in the sequence) is treated as NOT reached, so a
 * corrupt heartbeat fails safe toward the retryable transport classification.
 *
 * @param step - The last step name read from the heartbeat (or an error marker).
 */
export const laneStepReachedAgentInvocation = (
  step: string | null
): boolean => {
  if (step === null) {
    return false;
  }
  const sequence: readonly string[] = LANE_STEP_SEQUENCE;
  const stepIndex = sequence.indexOf(step);
  const agentInvocationIndex = sequence.indexOf("pi-invoke");
  return stepIndex !== -1 && stepIndex >= agentInvocationIndex;
};

/**
 * Pull the last step NAME from a formatted heartbeat tail.
 *
 * The executor reads `/workspace/.piwf-heartbeat` (lines of `<epoch> <step>`)
 * and joins the last 20 with `" | "`. Each entry is `<epoch> <step>`; we want
 * the trailing token of the last entry. Returns `null` for an empty/garbled tail
 * so the caller fails safe toward the transport classification.
 *
 * @param heartbeatTail - The `" | "`-joined heartbeat tail the executor built.
 */
export const lastHeartbeatStep = (heartbeatTail: string): string | null => {
  const entries = heartbeatTail
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const lastEntry = entries.at(-1);
  if (lastEntry === undefined) {
    return null;
  }
  const stepToken = lastEntry.split(/\s+/u).at(-1);
  return stepToken === undefined || stepToken.length === 0 ? null : stepToken;
};

/**
 * Classify a lane that aborted WITHOUT committing a usable result, by how far its
 * heartbeat got. Reached `pi-invoke`+ → an {@link AgentLaneIncompleteError} (the
 * agent ran; this is lane-internal, deterministic, must NOT blind-re-drive).
 * Froze before `pi-invoke` (or no heartbeat) → `null`, leaving the caller to
 * throw its existing transport error so a genuine outage stays retryable
 * (`adapter_unavailable`).
 *
 * Correct under EVERY root-cause hypothesis for wound #28 (ENOSPC at transcript,
 * an un-emitted EXIT-trap marker, oversized pi output): all of them reach
 * `pi-invoke` first, so all of them classify as lane-internal — the fix stops the
 * blind re-drive and lets the next honest run name the true root cause.
 */
export const classifyAgentLaneIncompleteFailure = (input: {
  readonly cause: unknown;
  readonly detail: string;
  // Best-effort `/workspace/.piwf-lane-diagnostics` content the executor read
  // alongside the heartbeat. Carries the CAUSE (disk free, byte sizes, the failing
  // write's exit) the aborting step announced before it died, since the lane
  // commits no receipt. Folded into the error message so the next read names ENOSPC
  // vs OOM vs other instead of us guessing (wound #29).
  readonly diagnostics?: string;
  readonly heartbeatTail: string;
  readonly runId: string;
  readonly workItemId: string;
}): AgentLaneIncompleteError | null => {
  const lastStep = lastHeartbeatStep(input.heartbeatTail);
  if (!laneStepReachedAgentInvocation(lastStep)) {
    return null;
  }
  return new AgentLaneIncompleteError({
    cause: input.cause,
    detail: input.detail,
    ...(input.diagnostics === undefined
      ? {}
      : { diagnostics: input.diagnostics }),
    lastStep,
    reachedAgentInvocation: true,
    runId: input.runId,
    workItemId: input.workItemId,
  });
};
