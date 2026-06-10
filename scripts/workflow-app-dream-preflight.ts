#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { hashJson } from "../src/app/domain/hash.ts";
import {
  WorkflowLivePreflightReceiptSchema,
  WorkflowLivePreflightDreamSourceFamilySchema,
  WorkflowLivePreflightRemotePackageRowSchema,
  WorkflowLivePreflightRelayOperationSchema,
} from "../src/app/domain/schemas.ts";
import type {
  WorkflowLivePreflightCheck,
  WorkflowLivePreflightRelayCapability,
  WorkflowLivePreflightReceipt,
  WorkflowLivePreflightRemotePackageRow,
  WorkflowLivePreflightRemoteRegistry,
  WorkflowLivePreflightRemoteSecretInventory,
} from "../src/app/domain/schemas.ts";
import { dreamMemoryFabricPackageMetadata } from "../src/cartridges/dream-memory-fabric/package-seed.ts";
import { dreamTranscriptReviewSourceProfile } from "../src/cartridges/dream-memory-fabric/source-profile.ts";
import { TrustedLocalDreamMemoryRelayReadinessReceiptSchema } from "../src/cartridges/dream-memory-fabric/trusted-local-relay-http.ts";

const defaultReceiptPath =
  ".wrangler/workflow-app/dream-preflight/latest-dream-preflight.json";
const defaultLocalRelayProofPath =
  ".wrangler/workflow-app/dream-relay/latest-local-proof.json";
const defaultWorkerUrl =
  "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";
const expectedCartridgePackageId = "workflow/dream-memory-fabric";
const workflowId = "dream.memory-fabric";
if (dreamMemoryFabricPackageMetadata.packageId !== expectedCartridgePackageId) {
  throw new Error(
    `Expected package seed template not found: ${expectedCartridgePackageId}`
  );
}

const expectedCartridgeArtifactRef =
  dreamMemoryFabricPackageMetadata.latestArtifactRef;
const expectedCartridgeManifestHash = hashJson(
  dreamMemoryFabricPackageMetadata
);
const expectedCartridgeWorkflowNodeTypes =
  dreamMemoryFabricPackageMetadata.exports
    .filter((exportRecord) => exportRecord.kind === "workflow-node")
    .map((exportRecord) => exportRecord.nodeType)
    .filter((nodeType): nodeType is string => nodeType !== undefined);

const RelayReceiptFamilyCountSchema = z.object({
  family: z.string().min(1),
  receiptCount: z.number().int().min(0),
});

const secretEnvNames = [
  "DISCORD_BOT_TOKEN",
  "DREAM_MEMORY_RELAY_TOKEN",
  "GITHUB_TOKEN",
  "LINEAR_API_TOKEN",
  "PI_AUTH_JSON_B64",
  "WORKFLOW_APP_ADMIN_TOKEN",
  "WORKFLOW_EXTERNAL_TELEMETRY_BEARER_TOKEN",
  "WZRRD_API_TOKEN",
] as const;

