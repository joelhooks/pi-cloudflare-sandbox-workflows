#!/usr/bin/env tsx

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

const defaultReceiptRoot = ".wrangler/workflow-app/seam-ladder";

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const argValue = (
  argv: readonly string[],
  name: string
): string | undefined => {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);

  return index === -1 ? undefined : argv[index + 1];
};

const slugTimestamp = (date: Date): string =>
  date.toISOString().replaceAll(/[-:.]/gu, "").replace("000Z", "Z");

const defaultRunId = (date: Date): string =>
  `seam-ladder-${slugTimestamp(date)}-${randomUUID().slice(0, 8)}`;

export const workflowSeamLadderIntegrationTestFiles = [
  "tests/integration/workflow-carrier-composition.acceptance.test.ts",
  "tests/integration/cloudflare-workflow-status-projection.test.ts",
  "tests/integration/cloudflare-workflow-event-stream.test.ts",
  "tests/integration/cloudflare-worker-route.test.ts",
  "tests/integration/cloudflare-workflow-front-door.test.ts",
  "tests/integration/cloudflare-run-async-driver.test.ts",
  "tests/integration/cloudflare-run-checkpoint.test.ts",
  "tests/integration/cloudflare-run-reaper.test.ts",
  "tests/integration/cloudflare-workflow-monitor-reads.test.ts",
  "tests/integration/cloudflare-artifacts-store.test.ts",
  "tests/integration/cloudflare-artifacts-store-clone.test.ts",
  "tests/integration/cloudflare-agent-lane-adapters.test.ts",
  "tests/integration/cloudflare-sandbox-agent-lanes.test.ts",
  "tests/integration/sandbox-command-encoding.test.ts",
  "tests/integration/admitted-agent-lane-runtime.test.ts",
  "tests/integration/cloudflare-capability-lease-broker.test.ts",
  "tests/integration/dream-live-preflight.test.ts",
  "tests/integration/dream-live-run-request.test.ts",
  "tests/integration/dream-memory-fabric-node-config-validate.test.ts",
  "tests/integration/memory-fabric-workflow-node-adapter.test.ts",
  "tests/integration/dream-memory-fabric-contract.test.ts",
  "tests/integration/trusted-local-dream-memory-fabric.test.ts",
  "tests/integration/trusted-local-dream-memory-relay-http.test.ts",
  "tests/integration/trusted-dream-memory-relay-server.test.ts",
  "tests/integration/dream-agentic-refinement-node.test.ts",
  "tests/integration/dream-readiness-report.test.ts",
  "tests/integration/cloudflare-wzrrd-publish-adapter.test.ts",
  "tests/integration/cloudflare-workflow-telemetry-sinks.test.ts",
] as const;

export const workflowSeamLadderCommandSpecs = [
  {
    args: ["test:carrier"],
    commandId: "carrier",
    summary:
      "Named carrier gate for D1/status/event projection plus Durable Object park/alarm/checkpoint/reaper behavior.",
  },
  {
    args: ["exec", "vitest", "run", ...workflowSeamLadderIntegrationTestFiles],
    commandId: "focused-integration",
    summary:
      "Focused Node integration suite covering D1/status/event, DO lifecycle, artifacts, lanes, leases, planner contracts, retrieval, reports, and verifier seams.",
  },
  {
    args: ["test:cloudflare-msw"],
    commandId: "cloudflare-msw",
    summary:
      "Cloudflare workerd/MSW canary for outbound Worker-runtime HTTP telemetry.",
  },
] as const;

export type WorkflowSeamLadderCommandId =
  (typeof workflowSeamLadderCommandSpecs)[number]["commandId"];

export interface WorkflowSeamLadderGate {
  readonly commandIds: readonly WorkflowSeamLadderCommandId[];
  readonly evidence: readonly string[];
  readonly failureClass:
    | "carrier"
    | "data-source"
    | "planner-contract"
    | "render-verifier";
  readonly gateId: string;
  readonly ladderLevel: number;
  readonly nonClaims: readonly string[];
  readonly title: string;
}

