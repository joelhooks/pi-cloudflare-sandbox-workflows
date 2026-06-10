import { getSandbox } from "@cloudflare/sandbox";
import type {
  ISandbox,
  Sandbox as SandboxDurableObject,
} from "@cloudflare/sandbox";
import { z } from "zod";

import type {
  AgentLaneRuntimePort,
  AgentLaneRuntimeRequest,
} from "../application/ports.ts";
import {
  AgentAuthLeaseSchema,
  AgentLaneReceiptSchema,
  WorkflowTraceContextSchema,
} from "../domain/schemas.ts";
import type { AgentLaneReceipt } from "../domain/schemas.ts";
import { jsonOutputNormalizerNodeScript } from "./agent-lane-json-output.ts";
import {
  agentLanePackageMountWriterNodeScript,
  buildAgentLanePackageMountIndex,
} from "./agent-lane-package-mounts.ts";
import { agentLaneTokenCostAccountingNodeScript } from "./agent-lane-token-cost-accounting.ts";
import { buildSandboxId, safeGitRefSegment } from "./sandbox-id.ts";

interface CloudflareSandboxAgentLaneEnv {
  readonly Sandbox: DurableObjectNamespace<SandboxDurableObject>;
}

interface RealSandbox extends ISandbox {
  destroy(): Promise<void>;
}

interface SandboxCommandResult {
  readonly command: string;
  readonly duration: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly success: boolean;
  readonly timestamp: string;
}

interface SandboxLaneResultMarker {
  readonly artifactCommitSha: string;
  readonly receiptPath: string;
}

const SandboxLaneResultMarkerSchema = z.object({
  artifactCommitSha: z.string().min(1),
  receiptPath: z.string().min(1),
});

const assertRealPiLaneInput = (input: AgentLaneRuntimeRequest): void => {
  if (!input.artifactRemote.startsWith("https://")) {
    throw new TypeError(
      "Cloudflare Sandbox lanes require an HTTPS Artifacts remote."
    );
  }

  if (!input.artifactTokenSecret) {
    throw new TypeError(
      "Cloudflare Sandbox lanes require a short-lived Artifacts token."
    );
  }

  AgentAuthLeaseSchema.parse(input.authLease);
  WorkflowTraceContextSchema.parse(input.traceContext);

  if (!input.leasedPiAuthJsonBase64) {
    throw new TypeError(
      "Cloudflare Sandbox Pi lanes require a leased Pi auth blob."
    );
  }
};

const redact = (value: string, secrets: readonly string[]): string => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }
  return redacted;
};