interface CommandResult {
  readonly command: readonly string[];
  readonly durationMs: number;
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface DreamPreflightArgs {
  readonly allowMissing: boolean;
  readonly checkRemote: boolean;
  readonly localRelayProofPath: string;
  readonly receiptPath: string;
  readonly workerUrl?: string;
}

interface EnvRequirement {
  readonly name: string;
  readonly required: boolean;
  readonly requiredFor: readonly string[];
}

interface BuildDreamLivePreflightReceiptInput {
  readonly deployScriptText: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedAt: string;
  readonly localRelayProofCheck: WorkflowLivePreflightCheck;
  readonly relayReadinessCheck: WorkflowLivePreflightCheck;
  readonly remoteRegistry: WorkflowLivePreflightRemoteRegistry;
  readonly remoteSecrets: WorkflowLivePreflightRemoteSecretInventory;
  readonly workerUrl: string;
  readonly wranglerConfigText: string;
}

interface RunCommandInput {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly secretValues: readonly string[];
}

const envRequirements: readonly EnvRequirement[] = [
  {
    name: "WORKFLOW_APP_ADMIN_TOKEN",
    required: true,
    requiredFor: ["package-seed-admin-route"],
  },
  {
    name: "PI_AUTH_JSON_B64",
    required: true,
    requiredFor: ["real-pi-agent-lane"],
  },
  {
    name: "WORKFLOW_APP_MODEL",
    required: true,
    requiredFor: ["cloudflare-agent-runtime"],
  },
  {
    name: "DREAM_MEMORY_RELAY_BASE_URL",
    required: true,
    requiredFor: ["dream-memory-relay-binding"],
  },
  {
    name: "DREAM_MEMORY_RELAY_TOKEN",
    required: true,
    requiredFor: ["dream-memory-relay-lease"],
  },
  {
    name: "DISCORD_BOT_TOKEN",
    required: false,
    requiredFor: ["optional-discord-status-report"],
  },
  {
    name: "WZRRD_API_TOKEN",
    required: true,
    requiredFor: ["dream-hitl-report-wzrrd-publish"],
  },
] as const;

const remoteRegistryCommand = [
  "exec",
  "wrangler",
  "d1",
  "execute",
  "pi-cloudflare-sandbox-workflows",
  "--remote",
  "--config",
  "wrangler.jsonc",
  "--command",
  "select package_id, artifact_ref, manifest_hash from packages order by package_id;",
] as const;

const remoteSecretInventoryCommand = [
  "exec",
  "wrangler",
  "secret",
  "list",
  "--config",
  "wrangler.jsonc",
] as const;

const relayRequiredOperations = z
  .array(WorkflowLivePreflightRelayOperationSchema)
  .parse(dreamTranscriptReviewSourceProfile.allowedRelayOperations);
const relayAllowedSourceFamilies = z
  .array(WorkflowLivePreflightDreamSourceFamilySchema)
  .parse(dreamTranscriptReviewSourceProfile.sourceFamiliesExpected);
const localProofRequiredRuntimes =
  dreamTranscriptReviewSourceProfile.requiredRuntimes;
const localProofRequiredMachineIds =
  dreamTranscriptReviewSourceProfile.requiredMachineIds;
const localProofRequiredSourceFamilies = relayAllowedSourceFamilies;

const LocalProofMachineCoverageSchema = z.object({
  authorityCount: z.number().int().min(0),
  machineId: z.string().min(1),
  missingReason: z.string().min(1).optional(),
  sourceCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalProofSourceFamilyCoverageSchema = z.object({
  authorityCount: z.number().int().min(0),
  family: z.string().min(1),
  missingReason: z.string().min(1).optional(),
  sourceCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalRelayProofReceiptSchema = z.object({
  backfill: z.object({
    actionCount: z.number().int().min(0),
    captureFixCount: z.number().int().min(0),
    status: z.string().min(1),
  }),
  backfillRun: z.object({
    blockedCount: z.number().int().min(0),
    completedCount: z.number().int().min(0),
    failedCount: z.number().int().min(0),
    skippedCount: z.number().int().min(0),
  }),
  checkedAt: z.string().min(1),
  correlation: z.object({
    edgeCount: z.number().int().min(1),
    nodeCount: z.number().int().min(1),
  }),
  health: z.object({
    blindSpotCount: z.number().int().min(0),
    degradedSourceCount: z.number().int().min(0),
    status: z.string().min(1),
  }),
  inventory: z.object({
    machineCoverage: z.array(LocalProofMachineCoverageSchema).default([]),
    runtimeCoverage: z.array(
      z.object({
        count: z.number().int().min(0),
        runtime: z.string().min(1),
        status: z.string().min(1),
      })
    ),
    sourceCount: z.number().int().min(1),
    sourceFamilyCoverage: z
      .array(LocalProofSourceFamilyCoverageSchema)
      .default([]),
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
    skippedSourceCount: z.number().int().min(0),
  }),
  sourceRootCount: z.number().int().min(1),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPresent = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length > 0;

const stripMatchingQuotes = (value: string): string => {
  if (value.length < 2) {
    return value;
  }

  const first = value.at(0);
  const last = value.at(-1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
};

export const parseDotEnvContent = (content: string): Record<string, string> => {
  const parsed: Record<string, string> = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = stripMatchingQuotes(trimmed.slice(index + 1).trim());
    if (key) {
      parsed[key] = value;
    }
  }

  return parsed;
};

const firstJsonArrayText = (output: string): string | null => {
  const lines = output.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trimStart().startsWith("["));
  if (start === -1) {
    return null;
  }

  return lines.slice(start).join("\n").trim();
};

export const extractPackageRowsFromD1Output = (
  output: string
): WorkflowLivePreflightRemotePackageRow[] => {
  const jsonText = firstJsonArrayText(output);
  if (jsonText === null) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const packageRows: WorkflowLivePreflightRemotePackageRow[] = [];
  for (const envelope of parsed) {
    if (!isRecord(envelope)) {
      continue;
    }

    const { results } = envelope;
    if (!Array.isArray(results)) {
      continue;
    }

    for (const row of results) {
      if (!isRecord(row)) {
        continue;
      }

      const {
        artifact_ref: artifactRef,
        manifest_hash: manifestHash,
        package_id: packageId,
      } = row;
      if (typeof packageId === "string" && packageId.length > 0) {
        packageRows.push(
          WorkflowLivePreflightRemotePackageRowSchema.parse({
            ...(typeof artifactRef === "string" && artifactRef.length > 0
              ? { artifactRef }
              : {}),
            ...(typeof manifestHash === "string" && manifestHash.length > 0
              ? { manifestHash }
              : {}),
            packageId,
          })
        );
      }
    }
  }

  return packageRows;
};

export const extractPackageIdsFromD1Output = (output: string): string[] => {
  const rows = extractPackageRowsFromD1Output(output);

  return rows.map((row) => row.packageId);
};

export const extractSecretNamesFromWranglerOutput = (
  output: string
): string[] => {
  const jsonText = firstJsonArrayText(output);
  if (jsonText === null) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map((row) => (isRecord(row) ? row["name"] : null))
    .filter((name): name is string => typeof name === "string");
};

const redactText = (value: string, secretValues: readonly string[]): string => {
  let redacted = value;
  for (const secretValue of secretValues) {
    redacted = redacted.replaceAll(secretValue, "[redacted]");
  }

  return redacted;
};

const collectSecretValues = (
  env: Readonly<Record<string, string | undefined>>
): readonly string[] =>
  secretEnvNames
    .map((name) => env[name])
    .filter((value): value is string => isPresent(value));

const readTextOrEmpty = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
};

const checkEnvRequirement = (
  env: Readonly<Record<string, string | undefined>>,
  requirement: EnvRequirement,
  remoteSecretNames: ReadonlySet<string>
): WorkflowLivePreflightCheck => {
  const present = isPresent(env[requirement.name]);
  const presentRemoteSecret = remoteSecretNames.has(requirement.name);
  let status: WorkflowLivePreflightCheck["status"] = "skipped";
  if (present) {
    status = "present";
  } else if (presentRemoteSecret) {
    status = "present";
  } else if (requirement.required) {
    status = "missing";
  }

  return {
    checkId: `env:${requirement.name}`,
    message:
      present || presentRemoteSecret
        ? `${requirement.name} is configured${
            presentRemoteSecret && !present ? " as a remote Worker secret" : ""
          }.`
        : `${requirement.name} is not configured.`,
    redacted: true,
    required: requirement.required,
    requiredFor: [...requirement.requiredFor],
    status,
  };
};

const checkSourceText = (input: {
  readonly checkId: string;
  readonly missingMessage: string;
  readonly presentMessage: string;
  readonly requiredFor: readonly string[];
  readonly sourceText: string;
  readonly token: string;
}): WorkflowLivePreflightCheck => {
  const present = input.sourceText.includes(input.token);
  return {
    checkId: input.checkId,
    message: present ? input.presentMessage : input.missingMessage,
    redacted: true,
    required: true,
    requiredFor: [...input.requiredFor],
    status: present ? "passed" : "missing",
  };
};

const relayHealthUrl = (baseUrl: string): string => {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return new URL("healthz", normalized).toString();
};

const missingRelayReadinessCheck = (
  message: string
): WorkflowLivePreflightCheck => ({
  checkId: "relay:healthz",
  message,
  redacted: true,
  required: true,
  requiredFor: ["dream-memory-relay-readiness", "dream-memory-relay-lease"],
  status: "missing",
});

const failedRelayReadinessCheck = (
  message: string
): WorkflowLivePreflightCheck => ({
  checkId: "relay:healthz",
  message,
  redacted: true,
  required: true,
  requiredFor: ["dream-memory-relay-readiness", "dream-memory-relay-lease"],
  status: "failed",
});

export const checkDreamRelayReadiness = async (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
}): Promise<WorkflowLivePreflightCheck> => {
  const relayBaseUrl = input.env["DREAM_MEMORY_RELAY_BASE_URL"];
  const relayToken = input.env["DREAM_MEMORY_RELAY_TOKEN"];
  if (relayBaseUrl === undefined || relayBaseUrl.trim().length === 0) {
    return missingRelayReadinessCheck(
      "Dream memory relay readiness was not checked because DREAM_MEMORY_RELAY_BASE_URL is missing."
    );
  }

  if (relayToken === undefined || relayToken.trim().length === 0) {
    return missingRelayReadinessCheck(
      "Dream memory relay readiness was not checked because DREAM_MEMORY_RELAY_TOKEN is missing."
    );
  }

  try {
    const fetcher = input.fetch ?? fetch;
    const response = await fetcher(relayHealthUrl(relayBaseUrl), {
      headers: {
        authorization: `Bearer ${relayToken}`,
      },
      method: "GET",
    });
    const responseText = await response.text();
    if (!response.ok) {
      return failedRelayReadinessCheck(
        `Dream memory relay /healthz returned HTTP ${response.status}.`
      );
    }

    const readinessResult =
      TrustedLocalDreamMemoryRelayReadinessReceiptSchema.safeParse(
        JSON.parse(responseText)
      );
    if (!readinessResult.success) {
      return failedRelayReadinessCheck(
        "Dream memory relay /healthz returned an invalid redacted readiness receipt."
      );
    }

    const { data: readiness } = readinessResult;
    const supportedOperations = new Set(readiness.supportedOperations);
    const missingOperations = relayRequiredOperations.filter(
      (operation) => !supportedOperations.has(operation)
    );
    if (missingOperations.length > 0) {
      return failedRelayReadinessCheck(
        `Dream memory relay readiness is missing required operations: ${missingOperations.join(", ")}.`
      );
    }

    if (readiness.rawCredentialsReturned || readiness.rawPathsReturned) {
      return failedRelayReadinessCheck(
        "Dream memory relay readiness reported raw credentials or raw paths."
      );
    }

    return {
      checkId: "relay:healthz",
      message:
        "Dream memory relay /healthz returned a redacted readiness receipt with required operations.",
      redacted: true,
      required: true,
      requiredFor: ["dream-memory-relay-readiness", "dream-memory-relay-lease"],
      status: "passed",
    };
  } catch (error) {
    return failedRelayReadinessCheck(
      `Dream memory relay readiness check failed: ${
        error instanceof Error
          ? redactText(error.message, [relayToken])
          : "Unknown relay readiness error."
      }`
    );
  }
};

const missingLocalRelayProofCheck = (
  message: string
): WorkflowLivePreflightCheck => ({
  checkId: "relay:local-proof",
  message,
  redacted: true,
  required: true,
  requiredFor: [
    "dream-memory-relay-local-proof",
    "dream-memory-relay-network-exposure-safety",
  ],
  status: "missing",
});

const failedLocalRelayProofCheck = (
  message: string
): WorkflowLivePreflightCheck => ({
  checkId: "relay:local-proof",
  message,
  redacted: true,
  required: true,
  requiredFor: [
    "dream-memory-relay-local-proof",
    "dream-memory-relay-network-exposure-safety",
  ],
  status: "failed",
});

const receiptFamilySummary = (
  counts: readonly z.infer<typeof RelayReceiptFamilyCountSchema>[]
): string | null => {
  if (counts.length === 0) {
    return null;
  }

  return counts
    .map((count) => `${count.family}:${count.receiptCount}`)
    .join(", ");
};

export const checkLocalRelayProof = async (
  proofPath: string
): Promise<WorkflowLivePreflightCheck> => {
  const proofText = await readTextOrEmpty(proofPath);
  if (proofText.trim().length === 0) {
    return missingLocalRelayProofCheck(
      `Trusted local Dream relay proof receipt is missing at ${proofPath}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(proofText);
  } catch {
    return failedLocalRelayProofCheck(
      "Trusted local Dream relay proof receipt is not valid JSON."
    );
  }

  const proofResult = LocalRelayProofReceiptSchema.safeParse(parsed);
  if (!proofResult.success) {
    return failedLocalRelayProofCheck(
      "Trusted local Dream relay proof receipt failed schema validation."
    );
  }

  const { data: proof } = proofResult;
  const coverageByRuntime = new Map(
    proof.inventory.runtimeCoverage.map((coverage) => [
      coverage.runtime,
      coverage,
    ])
  );
  const missingRuntimes = localProofRequiredRuntimes.filter((runtime) => {
    const coverage = coverageByRuntime.get(runtime);

    return (
      coverage === undefined ||
      coverage.status !== "captured" ||
      coverage.count <= 0
    );
  });
  if (missingRuntimes.length > 0) {
    return failedLocalRelayProofCheck(
      `Trusted local Dream relay proof is missing captured native runtime coverage for: ${missingRuntimes.join(", ")}.`
    );
  }

  const coverageByMachine = new Map(
    proof.inventory.machineCoverage.map((coverage) => [
      coverage.machineId,
      coverage,
    ])
  );
  const missingMachines = localProofRequiredMachineIds.filter((machineId) => {
    const coverage = coverageByMachine.get(machineId);

    return (
      coverage === undefined ||
      coverage.status !== "captured" ||
      coverage.sourceCount <= 0 ||
      coverage.authorityCount <= 0
    );
  });
  if (missingMachines.length > 0) {
    return failedLocalRelayProofCheck(
      `Trusted local Dream relay proof is missing required machine coverage for: ${missingMachines.join(", ")}.`
    );
  }

  const coverageBySourceFamily = new Map(
    proof.inventory.sourceFamilyCoverage.map((coverage) => [
      coverage.family,
      coverage,
    ])
  );
  const unreportedSourceFamilies = localProofRequiredSourceFamilies.filter(
    (family) => !coverageBySourceFamily.has(family)
  );
  if (unreportedSourceFamilies.length > 0) {
    return failedLocalRelayProofCheck(
      `Trusted local Dream relay proof is missing explicit source-family coverage for: ${unreportedSourceFamilies.join(", ")}.`
    );
  }
  const missingSourceFamilies = localProofRequiredSourceFamilies.filter(
    (family) => {
      const coverage = coverageBySourceFamily.get(family);

      return (
        coverage === undefined ||
        coverage.status !== "captured" ||
        coverage.sourceCount <= 0 ||
        coverage.authorityCount <= 0
      );
    }
  );

  if (proof.rawPathLeaked || proof.rawPathsReturned) {
    return failedLocalRelayProofCheck(
      "Trusted local Dream relay proof reported raw path leakage."
    );
  }

  if (proof.rawCredentialsReturned) {
    return failedLocalRelayProofCheck(
      "Trusted local Dream relay proof reported raw credential leakage."
    );
  }

  const backfillRunResultCount =
    proof.backfillRun.blockedCount +
    proof.backfillRun.completedCount +
    proof.backfillRun.failedCount +
    proof.backfillRun.skippedCount;
  if (backfillRunResultCount !== proof.backfill.actionCount) {
    return failedLocalRelayProofCheck(
      "Trusted local Dream relay proof backfill-run receipt does not match the planned action count."
    );
  }

  const familySummary = receiptFamilySummary(proof.search.hydratedFamilyCounts);
  const summarySuffix =
    familySummary === null
      ? "."
      : ` across hydrated families ${familySummary}.`;
  const missingSourceFamilySuffix =
    missingSourceFamilies.length === 0
      ? ""
      : ` Missing source families are explicitly reported: ${missingSourceFamilies.join(", ")}.`;

  return {
    checkId: "relay:local-proof",
    message: `Trusted local Dream relay proof passed with ${proof.sourceRootCount} source roots, ${proof.backfill.actionCount} backfill action receipt(s), ${proof.search.hitCount} search hits, ${proof.search.hydratedCount} hydrated redacted receipts, and ${proof.correlation.edgeCount} correlation edges${summarySuffix}${missingSourceFamilySuffix}`,
    redacted: true,
    required: true,
    requiredFor: [
      "dream-memory-relay-local-proof",
      "dream-memory-relay-network-exposure-safety",
    ],
    status: "passed",
  };
};

const commandResultFromSpawn = (input: {
  readonly args: readonly string[];
  readonly code: null | number;
  readonly durationMs: number;
  readonly secretValues: readonly string[];
  readonly stderr: string;
  readonly stdout: string;
}): CommandResult => ({
  command: ["pnpm", ...input.args],
  durationMs: input.durationMs,
  exitCode: input.code ?? 1,
  stderr: redactText(input.stderr, input.secretValues),
  stdout: redactText(input.stdout, input.secretValues),
});

const runCommand = (input: RunCommandInput): CommandResult => {
  const started = Date.now();
  const result = spawnSync("pnpm", [...input.args], {
    cwd: input.cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errorMessage = result.error?.message;
  const stderr =
    errorMessage === undefined
      ? result.stderr
      : `${result.stderr}\n${errorMessage}`;

  return commandResultFromSpawn({
    args: input.args,
    code: result.status,
    durationMs: Date.now() - started,
    secretValues: input.secretValues,
    stderr,
    stdout: result.stdout,
  });
};

const expectedRemoteRegistryFields = () => ({
  expectedPackageArtifactRef: expectedCartridgeArtifactRef,
  expectedPackageManifestHash: expectedCartridgeManifestHash,
  expectedWorkflowNodeTypes: expectedCartridgeWorkflowNodeTypes,
});

const buildRemoteRegistryFromResult = (
  result: CommandResult
): WorkflowLivePreflightRemoteRegistry => {
  const packageRows = extractPackageRowsFromD1Output(result.stdout);
  const expectedPackageRow = packageRows.find(
    (row) => row.packageId === expectedCartridgePackageId
  );
  const expectedPackageSeeded = expectedPackageRow !== undefined;
  const expectedPackageArtifactRefMatched =
    expectedPackageRow?.artifactRef === expectedCartridgeArtifactRef;
  const expectedPackageManifestHashMatched =
    expectedPackageRow?.manifestHash === expectedCartridgeManifestHash;
  if (result.exitCode !== 0) {
    return {
      command: [...result.command],
      errorMessage: "Remote Cloudflare D1 package registry query failed.",
      ...expectedRemoteRegistryFields(),
      expectedPackageArtifactRefMatched,
      expectedPackageId: expectedCartridgePackageId,
      expectedPackageManifestHashMatched,
      expectedPackageSeeded,
      packageIds: packageRows.map((row) => row.packageId),
      packageRows,
      redacted: true,
      status: "failed",
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  return {
    command: [...result.command],
    ...expectedRemoteRegistryFields(),
    expectedPackageArtifactRefMatched,
    expectedPackageId: expectedCartridgePackageId,
    expectedPackageManifestHashMatched,
    expectedPackageSeeded,
    packageIds: packageRows.map((row) => row.packageId),
    packageRows,
    redacted: true,
    status: "queried",
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const skippedRemoteRegistry = (): WorkflowLivePreflightRemoteRegistry => ({
  command: [],
  errorMessage: "Remote Cloudflare D1 package registry query was skipped.",
  ...expectedRemoteRegistryFields(),
  expectedPackageArtifactRefMatched: false,
  expectedPackageId: expectedCartridgePackageId,
  expectedPackageManifestHashMatched: false,
  expectedPackageSeeded: false,
  packageIds: [],
  packageRows: [],
  redacted: true,
  status: "skipped",
});

const buildRemoteSecretInventoryFromResult = (
  result: CommandResult
): WorkflowLivePreflightRemoteSecretInventory => {
  const secretNames = extractSecretNamesFromWranglerOutput(result.stdout);
  if (result.exitCode !== 0) {
    return {
      command: [...result.command],
      errorMessage: "Remote Cloudflare Worker secret inventory query failed.",
      redacted: true,
      secretNames,
      status: "failed",
      stderr: result.stderr,
      stdout: result.stdout,
    };
  }

  return {
    command: [...result.command],
    redacted: true,
    secretNames,
    status: "queried",
    stderr: result.stderr,
    stdout: result.stdout,
  };
};

const skippedRemoteSecretInventory =
  (): WorkflowLivePreflightRemoteSecretInventory => ({
    command: [],
    errorMessage: "Remote Cloudflare Worker secret inventory was skipped.",
    redacted: true,
    secretNames: [],
    status: "skipped",
  });

const requiredActionForCheck = (
  check: WorkflowLivePreflightCheck
): null | string => {
  if (
    !check.required ||
    (check.status !== "missing" && check.status !== "failed")
  ) {
    return null;
  }

  if (check.checkId === "env:WORKFLOW_APP_ADMIN_TOKEN") {
    return "Set WORKFLOW_APP_ADMIN_TOKEN so package seed admin routes can run.";
  }

  if (check.checkId === "env:PI_AUTH_JSON_B64") {
    return "Provision PI_AUTH_JSON_B64 as the real Pi agent auth lease material.";
  }

  if (check.checkId === "env:WORKFLOW_APP_MODEL") {
    return "Set WORKFLOW_APP_MODEL for the Cloudflare Worker agent runtime.";
  }

  if (check.checkId === "env:DREAM_MEMORY_RELAY_BASE_URL") {
    return "Set DREAM_MEMORY_RELAY_BASE_URL for the trusted memory relay endpoint.";
  }

  if (check.checkId === "env:DREAM_MEMORY_RELAY_TOKEN") {
    return "Provision DREAM_MEMORY_RELAY_TOKEN as a Worker secret for the trusted memory relay.";
  }

  if (check.checkId === "env:WZRRD_API_TOKEN") {
    return "Provision WZRRD_API_TOKEN so the Dream HITL report can be published as the required Wzrrd document.";
  }

  if (check.checkId === "wrangler:DREAM_MEMORY_RELAY_BASE_URL") {
    return "Add DREAM_MEMORY_RELAY_BASE_URL to Worker deploy configuration or deploy-time vars.";
  }

  if (check.checkId === "deploy-secret:DREAM_MEMORY_RELAY_TOKEN") {
    return "Add DREAM_MEMORY_RELAY_TOKEN to Worker secret propagation before deploying.";
  }

  if (check.checkId === "relay:local-proof") {
    if (check.message?.includes("missing required machine coverage")) {
      const missingMachineIds =
        check.message.split("for: ").at(1)?.replace(/\.$/u, "") ??
        "required machines";

      return `Add or provision trusted Dream source roots for missing machine coverage (${missingMachineIds}) before exposing the relay to Cloudflare.`;
    }

    return "Run pnpm app:dream:relay:proof and inspect the redacted local relay proof before exposing the relay to Cloudflare.";
  }

  if (check.checkId === "relay:healthz") {
    return "Start or provision the trusted Dream memory relay and verify its authenticated /healthz readiness receipt.";
  }

  return check.message ?? `Resolve ${check.checkId}.`;
};

const requiredActionsForRemoteRegistry = (
  remoteRegistry: WorkflowLivePreflightRemoteRegistry
): readonly string[] => {
  if (remoteRegistry.status === "failed") {
    return [
      "Re-run preflight with Cloudflare Wrangler auth available, or inspect remote D1 package rows manually.",
    ];
  }

  if (remoteRegistry.status === "skipped") {
    return [
      "Run preflight with the remote Cloudflare D1 package registry check enabled.",
    ];
  }

  if (remoteRegistry.expectedPackageSeeded !== true) {
    return [
      `Deploy current Worker code and seed packages so ${expectedCartridgePackageId} exists in remote Cloudflare D1/artifacts.`,
    ];
  }

  if (
    remoteRegistry.expectedPackageArtifactRefMatched !== true ||
    remoteRegistry.expectedPackageManifestHashMatched !== true
  ) {
    return [
      `Re-seed ${expectedCartridgePackageId} so the remote artifact ref and manifest hash match the current Dream cartridge manifest, including joelclaw.dream.backfill-run, joelclaw.dream.correlate, joelclaw.dream.refinement-proposals, and joelclaw.dream.hitl-report.`,
    ];
  }

  return [];
};

const requiredActionsForChecks = (
  checks: readonly WorkflowLivePreflightCheck[]
): readonly string[] =>
  checks
    .map((check) => requiredActionForCheck(check))
    .filter((action): action is string => action !== null);

const checkStatusFor = (
  checks: readonly WorkflowLivePreflightCheck[],
  checkId: string
): WorkflowLivePreflightCheck["status"] =>
  checks.find((check) => check.checkId === checkId)?.status ?? "missing";

const dreamRelayCapabilityFor = (input: {
  readonly checks: readonly WorkflowLivePreflightCheck[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly remoteSecretNames: ReadonlySet<string>;
  readonly wranglerConfigText: string;
}): WorkflowLivePreflightRelayCapability => {
  const endpointConfigured =
    isPresent(input.env["DREAM_MEMORY_RELAY_BASE_URL"]) ||
    input.wranglerConfigText.includes("DREAM_MEMORY_RELAY_BASE_URL");
  const tokenConfigured =
    isPresent(input.env["DREAM_MEMORY_RELAY_TOKEN"]) ||
    input.remoteSecretNames.has("DREAM_MEMORY_RELAY_TOKEN");
  const workerBaseUrlConfigured = input.wranglerConfigText.includes(
    "DREAM_MEMORY_RELAY_BASE_URL"
  );
  const secretRef =
    input.env["DREAM_MEMORY_RELAY_SECRET_REF"]?.trim() ||
    "secretref:dream-memory-relay";

  return {
    allowedOperations: [...relayRequiredOperations],
    allowedSourceFamilies: [...relayAllowedSourceFamilies],
    budget: {
      maxFiles: 500,
      maxRows: 1000,
      maxTokens: 100_000,
    },
    capability: "dream.memory.relay",
    idempotencyKeyPrefix: "dream-memory-relay",
    lease: {
      required: true,
      secretBindingName: "DREAM_MEMORY_RELAY_TOKEN",
      secretRef,
    },
    readiness: {
      endpointConfigured,
      healthzStatus: checkStatusFor(input.checks, "relay:healthz"),
      localProofStatus: checkStatusFor(input.checks, "relay:local-proof"),
      tokenConfigured,
      workerBaseUrlConfigured,
    },
    redacted: true,
    redactionPolicy: {
      mode: "redacted-evidence",
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    relayReceiptsRequired: true,
    traceCapability: "dream.memory.relay",
  };
};

export const buildDreamLivePreflightReceipt = (
  input: BuildDreamLivePreflightReceiptInput
): WorkflowLivePreflightReceipt => {
  const remoteSecretNames = new Set(input.remoteSecrets.secretNames);
  const checks = [
    ...envRequirements.map((requirement) =>
      checkEnvRequirement(input.env, requirement, remoteSecretNames)
    ),
    checkSourceText({
      checkId: "wrangler:DREAM_MEMORY_RELAY_BASE_URL",
      missingMessage:
        "Worker deploy config does not define DREAM_MEMORY_RELAY_BASE_URL.",
      presentMessage:
        "Worker deploy config defines DREAM_MEMORY_RELAY_BASE_URL.",
      requiredFor: ["dream-memory-relay-binding"],
      sourceText: input.wranglerConfigText,
      token: "DREAM_MEMORY_RELAY_BASE_URL",
    }),
    checkSourceText({
      checkId: "deploy-secret:DREAM_MEMORY_RELAY_TOKEN",
      missingMessage:
        "Deploy script does not propagate DREAM_MEMORY_RELAY_TOKEN.",
      presentMessage: "Deploy script propagates DREAM_MEMORY_RELAY_TOKEN.",
      requiredFor: ["dream-memory-relay-lease"],
      sourceText: input.deployScriptText,
      token: "DREAM_MEMORY_RELAY_TOKEN",
    }),
    input.localRelayProofCheck,
    input.relayReadinessCheck,
  ];
  const requiredActions = [
    ...requiredActionsForChecks(checks),
    ...requiredActionsForRemoteRegistry(input.remoteRegistry),
  ];
  const requiredChecksReady = checks.every(
    (check) =>
      !check.required ||
      (check.status !== "missing" && check.status !== "failed")
  );
  const remoteReady =
    input.remoteRegistry.status === "queried" &&
    input.remoteRegistry.expectedPackageArtifactRefMatched === true &&
    input.remoteRegistry.expectedPackageManifestHashMatched === true &&
    input.remoteRegistry.expectedPackageSeeded === true;

  return WorkflowLivePreflightReceiptSchema.parse({
    artifactModel: {
      cartridgeKind: "artifact-backed-workflow-cartridge",
      dynamicWorkflowRequiresGeneratedMachine: true,
      generatedArtifactsRequired: [
        "planner prompt/transcript",
        "workflow.xstate-machine.v1 config artifact",
        "generated TypeScript harness source",
        "machine/harness hashes",
        "dream.refinement-proposals.v1 proposal artifact",
        "dream.hitl-report.v1 MDSvX report artifact",
        "workflow.execution-proof.v1 Cloudflare execution proof",
        "workflow.cartridge-invocation-proof.v1 per-node proofs",
        "wzrrd.site.publish capability receipt for the Dream report",
      ],
      sideEffectsRequireCapabilityLeases: true,
    },
    checks,
    expectedCartridgePackageId,
    generatedAt: input.generatedAt,
    redacted: true,
    relayCapability: dreamRelayCapabilityFor({
      checks,
      env: input.env,
      remoteSecretNames,
      wranglerConfigText: input.wranglerConfigText,
    }),
    remoteRegistry: input.remoteRegistry,
    remoteSecrets: input.remoteSecrets,
    requiredActions,
    schemaVersion: "workflow.live-preflight.v1",
    status: requiredChecksReady && remoteReady ? "ready" : "blocked",
    workerUrl: input.workerUrl,
    workflowId,
  });
};

const parseArgs = (argv: readonly string[]): DreamPreflightArgs => {
  const hasArg = (name: string): boolean => argv.includes(name);
  const getArgValue = (name: string): string | undefined => {
    const prefix = `${name}=`;
    return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  };
  const workerUrl = getArgValue("--worker-url");

  const args = {
    allowMissing: hasArg("--allow-missing"),
    checkRemote: !hasArg("--skip-remote"),
    localRelayProofPath:
      getArgValue("--local-relay-proof-path") ?? defaultLocalRelayProofPath,
    receiptPath: getArgValue("--receipt-path") ?? defaultReceiptPath,
  };

  if (workerUrl === undefined) {
    return args;
  }

  return {
    ...args,
    workerUrl,
  };
};

const readDotEnvLocal = async (
  repoRoot: string
): Promise<Record<string, string>> =>
  parseDotEnvContent(await readTextOrEmpty(resolve(repoRoot, ".env.local")));

const queryRemoteRegistry = (input: {
  readonly repoRoot: string;
  readonly secretValues: readonly string[];
}): WorkflowLivePreflightRemoteRegistry =>
  buildRemoteRegistryFromResult(
    runCommand({
      args: remoteRegistryCommand,
      cwd: input.repoRoot,
      secretValues: input.secretValues,
    })
  );

const queryRemoteSecretInventory = (input: {
  readonly repoRoot: string;
  readonly secretValues: readonly string[];
}): WorkflowLivePreflightRemoteSecretInventory =>
  buildRemoteSecretInventoryFromResult(
    runCommand({
      args: remoteSecretInventoryCommand,
      cwd: input.repoRoot,
      secretValues: input.secretValues,
    })
  );

export const runDreamPreflightCli = async (input: {
  readonly argv: readonly string[];
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}): Promise<WorkflowLivePreflightReceipt> => {
  const args = parseArgs(input.argv);
  const dotEnv = await readDotEnvLocal(input.repoRoot);
  const env = {
    ...dotEnv,
    ...input.processEnv,
  };
  const secretValues = collectSecretValues(env);
  const deployScriptText = await readTextOrEmpty(
    resolve(input.repoRoot, "scripts/workflow-app-deploy-and-seed.mjs")
  );
  const log = input.log ?? console.log;
  const remoteRegistry = args.checkRemote
    ? queryRemoteRegistry({
        repoRoot: input.repoRoot,
        secretValues,
      })
    : skippedRemoteRegistry();
  const remoteSecrets = args.checkRemote
    ? queryRemoteSecretInventory({
        repoRoot: input.repoRoot,
        secretValues,
      })
    : skippedRemoteSecretInventory();
  const receipt = buildDreamLivePreflightReceipt({
    deployScriptText,
    env,
    generatedAt: new Date().toISOString(),
    localRelayProofCheck: await checkLocalRelayProof(
      resolve(input.repoRoot, args.localRelayProofPath)
    ),
    relayReadinessCheck: await checkDreamRelayReadiness({
      env,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    }),
    remoteRegistry,
    remoteSecrets,
    workerUrl: args.workerUrl ?? env["WORKFLOW_APP_URL"] ?? defaultWorkerUrl,
    wranglerConfigText: await readTextOrEmpty(
      resolve(input.repoRoot, "wrangler.jsonc")
    ),
  });
  const receiptPath = resolve(input.repoRoot, args.receiptPath);

  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receiptPath}`);

  if (!args.allowMissing && receipt.status !== "ready") {
    process.exitCode = 1;
  }

  return receipt;
};

const isMainModule = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.filename === resolve(process.argv[1]);

if (isMainModule()) {
  await runDreamPreflightCli({
    argv: process.argv.slice(2),
    processEnv: process.env,
    repoRoot: resolve(import.meta.dirname, ".."),
  });
}