export const workflowSeamLadderGates = [
  {
    commandIds: ["carrier"],
    evidence: [
      "tests/integration/workflow-carrier-composition.acceptance.test.ts",
      "tests/integration/cloudflare-workflow-status-projection.test.ts",
      "tests/integration/cloudflare-workflow-event-stream.test.ts",
      "tests/integration/cloudflare-worker-route.test.ts",
      "tests/integration/cloudflare-workflow-front-door.test.ts",
    ],
    failureClass: "carrier",
    gateId: "seam-01-d1-state",
    ladderLevel: 1,
    nonClaims: [
      "Does not require a planner, sandbox lane, Wzrrd publish, or Dreamer live submit.",
    ],
    title: "D1 run state and event projection",
  },
  {
    commandIds: ["carrier"],
    evidence: [
      "tests/integration/workflow-carrier-composition.acceptance.test.ts",
      "tests/integration/cloudflare-run-async-driver.test.ts",
      "tests/integration/cloudflare-run-checkpoint.test.ts",
      "tests/integration/cloudflare-run-reaper.test.ts",
      "tests/integration/cloudflare-workflow-monitor-reads.test.ts",
    ],
    failureClass: "carrier",
    gateId: "seam-02-do-lifecycle",
    ladderLevel: 2,
    nonClaims: [
      "Does not prove stochastic planner output or real external side effects.",
    ],
    title: "Durable Object drive lifecycle",
  },
  {
    commandIds: ["focused-integration"],
    evidence: [
      "tests/integration/cloudflare-artifacts-store.test.ts",
      "tests/integration/cloudflare-artifacts-store-clone.test.ts",
      "tests/integration/cloudflare-agent-lane-adapters.test.ts",
    ],
    failureClass: "carrier",
    gateId: "seam-03-artifacts",
    ladderLevel: 3,
    nonClaims: ["Does not publish public reports."],
    title: "Git-backed Artifacts",
  },
  {
    commandIds: ["focused-integration"],
    evidence: [
      "tests/integration/cloudflare-sandbox-agent-lanes.test.ts",
      "tests/integration/sandbox-command-encoding.test.ts",
      "tests/integration/admitted-agent-lane-runtime.test.ts",
    ],
    failureClass: "carrier",
    gateId: "seam-04-sandbox-lanes",
    ladderLevel: 4,
    nonClaims: ["Does not require Cloudflare memory relay credentials."],
    title: "Agent lane command/runtime",
  },
  {
    commandIds: ["focused-integration"],
    evidence: [
      "tests/integration/cloudflare-capability-lease-broker.test.ts",
      "tests/integration/cloudflare-agent-lane-adapters.test.ts",
    ],
    failureClass: "carrier",
    gateId: "seam-05-capability-leases",
    ladderLevel: 5,
    nonClaims: ["Does not expose raw secrets or require live approval leases."],
    title: "Capability leases",
  },
  {
    commandIds: ["focused-integration"],
    evidence: [
      "tests/integration/dream-live-run-request.test.ts",
      "tests/integration/dream-memory-fabric-node-config-validate.test.ts",
      "tests/integration/memory-fabric-workflow-node-adapter.test.ts",
    ],
    failureClass: "planner-contract",
    gateId: "seam-06-planner-generated-machine",
    ladderLevel: 6,
    nonClaims: ["Does not live-submit to Cloudflare without relay sign-off."],
    title: "Planner plus generated machine",
  },
  {
    commandIds: ["focused-integration"],
    evidence: [
      "tests/integration/dream-memory-fabric-contract.test.ts",
      "tests/integration/trusted-local-dream-memory-fabric.test.ts",
      "tests/integration/trusted-local-dream-memory-relay-http.test.ts",
      "tests/integration/trusted-dream-memory-relay-server.test.ts",
    ],
    failureClass: "data-source",
    gateId: "seam-07-transcript-retrieval",
    ladderLevel: 7,
    nonClaims: [
      "Local relay proof does not mean the Worker-facing relay endpoint is provisioned.",
    ],
    title: "Transcript retrieval",
  },
  {
    commandIds: ["focused-integration"],
    evidence: [
      "tests/integration/dream-agentic-refinement-node.test.ts",
      "tests/integration/dream-readiness-report.test.ts",
      "tests/integration/cloudflare-wzrrd-publish-adapter.test.ts",
    ],
    failureClass: "render-verifier",
    gateId: "seam-08-report-verifier",
    ladderLevel: 8,
    nonClaims: [
      "Does not prove a public Wzrrd publish unless publish is requested.",
    ],
    title: "Report plus verifier",
  },
  {
    commandIds: ["cloudflare-msw", "focused-integration"],
    evidence: [
      "tests/integration/cloudflare-workflow-telemetry-sinks.test.ts",
      "tests/cloudflare-msw/external-telemetry-msw.cf.ts",
    ],
    failureClass: "carrier",
    gateId: "canary-cloudflare-msw-telemetry",
    ladderLevel: 9,
    nonClaims: [
      "@msw/cloudflare proves outbound Worker fetch interception only; it is not a D1/DO/Sandbox binding emulator.",
    ],
    title: "Cloudflare MSW outbound HTTP canary",
  },
] as const satisfies readonly WorkflowSeamLadderGate[];

const CommandReceiptSchema = z.object({
  command: z.array(z.string().min(1)),
  commandId: z.string().min(1),
  durationMs: z.number().int().min(0),
  exitCode: z.number().int(),
  stderrTail: z.string(),
  stdoutTail: z.string(),
});

export type WorkflowSeamLadderCommandReceipt = z.infer<
  typeof CommandReceiptSchema
>;

const ReceiptSchema = z.object({
  commands: z.array(CommandReceiptSchema),
  gateCount: z.number().int().min(1),
  gates: z.array(
    z.object({
      commandIds: z.array(z.string().min(1)),
      evidence: z.array(z.string().min(1)),
      failureClass: z.string().min(1),
      gateId: z.string().min(1),
      nonClaims: z.array(z.string().min(1)),
      status: z.enum(["blocked", "captured"]),
      title: z.string().min(1),
    })
  ),
  generatedAt: z.string().min(1),
  gitCommit: z.string().min(1),
  manifestHash: z.string().length(64),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.seam-ladder.acceptance.v1"),
  status: z.enum(["blocked", "captured"]),
});

