#!/usr/bin/env tsx
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { hashJson } from "../src/app/domain/hash.ts";
import {
  WorkflowLivePreflightReceiptSchema,
  WorkflowLivePreflightMemorySourceFamilySchema,
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
import type { MemorySourceProfile } from "../src/app/domain/source-profile.ts";
import { packageMetadataForSeedTemplate } from "../src/app/infrastructure/cloudflare-package-seeder.ts";
import { defaultPackageSeedTemplatesWithInstalledCartridges } from "../src/cartridges/cloudflare-workflow-cartridges.ts";
import { TrustedLocalMemoryRelayReadinessReceiptSchema } from "../src/cartridges/memory-fabric/trusted-local-relay-http.ts";
import {
  requireInstalledSourceProfile,
  workflowProfileWorkspacePaths,
} from "./workflow-app-profile.ts";

const defaultLocalRelayProofPath =
  ".wrangler/workflow-app/memory-relay/latest-local-proof.json";
const defaultWorkerUrl =
  "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";

const RelayReceiptFamilyCountSchema = z.object({
  family: z.string().min(1),
  receiptCount: z.number().int().min(0),
});

const secretEnvNames = [
  "DISCORD_BOT_TOKEN",
  "MEMORY_RELAY_TOKEN",
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

interface WorkflowPreflightArgs {
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

interface CartridgeExpectations {
  readonly expectedCartridgeArtifactRef: string;
  readonly expectedCartridgeManifestHash: string;
  readonly expectedCartridgePackageId: string;
  readonly expectedCartridgeSchemaExportIds: readonly string[];
  readonly expectedCartridgeWorkflowNodeTypes: readonly string[];
}

interface BuildWorkflowLivePreflightReceiptInput {
  readonly deployScriptText: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly generatedAt: string;
  readonly localRelayProofCheck: WorkflowLivePreflightCheck;
  readonly profile: MemorySourceProfile;
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
    name: "MEMORY_RELAY_BASE_URL",
    required: true,
    requiredFor: ["memory-relay-binding"],
  },
  {
    name: "MEMORY_RELAY_TOKEN",
    required: true,
    requiredFor: ["memory-relay-lease"],
  },
  {
    name: "DISCORD_BOT_TOKEN",
    required: false,
    requiredFor: ["optional-discord-status-report"],
  },
  {
    name: "WZRRD_API_TOKEN",
    required: true,
    requiredFor: ["memory-hitl-report-wzrrd-publish"],
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

const cartridgeExpectationsFor = (
  profile: MemorySourceProfile
): CartridgeExpectations => {
  const seedTemplate = defaultPackageSeedTemplatesWithInstalledCartridges.find(
    (template) => template.packageId === profile.packageId
  );
  if (seedTemplate === undefined) {
    throw new Error(
      `No installed package seed template found for ${profile.packageId}.`
    );
  }

  const metadata = packageMetadataForSeedTemplate(seedTemplate);

  return {
    expectedCartridgeArtifactRef: metadata.latestArtifactRef,
    expectedCartridgeManifestHash: hashJson(metadata),
    expectedCartridgePackageId: profile.packageId,
    expectedCartridgeSchemaExportIds: metadata.exports
      .filter((exportRecord) => exportRecord.kind === "schema")
      .map((exportRecord) => exportRecord.exportId),
    expectedCartridgeWorkflowNodeTypes: metadata.exports
      .filter((exportRecord) => exportRecord.kind === "workflow-node")
      .map((exportRecord) => exportRecord.nodeType)
      .filter((nodeType): nodeType is string => nodeType !== undefined),
  };
};

const relayRequiredOperationsFor = (profile: MemorySourceProfile) =>
  z
    .array(WorkflowLivePreflightRelayOperationSchema)
    .parse(profile.allowedRelayOperations);

const relayAllowedSourceFamiliesFor = (profile: MemorySourceProfile) =>
  z
    .array(WorkflowLivePreflightMemorySourceFamilySchema)
    .parse(profile.sourceFamiliesExpected);

const LocalProofSourceFamilyCoverageSchema = z.object({
  family: z.string().min(1),
  missingReason: z.string().min(1).optional(),
  receiptCount: z.number().int().min(0),
  sourceIds: z.array(z.string().min(1)).default([]),
  status: z.enum(["captured", "missing"]),
});

const LocalRelayProofReceiptSchema = z.object({
  checkedAt: z.string().min(1),
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
    skippedSourceCount: z.number().int().min(0),
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
  sourceFamilyCoverage: z
    .array(LocalProofSourceFamilyCoverageSchema)
    .default([]),
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
  requiredFor: ["memory-relay-readiness", "memory-relay-lease"],
  status: "missing",
});

const failedRelayReadinessCheck = (
  message: string
): WorkflowLivePreflightCheck => ({
  checkId: "relay:healthz",
  message,
  redacted: true,
  required: true,
  requiredFor: ["memory-relay-readiness", "memory-relay-lease"],
  status: "failed",
});

export const checkMemoryRelayReadiness = async (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly requiredOperations: readonly string[];
}): Promise<WorkflowLivePreflightCheck> => {
  const relayBaseUrl = input.env["MEMORY_RELAY_BASE_URL"];
  const relayToken = input.env["MEMORY_RELAY_TOKEN"];
  if (relayBaseUrl === undefined || relayBaseUrl.trim().length === 0) {
    return missingRelayReadinessCheck(
      "Memory relay readiness was not checked because MEMORY_RELAY_BASE_URL is missing."
    );
  }

  if (relayToken === undefined || relayToken.trim().length === 0) {
    return missingRelayReadinessCheck(
      "Memory relay readiness was not checked because MEMORY_RELAY_TOKEN is missing."
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
        `Memory relay /healthz returned HTTP ${response.status}.`
      );
    }

    const readinessResult =
      TrustedLocalMemoryRelayReadinessReceiptSchema.safeParse(
        JSON.parse(responseText)
      );
    if (!readinessResult.success) {
      return failedRelayReadinessCheck(
        "Memory relay /healthz returned an invalid redacted readiness receipt."
      );
    }

    const { data: readiness } = readinessResult;
    const supportedOperations = new Set<string>(readiness.supportedOperations);
    const missingOperations = input.requiredOperations.filter(
      (operation) => !supportedOperations.has(operation)
    );
    if (missingOperations.length > 0) {
      return failedRelayReadinessCheck(
        `Memory relay readiness is missing required operations: ${missingOperations.join(", ")}.`
      );
    }

    if (readiness.rawCredentialsReturned || readiness.rawPathsReturned) {
      return failedRelayReadinessCheck(
        "Memory relay readiness reported raw credentials or raw paths."
      );
    }

    return {
      checkId: "relay:healthz",
      message:
        "Memory relay /healthz returned a redacted readiness receipt with required operations.",
      redacted: true,
      required: true,
      requiredFor: ["memory-relay-readiness", "memory-relay-lease"],
      status: "passed",
    };
  } catch (error) {
    return failedRelayReadinessCheck(
      `Memory relay readiness check failed: ${
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
    "memory-relay-local-proof",
    "memory-relay-network-exposure-safety",
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
    "memory-relay-local-proof",
    "memory-relay-network-exposure-safety",
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

export const checkLocalRelayProof = async (input: {
  readonly proofPath: string;
  readonly requiredSourceFamilies: readonly string[];
}): Promise<WorkflowLivePreflightCheck> => {
  const proofText = await readTextOrEmpty(input.proofPath);
  if (proofText.trim().length === 0) {
    return missingLocalRelayProofCheck(
      `Trusted local Memory relay proof receipt is missing at ${input.proofPath}.`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(proofText);
  } catch {
    return failedLocalRelayProofCheck(
      "Trusted local Memory relay proof receipt is not valid JSON."
    );
  }

  const proofResult = LocalRelayProofReceiptSchema.safeParse(parsed);
  if (!proofResult.success) {
    return failedLocalRelayProofCheck(
      "Trusted local Memory relay proof receipt failed schema validation."
    );
  }

  const { data: proof } = proofResult;
  const coverageBySourceFamily = new Map(
    proof.sourceFamilyCoverage.map((coverage) => [coverage.family, coverage])
  );
  const missingSourceFamilies = input.requiredSourceFamilies.filter(
    (family) => {
      const coverage = coverageBySourceFamily.get(family);

      return (
        coverage === undefined ||
        coverage.status !== "captured" ||
        coverage.receiptCount <= 0
      );
    }
  );

  if (proof.rawPathLeaked || proof.rawPathsReturned) {
    return failedLocalRelayProofCheck(
      "Trusted local Memory relay proof reported raw path leakage."
    );
  }

  if (proof.rawCredentialsReturned) {
    return failedLocalRelayProofCheck(
      "Trusted local Memory relay proof reported raw credential leakage."
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
      : ` Coverage caveat (reported, not blocking): missing source families ${missingSourceFamilies.join(", ")}.`;

  return {
    checkId: "relay:local-proof",
    message: `Trusted local Memory relay proof passed with ${proof.sourceRootCount} source roots, ${proof.signals.signalCount} signal receipt(s), ${proof.search.hitCount} search hits, ${proof.search.hydratedCount} hydrated redacted receipts, and ${proof.correlation.edgeCount} correlation edges${summarySuffix}${missingSourceFamilySuffix}`,
    redacted: true,
    required: true,
    requiredFor: [
      "memory-relay-local-proof",
      "memory-relay-network-exposure-safety",
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

const expectedRemoteRegistryFields = (expectations: CartridgeExpectations) => ({
  expectedPackageArtifactRef: expectations.expectedCartridgeArtifactRef,
  expectedPackageManifestHash: expectations.expectedCartridgeManifestHash,
  expectedSchemaExportIds: [...expectations.expectedCartridgeSchemaExportIds],
  expectedWorkflowNodeTypes: [
    ...expectations.expectedCartridgeWorkflowNodeTypes,
  ],
});

const buildRemoteRegistryFromResult = (
  result: CommandResult,
  expectations: CartridgeExpectations
): WorkflowLivePreflightRemoteRegistry => {
  const packageRows = extractPackageRowsFromD1Output(result.stdout);
  const expectedPackageRow = packageRows.find(
    (row) => row.packageId === expectations.expectedCartridgePackageId
  );
  const expectedPackageSeeded = expectedPackageRow !== undefined;
  const expectedPackageArtifactRefMatched =
    expectedPackageRow?.artifactRef ===
    expectations.expectedCartridgeArtifactRef;
  const expectedPackageManifestHashMatched =
    expectedPackageRow?.manifestHash ===
    expectations.expectedCartridgeManifestHash;
  if (result.exitCode !== 0) {
    return {
      command: [...result.command],
      errorMessage: "Remote Cloudflare D1 package registry query failed.",
      ...expectedRemoteRegistryFields(expectations),
      expectedPackageArtifactRefMatched,
      expectedPackageId: expectations.expectedCartridgePackageId,
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
    ...expectedRemoteRegistryFields(expectations),
    expectedPackageArtifactRefMatched,
    expectedPackageId: expectations.expectedCartridgePackageId,
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

const skippedRemoteRegistry = (
  expectations: CartridgeExpectations
): WorkflowLivePreflightRemoteRegistry => ({
  command: [],
  errorMessage: "Remote Cloudflare D1 package registry query was skipped.",
  ...expectedRemoteRegistryFields(expectations),
  expectedPackageArtifactRefMatched: false,
  expectedPackageId: expectations.expectedCartridgePackageId,
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
  check: WorkflowLivePreflightCheck,
  profileId: string
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

  if (check.checkId === "env:MEMORY_RELAY_BASE_URL") {
    return "Set MEMORY_RELAY_BASE_URL for the trusted memory relay endpoint.";
  }

  if (check.checkId === "env:MEMORY_RELAY_TOKEN") {
    return "Provision MEMORY_RELAY_TOKEN as a Worker secret for the trusted memory relay.";
  }

  if (check.checkId === "env:WZRRD_API_TOKEN") {
    return "Provision WZRRD_API_TOKEN so the HITL report can be published as the required Wzrrd document.";
  }

  if (check.checkId === "wrangler:MEMORY_RELAY_BASE_URL") {
    return "Add MEMORY_RELAY_BASE_URL to Worker deploy configuration or deploy-time vars.";
  }

  if (check.checkId === "deploy-secret:MEMORY_RELAY_TOKEN") {
    return "Add MEMORY_RELAY_TOKEN to Worker secret propagation before deploying.";
  }

  if (check.checkId === "relay:local-proof") {
    return `Run pnpm app:relay:proof --profile ${profileId} and inspect the redacted local relay proof before exposing the relay to Cloudflare.`;
  }

  if (check.checkId === "relay:healthz") {
    return "Start or provision the trusted Memory relay and verify its authenticated /healthz readiness receipt.";
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
      `Deploy current Worker code and seed packages so ${remoteRegistry.expectedPackageId} exists in remote Cloudflare D1/artifacts.`,
    ];
  }

  if (
    remoteRegistry.expectedPackageArtifactRefMatched !== true ||
    remoteRegistry.expectedPackageManifestHashMatched !== true
  ) {
    const expectedContractSummary = [
      ...remoteRegistry.expectedWorkflowNodeTypes,
      ...remoteRegistry.expectedSchemaExportIds,
    ].join(", ");

    return [
      `Re-seed ${remoteRegistry.expectedPackageId} so the remote artifact ref and manifest hash match the current cartridge manifest, including ${expectedContractSummary}.`,
    ];
  }

  return [];
};

const requiredActionsForChecks = (
  checks: readonly WorkflowLivePreflightCheck[],
  profileId: string
): readonly string[] =>
  checks
    .map((check) => requiredActionForCheck(check, profileId))
    .filter((action): action is string => action !== null);

const checkStatusFor = (
  checks: readonly WorkflowLivePreflightCheck[],
  checkId: string
): WorkflowLivePreflightCheck["status"] =>
  checks.find((check) => check.checkId === checkId)?.status ?? "missing";

const deployScriptSupportsMemoryRelayWorkerVar = (
  deployScriptText: string
): boolean =>
  deployScriptText.includes("MEMORY_RELAY_BASE_URL") &&
  deployScriptText.includes("memoryRelaySignoffPhrase");

const workerRelayBaseUrlConfigured = (input: {
  readonly deployScriptText: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly wranglerConfigText: string;
}): boolean =>
  input.wranglerConfigText.includes("MEMORY_RELAY_BASE_URL") ||
  (isPresent(input.env["MEMORY_RELAY_BASE_URL"]) &&
    deployScriptSupportsMemoryRelayWorkerVar(input.deployScriptText));

const checkMemoryRelayWorkerBaseUrlConfig = (input: {
  readonly deployScriptText: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly wranglerConfigText: string;
}): WorkflowLivePreflightCheck => ({
  checkId: "wrangler:MEMORY_RELAY_BASE_URL",
  message: workerRelayBaseUrlConfigured(input)
    ? "Worker deploy config or signoff-gated deploy-time injection defines MEMORY_RELAY_BASE_URL."
    : "Worker deploy config does not define MEMORY_RELAY_BASE_URL.",
  redacted: true,
  required: true,
  requiredFor: ["memory-relay-binding"],
  status: workerRelayBaseUrlConfigured(input) ? "passed" : "missing",
});

const memoryRelayCapabilityFor = (input: {
  readonly checks: readonly WorkflowLivePreflightCheck[];
  readonly deployScriptText: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly profile: MemorySourceProfile;
  readonly remoteSecretNames: ReadonlySet<string>;
  readonly wranglerConfigText: string;
}): WorkflowLivePreflightRelayCapability => {
  const endpointConfigured =
    isPresent(input.env["MEMORY_RELAY_BASE_URL"]) ||
    input.wranglerConfigText.includes("MEMORY_RELAY_BASE_URL");
  const tokenConfigured =
    isPresent(input.env["MEMORY_RELAY_TOKEN"]) ||
    input.remoteSecretNames.has("MEMORY_RELAY_TOKEN");
  const workerBaseUrlConfiguredForDeploy = workerRelayBaseUrlConfigured(input);
  const secretRef =
    input.env["MEMORY_RELAY_SECRET_REF"]?.trim() || "secretref:memory-relay";

  return {
    allowedOperations: [...relayRequiredOperationsFor(input.profile)],
    allowedSourceFamilies: [...relayAllowedSourceFamiliesFor(input.profile)],
    budget: {
      maxFiles: 500,
      maxRows: 1000,
      maxTokens: 100_000,
    },
    capability: "memory.relay",
    idempotencyKeyPrefix: "memory-relay",
    lease: {
      required: true,
      secretBindingName: "MEMORY_RELAY_TOKEN",
      secretRef,
    },
    readiness: {
      endpointConfigured,
      healthzStatus: checkStatusFor(input.checks, "relay:healthz"),
      localProofStatus: checkStatusFor(input.checks, "relay:local-proof"),
      tokenConfigured,
      workerBaseUrlConfigured: workerBaseUrlConfiguredForDeploy,
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
    traceCapability: "memory.relay",
  };
};

export const buildWorkflowLivePreflightReceipt = (
  input: BuildWorkflowLivePreflightReceiptInput
): WorkflowLivePreflightReceipt => {
  const remoteSecretNames = new Set(input.remoteSecrets.secretNames);
  const checks = [
    ...envRequirements.map((requirement) =>
      checkEnvRequirement(input.env, requirement, remoteSecretNames)
    ),
    checkMemoryRelayWorkerBaseUrlConfig({
      deployScriptText: input.deployScriptText,
      env: input.env,
      wranglerConfigText: input.wranglerConfigText,
    }),
    checkSourceText({
      checkId: "deploy-secret:MEMORY_RELAY_TOKEN",
      missingMessage: "Deploy script does not propagate MEMORY_RELAY_TOKEN.",
      presentMessage: "Deploy script propagates MEMORY_RELAY_TOKEN.",
      requiredFor: ["memory-relay-lease"],
      sourceText: input.deployScriptText,
      token: "MEMORY_RELAY_TOKEN",
    }),
    input.localRelayProofCheck,
    input.relayReadinessCheck,
  ];
  const requiredActions = [
    ...requiredActionsForChecks(checks, input.profile.profileId),
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
        "memory.refinement-proposals.v1 proposal artifact",
        "workflow.hitl-report.v1 MDSvX report artifact",
        "memory.hitl-decision.v1 decision contract artifact",
        "memory.hitl-decision-workflow-seed.v1 seed artifact",
        "memory.hitl-follow-up-run-request.v1 draft artifact",
        "workflow.execution-proof.v1 Cloudflare execution proof",
        "workflow.cartridge-invocation-proof.v1 per-node proofs",
        "wzrrd.site.publish capability receipt for the HITL report",
      ],
      sideEffectsRequireCapabilityLeases: true,
    },
    checks,
    expectedCartridgePackageId: input.profile.packageId,
    generatedAt: input.generatedAt,
    redacted: true,
    relayCapability: memoryRelayCapabilityFor({
      checks,
      deployScriptText: input.deployScriptText,
      env: input.env,
      profile: input.profile,
      remoteSecretNames,
      wranglerConfigText: input.wranglerConfigText,
    }),
    remoteRegistry: input.remoteRegistry,
    remoteSecrets: input.remoteSecrets,
    requiredActions,
    schemaVersion: "workflow.live-preflight.v1",
    status: requiredChecksReady && remoteReady ? "ready" : "blocked",
    workerUrl: input.workerUrl,
    workflowId: input.profile.workflowId,
  });
};

const parseArgs = (
  argv: readonly string[],
  profile: MemorySourceProfile
): WorkflowPreflightArgs => {
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
    receiptPath:
      getArgValue("--receipt-path") ??
      workflowProfileWorkspacePaths(profile.profileId).preflightReceiptPath,
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
  readonly expectations: CartridgeExpectations;
  readonly repoRoot: string;
  readonly secretValues: readonly string[];
}): WorkflowLivePreflightRemoteRegistry =>
  buildRemoteRegistryFromResult(
    runCommand({
      args: remoteRegistryCommand,
      cwd: input.repoRoot,
      secretValues: input.secretValues,
    }),
    input.expectations
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

export const runWorkflowPreflightCli = async (input: {
  readonly argv: readonly string[];
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}): Promise<WorkflowLivePreflightReceipt> => {
  const profile = requireInstalledSourceProfile(input.argv);
  const args = parseArgs(input.argv, profile);
  const expectations = cartridgeExpectationsFor(profile);
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
        expectations,
        repoRoot: input.repoRoot,
        secretValues,
      })
    : skippedRemoteRegistry(expectations);
  const remoteSecrets = args.checkRemote
    ? queryRemoteSecretInventory({
        repoRoot: input.repoRoot,
        secretValues,
      })
    : skippedRemoteSecretInventory();
  const receipt = buildWorkflowLivePreflightReceipt({
    deployScriptText,
    env,
    generatedAt: new Date().toISOString(),
    localRelayProofCheck: await checkLocalRelayProof({
      proofPath: resolve(input.repoRoot, args.localRelayProofPath),
      requiredSourceFamilies: profile.sourceFamiliesExpected,
    }),
    profile,
    relayReadinessCheck: await checkMemoryRelayReadiness({
      env,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      requiredOperations: profile.allowedRelayOperations,
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
  try {
    await runWorkflowPreflightCli({
      argv: process.argv.slice(2),
      processEnv: process.env,
      repoRoot: resolve(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Workflow preflight failed."
    );
    process.exitCode = 1;
  }
}
