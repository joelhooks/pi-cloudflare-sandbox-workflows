#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ActorSchema,
  DreamLiveRunRequestReceiptSchema,
  WorkflowLivePreflightReceiptSchema,
  WorkflowRunRequestSchema,
} from "../src/app/domain/schemas.ts";
import type {
  Actor,
  DreamLiveRunRequestReceipt,
  WorkflowLivePreflightReceipt,
  WorkflowRunRequest,
} from "../src/app/domain/schemas.ts";
import { dreamMemoryFabricPackageMetadata } from "../src/cartridges/dream-memory-fabric/package-seed.ts";
import { dreamTranscriptReviewSourceProfile } from "../src/cartridges/dream-memory-fabric/source-profile.ts";
import { runDreamPreflightCli } from "./workflow-app-dream-preflight.ts";

const defaultPreflightPath =
  ".wrangler/workflow-app/dream-preflight/latest-dream-preflight.json";
const defaultRunDir = ".wrangler/workflow-app/dream-runs";
const defaultWorkerUrl =
  "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";
const dreamRelaySignoffPhrase =
  "exposing JoelClaw/Typesense over a new network boundary";
const missingSubmitSignoffAction =
  "Provide the exact owner sign-off phrase before submitting a live Dream run that uses the trusted memory relay network boundary.";

const requiredPackageIds = [
  "badass-courses/claw-kernel",
  "joelhooks/configured-familiar-kernel",
  "workflow/dream-memory-fabric",
] as const;

const requiredRelayCheckIds = [
  "env:DREAM_MEMORY_RELAY_BASE_URL",
  "env:DREAM_MEMORY_RELAY_TOKEN",
  "wrangler:DREAM_MEMORY_RELAY_BASE_URL",
  "relay:healthz",
] as const;

const dreamWorkflowNodePalette = dreamMemoryFabricPackageMetadata.exports
  .filter((exportRecord) => exportRecord.kind === "workflow-node")
  .map((exportRecord) => exportRecord.nodeType)
  .filter((nodeType): nodeType is string => nodeType !== undefined);

const dreamSourcePackPlannerSummary =
  dreamTranscriptReviewSourceProfile.sourcePacks
    .map(
      (pack) =>
        `${pack.packId} (${pack.selectionPolicy}; families ${pack.sourceFamilies.join(", ")}; surfaces ${pack.surfaces.join(", ")}; capabilities ${pack.requiredCapabilityKinds.join(", ")})`
    )
    .join("; ");

interface DreamRunArgs {
  readonly approvalSignoff?: string;
  readonly localRelayProofPath?: string;
  readonly preflightPath: string;
  readonly refreshPreflight: boolean;
  readonly receiptPath?: string;
  readonly requestPath?: string;
  readonly responsePath?: string;
  readonly runId?: string;
  readonly submit: boolean;
  readonly workerUrl?: string;
}

interface PreflightLoadResult {
  readonly receipt?: WorkflowLivePreflightReceipt;
  readonly requiredActions: readonly string[];
  readonly status: "blocked" | "invalid" | "missing" | "ready";
}

export interface BuildDreamLiveRunRequestInput {
  readonly actor?: Actor;
  readonly runId: string;
  readonly sessionId?: string;
}

export interface BuildDreamLiveRunRequestReceiptInput {
  readonly checkedAt: string;
  readonly preflight: PreflightLoadResult;
  readonly preflightPath: string;
  readonly preflightRefreshed: boolean;
  readonly request: WorkflowRunRequest;
  readonly requestPath: string;
  readonly submitBlockers?: readonly string[];
  readonly responsePath?: string;
  readonly submitAttempted: boolean;
  readonly submitStatusCode?: number;
  readonly workerUrl: string;
}

export interface RunDreamLiveRunCliInput {
  readonly argv: readonly string[];
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
  readonly runPreflight?: DreamPreflightRunner;
}

type DreamPreflightRunner = (input: {
  readonly argv: readonly string[];
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}) => Promise<WorkflowLivePreflightReceipt>;

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const timestampSegment = (date: Date): string =>
  date.toISOString().replaceAll(/[-:.]/gu, "").replace("000Z", "Z");

const defaultRunId = (date: Date): string =>
  `run-live-dream-memory-fabric-${timestampSegment(date)}-${randomUUID().slice(0, 8)}`;

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
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
};

