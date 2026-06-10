#!/usr/bin/env tsx

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";
import { trustedLocalMemoryRelayHttpConfigFromEnv } from "../src/cartridges/memory-fabric/trusted-local-relay-http.ts";
import {
  requireInstalledSourceProfile,
  workflowProfileWorkspacePaths,
} from "./workflow-app-profile.ts";

const defaultLocalRelayProofPath =
  ".wrangler/workflow-app/memory-relay/latest-local-proof.json";
const defaultLocalRelayReadinessPath =
  ".wrangler/workflow-app/memory-relay/latest-local-readiness.json";
const defaultLocalRelayStartupEnvPath =
  ".wrangler/workflow-app/memory-relay/local-relay-startup-env.json";
const defaultReceiptPath =
  ".wrangler/workflow-app/memory-relay/latest-provisioning-preflight.json";
const signoffPhrase = "exposing JoelClaw/Typesense over a new network boundary";
const exactSignoffAction =
  "Get explicit owner sign-off for exposing the trusted Memory relay over a new network boundary.";
const invalidSignoffAction =
  "Recorded relay exposure sign-off did not match the required phrase; provide the exact sign-off phrase before provisioning.";
const localRelaySourceRootsAction =
  "Set MEMORY_RELAY_SOURCE_ROOTS_JSON before starting the local trusted relay.";
const localRelayTokenAction =
  "Set MEMORY_RELAY_TOKEN locally before starting the relay and provisioning the Worker secret.";
const localRelayStartupEnvNames = [
  "MEMORY_RELAY_SOURCE_ROOTS_JSON",
  "MEMORY_RELAY_TOKEN",
] as const;
const LocalRelayStartupEnvNameSchema = z.enum(localRelayStartupEnvNames);

const MemoryRelayProvisioningPlanStepSchema = z.object({
  blockedBy: z.array(z.string().min(1)).default([]),
  commandTemplate: z.string().min(1).optional(),
  description: z.string().min(1),
  executed: z.literal(false),
  expectedReceipt: z.string().min(1).optional(),
  redacted: z.literal(true),
  requiresSignoff: z.boolean(),
  sideEffectClass: z.enum([
    "none",
    "local-process",
    "secret-write",
    "network-boundary",
    "worker-config",
    "remote-verification",
    "live-workflow-submit",
  ]),
  status: z.enum(["blocked", "ready", "ready-after-signoff"]),
  stepId: z.string().min(1),
});

export const MemoryRelayProvisioningPlanSchema = z.object({
  approvalStatus: z.enum(["approved", "invalid", "required"]),
  noSideEffectsPerformed: z.literal(true),
  redacted: z.literal(true),
  requiredSecretBindings: z.array(z.literal("MEMORY_RELAY_TOKEN")),
  requiredSignoffPhrase: z.literal(signoffPhrase),
  requiredWorkerVars: z.array(z.literal("MEMORY_RELAY_BASE_URL")),
  schemaVersion: z.literal("trusted.memory-relay.provisioning-plan.v1"),
  selectedTransportCandidates: z.array(
    z.object({
      available: z.boolean(),
      command: z.string().min(1),
      preferred: z.boolean(),
      reason: z.string().min(1),
    })
  ),
  steps: z.array(MemoryRelayProvisioningPlanStepSchema),
});

export type MemoryRelayProvisioningPlan = z.infer<
  typeof MemoryRelayProvisioningPlanSchema
>;

const RelayReceiptFamilyCountSchema = z.object({
  family: z.string().min(1),
  receiptCount: z.number().int().min(0),
});

