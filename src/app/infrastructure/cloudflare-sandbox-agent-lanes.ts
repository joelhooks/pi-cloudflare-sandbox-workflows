import { getSandbox } from "@cloudflare/sandbox";
import type {
  ISandbox,
  Sandbox as SandboxDurableObject,
} from "@cloudflare/sandbox";

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
import { buildAgentLanePackageMountIndex } from "./agent-lane-package-mounts.ts";
import {
  buildPiAgentLaneCommand,
  parseLaneResultMarker,
} from "./cloudflare-sandbox-agent-lane-command.ts";
import type { SandboxCommandResult } from "./cloudflare-sandbox-agent-lane-command.ts";
import { buildSandboxId, safeGitRefSegment } from "./sandbox-id.ts";

interface CloudflareSandboxAgentLaneEnv {
  readonly Sandbox: DurableObjectNamespace<SandboxDurableObject>;
}

interface RealSandbox extends ISandbox {
  destroy(): Promise<void>;
}

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
  const promptSourcePath = `/workspace/piwf-agent-lane-prompt-${safeGitRefSegment(input.input.laneId)}.md`;
  const packageMountIndex = buildAgentLanePackageMountIndex(
    input.input.packageMounts ?? []
  );

  try {
    await sandbox.writeFile(promptSourcePath, input.input.prompt);
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
          LANE_PROMPT_ARTIFACT_REF: promptRef,
          LANE_PROMPT_PATH: input.input.promptPath,
          LANE_PROMPT_SOURCE_PATH: promptSourcePath,
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
    const marker = parseLaneResultMarker(result);
    if (marker.status === "error") {
      throw new Error(
        `Cloudflare Sandbox Pi lane aborted at step "${marker.failingStep ?? "unknown"}" (exit ${marker.exitCode}, pi ${marker.piStatus ?? "n/a"}): ${marker.gitLogTail || marker.stderrTail || "no diagnostic output"}`
      );
    }
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