const parseArgs = (argv: readonly string[]): DreamRunArgs => {
  const approvalSignoff =
    argValue(argv, "--approval-signoff") ??
    argValue(argv, "--dream-relay-approval-signoff");
  const runId = argValue(argv, "--run-id");
  const requestPath = argValue(argv, "--request-path");
  const receiptPath = argValue(argv, "--receipt-path");
  const responsePath = argValue(argv, "--response-path");
  const workerUrl = argValue(argv, "--worker-url");
  const localRelayProofPath = argValue(argv, "--local-relay-proof-path");
  const submit = argv.includes("--submit");
  const refreshPreflight =
    argv.includes("--refresh-preflight") ||
    (submit && !argv.includes("--skip-preflight-refresh"));

  return {
    ...(approvalSignoff === undefined ? {} : { approvalSignoff }),
    ...(localRelayProofPath === undefined ? {} : { localRelayProofPath }),
    preflightPath: argValue(argv, "--preflight-path") ?? defaultPreflightPath,
    refreshPreflight,
    submit,
    ...(receiptPath === undefined ? {} : { receiptPath }),
    ...(requestPath === undefined ? {} : { requestPath }),
    ...(responsePath === undefined ? {} : { responsePath }),
    ...(runId === undefined ? {} : { runId }),
    ...(workerUrl === undefined ? {} : { workerUrl }),
  };
};

const readTextOrEmpty = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
};

const readPreflight = async (path: string): Promise<PreflightLoadResult> => {
  const text = await readTextOrEmpty(path);
  if (text.trim().length === 0) {
    return {
      requiredActions: [
        `Run pnpm app:dream:preflight before preparing a live Dream run request. Missing receipt: ${path}.`,
      ],
      status: "missing",
    };
  }

  try {
    const receipt = WorkflowLivePreflightReceiptSchema.parse(JSON.parse(text));

    return {
      receipt,
      requiredActions: receipt.requiredActions,
      status: receipt.status,
    };
  } catch {
    return {
      requiredActions: [
        `Repair the Dream live preflight receipt before preparing a live Dream run request: ${path}.`,
      ],
      status: "invalid",
    };
  }
};

const suppressPreflightLog = (message: string): void => {
  void message;
};

const preflightLoadResultForReceipt = (
  receipt: WorkflowLivePreflightReceipt
): PreflightLoadResult => ({
  receipt,
  requiredActions: receipt.requiredActions,
  status: receipt.status,
});

const normalizeWorkerUrl = (value: string): string =>
  value.replaceAll(/\/+$/gu, "");

const actorForDreamRun = (input: {
  readonly runId: string;
  readonly sessionId?: string;
}): Actor =>
  ActorSchema.parse({
    id: "actor:dream-live-operator",
    organizationId: "org:joelhooks",
    roleIds: ["workflow.operator", "wzrrd.publish"],
    sessionId: input.sessionId ?? `session:${input.runId}`,
    trustTier: "reviewed",
    type: "agent",
  });

export const buildDreamLiveRunRequest = (
  input: BuildDreamLiveRunRequestInput
): WorkflowRunRequest =>
  WorkflowRunRequestSchema.parse({
    actor:
      input.actor ??
      actorForDreamRun({
        runId: input.runId,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
      }),
    planProposal: {
      intent:
        "Run Dreaming as a real Cloudflare-generated dynamic workflow over the installed workflow/dream-memory-fabric cartridge. Inventory the memory fabric, check source and index health, plan recovery-only backfills, execute the recovery receipt node, mine redacted correction/friction/decision/workflow signals, search T-shaped across near-term and far-term memory, hydrate redacted receipts, correlate evidence, emit refinement proposals for kernel/package/workflow/schema/access-lease changes, render the canonical Dream HITL report, and publish the report through Wzrrd only after verifier acceptance.",
      requestedPackageIds: [...requiredPackageIds],
      stochasticNotes: [
        "Use only generated workflow.node.invoke states for Dream cartridge work; do not use static Dream branches in the runner.",
        `Use source profile ${dreamTranscriptReviewSourceProfile.profileId}: families ${dreamTranscriptReviewSourceProfile.sourceFamiliesExpected.join(", ")}; runtimes ${dreamTranscriptReviewSourceProfile.requiredRuntimes.join(", ")}; machines ${dreamTranscriptReviewSourceProfile.requiredMachineIds.join(", ")}; horizons ${dreamTranscriptReviewSourceProfile.timeHorizons.join(", ")}.`,
        `Dream cartridge node palette: ${dreamWorkflowNodePalette.join(", ")}. The planner may choose order, branching, loops, parallelism, and Think lanes when justified by the task, but verifier proof must show source inventory, source health, recovery-only backfill receipt, run/artifact capture receipts, signal mining, memory search, hydration, correlation, refinement proposals, and HITL report effects happened through generated workflow.node.invoke states.`,
        `Source packs advertised by the installed profile: ${dreamSourcePackPlannerSummary}. Optional-lease packs may be used only when actor scope and leases allow them. Separate-workflow packs must be saved or linked as candidates, not silently folded into transcript-review Dream readiness.`,
        "Generate a task-specific workflow.xstate-machine.v1 artifact and generated harness source before execution. Verifier proof must show Cloudflare executed the generated machine artifacts.",
        `Generated Dream retrieval and signal-mining steps must declare dreamCoverageHorizons covering: ${dreamTranscriptReviewSourceProfile.timeHorizons.join(", ")}.`,
        "Require native runtime coverage for Pi, Codex, Claude, and Cloudflare or state the missing/false-positive coverage explicitly in the report.",
        "Search across horizons: 24h, 7d, 30d, current quarter, and all-time. Do not collapse the dream into a recent-only summary.",
        'Use outputTarget {"kind":"wzrrd","reviewPath":"review/summary.json","primaryDocument":{"artifactPath":"dream/hitl-report.mdsvx","publishPath":"report.mdsvx","mediaType":"text/mdsvx","title":"This dream found work to do."}}.',
        "Public Wzrrd output must be noindex, redacted, and proof-below-dreams using docs/dream-report-canon.md.",
        "Cloudflare must access memory only through the trusted Dream relay. Do not request raw local paths, raw transcripts, raw credentials, or direct Typesense access.",
        "Accepted dreams should propose kernel/package/workflow/schema/access-lease refinements with reasoning, rating, recommendation, and receipt metadata.",
      ],
    },
    runId: input.runId,
    workItemId: "work-item:dream-memory-fabric",
  });