const SourceFamilyCoverageSchema = z.object({
  family: z.string().min(1),
  missingReason: z.string().min(1).optional(),
  receiptCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalRelayProofSchema = z.object({
  correlation: z.object({
    edgeCount: z.number().int().min(1),
    nodeCount: z.number().int().min(1),
  }),
  rawCredentialsReturned: z.literal(false),
  rawPathLeaked: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  runId: z.string().min(1),
  schemaVersion: z.literal("trusted.memory-relay.local-proof.v1"),
  search: z.object({
    hitCount: z.number().int().min(1),
    hydratedCount: z.number().int().min(1),
    hydratedFamilyCounts: z.array(RelayReceiptFamilyCountSchema).default([]),
  }),
  signals: z
    .object({
      receiptFamilyCounts: z.array(RelayReceiptFamilyCountSchema).default([]),
      signalCount: z.number().int().min(0),
      signalKinds: z.array(z.string().min(1)).default([]),
    })
    .default({
      receiptFamilyCounts: [],
      signalCount: 0,
      signalKinds: [],
    }),
  sourceFamilyCoverage: z.array(SourceFamilyCoverageSchema).default([]),
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

export const MemoryRelayProvisioningPreflightReceiptSchema = z.object({
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
    correlationEdgeCount: z.number().int().min(0).optional(),
    correlationNodeCount: z.number().int().min(0).optional(),
    hydratedCount: z.number().int().min(0).optional(),
    hydratedFamilyCounts: z.array(RelayReceiptFamilyCountSchema).optional(),
    missingSourceFamilies: z.array(z.string().min(1)).optional(),
    path: z.string().min(1),
    rawCredentialsReturned: z.literal(false).optional(),
    rawPathLeaked: z.literal(false).optional(),
    rawPathsReturned: z.literal(false).optional(),
    runId: z.string().min(1).optional(),
    searchHitCount: z.number().int().min(0).optional(),
    signalCount: z.number().int().min(0).optional(),
    signalKinds: z.array(z.string().min(1)).optional(),
    sourceFamilyCoverage: z.array(SourceFamilyCoverageSchema).optional(),
    sourceRootCount: z.number().int().min(0).optional(),
    status: z.enum(["failed", "missing", "passed"]),
  }),
  localRelayReadiness: z.object({
    boundHost: z.string().min(1).optional(),
    boundPort: z.number().int().min(1).optional(),
    checkedAt: z.string().min(1).optional(),
    configuredHost: z.string().min(1).optional(),
    configuredPort: z.number().int().min(1).optional(),
    healthzStatus: z.enum(["failed", "missing", "passed"]),
    path: z.string().min(1),
    rawCredentialsReturned: z.literal(false).optional(),
    rawPathsReturned: z.literal(false).optional(),
    sourceRootCount: z.number().int().min(0).optional(),
    startupEnvRef: z.string().min(1).optional(),
    status: z.enum(["failed", "missing", "passed"]),
    supportedOperationCount: z.number().int().min(0).optional(),
    tokenConfigured: z.boolean().optional(),
    usedConfiguredPort: z.boolean().optional(),
  }),
  localRelayStartup: z.object({
    envRef: z.string().min(1).optional(),
    envSource: z
      .enum(["artifact", "artifact-and-process", "none", "process"])
      .optional(),
    host: z.string().min(1).optional(),
    invalidEnv: z.array(LocalRelayStartupEnvNameSchema).default([]),
    missingEnv: z.array(LocalRelayStartupEnvNameSchema).default([]),
    port: z.number().int().min(1).optional(),
    redacted: z.literal(true),
    sourceRootCount: z.number().int().min(0),
    status: z.enum(["blocked", "ready"]),
    tokenConfigured: z.boolean(),
  }),
  networkTools: z.array(
    z.object({
      available: z.boolean(),
      command: z.string().min(1),
      path: z.string().min(1).optional(),
    })
  ),
  provisioningPlan: MemoryRelayProvisioningPlanSchema,
  recommendedNextActions: z.array(z.string().min(1)),
  redacted: z.literal(true),
  schemaVersion: z.literal("trusted.memory-relay.provisioning-preflight.v1"),
  status: z.enum(["blocked", "ready-for-approved-provisioning"]),
});

export type MemoryRelayProvisioningPreflightReceipt = z.infer<
  typeof MemoryRelayProvisioningPreflightReceiptSchema
>;

interface ProvisioningPreflightArgs {
  readonly approvalRef?: string;
  readonly approvalSignoff?: string;
  readonly livePreflightPath: string;
  readonly localRelayProofPath: string;
  readonly localRelayReadinessPath: string;
  readonly localRelayStartupEnvPath: string;
  readonly receiptPath: string;
}

export interface CommandProbe {
  readonly available: boolean;
  readonly command: string;
  readonly path?: string;
}

export interface BuildMemoryRelayProvisioningPreflightInput {
  readonly approvalRef?: string;
  readonly approvalSignoff?: string;
  readonly checkedAt: string;
  readonly livePreflightPath: string;
  readonly livePreflightText: string;
  readonly localRelayProofPath: string;
  readonly localRelayProofText: string;
  readonly localRelayReadinessPath?: string;
  readonly localRelayReadinessText?: string;
  readonly localRelayStartupEnv?: Readonly<Record<string, string | undefined>>;
  readonly localRelayStartupEnvRef?: string;
  readonly localRelayStartupEnvSource?:
    | "artifact"
    | "artifact-and-process"
    | "none"
    | "process";
  readonly networkTools: readonly CommandProbe[];
  readonly profile: MemorySourceProfile;
  readonly visionText: string;
}

const LocalRelayStartupEnvArtifactSchema = z.record(z.string(), z.string());

const LocalRelayReadinessProofSchema = z.object({
  boundHost: z.string().min(1),
  boundPort: z.number().int().min(1),
  checkedAt: z.string().min(1),
  configuredHost: z.string().min(1),
  configuredPort: z.number().int().min(1),
  healthz: z.object({
    authRequired: z.literal(true),
    httpStatus: z.literal(200),
    rawCredentialsReturned: z.literal(false),
    rawPathsReturned: z.literal(false),
    schemaVersion: z.literal("trusted.memory-relay.readiness.v1"),
    sourceRootCount: z.number().int().min(1),
    status: z.literal("passed"),
    supportedOperationCount: z.number().int().min(1),
  }),
  rawCredentialsReturned: z.literal(false),
  rawPathsReturned: z.literal(false),
  redacted: z.literal(true),
  schemaVersion: z.literal("trusted.memory-relay.local-readiness-proof.v1"),
  sourceRootCount: z.number().int().min(1),
  startupEnvRef: z.string().min(1),
  status: z.literal("passed"),
  tokenConfigured: z.literal(true),
  usedConfiguredPort: z.boolean(),
});

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
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }

  return undefined;
};

