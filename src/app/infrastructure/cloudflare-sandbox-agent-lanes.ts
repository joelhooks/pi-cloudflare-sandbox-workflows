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
  AgentLaneDispatchReceiptSchema,
  AgentLaneProcessStatusReceiptSchema,
  AgentLaneReceiptSchema,
  WorkflowTraceContextSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneDispatchReceipt,
  AgentLaneProcessStatusReceipt,
  AgentLaneReceipt,
} from "../domain/schemas.ts";
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

type SandboxProcessStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "error";

interface SandboxProcessHandle {
  readonly endTime?: Date | number | string;
  readonly exitCode?: number;
  readonly id: string;
  readonly sessionId?: string;
  readonly status: SandboxProcessStatus;
  getStatus?(): Promise<
    SandboxProcessStatus | { readonly status: SandboxProcessStatus }
  >;
}

interface AsyncProcessSandboxMethods {
  getProcess(
    id: string,
    sessionId?: string
  ): Promise<SandboxProcessHandle | null>;
  startProcess(
    command: string,
    options: {
      readonly cwd: string;
      readonly env: Record<string, string>;
    }
  ): Promise<SandboxProcessHandle>;
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

const wrapCommandForSandbox = (command: string): string => {
  const encodedCommand = btoa(command);

  return String.raw`set +e
script_path="$(mktemp)"
printf '%s' '${encodedCommand}' | base64 -d > "$script_path"
timeout "$PIWF_COMMAND_TIMEOUT_SECONDS" bash "$script_path" 2>&1
status=$?
rm -f "$script_path"
printf '\n__PIWF_EXIT_CODE__:%s\n' "$status"`;
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
  const wrappedCommand = wrapCommandForSandbox(command);
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

const hasAsyncProcessMethods = (
  sandbox: RealSandbox
): sandbox is RealSandbox & AsyncProcessSandboxMethods => {
  const candidate: {
    readonly getProcess?: unknown;
    readonly startProcess?: unknown;
  } = sandbox;

  return (
    typeof candidate.startProcess === "function" &&
    typeof candidate.getProcess === "function"
  );
};

const asAsyncProcessSandbox = (
  sandbox: RealSandbox
): RealSandbox & AsyncProcessSandboxMethods => {
  if (!hasAsyncProcessMethods(sandbox)) {
    throw new Error(
      "Cloudflare Sandbox runtime does not expose async process methods."
    );
  }

  return sandbox;
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

const prepareCloudflareSandboxPiAgentLane = (input: {
  readonly env: CloudflareSandboxAgentLaneEnv;
  readonly input: AgentLaneRuntimeRequest;
}): {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly expectedOutputArtifactRefs: readonly string[];
  readonly expectedReceiptArtifactRef: string;
  readonly promptArtifactRef: string;
  readonly promptSourcePath: string;
  readonly sandbox: RealSandbox;
  readonly sandboxId: string;
} => {
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
  const authenticatedRemote = toAuthenticatedRemote(
    input.input.artifactRemote,
    input.input.artifactTokenSecret
  );

  return {
    command: buildPiAgentLaneCommand(),
    env: {
      ARTIFACTS_GIT_REMOTE: authenticatedRemote.remote,
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
    expectedOutputArtifactRefs: outputRefs,
    expectedReceiptArtifactRef: receiptRef,
    promptArtifactRef: promptRef,
    promptSourcePath,
    sandbox,
    sandboxId,
  };
};

const runCloudflareSandboxPiAgentLane = async (input: {
  readonly env: CloudflareSandboxAgentLaneEnv;
  readonly input: AgentLaneRuntimeRequest;
}): Promise<AgentLaneReceipt> => {
  const prepared = prepareCloudflareSandboxPiAgentLane(input);

  try {
    await prepared.sandbox.writeFile(
      prepared.promptSourcePath,
      input.input.prompt
    );
    const result = await runCommand(
      prepared.sandbox,
      prepared.command,
      {
        tokenSecret: input.input.artifactTokenSecret,
      },
      {
        env: prepared.env,
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

    const receiptFile = await prepared.sandbox.readFile(
      `/workspace/piwf-agent-lane/${marker.receiptPath}`
    );
    const receipt = AgentLaneReceiptSchema.parse({
      ...JSON.parse(receiptFile.content),
      artifactCommitSha: marker.artifactCommitSha,
      sandboxAccounting: {
        commandDurationMs: result.duration,
      },
    });
    const cleanupReceipt = await destroySandbox(
      prepared.sandbox,
      prepared.sandboxId
    );

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
    await destroySandbox(prepared.sandbox, prepared.sandboxId).catch(
      (destroyError: unknown) => {
        console.error(
          "Cloudflare Sandbox destroy failed during agent lane cleanup.",
          destroyError
        );
      }
    );
    throw error;
  }
};

const dispatchCloudflareSandboxPiAgentLane = async (input: {
  readonly env: CloudflareSandboxAgentLaneEnv;
  readonly input: AgentLaneRuntimeRequest;
}): Promise<AgentLaneDispatchReceipt> => {
  const prepared = prepareCloudflareSandboxPiAgentLane(input);
  await prepared.sandbox.writeFile(
    prepared.promptSourcePath,
    input.input.prompt
  );
  const process = await asAsyncProcessSandbox(prepared.sandbox).startProcess(
    wrapCommandForSandbox(prepared.command),
    {
      cwd: "/workspace",
      env: prepared.env,
    }
  );
  const dispatchedAt = new Date();

  return AgentLaneDispatchReceiptSchema.parse({
    deadline: new Date(
      dispatchedAt.getTime() + input.input.timeoutMs
    ).toISOString(),
    dispatchedAt: dispatchedAt.toISOString(),
    expectedOutputArtifactRefs: prepared.expectedOutputArtifactRefs,
    expectedReceiptArtifactRef: prepared.expectedReceiptArtifactRef,
    kind: input.input.kind,
    laneAuthLeaseId: input.input.authLease.leaseId,
    laneId: input.input.laneId,
    processId: process.id,
    promptArtifactRef: prepared.promptArtifactRef,
    runId: input.input.runId,
    sandboxId: prepared.sandboxId,
    schemaVersion: "agent-lane.dispatch-receipt.v1",
    ...(process.sessionId === undefined
      ? {}
      : { sessionId: process.sessionId }),
    workItemId: input.input.workItemId,
  });
};

const resolveProcessStatus = async (
  process: SandboxProcessHandle
): Promise<SandboxProcessStatus> => {
  if (process.getStatus === undefined) {
    return process.status;
  }

  const status = await process.getStatus();
  return typeof status === "string" ? status : status.status;
};

const processEndTimeValue = (
  endTime: SandboxProcessHandle["endTime"]
): number | string | undefined => {
  if (endTime instanceof Date) {
    return endTime.toISOString();
  }

  return endTime;
};

const pollCloudflareSandboxPiAgentLane = async (input: {
  readonly dispatch: AgentLaneDispatchReceipt;
  readonly env: CloudflareSandboxAgentLaneEnv;
}): Promise<AgentLaneProcessStatusReceipt> => {
  const sandbox = asAsyncProcessSandbox(
    getRealSandbox(input.env.Sandbox, input.dispatch.sandboxId)
  );
  const process = await sandbox.getProcess(
    input.dispatch.processId,
    input.dispatch.sessionId
  );
  if (process === null) {
    return AgentLaneProcessStatusReceiptSchema.parse({
      checkedAt: new Date().toISOString(),
      kind: input.dispatch.kind,
      laneId: input.dispatch.laneId,
      processId: input.dispatch.processId,
      runId: input.dispatch.runId,
      sandboxId: input.dispatch.sandboxId,
      schemaVersion: "agent-lane.process-status.v1",
      ...(input.dispatch.sessionId === undefined
        ? {}
        : { sessionId: input.dispatch.sessionId }),
      status: "not_found",
      workItemId: input.dispatch.workItemId,
    });
  }

  const status = await resolveProcessStatus(process);
  const sessionId = process.sessionId ?? input.dispatch.sessionId;

  return AgentLaneProcessStatusReceiptSchema.parse({
    checkedAt: new Date().toISOString(),
    ...(processEndTimeValue(process.endTime) === undefined
      ? {}
      : { endTime: processEndTimeValue(process.endTime) }),
    ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
    kind: input.dispatch.kind,
    laneId: input.dispatch.laneId,
    processId: input.dispatch.processId,
    runId: input.dispatch.runId,
    sandboxId: input.dispatch.sandboxId,
    schemaVersion: "agent-lane.process-status.v1",
    ...(sessionId === undefined ? {} : { sessionId }),
    status,
    workItemId: input.dispatch.workItemId,
  });
};

const cleanupCloudflareSandboxPiAgentLane = async (input: {
  readonly dispatch: AgentLaneDispatchReceipt;
  readonly env: CloudflareSandboxAgentLaneEnv;
}): Promise<void> => {
  await destroySandbox(
    getRealSandbox(input.env.Sandbox, input.dispatch.sandboxId),
    input.dispatch.sandboxId
  );
};

export const createCloudflareSandboxPiAgentLaneRuntime = (
  env: CloudflareSandboxAgentLaneEnv
): AgentLaneRuntimePort => ({
  cleanupLane(input) {
    return cleanupCloudflareSandboxPiAgentLane({
      dispatch: input.dispatch,
      env,
    });
  },
  dispatchLane(input) {
    return dispatchCloudflareSandboxPiAgentLane({ env, input });
  },
  async pollLane(input) {
    return await pollCloudflareSandboxPiAgentLane({
      dispatch: input.dispatch,
      env,
    });
  },
  async readLaneReceipt(input) {
    let receiptDocument: unknown;
    try {
      receiptDocument = await input.artifacts.readJson({
        artifactRef: input.dispatch.expectedReceiptArtifactRef,
      });
    } catch {
      return null;
    }

    return AgentLaneReceiptSchema.parse(receiptDocument);
  },
  runLane(input) {
    return runCloudflareSandboxPiAgentLane({ env, input });
  },
  runtime: "pi-agent-cli",
});