const missingReadyReasons = (
  preflight: PreflightLoadResult
): readonly string[] => {
  if (preflight.status !== "ready") {
    return preflight.requiredActions;
  }

  const checks = preflight.receipt?.checks ?? [];
  const failedRequiredRelayChecks = checks
    .filter(
      (check) =>
        requiredRelayCheckIds.includes(
          check.checkId as (typeof requiredRelayCheckIds)[number]
        ) &&
        check.required &&
        (check.status === "missing" || check.status === "failed")
    )
    .map((check) => `${check.checkId}: ${check.message ?? check.status}`);

  return failedRequiredRelayChecks;
};

const submitSignoffFor = (input: {
  readonly args: DreamRunArgs;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
}): string | undefined =>
  input.args.approvalSignoff ??
  input.processEnv["DREAM_MEMORY_RELAY_APPROVAL_SIGNOFF"] ??
  input.processEnv["DREAM_MEMORY_RELAY_PROVISIONING_SIGNOFF"];

const missingSubmitApprovalReasons = (input: {
  readonly args: DreamRunArgs;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
}): readonly string[] => {
  if (!input.args.submit) {
    return [];
  }

  return submitSignoffFor(input) === dreamRelaySignoffPhrase
    ? []
    : [missingSubmitSignoffAction];
};

export const buildDreamLiveRunRequestReceipt = (
  input: BuildDreamLiveRunRequestReceiptInput
): DreamLiveRunRequestReceipt => {
  const blockedReasons = [
    ...missingReadyReasons(input.preflight),
    ...(input.submitBlockers ?? []),
  ];
  let status: DreamLiveRunRequestReceipt["status"] = "prepared";
  if (blockedReasons.length > 0) {
    status = "blocked";
  } else if (input.submitAttempted) {
    status =
      input.submitStatusCode !== undefined &&
      input.submitStatusCode >= 200 &&
      input.submitStatusCode < 300
        ? "submitted"
        : "failed";
  }

  return DreamLiveRunRequestReceiptSchema.parse({
    blockedReasons,
    checkedAt: input.checkedAt,
    preflight: {
      ...(input.preflight.receipt?.generatedAt === undefined
        ? {}
        : { generatedAt: input.preflight.receipt.generatedAt }),
      path: input.preflightPath,
      refreshed: input.preflightRefreshed,
      requiredActions: input.preflight.requiredActions,
      status: input.preflight.status,
    },
    redacted: true,
    ...(input.preflight.receipt?.relayCapability === undefined
      ? {}
      : { relayCapability: input.preflight.receipt.relayCapability }),
    request: input.request,
    requestPath: input.requestPath,
    ...(input.responsePath === undefined
      ? {}
      : { responsePath: input.responsePath }),
    runId: input.request.runId,
    schemaVersion: "workflow.dream-live-run-request.v1",
    status,
    submit: {
      attempted: input.submitAttempted,
      ...(input.submitStatusCode === undefined
        ? {}
        : { statusCode: input.submitStatusCode }),
      ...(input.submitAttempted ? { url: `${input.workerUrl}/runs` } : {}),
    },
    workerUrl: input.workerUrl,
  });
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const responseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {
      redacted: true,
      status: response.status,
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      redacted: true,
      status: response.status,
      text,
    };
  }
};