const missingSourceFamiliesFor = (
  requiredSourceFamilies: readonly string[],
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
      coverage.receiptCount <= 0
    );
  });
};

const parseArgs = (
  argv: readonly string[],
  profile: MemorySourceProfile
): ProvisioningPreflightArgs => {
  const approvalRef = argValue(argv, "--approval-ref");
  const approvalSignoff = argValue(argv, "--approval-signoff");
  const args = {
    livePreflightPath:
      argValue(argv, "--live-preflight-path") ??
      workflowProfileWorkspacePaths(profile.profileId).preflightReceiptPath,
    localRelayProofPath:
      argValue(argv, "--local-relay-proof-path") ?? defaultLocalRelayProofPath,
    localRelayReadinessPath:
      argValue(argv, "--local-relay-readiness-path") ??
      defaultLocalRelayReadinessPath,
    localRelayStartupEnvPath:
      argValue(argv, "--local-relay-startup-env-path") ??
      defaultLocalRelayStartupEnvPath,
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

const safeLocalArtifactRef = (path: string): string =>
  path.startsWith(".wrangler/") ? path : "<redacted-local-operator-artifact>";

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
  readonly requiredSourceFamilies: readonly string[];
  readonly text: string;
}): MemoryRelayProvisioningPreflightReceipt["localRelayProof"] => {
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
  const missingSourceFamilies = missingSourceFamiliesFor(
    input.requiredSourceFamilies,
    proof.sourceFamilyCoverage
  );

  return {
    correlationEdgeCount: proof.correlation.edgeCount,
    correlationNodeCount: proof.correlation.nodeCount,
    hydratedCount: proof.search.hydratedCount,
    hydratedFamilyCounts: proof.search.hydratedFamilyCounts,
    missingSourceFamilies,
    path: input.path,
    rawCredentialsReturned: proof.rawCredentialsReturned,
    rawPathLeaked: proof.rawPathLeaked,
    rawPathsReturned: proof.rawPathsReturned,
    runId: proof.runId,
    searchHitCount: proof.search.hitCount,
    signalCount: proof.signals.signalCount,
    signalKinds: proof.signals.signalKinds,
    sourceFamilyCoverage: proof.sourceFamilyCoverage,
    sourceRootCount: proof.sourceRootCount,
    status: "passed",
  };
};

