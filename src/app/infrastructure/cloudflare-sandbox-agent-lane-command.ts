import { z } from "zod";

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
# channel. Text mode only echoes the final assistant message and goes silent when
# the run ends on a tool call, error, or abort — so a JSON lane that scraped text
# mode would lose the verdict the agent actually produced. The normalizer reads
# the event stream's agent_end message to recover it.
pi_mode_args=""
if [ "$LANE_OUTPUT_MEDIA_TYPE" = "application/json" ]; then
  pi_mode_args="--mode json"
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
timeout "$pi_budget_s" pi --provider "$PI_PROVIDER" --model "$PI_MODEL" --no-session $pi_mode_args -p "$(cat "$LANE_PROMPT_PATH")" > "$raw_output_path" 2> "$stderr_path"
pi_status=$?
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
  if node <<'NODE'
${jsonOutputNormalizerNodeScript}
NODE
  then
    output_normalized=1
  else
    output_normalized=0
    persist_unnormalized_output
  fi
else
  persist_unnormalized_output
fi
export output_normalized
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
mark build-transcript
{
  printf '# Pi agent lane transcript\n\n'
  printf 'Run: %s\n' "$RUN_ID"
  printf 'Work item: %s\n' "$WORK_ITEM_ID"
  printf 'Lane: %s\n' "$LANE_ID"
  printf 'Trace: %s\n' "$WORKFLOW_TRACE_ID"
  printf 'Span: %s\n' "$WORKFLOW_SPAN_ID"
  printf 'Exit status: %s\n\n' "$pi_status"
  printf '## Mounted Packages\n\n'
  cat packages/pinned-packages.json || true
  printf '\n\n'
  printf '## Raw Output\n\n'
  cat "$raw_output_path" || true
  printf '\n\n## Normalized Output\n\n'
  cat "$LANE_OUTPUT_PATH" || true
  printf '\n\n## Stderr\n\n'
  cat "$stderr_path" || true
} > "$LANE_TRANSCRIPT_PATH"
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
