import { z } from "zod";

import { jsonOutputNormalizerNodeScript } from "./agent-lane-json-output.ts";
import { agentLanePackageMountWriterNodeScript } from "./agent-lane-package-mounts.ts";
import { agentLaneTokenCostAccountingNodeScript } from "./agent-lane-token-cost-accounting.ts";

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
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
agent_dir="/workspace/.pi/agent"
auth_path="$agent_dir/auth.json"
raw_output_path="/workspace/piwf-agent-lane-output-raw.txt"
stderr_path="/workspace/piwf-agent-lane-stderr.txt"
git_log_path="/workspace/piwf-agent-lane-git.log"
export raw_output_path stderr_path
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
  PIWF_FAIL_EXIT_CODE="$exit_code" \
  PIWF_FAIL_STEP="$current_step" \
  PIWF_FAIL_PI_STATUS="$pi_status" \
  PIWF_FAIL_STDERR_TAIL="$stderr_tail" \
  PIWF_FAIL_GIT_LOG_TAIL="$git_log_tail" \
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
NODE
}
trap emit_failure_marker EXIT
current_step="prepare-auth"
rm -rf /workspace/piwf-agent-lane
mkdir -p "$agent_dir"
printf '%s' "$PI_AUTH_JSON_B64" | base64 -d > "$auth_path"
chmod 600 "$auth_path"
current_step="clone-artifacts"
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-agent-lane > "$git_log_path" 2>&1
cd /workspace/piwf-agent-lane
git config user.name "pi-workflow-agent-lane"
git config user.email "pi-workflow-agent-lane@example.invalid"
current_step="checkout-branch"
git checkout -B "$LANE_BRANCH" >> "$git_log_path" 2>&1
current_step="mount-packages"
node <<'NODE'
${agentLanePackageMountWriterNodeScript}
NODE
mkdir -p "$(dirname "$LANE_PROMPT_PATH")" "$(dirname "$LANE_OUTPUT_PATH")" "$(dirname "$LANE_TRANSCRIPT_PATH")" "$(dirname "$LANE_RECEIPT_PATH")"
printf '%s' "$LANE_PROMPT" > "$LANE_PROMPT_PATH"
current_step="pi-invoke"
set +e
pi --provider "$PI_PROVIDER" --model "$PI_MODEL" --no-session -p "$(cat "$LANE_PROMPT_PATH")" > "$raw_output_path" 2> "$stderr_path"
pi_status=$?
set -e
current_step="normalize-output"
if [ "$LANE_OUTPUT_MEDIA_TYPE" = "application/json" ]; then
  if ! node <<'NODE'
${jsonOutputNormalizerNodeScript}
NODE
  then
    cp "$raw_output_path" "$LANE_OUTPUT_PATH"
    pi_status=65
  fi
else
  cp "$raw_output_path" "$LANE_OUTPUT_PATH"
fi
completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
current_step="build-transcript"
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
current_step="hash-artifacts"
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
current_step="build-receipt"
node <<'NODE'
const fs = require("fs");
${agentLaneTokenCostAccountingNodeScript}
const outputRefs = JSON.parse(process.env.LANE_OUTPUT_ARTIFACT_REFS_JSON);
const accounting = parseAgentLaneTokenCostAccountingFromText([
  fs.readFileSync(process.env.raw_output_path, "utf8"),
  fs.readFileSync(process.env.stderr_path, "utf8")
].join("\n"));
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
  realAgent: true,
  receiptRef: process.env.LANE_RECEIPT_ARTIFACT_REF,
  authLease: JSON.parse(process.env.LANE_AUTH_LEASE_JSON),
  redacted: true,
  runtime: process.env.LANE_RUNTIME,
  sandboxRef: process.env.LANE_SANDBOX_REF,
  startedAt: process.env.started_at,
  status: Number(process.env.pi_status) === 0 ? "completed" : "failed",
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
current_step="git-add"
git add "$LANE_PROMPT_PATH" "$LANE_OUTPUT_PATH" "$LANE_TRANSCRIPT_PATH" "$LANE_RECEIPT_PATH" packages >> "$git_log_path" 2>&1
current_step="git-commit"
git commit -m "agent lane: $LANE_ID $RUN_ID" >> "$git_log_path" 2>&1
commit="$(git rev-parse HEAD)"
current_step="git-push"
git push origin HEAD:"refs/heads/$LANE_BRANCH" >> "$git_log_path" 2>&1
export commit
current_step="emit-marker"
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

export const parseLaneResultMarker = (
  result: SandboxCommandResult
): SandboxLaneResultMarker => {
  const marker = /__PIWF_AGENT_LANE_RESULT__:([A-Za-z0-9+/=]+)/u.exec(
    result.stdout
  );
  if (marker?.[1] === undefined) {
    throw new Error(
      `Cloudflare Sandbox lane did not emit a result marker (exit ${result.exitCode}). stdout tail: ${tailForDiagnostic(result.stdout) || "<empty>"} | stderr tail: ${tailForDiagnostic(result.stderr) || "<empty>"}`
    );
  }

  return SandboxLaneResultMarkerSchema.parse(JSON.parse(atob(marker[1])));
};