const localRelayReadinessSummary = (input: {
  readonly path: string;
  readonly text: string;
}): MemoryRelayProvisioningPreflightReceipt["localRelayReadiness"] => {
  const parsed = parseJsonOrNull(input.text);
  if (parsed === null) {
    return {
      healthzStatus: "missing",
      path: input.path,
      status: input.text.trim().length === 0 ? "missing" : "failed",
    };
  }

  const readinessResult = LocalRelayReadinessProofSchema.safeParse(parsed);
  if (!readinessResult.success) {
    return {
      healthzStatus: "failed",
      path: input.path,
      status: "failed",
    };
  }

  const { data: readiness } = readinessResult;

  return {
    boundHost: readiness.boundHost,
    boundPort: readiness.boundPort,
    checkedAt: readiness.checkedAt,
    configuredHost: readiness.configuredHost,
    configuredPort: readiness.configuredPort,
    healthzStatus: readiness.healthz.status,
    path: input.path,
    rawCredentialsReturned: readiness.rawCredentialsReturned,
    rawPathsReturned: readiness.rawPathsReturned,
    sourceRootCount: readiness.sourceRootCount,
    startupEnvRef: readiness.startupEnvRef,
    status: readiness.status,
    supportedOperationCount: readiness.healthz.supportedOperationCount,
    tokenConfigured: readiness.tokenConfigured,
    usedConfiguredPort: readiness.usedConfiguredPort,
  };
};