const runCommand = async (
  sandbox: RealSandbox,
  command: string,
  redaction: { readonly tokenSecret: string },
  options: {
    readonly env: Record<string, string>;
    readonly timeout: number;
  }
): Promise<SandboxCommandResult> => {
  const encodedCommand = btoa(command);
  const wrappedCommand = String.raw`set +e
script_path="$(mktemp)"
printf '%s' '${encodedCommand}' | base64 -d > "$script_path"
timeout "$PIWF_COMMAND_TIMEOUT_SECONDS" bash "$script_path" 2>&1
status=$?
rm -f "$script_path"
printf '\n__PIWF_EXIT_CODE__:%s\n' "$status"`;
  const result = await sandbox.exec(wrappedCommand, {
    cwd: "/workspace",
    env: options.env,
    timeout: options.timeout,
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const exitMatch = /__PIWF_EXIT_CODE__:(\d+)/u.exec(combinedOutput);
  const exitCode =
    exitMatch?.[1] === undefined ? result.exitCode : Number(exitMatch[1]);

  return {
    command,
    duration: result.duration,
    exitCode,
    stderr: redact(result.stderr, [redaction.tokenSecret]),
    stdout: redact(result.stdout, [redaction.tokenSecret]),
    success: exitCode === 0,
    timestamp: result.timestamp,
  };
};

const buildPiAgentLaneCommand = (): string => String.raw`set -eu
started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
agent_dir="/workspace/.pi/agent"
auth_path="$agent_dir/auth.json"
raw_output_path="/workspace/piwf-agent-lane-output-raw.txt"
stderr_path="/workspace/piwf-agent-lane-stderr.txt"
export raw_output_path stderr_path
rm -rf /workspace/piwf-agent-lane
mkdir -p "$agent_dir"
printf '%s' "$PI_AUTH_JSON_B64" | base64 -d > "$auth_path"
chmod 600 "$auth_path"
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-agent-lane
cd /workspace/piwf-agent-lane
git config user.name "pi-workflow-agent-lane"
git config user.email "pi-workflow-agent-lane@example.invalid"
git checkout -B "$LANE_BRANCH"
node <<'NODE'
${agentLanePackageMountWriterNodeScript}
NODE
mkdir -p "$(dirname "$LANE_PROMPT_PATH")" "$(dirname "$LANE_OUTPUT_PATH")" "$(dirname "$LANE_TRANSCRIPT_PATH")" "$(dirname "$LANE_RECEIPT_PATH")"
printf '%s' "$LANE_PROMPT" > "$LANE_PROMPT_PATH"
set +e
pi --provider "$PI_PROVIDER" --model "$PI_MODEL" --no-session -p "$(cat "$LANE_PROMPT_PATH")" > "$raw_output_path" 2> "$stderr_path"
pi_status=$?
set -e
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
git add "$LANE_PROMPT_PATH" "$LANE_OUTPUT_PATH" "$LANE_TRANSCRIPT_PATH" "$LANE_RECEIPT_PATH" packages
git commit -m "agent lane: $LANE_ID $RUN_ID"
commit="$(git rev-parse HEAD)"
git push origin HEAD:"refs/heads/$LANE_BRANCH"
export commit
node <<'NODE'
const payload = {
  artifactCommitSha: process.env.commit,
  receiptPath: process.env.LANE_RECEIPT_PATH
};
process.stdout.write("\n__PIWF_AGENT_LANE_RESULT__:" + Buffer.from(JSON.stringify(payload), "utf8").toString("base64") + "\n");
NODE
exit "$pi_status"`;

const parseLaneResultMarker = (stdout: string): SandboxLaneResultMarker => {
  const marker = /__PIWF_AGENT_LANE_RESULT__:([A-Za-z0-9+/=]+)/u.exec(stdout);
  if (marker?.[1] === undefined) {
    throw new Error("Cloudflare Sandbox lane did not emit a result marker.");
  }

  return SandboxLaneResultMarkerSchema.parse(JSON.parse(atob(marker[1])));
};

const getRealSandbox = (
  namespace: DurableObjectNamespace<SandboxDurableObject>,
  sandboxId: string
): RealSandbox =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Cloudflare Sandbox SDK returns ISandbox, while the runtime sandbox also exposes destroy().
  getSandbox(namespace, sandboxId) as unknown as RealSandbox;

const destroySandbox = async (
  sandbox: RealSandbox,
  sandboxId: string
): Promise<string> => {
  await sandbox.destroy();
  return `destroy:${sandboxId}:ok`;
};

const toAuthenticatedRemote = (
  remote: string,
  token: string
): { readonly remote: string; readonly tokenSecret: string } => {
  const tokenSecret = token.split("?expires=")[0] ?? token;
  return {
    remote: `https://x:${tokenSecret}@${remote.slice("https://".length)}`,
    tokenSecret,
  };
};

const runCloudflareSandboxPiAgentLane = async (input: {
  readonly env: CloudflareSandboxAgentLaneEnv;
  readonly input: AgentLaneRuntimeRequest;
}): Promise<AgentLaneReceipt> => {
  assertRealPiLaneInput(input.input);

  const sandboxId = buildSandboxId(input.input.runId, input.input.laneId);
  const sandbox = getRealSandbox(input.env.Sandbox, sandboxId);
  const promptRef = input.input.artifactRef({
    path: input.input.promptPath,
    runId: input.input.runId,
  });
  const transcriptRef = input.input.artifactRef({
    path: input.input.transcriptPath,
    runId: input.input.runId,
  });
  const receiptRef = input.input.artifactRef({
    path: input.input.receiptPath,
    runId: input.input.runId,
  });
  const packageMountIndexRef = input.input.artifactRef({
    path: "packages/pinned-packages.json",
    runId: input.input.runId,
  });
  const outputRefs = [
    input.input.artifactRef({
      path: input.input.outputPath,
      runId: input.input.runId,
    }),
  ];
  const packageMountIndex = buildAgentLanePackageMountIndex(
    input.input.packageMounts ?? []
  );

  try {
    const result = await runCommand(
      sandbox,
      buildPiAgentLaneCommand(),
      {
        tokenSecret: input.input.artifactTokenSecret,
      },
      {
        env: {
          ARTIFACTS_GIT_REMOTE: toAuthenticatedRemote(
            input.input.artifactRemote,
            input.input.artifactTokenSecret
          ).remote,
          GIT_TERMINAL_PROMPT: "0",
          LANE_AUTH_LEASE_JSON: JSON.stringify(input.input.authLease),
          LANE_BRANCH:
            input.input.branchName ??
            `lane-${safeGitRefSegment(input.input.laneId)}`,
          LANE_ID: input.input.laneId,
          LANE_KIND: input.input.kind,
          LANE_OUTPUT_ARTIFACT_REFS_JSON: JSON.stringify(outputRefs),
          LANE_OUTPUT_MEDIA_TYPE: input.input.outputMediaType,
          LANE_OUTPUT_PATH: input.input.outputPath,
          LANE_PACKAGE_MOUNT_INDEX_ARTIFACT_REF: packageMountIndexRef,
          LANE_PACKAGE_MOUNT_INDEX_JSON: JSON.stringify(packageMountIndex),
          LANE_PROMPT: input.input.prompt,
          LANE_PROMPT_ARTIFACT_REF: promptRef,
          LANE_PROMPT_PATH: input.input.promptPath,
          LANE_RECEIPT_ARTIFACT_REF: receiptRef,
          LANE_RECEIPT_PATH: input.input.receiptPath,
          LANE_RUNTIME: "pi-agent-cli",
          LANE_SANDBOX_REF: `cloudflare-sandbox:${sandboxId}`,
          LANE_TRANSCRIPT_ARTIFACT_REF: transcriptRef,
          LANE_TRANSCRIPT_PATH: input.input.transcriptPath,
          PIWF_COMMAND_TIMEOUT_SECONDS: String(
            Math.ceil(input.input.timeoutMs / 1000)
          ),
          PI_AUTH_JSON_B64: input.input.leasedPiAuthJsonBase64,
          PI_MODEL: input.input.model,
          PI_PROVIDER: input.input.provider,
          RUN_ID: input.input.runId,
          WORKFLOW_PARENT_SPAN_ID: input.input.traceContext.parentSpanId ?? "",
          WORKFLOW_SPAN_ID: input.input.traceContext.spanId,
          WORKFLOW_TRACE_CONTEXT_JSON: JSON.stringify(input.input.traceContext),
          WORKFLOW_TRACE_ID: input.input.traceContext.traceId,
          WORK_ITEM_ID: input.input.workItemId,
        },
        timeout: input.input.timeoutMs,
      }
    );
    const marker = parseLaneResultMarker(result.stdout);
    if (!result.success) {
      throw new Error(
        `Cloudflare Sandbox Pi lane failed after commit ${marker.artifactCommitSha}: ${result.stderr || result.stdout}`
      );
    }

    const receiptFile = await sandbox.readFile(
      `/workspace/piwf-agent-lane/${marker.receiptPath}`
    );
    const receipt = AgentLaneReceiptSchema.parse({
      ...JSON.parse(receiptFile.content),
      artifactCommitSha: marker.artifactCommitSha,
      sandboxAccounting: {
        commandDurationMs: result.duration,
      },
    });
    const cleanupReceipt = await destroySandbox(sandbox, sandboxId);

    return AgentLaneReceiptSchema.parse({
      ...receipt,
      sandboxAccounting: {
        ...receipt.sandboxAccounting,
        cleanup: {
          receipt: cleanupReceipt,
          status: "destroyed",
        },
      },
    });
  } catch (error) {
    await destroySandbox(sandbox, sandboxId).catch((destroyError: unknown) => {
      console.error(
        "Cloudflare Sandbox destroy failed during agent lane cleanup.",
        destroyError
      );
    });
    throw error;
  }
};

export const createCloudflareSandboxPiAgentLaneRuntime = (
  env: CloudflareSandboxAgentLaneEnv
): AgentLaneRuntimePort => ({
  runLane(input) {
    return runCloudflareSandboxPiAgentLane({ env, input });
  },
  runtime: "pi-agent-cli",
});

export const __cloudflareSandboxAgentLaneTestHooks = {
  buildPiAgentLaneCommand,
};
