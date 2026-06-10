#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ActorSchema,
  WorkflowLiveRunRequestReceiptSchema,
  WorkflowLivePreflightReceiptSchema,
  WorkflowRunRequestSchema,
} from "../src/app/domain/schemas.ts";
import type {
  Actor,
  WorkflowLiveRunRequestReceipt,
  WorkflowLivePreflightReceipt,
  WorkflowRunRequest,
} from "../src/app/domain/schemas.ts";
import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";
import { runWorkflowPreflightCli } from "./workflow-app-preflight.ts";
import {
  requireInstalledSourceProfile,
  workflowProfileWorkspacePaths,
} from "./workflow-app-profile.ts";

const defaultWorkerUrl =
  "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";
const memoryRelaySignoffPhrase =
  "exposing JoelClaw/Typesense over a new network boundary";
const missingSubmitSignoffAction =
  "Provide the exact owner sign-off phrase before submitting a live workflow run that uses the trusted memory relay network boundary.";

const requiredRelayCheckIds = [
  "env:MEMORY_RELAY_BASE_URL",
  "env:MEMORY_RELAY_TOKEN",
  "wrangler:MEMORY_RELAY_BASE_URL",
  "relay:healthz",
] as const;

interface WorkflowRunArgs {
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

export interface BuildWorkflowLiveRunRequestInput {
  readonly actor?: Actor;
  readonly profile: MemorySourceProfile;
  readonly runId: string;
  readonly sessionId?: string;
}

export interface BuildWorkflowLiveRunRequestReceiptInput {
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

export interface RunWorkflowLiveRunCliInput {
  readonly argv: readonly string[];
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
  readonly runPreflight?: WorkflowPreflightRunner;
}

type WorkflowPreflightRunner = (input: {
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
  `run-live-${timestampSegment(date)}-${randomUUID().slice(0, 8)}`;

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

const parseArgs = (
  argv: readonly string[],
  profile: MemorySourceProfile
): WorkflowRunArgs => {
  const approvalSignoff = argValue(argv, "--approval-signoff");
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
    preflightPath:
      argValue(argv, "--preflight-path") ??
      workflowProfileWorkspacePaths(profile.profileId).preflightReceiptPath,
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

const readPreflight = async (input: {
  readonly path: string;
  readonly profileId: string;
}): Promise<PreflightLoadResult> => {
  const text = await readTextOrEmpty(input.path);
  if (text.trim().length === 0) {
    return {
      requiredActions: [
        `Run pnpm app:preflight --profile ${input.profileId} before preparing a live workflow run request. Missing receipt: ${input.path}.`,
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
        `Repair the live preflight receipt before preparing a live workflow run request: ${input.path}.`,
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

const actorForLiveRun = (input: {
  readonly runId: string;
  readonly sessionId?: string;
}): Actor =>
  ActorSchema.parse({
    id: "actor:workflow-live-operator",
    organizationId: "org:joelhooks",
    roleIds: ["workflow.operator", "wzrrd.publish"],
    sessionId: input.sessionId ?? `session:${input.runId}`,
    trustTier: "reviewed",
    type: "agent",
  });

const sourcePackPlannerSummaryFor = (profile: MemorySourceProfile): string =>
  profile.sourcePacks
    .map(
      (pack) =>
        `${pack.packId} (${pack.selectionPolicy}; families ${pack.sourceFamilies.join(", ")}; surfaces ${pack.surfaces.join(", ")}; capabilities ${pack.requiredCapabilityKinds.join(", ")})`
    )
    .join("; ");

const profileStochasticNotesFor = (
  profile: MemorySourceProfile
): readonly string[] => {
  const horizons = profile.timeHorizons.join(", ");
  const sourcePackNotes =
    profile.sourcePacks.length === 0
      ? []
      : [
          `Source packs advertised by the installed profile: ${sourcePackPlannerSummaryFor(profile)}. Optional-lease packs may be used only when actor scope and leases allow them. Separate-workflow packs must be saved or linked as candidates, not silently folded into this profile's readiness.`,
          "Generated planning steps must declare memorySourcePackDispositions for every advertised source pack with requiredCapabilityKinds, capabilityKinds, missingCapabilityKinds, and leaseRefs. Optional-lease packs are selected-with-lease only when scoped leases cover their requiredCapabilityKinds and leaseRefs are present; otherwise they must be skipped-missing-lease with explicit missingCapabilityKinds. Separate-workflow packs are separate-workflow-candidate and must not clear this profile's readiness.",
        ];

  return [
    `Use source profile ${profile.profileId}: families ${profile.sourceFamiliesExpected.join(", ")}; runtimes ${profile.requiredRuntimes.join(", ")}; horizons ${horizons}.`,
    ...sourcePackNotes,
    "Generate a task-specific workflow.xstate-machine.v1 artifact and generated harness source before execution. Verifier proof must show Cloudflare executed the generated machine artifacts.",
    `Generated retrieval and signal-mining steps must declare memoryCoverageHorizons covering: ${horizons}.`,
    "Report runtime, machine, and source-family coverage gaps as explicit caveats in the run report; coverage caveats never block the run. Memory-fabric repair is a separate workflow.",
    `Search across horizons: ${horizons}. Do not collapse the run into a recent-only summary.`,
    "Cloudflare must access memory only through the trusted Memory relay. Do not request raw local paths, raw transcripts, raw credentials, or direct Typesense access.",
    ...(profile.plannerGuidance?.stochasticNotes ?? []),
  ];
};

export const buildWorkflowLiveRunRequest = (
  input: BuildWorkflowLiveRunRequestInput
): WorkflowRunRequest => {
  const { profile } = input;
  const guidance = profile.plannerGuidance;
  const requestedPackageIds = [
    ...new Set([...(guidance?.requestedPackageIds ?? []), profile.packageId]),
  ];

  return WorkflowRunRequestSchema.parse({
    actor:
      input.actor ??
      actorForLiveRun({
        runId: input.runId,
        ...(input.sessionId === undefined
          ? {}
          : { sessionId: input.sessionId }),
      }),
    planProposal: {
      intent: guidance?.intent ?? profile.purpose,
      requestedPackageIds,
      stochasticNotes: [...profileStochasticNotesFor(profile)],
    },
    runId: input.runId,
    workItemId: guidance?.workItemId ?? `work-item:${profile.profileId}`,
  });
};

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
  readonly args: WorkflowRunArgs;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
}): string | undefined =>
  input.args.approvalSignoff ??
  input.processEnv["MEMORY_RELAY_APPROVAL_SIGNOFF"] ??
  input.processEnv["MEMORY_RELAY_PROVISIONING_SIGNOFF"];

const missingSubmitApprovalReasons = (input: {
  readonly args: WorkflowRunArgs;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
}): readonly string[] => {
  if (!input.args.submit) {
    return [];
  }

  return submitSignoffFor(input) === memoryRelaySignoffPhrase
    ? []
    : [missingSubmitSignoffAction];
};

export const buildWorkflowLiveRunRequestReceipt = (
  input: BuildWorkflowLiveRunRequestReceiptInput
): WorkflowLiveRunRequestReceipt => {
  const blockedReasons = [
    ...missingReadyReasons(input.preflight),
    ...(input.submitBlockers ?? []),
  ];
  let status: WorkflowLiveRunRequestReceipt["status"] = "prepared";
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

  return WorkflowLiveRunRequestReceiptSchema.parse({
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
    schemaVersion: "workflow.live-run-request.v1",
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

const submitLiveRunIfAllowed = async (input: {
  readonly args: WorkflowRunArgs;
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

export const runWorkflowLiveRunCli = async (
  input: RunWorkflowLiveRunCliInput
): Promise<WorkflowLiveRunRequestReceipt> => {
  const now = new Date();
  const profile = requireInstalledSourceProfile(input.argv, {
    env: input.processEnv,
    repoRoot: input.repoRoot,
  });
  const args = parseArgs(input.argv, profile);
  const runId = args.runId ?? defaultRunId(now);
  const preflightPath = resolve(input.repoRoot, args.preflightPath);
  const preflight = args.refreshPreflight
    ? preflightLoadResultForReceipt(
        await (input.runPreflight ?? runWorkflowPreflightCli)({
          argv: [
            "--profile",
            profile.profileId,
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
    : await readPreflight({
        path: preflightPath,
        profileId: profile.profileId,
      });
  const workerUrl = normalizeWorkerUrl(
    args.workerUrl ??
      preflight.receipt?.workerUrl ??
      input.processEnv["WORKFLOW_APP_URL"] ??
      defaultWorkerUrl
  );
  const request = buildWorkflowLiveRunRequest({ profile, runId });
  const runDir = workflowProfileWorkspacePaths(profile.profileId).runReceiptDir;
  const relativeRequestPath =
    args.requestPath ?? `${runDir}/${runId}-request.json`;
  const relativeReceiptPath =
    args.receiptPath ?? `${runDir}/${runId}-receipt.json`;
  const relativeResponsePath =
    args.responsePath ?? `${runDir}/${runId}-response.json`;
  const requestPath = resolve(input.repoRoot, relativeRequestPath);
  const receiptPath = resolve(input.repoRoot, relativeReceiptPath);
  const responsePath = resolve(input.repoRoot, relativeResponsePath);

  await writeJson(requestPath, request);

  const submitResult = await submitLiveRunIfAllowed({
    args,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    preflight,
    processEnv: input.processEnv,
    request,
    responsePath,
    workerUrl,
  });

  const receipt = buildWorkflowLiveRunRequestReceipt({
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
  try {
    await runWorkflowLiveRunCli({
      argv: process.argv.slice(2),
      processEnv: process.env,
      repoRoot: resolve(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Workflow live run request failed."
    );
    process.exitCode = 1;
  }
}