const livePreflightSummary = (input: {
  readonly path: string;
  readonly text: string;
}): MemoryRelayProvisioningPreflightReceipt["livePreflight"] => {
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

const localRelayStartupSummary = (
  env: Readonly<Record<string, string | undefined>> = {},
  metadata: {
    readonly envRef?: string;
    readonly envSource?:
      | "artifact"
      | "artifact-and-process"
      | "none"
      | "process";
  } = {}
): MemoryRelayProvisioningPreflightReceipt["localRelayStartup"] => {
  const summaryMetadata = {
    ...(metadata.envRef === undefined ? {} : { envRef: metadata.envRef }),
    ...(metadata.envSource === undefined
      ? {}
      : { envSource: metadata.envSource }),
  };
  const missingEnv = localRelayStartupEnvNames.filter((name) => {
    const value = env[name];

    return value === undefined || value.length === 0;
  });

  if (missingEnv.length > 0) {
    return {
      ...summaryMetadata,
      invalidEnv: [],
      missingEnv,
      redacted: true,
      sourceRootCount: 0,
      status: "blocked",
      tokenConfigured: (env["MEMORY_RELAY_TOKEN"]?.length ?? 0) > 0,
    };
  }

  try {
    const config = trustedLocalMemoryRelayHttpConfigFromEnv(env);

    return {
      ...summaryMetadata,
      host: config.host,
      invalidEnv: [],
      missingEnv: [],
      port: config.port,
      redacted: true,
      sourceRootCount: config.memoryFabric.sourceRoots.length,
      status: "ready",
      tokenConfigured: true,
    };
  } catch {
    return {
      ...summaryMetadata,
      invalidEnv: ["MEMORY_RELAY_SOURCE_ROOTS_JSON"],
      missingEnv: [],
      redacted: true,
      sourceRootCount: 0,
      status: "blocked",
      tokenConfigured: true,
    };
  }
};

const localRelayStartupEnvSourceFor = (input: {
  readonly artifactLoaded: boolean;
  readonly processHasStartupEnv: boolean;
}): "artifact" | "artifact-and-process" | "none" | "process" => {
  if (input.artifactLoaded && input.processHasStartupEnv) {
    return "artifact-and-process";
  }

  if (input.artifactLoaded) {
    return "artifact";
  }

  if (input.processHasStartupEnv) {
    return "process";
  }

  return "none";
};

const recommendedNextActions = (input: {
  readonly approvalStatus: "approved" | "invalid" | "required";
  readonly livePreflight: MemoryRelayProvisioningPreflightReceipt["livePreflight"];
  readonly localRelayProof: MemoryRelayProvisioningPreflightReceipt["localRelayProof"];
  readonly localRelayReadiness: MemoryRelayProvisioningPreflightReceipt["localRelayReadiness"];
  readonly localRelayStartup: MemoryRelayProvisioningPreflightReceipt["localRelayStartup"];
  readonly networkTools: readonly CommandProbe[];
  readonly profileId: string;
  readonly visionHasSignoffRule: boolean;
}): readonly string[] => {
  const actions: string[] = [];

  if (!input.visionHasSignoffRule) {
    actions.push(
      "Restore the Vision sign-off rule before provisioning a relay network boundary."
    );
  }

  if (input.localRelayProof.status !== "passed") {
    actions.push(
      `Run pnpm app:relay:proof --profile ${input.profileId} and inspect the redacted local relay proof receipt.`
    );
  }

  if (
    input.localRelayProof.missingSourceFamilies !== undefined &&
    input.localRelayProof.missingSourceFamilies.length > 0
  ) {
    actions.push(
      `Coverage caveat (reported, not blocking): missing source families ${input.localRelayProof.missingSourceFamilies.join(", ")} will appear in the run report.`
    );
  }

  if (input.approvalStatus === "invalid") {
    actions.push(invalidSignoffAction);
  }

  if (input.approvalStatus === "required") {
    actions.push(exactSignoffAction);
  }

  if (
    input.localRelayStartup.missingEnv.includes(
      "MEMORY_RELAY_SOURCE_ROOTS_JSON"
    ) ||
    input.localRelayStartup.invalidEnv.includes(
      "MEMORY_RELAY_SOURCE_ROOTS_JSON"
    )
  ) {
    actions.push(localRelaySourceRootsAction);
  }

  if (input.localRelayStartup.missingEnv.includes("MEMORY_RELAY_TOKEN")) {
    actions.push(localRelayTokenAction);
  }

  if (
    input.localRelayStartup.status === "ready" &&
    input.localRelayReadiness.status !== "passed"
  ) {
    actions.push(
      `Run pnpm app:relay:readiness --profile ${input.profileId} to prove the local trusted relay can boot from the generated startup env and pass authenticated /healthz.`
    );
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

  if (input.livePreflight.missingCheckIds.includes("env:MEMORY_RELAY_TOKEN")) {
    actions.push(
      "Provision MEMORY_RELAY_TOKEN as a remote Worker secret without printing the token."
    );
  }

  if (
    input.livePreflight.missingCheckIds.includes(
      "wrangler:MEMORY_RELAY_BASE_URL"
    )
  ) {
    actions.push(
      "Add MEMORY_RELAY_BASE_URL to Worker deploy configuration after the endpoint is approved."
    );
  }

  return [...new Set(actions)];
};

const preferredTransportCommands = ["cloudflared", "ngrok", "tailscale"];

const transportCandidatesFor = (
  networkTools: readonly CommandProbe[]
): MemoryRelayProvisioningPlan["selectedTransportCandidates"] => {
  const toolsByCommand = new Map(
    networkTools.map((tool) => [tool.command, tool])
  );

  return preferredTransportCommands.map((command, index) => {
    const tool = toolsByCommand.get(command);
    const available = tool?.available === true;

    return {
      available,
      command,
      preferred: index === 0,
      reason: available
        ? `${command} is installed locally.`
        : `${command} is not available on PATH.`,
    };
  });
};

const provisioningPlanBlockedBy = (input: {
  readonly approvalStatus: "approved" | "invalid" | "required";
  readonly livePreflight: MemoryRelayProvisioningPreflightReceipt["livePreflight"];
  readonly localRelayProof: MemoryRelayProvisioningPreflightReceipt["localRelayProof"];
  readonly localRelayReadiness: MemoryRelayProvisioningPreflightReceipt["localRelayReadiness"];
  readonly localRelayStartup: MemoryRelayProvisioningPreflightReceipt["localRelayStartup"];
  readonly networkTools: readonly CommandProbe[];
  readonly visionHasSignoffRule: boolean;
}): readonly string[] => {
  const blockers: string[] = [];

  if (!input.visionHasSignoffRule) {
    blockers.push("missing-vision-signoff-rule");
  }

  if (input.approvalStatus !== "approved") {
    blockers.push("missing-exact-owner-signoff");
  }

  if (input.localRelayProof.status !== "passed") {
    blockers.push("local-relay-proof-not-passed");
  }

  if (input.localRelayStartup.status !== "ready") {
    blockers.push("local-relay-startup-config-missing");
  }

  if (!input.networkTools.some((tool) => tool.available)) {
    blockers.push("no-approved-transport-tool");
  }

  if (
    input.livePreflight.status !== "ready" &&
    input.livePreflight.status !== "blocked"
  ) {
    blockers.push("live-preflight-unavailable");
  }

  return [...new Set(blockers)];
};

const buildProvisioningStep = (input: {
  readonly blockedBy?: readonly string[];
  readonly commandTemplate?: string;
  readonly description: string;
  readonly expectedReceipt?: string;
  readonly requiresSignoff: boolean;
  readonly sideEffectClass: z.infer<
    typeof MemoryRelayProvisioningPlanStepSchema
  >["sideEffectClass"];
  readonly stepId: string;
}): z.infer<typeof MemoryRelayProvisioningPlanStepSchema> => {
  const blockedBy = [...(input.blockedBy ?? [])];
  const status = (() => {
    if (blockedBy.length > 0) {
      return "blocked";
    }

    if (input.requiresSignoff) {
      return "ready-after-signoff";
    }

    return "ready";
  })();

  return MemoryRelayProvisioningPlanStepSchema.parse({
    blockedBy,
    ...(input.commandTemplate === undefined
      ? {}
      : { commandTemplate: input.commandTemplate }),
    description: input.description,
    executed: false,
    ...(input.expectedReceipt === undefined
      ? {}
      : { expectedReceipt: input.expectedReceipt }),
    redacted: true,
    requiresSignoff: input.requiresSignoff,
    sideEffectClass: input.sideEffectClass,
    status,
    stepId: input.stepId,
  });
};

const localRelayReadinessStepBlockers = (input: {
  readonly localRelayReadiness: MemoryRelayProvisioningPreflightReceipt["localRelayReadiness"];
  readonly localRelayStartup: MemoryRelayProvisioningPreflightReceipt["localRelayStartup"];
}): readonly string[] => {
  if (input.localRelayStartup.status !== "ready") {
    return ["local-relay-startup-config-missing"];
  }

  if (input.localRelayReadiness.status !== "passed") {
    return ["local-relay-readiness-not-passed"];
  }

  return [];
};

const buildProvisioningPlan = (input: {
  readonly approvalStatus: "approved" | "invalid" | "required";
  readonly livePreflight: MemoryRelayProvisioningPreflightReceipt["livePreflight"];
  readonly livePreflightPath: string;
  readonly localRelayProof: MemoryRelayProvisioningPreflightReceipt["localRelayProof"];
  readonly localRelayReadiness: MemoryRelayProvisioningPreflightReceipt["localRelayReadiness"];
  readonly localRelayStartup: MemoryRelayProvisioningPreflightReceipt["localRelayStartup"];
  readonly networkTools: readonly CommandProbe[];
  readonly profileId: string;
  readonly visionHasSignoffRule: boolean;
}): MemoryRelayProvisioningPlan => {
  const baseBlockers = provisioningPlanBlockedBy(input);
  const localReadinessBlockers =
    input.localRelayReadiness.status === "passed"
      ? []
      : ["local-relay-readiness-not-passed"];
  const relayExposureBlockers = [...baseBlockers, ...localReadinessBlockers];
  const relayConfigBlockers = [
    ...relayExposureBlockers,
    ...(input.livePreflight.missingCheckIds.includes(
      "env:MEMORY_RELAY_BASE_URL"
    )
      ? ["missing-memory-relay-base-url"]
      : []),
    ...(input.livePreflight.missingCheckIds.includes("env:MEMORY_RELAY_TOKEN")
      ? ["missing-memory-relay-token"]
      : []),
    ...(input.livePreflight.missingCheckIds.includes(
      "wrangler:MEMORY_RELAY_BASE_URL"
    )
      ? ["missing-worker-relay-url-config"]
      : []),
    ...(input.livePreflight.relayHealthzStatus === "passed"
      ? []
      : ["relay-healthz-not-verified"]),
  ];
  const { runReceiptDir } = workflowProfileWorkspacePaths(input.profileId);

  return MemoryRelayProvisioningPlanSchema.parse({
    approvalStatus: input.approvalStatus,
    noSideEffectsPerformed: true,
    redacted: true,
    requiredSecretBindings: ["MEMORY_RELAY_TOKEN"],
    requiredSignoffPhrase: signoffPhrase,
    requiredWorkerVars: ["MEMORY_RELAY_BASE_URL"],
    schemaVersion: "trusted.memory-relay.provisioning-plan.v1",
    selectedTransportCandidates: transportCandidatesFor(input.networkTools),
    steps: [
      buildProvisioningStep({
        blockedBy:
          input.localRelayProof.status === "passed"
            ? []
            : ["local-relay-proof-not-passed"],
        commandTemplate: `pnpm app:relay:proof --profile ${input.profileId}`,
        description:
          "Refresh the redacted local relay proof before any network exposure.",
        expectedReceipt:
          ".wrangler/workflow-app/memory-relay/latest-local-proof.json",
        requiresSignoff: false,
        sideEffectClass: "none",
        stepId: "refresh-local-relay-proof",
      }),
      buildProvisioningStep({
        blockedBy: baseBlockers,
        commandTemplate: `pnpm app:relay --profile ${input.profileId}`,
        description:
          "Start the trusted Memory relay bound to localhost with approved source roots and a non-printed token.",
        expectedReceipt: "trusted.memory-relay.readiness.v1",
        requiresSignoff: true,
        sideEffectClass: "local-process",
        stepId: "start-local-trusted-relay",
      }),
      buildProvisioningStep({
        blockedBy: localRelayReadinessStepBlockers(input),
        commandTemplate: `pnpm app:relay:readiness --profile ${input.profileId}`,
        description:
          "Start the trusted local relay transiently and prove authenticated /healthz from the generated startup env.",
        expectedReceipt:
          ".wrangler/workflow-app/memory-relay/latest-local-readiness.json",
        requiresSignoff: false,
        sideEffectClass: "local-process",
        stepId: "verify-local-relay-readiness",
      }),
      buildProvisioningStep({
        blockedBy: relayExposureBlockers,
        commandTemplate:
          "<approved-transport> expose http://127.0.0.1:<relay-port> as HTTPS",
        description:
          "Expose the localhost trusted relay through the approved HTTPS transport.",
        expectedReceipt: "approved HTTPS relay URL",
        requiresSignoff: true,
        sideEffectClass: "network-boundary",
        stepId: "expose-approved-https-relay",
      }),
      buildProvisioningStep({
        blockedBy: relayExposureBlockers,
        commandTemplate:
          "printf '%s' \"$MEMORY_RELAY_TOKEN\" | pnpm exec wrangler secret put MEMORY_RELAY_TOKEN --config wrangler.jsonc",
        description:
          "Provision the relay token as a remote Worker secret without printing token material.",
        expectedReceipt: "wrangler secret list includes MEMORY_RELAY_TOKEN",
        requiresSignoff: true,
        sideEffectClass: "secret-write",
        stepId: "provision-worker-relay-token",
      }),
      buildProvisioningStep({
        blockedBy: relayExposureBlockers,
        commandTemplate:
          "deploy Worker with MEMORY_RELAY_BASE_URL set to the approved HTTPS relay URL",
        description:
          "Deploy or configure the Worker with the approved relay base URL.",
        expectedReceipt: input.livePreflightPath,
        requiresSignoff: true,
        sideEffectClass: "worker-config",
        stepId: "configure-worker-relay-url",
      }),
      buildProvisioningStep({
        blockedBy: relayConfigBlockers,
        commandTemplate: `pnpm app:preflight --profile ${input.profileId}`,
        description:
          "Verify authenticated /healthz and live run readiness after relay config is present.",
        expectedReceipt: input.livePreflightPath,
        requiresSignoff: true,
        sideEffectClass: "remote-verification",
        stepId: "verify-relay-healthz",
      }),
      buildProvisioningStep({
        blockedBy: relayConfigBlockers,
        commandTemplate: `pnpm app:run --profile ${input.profileId} --submit`,
        description:
          "Submit the generated Cloudflare workflow only after preflight is ready.",
        expectedReceipt: `${runReceiptDir}/<run-id>-receipt.json`,
        requiresSignoff: true,
        sideEffectClass: "live-workflow-submit",
        stepId: "submit-live-run",
      }),
    ],
  });
};

export const buildMemoryRelayProvisioningPreflightReceipt = (
  input: BuildMemoryRelayProvisioningPreflightInput
): MemoryRelayProvisioningPreflightReceipt => {
  const visionHasSignoffRule =
    input.visionText.includes("Needs Sign-Off") &&
    input.visionText.includes(signoffPhrase);
  const localRelayProof = localRelayProofSummary({
    path: input.localRelayProofPath,
    requiredSourceFamilies: input.profile.sourceFamiliesExpected,
    text: input.localRelayProofText,
  });
  const localRelayReadiness = localRelayReadinessSummary({
    path: input.localRelayReadinessPath ?? defaultLocalRelayReadinessPath,
    text: input.localRelayReadinessText ?? "",
  });
  const localRelayStartup = localRelayStartupSummary(
    input.localRelayStartupEnv,
    {
      ...(input.localRelayStartupEnvRef === undefined
        ? {}
        : { envRef: input.localRelayStartupEnvRef }),
      ...(input.localRelayStartupEnvSource === undefined
        ? {}
        : { envSource: input.localRelayStartupEnvSource }),
    }
  );
  const livePreflight = livePreflightSummary({
    path: input.livePreflightPath,
    text: input.livePreflightText,
  });
  const approvalStatus = approvalStatusFor(input.approvalSignoff);
  const actions = recommendedNextActions({
    approvalStatus,
    livePreflight,
    localRelayProof,
    localRelayReadiness,
    localRelayStartup,
    networkTools: input.networkTools,
    profileId: input.profile.profileId,
    visionHasSignoffRule,
  });
  const provisioningPlan = buildProvisioningPlan({
    approvalStatus,
    livePreflight,
    livePreflightPath: input.livePreflightPath,
    localRelayProof,
    localRelayReadiness,
    localRelayStartup,
    networkTools: input.networkTools,
    profileId: input.profile.profileId,
    visionHasSignoffRule,
  });
  const readyForApprovedProvisioning =
    approvalStatus === "approved" &&
    visionHasSignoffRule &&
    localRelayProof.status === "passed" &&
    localRelayReadiness.status === "passed" &&
    localRelayStartup.status === "ready" &&
    input.networkTools.some((tool) => tool.available);

  return MemoryRelayProvisioningPreflightReceiptSchema.parse({
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
    localRelayReadiness,
    localRelayStartup,
    networkTools: input.networkTools.map((tool) => ({
      available: tool.available,
      command: tool.command,
      ...(tool.path === undefined ? {} : { path: tool.path }),
    })),
    provisioningPlan,
    recommendedNextActions: actions,
    redacted: true,
    schemaVersion: "trusted.memory-relay.provisioning-preflight.v1",
    status: readyForApprovedProvisioning
      ? "ready-for-approved-provisioning"
      : "blocked",
  });
};

export const runMemoryRelayProvisioningPreflightCli = async (input: {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly networkTools?: readonly CommandProbe[];
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}): Promise<MemoryRelayProvisioningPreflightReceipt> => {
  const profile = requireInstalledSourceProfile(input.argv);
  const args = parseArgs(input.argv, profile);
  const livePreflightPath = resolve(input.repoRoot, args.livePreflightPath);
  const localRelayProofPath = resolve(input.repoRoot, args.localRelayProofPath);
  const localRelayReadinessPath = resolve(
    input.repoRoot,
    args.localRelayReadinessPath
  );
  const localRelayStartupEnvPath = resolve(
    input.repoRoot,
    args.localRelayStartupEnvPath
  );
  const receiptPath = resolve(input.repoRoot, args.receiptPath);
  const startupEnvText = await readTextOrEmpty(localRelayStartupEnvPath);
  const startupEnvArtifactResult =
    startupEnvText.trim().length === 0
      ? undefined
      : LocalRelayStartupEnvArtifactSchema.safeParse(
          parseJsonOrNull(startupEnvText)
        );
  const startupEnvFromArtifact =
    startupEnvArtifactResult?.success === true
      ? startupEnvArtifactResult.data
      : {};
  const processEnv = input.processEnv ?? process.env;
  const processHasStartupEnv = localRelayStartupEnvNames.some((name) => {
    const value = processEnv[name];

    return value !== undefined && value.length > 0;
  });
  const startupEnvArtifactLoaded = startupEnvArtifactResult?.success === true;
  const localRelayStartupEnvSource = localRelayStartupEnvSourceFor({
    artifactLoaded: startupEnvArtifactLoaded,
    processHasStartupEnv,
  });
  const receipt = buildMemoryRelayProvisioningPreflightReceipt({
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
    localRelayReadinessPath: args.localRelayReadinessPath,
    localRelayReadinessText: await readTextOrEmpty(localRelayReadinessPath),
    localRelayStartupEnv: {
      ...startupEnvFromArtifact,
      ...processEnv,
    },
    localRelayStartupEnvRef: safeLocalArtifactRef(
      args.localRelayStartupEnvPath
    ),
    localRelayStartupEnvSource,
    networkTools: input.networkTools ?? defaultNetworkToolProbes(),
    profile,
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
    await runMemoryRelayProvisioningPreflightCli({
      argv: process.argv.slice(2),
      repoRoot: process.cwd(),
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "memory_relay_provisioning_preflight_failed",
            message:
              error instanceof Error
                ? error.message
                : "Memory relay provisioning preflight failed.",
            redacted: true,
          },
          redacted: true,
          schemaVersion: "trusted.memory-relay.provisioning-preflight-error.v1",
          status: "failed",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