export type WorkflowSeamLadderReceipt = z.infer<typeof ReceiptSchema>;

const tail = (value: string, maxLength = 6000): string =>
  value.length <= maxLength ? value : value.slice(-maxLength);

const manifestHash = (): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        commands: workflowSeamLadderCommandSpecs,
        gates: workflowSeamLadderGates,
      })
    )
    .digest("hex");

const runCommand = async (input: {
  readonly args: readonly string[];
  readonly commandId: string;
  readonly cwd: string;
}): Promise<WorkflowSeamLadderCommandReceipt> => {
  const start = Date.now();

  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is callback/event based; this wrapper captures streaming output and exit status for the receipt.
  return await new Promise((resolve) => {
    const child = spawn("pnpm", input.args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
      process.stderr.write(chunk);
    });
    child.on("close", (exitCode) => {
      resolve(
        CommandReceiptSchema.parse({
          command: ["pnpm", ...input.args],
          commandId: input.commandId,
          durationMs: Date.now() - start,
          exitCode: exitCode ?? 1,
          stderrTail: tail(stderr),
          stdoutTail: tail(stdout),
        })
      );
    });
  });
};

const gitCommit = async (cwd: string): Promise<string> => {
  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is callback/event based and avoids shelling through pnpm.
  const result = await new Promise<{
    readonly exitCode: number;
    readonly stdout: string;
  }>((resolve) => {
    const child = spawn("git", ["rev-parse", "--short", "HEAD"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.on("close", (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout,
      });
    });
  });

  return result.exitCode === 0 ? result.stdout.trim() : "unknown";
};

export const buildWorkflowSeamLadderReceipt = (input: {
  readonly commands: readonly WorkflowSeamLadderCommandReceipt[];
  readonly generatedAt: string;
  readonly gitCommit: string;
  readonly runId: string;
}): WorkflowSeamLadderReceipt => {
  const commandStatus = new Map(
    input.commands.map((command) => [command.commandId, command.exitCode])
  );
  const gates = workflowSeamLadderGates.map((gate) => {
    const passed = gate.commandIds.every(
      (commandId) => commandStatus.get(commandId) === 0
    );

    return {
      commandIds: [...gate.commandIds],
      evidence: [...gate.evidence],
      failureClass: gate.failureClass,
      gateId: gate.gateId,
      nonClaims: [...gate.nonClaims],
      status: passed ? "captured" : "blocked",
      title: gate.title,
    } as const;
  });
  const status = gates.every((gate) => gate.status === "captured")
    ? "captured"
    : "blocked";

  return ReceiptSchema.parse({
    commands: input.commands,
    gateCount: gates.length,
    gates,
    generatedAt: input.generatedAt,
    gitCommit: input.gitCommit,
    manifestHash: manifestHash(),
    redacted: true,
    runId: input.runId,
    schemaVersion: "workflow.seam-ladder.acceptance.v1",
    status,
  });
};

const receiptPathFor = (input: {
  readonly argv: readonly string[];
  readonly repoRoot: string;
  readonly runId: string;
}): string =>
  resolvePath(
    input.repoRoot,
    argValue(input.argv, "--receipt-path") ??
      `${defaultReceiptRoot}/${input.runId}/receipt.json`
  );

export const runWorkflowSeamLadderGateCli = async (input: {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly repoRoot: string;
}): Promise<WorkflowSeamLadderReceipt> => {
  const generatedAt = new Date();
  const runId = argValue(input.argv, "--run-id") ?? defaultRunId(generatedAt);
  const skipTests = input.argv.includes("--skip-tests");
  const selectedCommands = skipTests ? [] : workflowSeamLadderCommandSpecs;
  const commands: WorkflowSeamLadderCommandReceipt[] = [];
  const log = input.log ?? console.log;

  for (const command of selectedCommands) {
    log(`running ${command.commandId}: pnpm ${command.args.join(" ")}`);
    commands.push(
      await runCommand({
        args: command.args,
        commandId: command.commandId,
        cwd: input.repoRoot,
      })
    );
  }

  const receipt = buildWorkflowSeamLadderReceipt({
    commands,
    generatedAt: generatedAt.toISOString(),
    gitCommit: await gitCommit(input.repoRoot),
    runId,
  });
  const receiptPath = receiptPathFor({
    argv: input.argv,
    repoRoot: input.repoRoot,
    runId,
  });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(
    receiptPath,
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf-8"
  );
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receiptPath}`);

  if (receipt.status !== "captured") {
    process.exitCode = 1;
  }

  return receipt;
};

if (isMain()) {
  try {
    await runWorkflowSeamLadderGateCli({
      argv: process.argv.slice(2),
      repoRoot: resolvePath(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Workflow seam ladder gate failed."
    );
    process.exitCode = 1;
  }
}
