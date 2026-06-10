#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { dreamTranscriptReviewSourceProfile } from "../src/cartridges/dream-memory-fabric/source-profile.ts";

const defaultLivePreflightPath =
  ".wrangler/workflow-app/dream-preflight/latest-dream-preflight.json";
const defaultLocalRelayProofPath =
  ".wrangler/workflow-app/dream-relay/latest-local-proof.json";
const defaultReceiptPath =
  ".wrangler/workflow-app/dream-relay/latest-provisioning-preflight.json";
const signoffPhrase = "exposing JoelClaw/Typesense over a new network boundary";
const exactSignoffAction =
  "Get explicit owner sign-off for exposing the trusted Dream relay over a new network boundary.";
const invalidSignoffAction =
  "Recorded relay exposure sign-off did not match the required phrase; provide the exact sign-off phrase before provisioning.";

const RelayReceiptFamilyCountSchema = z.object({
  family: z.string().min(1),
  receiptCount: z.number().int().min(0),
});

const { requiredMachineIds } = dreamTranscriptReviewSourceProfile;
const requiredSourceFamilies =
  dreamTranscriptReviewSourceProfile.sourceFamiliesExpected;

const MachineCoverageSchema = z.object({
  authorityCount: z.number().int().min(0),
  machineId: z.string().min(1),
  missingReason: z.string().min(1).optional(),
  sourceCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const SourceFamilyCoverageSchema = z.object({
  authorityCount: z.number().int().min(0),
  family: z.string().min(1),
  missingReason: z.string().min(1).optional(),
  sourceCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalRelayProofSchema = z.object({
  backfillRun: z.object({
    blockedCount: z.number().int().min(0),
    completedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
  }),
  correlation: z.object({
    edgeCount: z.number().int().min(1),
    nodeCount: z.number().int().min(1),
  }),
  inventory: z.object({
    machineCoverage: z.array(MachineCoverageSchema),
    sourceFamilyCoverage: z.array(SourceFamilyCoverageSchema).default([]),
  }),
  rawCredentialsReturned: z.literal(false),
  rawPathLeaked: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("trusted.dream-memory-relay.local-proof.v1"),
  search: z.object({
    hitCount: z.number().int().min(1),
    hydratedCount: z.number().int().min(1),
    hydratedFamilyCounts: z.array(RelayReceiptFamilyCountSchema).default([]),
  }),
  sourceRootCount: z.number().int().min(1),
});

const LivePreflightSchema = z.object({
  checks: z.array(
    z.object({
      checkId: z.string().min(1),
      message: z.string().min(1).optional(),
      status: z.string().min(1),
    })
  ),
  generatedAt: z.string().min(1),
  redacted: z.literal(true),
  requiredActions: z.array(z.string().min(1)).default([]),
  schemaVersion: z.literal("workflow.live-preflight.v1"),
  status: z.enum(["blocked", "ready"]),
});

export const DreamRelayProvisioningPreflightReceiptSchema = z.object({
  approval: z.object({
    approvalRef: z.string().min(1).optional(),
    required: z.literal(true),
    signoffPhrase: z.literal(signoffPhrase),
    signoffProvided: z.boolean(),
    status: z.enum(["approved", "invalid", "required"]),
  }),
  checkedAt: z.string().min(1),
  livePreflight: z.object({
    missingCheckIds: z.array(z.string().min(1)),
    path: z.string().min(1),
    relayHealthzStatus: z.string().min(1).optional(),
    relayLocalProofStatus: z.string().min(1).optional(),
    status: z.enum(["blocked", "failed", "missing", "ready"]),
  }),
  localRelayProof: z.object({
    backfillRunBlockedCount: z.number().int().min(0).optional(),
    backfillRunCompletedCount: z.number().int().min(0).optional(),
    backfillRunFailedCount: z.number().int().min(0).optional(),
    backfillRunSkippedCount: z.number().int().min(0).optional(),
    correlationEdgeCount: z.number().int().min(0).optional(),
    correlationNodeCount: z.number().int().min(0).optional(),
    hydratedCount: z.number().int().min(0).optional(),
    hydratedFamilyCounts: z.array(RelayReceiptFamilyCountSchema).optional(),
    machineCoverage: z.array(MachineCoverageSchema).optional(),
    missingMachineIds: z.array(z.string().min(1)).optional(),
    missingSourceFamilies: z.array(z.string().min(1)).optional(),
    path: z.string().min(1),
    rawCredentialsReturned: z.literal(false).optional(),
    rawPathLeaked: z.literal(false).optional(),
    rawPathsReturned: z.literal(false).optional(),
    runId: z.string().min(1).optional(),
    searchHitCount: z.number().int().min(0).optional(),
    sourceRootCount: z.number().int().min(0).optional(),
    status: z.enum(["failed", "missing", "passed"]),
  }),
  networkTools: z.array(
    z.object({
      available: z.boolean(),
      command: z.string().min(1),
      path: z.string().min(1).optional(),
    })
  ),
  recommendedNextActions: z.array(z.string().min(1)),
  redacted: z.literal(true),
  schemaVersion: z.literal(
    "trusted.dream-memory-relay.provisioning-preflight.v1"
  ),
  status: z.enum(["blocked", "ready-for-approved-provisioning"]),
});

export type DreamRelayProvisioningPreflightReceipt = z.infer<
  typeof DreamRelayProvisioningPreflightReceiptSchema
>;

interface ProvisioningPreflightArgs {
  readonly approvalRef?: string;
  readonly approvalSignoff?: string;
  readonly livePreflightPath: string;
  readonly localRelayProofPath: string;
  readonly receiptPath: string;
}

export interface CommandProbe {
  readonly available: boolean;
  readonly command: string;
  readonly path?: string;
}

export interface BuildDreamRelayProvisioningPreflightInput {
  readonly approvalRef?: string;
  readonly approvalSignoff?: string;
  readonly checkedAt: string;
  readonly livePreflightPath: string;
  readonly livePreflightText: string;
  readonly localRelayProofPath: string;
  readonly localRelayProofText: string;
  readonly networkTools: readonly CommandProbe[];
  readonly visionText: string;
}

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
  if (index !== -1) {
    return argv[index + 1];
  }

  return undefined;
};

const missingMachineIdsFor = (
  machineCoverage: readonly z.infer<typeof MachineCoverageSchema>[]
): string[] => {
  const coverageByMachine = new Map(
    machineCoverage.map((coverage) => [coverage.machineId, coverage])
  );

  return requiredMachineIds.filter((machineId) => {
    const coverage = coverageByMachine.get(machineId);

    return (
      coverage === undefined ||
      coverage.status !== "captured" ||
      coverage.sourceCount <= 0 ||
      coverage.authorityCount <= 0
    );
  });
};

const missingSourceFamiliesFor = (
  sourceFamilyCoverage: readonly z.infer<typeof SourceFamilyCoverageSchema>[]
): string[] => {
  const coverageByFamily = new Map(
    sourceFamilyCoverage.map((coverage) => [coverage.family, coverage])
  );

  return requiredSourceFamilies.filter((family) => {
    const coverage = coverageByFamily.get(family);

    return (
      coverage === undefined ||
      coverage.status !== "captured" ||
      coverage.sourceCount <= 0 ||
      coverage.authorityCount <= 0
    );
  });
};

const unreportedSourceFamiliesFor = (
  sourceFamilyCoverage: readonly z.infer<typeof SourceFamilyCoverageSchema>[]
): string[] => {
  const reportedFamilies = new Set(
    sourceFamilyCoverage.map((coverage) => coverage.family)
  );

  return requiredSourceFamilies.filter(
    (family) => !reportedFamilies.has(family)
  );
};

const parseArgs = (argv: readonly string[]): ProvisioningPreflightArgs => {
  const approvalRef = argValue(argv, "--approval-ref");
  const approvalSignoff = argValue(argv, "--approval-signoff");
  const args = {
    livePreflightPath:
      argValue(argv, "--live-preflight-path") ?? defaultLivePreflightPath,
    localRelayProofPath:
      argValue(argv, "--local-relay-proof-path") ?? defaultLocalRelayProofPath,
    receiptPath: argValue(argv, "--receipt-path") ?? defaultReceiptPath,
  };

  if (approvalRef === undefined && approvalSignoff === undefined) {
    return args;
  }

  return {
    ...args,
    ...(approvalRef === undefined ? {} : { approvalRef }),
    ...(approvalSignoff === undefined ? {} : { approvalSignoff }),
  };
};

const readTextOrEmpty = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
};

const parseJsonOrNull = (text: string): unknown | null => {
  if (text.trim().length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const probeCommand = (command: string): CommandProbe => {
  const result = spawnSync("which", [command], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const output = result.stdout.trim();

  return {
    available: result.status === 0 && output.length > 0,
    command,
    ...(output.length === 0 ? {} : { path: output }),
  };
};

const defaultNetworkToolProbes = (): readonly CommandProbe[] => [
  probeCommand("cloudflared"),
  probeCommand("ngrok"),
  probeCommand("tailscale"),
];

const approvalStatusFor = (
  approvalSignoff: string | undefined
): "approved" | "invalid" | "required" => {
  if (approvalSignoff === undefined) {
    return "required";
  }

  return approvalSignoff === signoffPhrase ? "approved" : "invalid";
};

const localRelayProofSummary = (input: {
  readonly path: string;
  readonly text: string;
}): DreamRelayProvisioningPreflightReceipt["localRelayProof"] => {
  const parsed = parseJsonOrNull(input.text);
  if (parsed === null) {
    return {
      path: input.path,
      status: input.text.trim().length === 0 ? "missing" : "failed",
    };
  }

  const proofResult = LocalRelayProofSchema.safeParse(parsed);
  if (!proofResult.success) {
    return {
      path: input.path,
      status: "failed",
    };
  }

  const { data: proof } = proofResult;
  const missingMachineIds = missingMachineIdsFor(
    proof.inventory.machineCoverage
  );
  const missingSourceFamilies = missingSourceFamiliesFor(
    proof.inventory.sourceFamilyCoverage
  );
  const unreportedSourceFamilies = unreportedSourceFamiliesFor(
    proof.inventory.sourceFamilyCoverage
  );

  return {
    backfillRunBlockedCount: proof.backfillRun.blockedCount,
    backfillRunCompletedCount: proof.backfillRun.completedCount,
    backfillRunFailedCount: proof.backfillRun.failedCount,
    backfillRunSkippedCount: proof.backfillRun.skippedCount,
    correlationEdgeCount: proof.correlation.edgeCount,
    correlationNodeCount: proof.correlation.nodeCount,
    hydratedCount: proof.search.hydratedCount,
    hydratedFamilyCounts: proof.search.hydratedFamilyCounts,
    machineCoverage: proof.inventory.machineCoverage,
    missingMachineIds,
    missingSourceFamilies,
    path: input.path,
    rawCredentialsReturned: proof.rawCredentialsReturned,
    rawPathLeaked: proof.rawPathLeaked,
    rawPathsReturned: proof.rawPathsReturned,
    runId: proof.runId,
    searchHitCount: proof.search.hitCount,
    sourceRootCount: proof.sourceRootCount,
    status:
      missingMachineIds.length === 0 && unreportedSourceFamilies.length === 0
        ? "passed"
        : "failed",
  };
};

const livePreflightSummary = (input: {
  readonly path: string;
  readonly text: string;
}): DreamRelayProvisioningPreflightReceipt["livePreflight"] => {
  const parsed = parseJsonOrNull(input.text);
  if (parsed === null) {
    return {
      missingCheckIds: [],
      path: input.path,
      status: input.text.trim().length === 0 ? "missing" : "failed",
    };
  }

  const preflightResult = LivePreflightSchema.safeParse(parsed);
  if (!preflightResult.success) {
    return {
      missingCheckIds: [],
      path: input.path,
      status: "failed",
    };
  }

  const { data: preflight } = preflightResult;
  const failedOrMissing = preflight.checks.filter(
    (check) => check.status === "missing" || check.status === "failed"
  );
  const relayHealthz = preflight.checks.find(
    (check) => check.checkId === "relay:healthz"
  );
  const relayLocalProof = preflight.checks.find(
    (check) => check.checkId === "relay:local-proof"
  );

  return {
    missingCheckIds: failedOrMissing.map((check) => check.checkId),
    path: input.path,
    ...(relayHealthz === undefined
      ? {}
      : { relayHealthzStatus: relayHealthz.status }),
    ...(relayLocalProof === undefined
      ? {}
      : { relayLocalProofStatus: relayLocalProof.status }),
    status: preflight.status,
  };
};

const recommendedNextActions = (input: {
  readonly approvalStatus: "approved" | "invalid" | "required";
  readonly livePreflight: DreamRelayProvisioningPreflightReceipt["livePreflight"];
  readonly localRelayProof: DreamRelayProvisioningPreflightReceipt["localRelayProof"];
  readonly networkTools: readonly CommandProbe[];
  readonly visionHasSignoffRule: boolean;
}): readonly string[] => {
  const actions: string[] = [];

  if (!input.visionHasSignoffRule) {
    actions.push(
      "Restore the Vision sign-off rule before provisioning a relay network boundary."
    );
  }

  if (input.localRelayProof.status !== "passed") {
    if (
      input.localRelayProof.missingMachineIds !== undefined &&
      input.localRelayProof.missingMachineIds.length > 0
    ) {
      actions.push(
        `Add or provision trusted Dream source roots for missing machine coverage: ${input.localRelayProof.missingMachineIds.join(", ")}.`
      );
    } else {
      actions.push(
        "Run pnpm app:dream:relay:proof and inspect the redacted local relay proof receipt."
      );
    }
  }

  if (
    input.localRelayProof.missingSourceFamilies !== undefined &&
    input.localRelayProof.missingSourceFamilies.length > 0
  ) {
    actions.push(
      `Provision scoped Dream source adapters or capability leases for missing source families: ${input.localRelayProof.missingSourceFamilies.join(", ")}.`
    );
  }

  if (input.approvalStatus === "invalid") {
    actions.push(invalidSignoffAction);
  }

  if (input.approvalStatus === "required") {
    actions.push(exactSignoffAction);
  }

  if (!input.networkTools.some((tool) => tool.available)) {
    actions.push(
      "Install or configure an approved relay exposure tool such as cloudflared, ngrok, or Tailscale Funnel."
    );
  }

  if (input.livePreflight.relayHealthzStatus !== "passed") {
    actions.push(
      "Provision an approved HTTPS relay endpoint and verify authenticated /healthz."
    );
  }

  if (
    input.livePreflight.missingCheckIds.includes("env:DREAM_MEMORY_RELAY_TOKEN")
  ) {
    actions.push(
      "Provision DREAM_MEMORY_RELAY_TOKEN as a remote Worker secret without printing the token."
    );
  }

  if (
    input.livePreflight.missingCheckIds.includes(
      "wrangler:DREAM_MEMORY_RELAY_BASE_URL"
    )
  ) {
    actions.push(
      "Add DREAM_MEMORY_RELAY_BASE_URL to Worker deploy configuration after the endpoint is approved."
    );
  }

  return [...new Set(actions)];
};

export const buildDreamRelayProvisioningPreflightReceipt = (
  input: BuildDreamRelayProvisioningPreflightInput
): DreamRelayProvisioningPreflightReceipt => {
  const visionHasSignoffRule =
    input.visionText.includes("Needs Sign-Off") &&
    input.visionText.includes(signoffPhrase);
  const localRelayProof = localRelayProofSummary({
    path: input.localRelayProofPath,
    text: input.localRelayProofText,
  });
  const livePreflight = livePreflightSummary({
    path: input.livePreflightPath,
    text: input.livePreflightText,
  });
  const approvalStatus = approvalStatusFor(input.approvalSignoff);
  const actions = recommendedNextActions({
    approvalStatus,
    livePreflight,
    localRelayProof,
    networkTools: input.networkTools,
    visionHasSignoffRule,
  });
  const readyForApprovedProvisioning =
    approvalStatus === "approved" &&
    visionHasSignoffRule &&
    localRelayProof.status === "passed" &&
    input.networkTools.some((tool) => tool.available);

  return DreamRelayProvisioningPreflightReceiptSchema.parse({
    approval: {
      ...(input.approvalRef === undefined
        ? {}
        : { approvalRef: input.approvalRef }),
      required: true,
      signoffPhrase,
      signoffProvided: approvalStatus === "approved",
      status: approvalStatus,
    },
    checkedAt: input.checkedAt,
    livePreflight,
    localRelayProof,
    networkTools: input.networkTools.map((tool) => ({
      available: tool.available,
      command: tool.command,
      ...(tool.path === undefined ? {} : { path: tool.path }),
    })),
    recommendedNextActions: actions,
    redacted: true,
    schemaVersion: "trusted.dream-memory-relay.provisioning-preflight.v1",
    status: readyForApprovedProvisioning
      ? "ready-for-approved-provisioning"
      : "blocked",
  });
};

export const runDreamRelayProvisioningPreflightCli = async (input: {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly repoRoot: string;
}): Promise<DreamRelayProvisioningPreflightReceipt> => {
  const args = parseArgs(input.argv);
  const livePreflightPath = resolve(input.repoRoot, args.livePreflightPath);
  const localRelayProofPath = resolve(input.repoRoot, args.localRelayProofPath);
  const receiptPath = resolve(input.repoRoot, args.receiptPath);
  const receipt = buildDreamRelayProvisioningPreflightReceipt({
    ...(args.approvalRef === undefined
      ? {}
      : { approvalRef: args.approvalRef }),
    ...(args.approvalSignoff === undefined
      ? {}
      : { approvalSignoff: args.approvalSignoff }),
    checkedAt: new Date().toISOString(),
    livePreflightPath: args.livePreflightPath,
    livePreflightText: await readTextOrEmpty(livePreflightPath),
    localRelayProofPath: args.localRelayProofPath,
    localRelayProofText: await readTextOrEmpty(localRelayProofPath),
    networkTools: defaultNetworkToolProbes(),
    visionText: await readTextOrEmpty(resolve(input.repoRoot, "VISION.md")),
  });
  const log = input.log ?? console.log;

  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receiptPath}`);

  return receipt;
};

if (isMain()) {
  try {
    await runDreamRelayProvisioningPreflightCli({
      argv: process.argv.slice(2),
      repoRoot: process.cwd(),
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "dream_relay_provisioning_preflight_failed",
            message:
              error instanceof Error
                ? error.message
                : "Dream relay provisioning preflight failed.",
            redacted: true,
          },
          redacted: true,
          schemaVersion:
            "trusted.dream-memory-relay.provisioning-preflight-error.v1",
          status: "failed",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