const submitLiveDreamRunIfAllowed = async (input: {
  readonly args: DreamRunArgs;
  readonly fetch?: typeof fetch;
  readonly preflight: PreflightLoadResult;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly request: WorkflowRunRequest;
  readonly responsePath: string;
  readonly workerUrl: string;
}): Promise<{
  readonly attempted: boolean;
  readonly submitBlockers: readonly string[];
  readonly submitStatusCode?: number;
}> => {
  const submitBlockers = missingSubmitApprovalReasons({
    args: input.args,
    processEnv: input.processEnv,
  });
  const canSubmit =
    input.args.submit &&
    input.preflight.status === "ready" &&
    submitBlockers.length === 0;
  if (!canSubmit) {
    return {
      attempted: false,
      submitBlockers,
    };
  }

  const response = await (input.fetch ?? fetch)(`${input.workerUrl}/runs`, {
    body: JSON.stringify(input.request),
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });
  await writeJson(input.responsePath, await responseBody(response));

  return {
    attempted: true,
    submitBlockers,
    submitStatusCode: response.status,
  };
};

export const runDreamLiveRunCli = async (
  input: RunDreamLiveRunCliInput
): Promise<DreamLiveRunRequestReceipt> => {
  const now = new Date();
  const args = parseArgs(input.argv);
  const runId = args.runId ?? defaultRunId(now);
  const preflightPath = resolve(input.repoRoot, args.preflightPath);
  const preflight = args.refreshPreflight
    ? preflightLoadResultForReceipt(
        await (input.runPreflight ?? runDreamPreflightCli)({
          argv: [
            "--allow-missing",
            `--receipt-path=${args.preflightPath}`,
            ...(args.workerUrl === undefined
              ? []
              : [`--worker-url=${args.workerUrl}`]),
            ...(args.localRelayProofPath === undefined
              ? []
              : [`--local-relay-proof-path=${args.localRelayProofPath}`]),
          ],
          ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          log: suppressPreflightLog,
          processEnv: input.processEnv,
          repoRoot: input.repoRoot,
        })
      )
    : await readPreflight(preflightPath);
  const workerUrl = normalizeWorkerUrl(
    args.workerUrl ??
      preflight.receipt?.workerUrl ??
      input.processEnv["WORKFLOW_APP_URL"] ??
      defaultWorkerUrl
  );
  const request = buildDreamLiveRunRequest({ runId });
  const relativeRequestPath =
    args.requestPath ?? `${defaultRunDir}/${runId}-request.json`;
  const relativeReceiptPath =
    args.receiptPath ?? `${defaultRunDir}/${runId}-receipt.json`;
  const relativeResponsePath =
    args.responsePath ?? `${defaultRunDir}/${runId}-response.json`;
  const requestPath = resolve(input.repoRoot, relativeRequestPath);
  const receiptPath = resolve(input.repoRoot, relativeReceiptPath);
  const responsePath = resolve(input.repoRoot, relativeResponsePath);

  await writeJson(requestPath, request);

  const submitResult = await submitLiveDreamRunIfAllowed({
    args,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    preflight,
    processEnv: input.processEnv,
    request,
    responsePath,
    workerUrl,
  });

  const receipt = buildDreamLiveRunRequestReceipt({
    checkedAt: now.toISOString(),
    preflight,
    preflightPath: args.preflightPath,
    preflightRefreshed: args.refreshPreflight,
    request,
    requestPath: relativeRequestPath,
    ...(submitResult.attempted ? { responsePath: relativeResponsePath } : {}),
    submitAttempted: submitResult.attempted,
    submitBlockers: submitResult.submitBlockers,
    ...(submitResult.submitStatusCode === undefined
      ? {}
      : { submitStatusCode: submitResult.submitStatusCode }),
    workerUrl,
  });
  await writeJson(receiptPath, receipt);
  const log = input.log ?? console.log;
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receiptPath}`);

  return receipt;
};

if (isMain()) {
  await runDreamLiveRunCli({
    argv: process.argv.slice(2),
    processEnv: process.env,
    repoRoot: resolve(import.meta.dirname, ".."),
  });
}
