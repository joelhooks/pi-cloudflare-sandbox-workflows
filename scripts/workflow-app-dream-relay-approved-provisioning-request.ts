#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { trustedLocalDreamMemoryRelayHttpConfigFromEnv } from "../src/cartridges/dream-memory-fabric/trusted-local-relay-http.ts";
import { DreamRelayLocalReadinessProofReceiptSchema } from "./workflow-app-dream-relay-local-readiness.ts";
import { DreamRelayProvisioningPreflightReceiptSchema } from "./workflow-app-dream-relay-provisioning-preflight.ts";

const defaultLocalRelayReadinessPath =
  ".wrangler/workflow-app/dream-relay/latest-local-readiness.json";
const defaultLocalRelayStartupEnvPath =
  ".wrangler/workflow-app/dream-relay/local-relay-startup-env.json";
const defaultProvisioningPreflightPath =
  ".wrangler/workflow-app/dream-relay/latest-provisioning-preflight.json";
const defaultReceiptPath =
  ".wrangler/workflow-app/dream-relay/latest-approved-provisioning-request.json";
const signoffPhrase = "exposing JoelClaw/Typesense over a new network boundary";

const StartupEnvArtifactSchema = z.record(z.string(), z.string());

const ProvisioningCommandSchema = z.object({
  blockedBy: z.array(z.string().min(1)).default([]),
  commandTemplate: z.string().min(1),
  redacted: z.literal(true),
  requiresSignoff: z.literal(true),
  sideEffectClass: z.enum([
    "secret-write",
    "worker-config",
    "remote-verification",
    "live-workflow-submit",
  ]),
  status: z.enum(["blocked", "ready-after-signoff"]),
  stepId: z.string().min(1),
});

export const DreamRelayApprovedProvisioningRequestReceiptSchema = z.object({
  approval: z.object({
    required: z.literal(true),
    signoffPhrase: z.literal(signoffPhrase),
    signoffProvided: z.boolean(),
    status: z.enum(["approved", "invalid", "required"]),
  }),
  blockers: z.array(z.string().min(1)),
  checkedAt: z.string().min(1),
  commands: z.array(ProvisioningCommandSchema),
  localRelay: z.object({
    localReadinessPath: z.string().min(1),
    localReadinessStatus: z.enum(["failed", "missing", "passed"]),
    localStartupEnvRef: z.string().min(1),
    localStartupStatus: z.enum(["blocked", "ready"]),
    provisioningPreflightCheckedAt: z.string().min(1).optional(),
    provisioningPreflightPath: z.string().min(1),
    provisioningPreflightStatus: z.enum(["blocked", "missing", "ready"]),
    sourceRootCount: z.number().int().min(0),
    tokenConfigured: z.boolean(),
  }),
  noSideEffectsPerformed: z.literal(true),
  redacted: z.literal(true),
  relayEndpoint: z.object({
    configured: z.boolean(),
    hostHash: z.string().min(1).optional(),
    https: z.boolean(),
    redacted: z.literal(true),
  }),
  requiredSecretBindings: z.array(z.literal("MEMORY_RELAY_TOKEN")),
  requiredWorkerVars: z.array(z.literal("MEMORY_RELAY_BASE_URL")),
  schemaVersion: z.literal(
    "trusted.dream-memory-relay.approved-provisioning-request.v1"
  ),
  status: z.enum(["blocked", "ready-to-provision"]),
});

export type DreamRelayApprovedProvisioningRequestReceipt = z.infer<
  typeof DreamRelayApprovedProvisioningRequestReceiptSchema
>;

export interface DreamRelayApprovedProvisioningRequestCliInput {
  readonly argv: readonly string[];
  readonly log?: (message: string) => void;
  readonly now?: () => string;
  readonly processEnv?: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

interface ApprovedProvisioningArgs {
  readonly approvalSignoff?: string;
  readonly localRelayReadinessPath: string;
  readonly localRelayStartupEnvPath: string;
  readonly provisioningPreflightPath: string;
  readonly receiptPath: string;
  readonly relayBaseUrl?: string;
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
  if (index !== -1 && index + 1 < argv.length) {
    return argv[index + 1];
  }

  return undefined;
};

const parseArgs = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): ApprovedProvisioningArgs => {
  const approvalSignoff =
    argValue(argv, "--approval-signoff") ??
    env["MEMORY_RELAY_APPROVAL_SIGNOFF"] ??
    env["MEMORY_RELAY_PROVISIONING_SIGNOFF"];
  const relayBaseUrl =
    argValue(argv, "--relay-base-url") ?? env["MEMORY_RELAY_BASE_URL"];

  return {
    ...(approvalSignoff === undefined ? {} : { approvalSignoff }),
    localRelayReadinessPath:
      argValue(argv, "--local-relay-readiness-path") ??
      defaultLocalRelayReadinessPath,
    localRelayStartupEnvPath:
      argValue(argv, "--local-relay-startup-env-path") ??
      defaultLocalRelayStartupEnvPath,
    provisioningPreflightPath:
      argValue(argv, "--provisioning-preflight-path") ??
      defaultProvisioningPreflightPath,
    receiptPath: argValue(argv, "--out") ?? defaultReceiptPath,
    ...(relayBaseUrl === undefined ? {} : { relayBaseUrl }),
  };
};

const safeLocalArtifactRef = (path: string): string =>
  path.startsWith(".wrangler/") ? path : "<redacted-local-operator-artifact>";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const readJsonOrNull = async (path: string): Promise<unknown | null> => {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
};

const relayUrlSummary = (
  relayBaseUrl: string | undefined
): {
  readonly blockers: readonly string[];
  readonly summary: DreamRelayApprovedProvisioningRequestReceipt["relayEndpoint"];
} => {
  if (relayBaseUrl === undefined || relayBaseUrl.trim().length === 0) {
    return {
      blockers: ["missing-dream-memory-relay-base-url"],
      summary: {
        configured: false,
        https: false,
        redacted: true,
      },
    };
  }

  try {
    const url = new URL(relayBaseUrl);
    const https = url.protocol === "https:";

    return {
      blockers: https ? [] : ["dream-memory-relay-base-url-not-https"],
      summary: {
        configured: true,
        hostHash: sha256(url.host),
        https,
        redacted: true,
      },
    };
  } catch {
    return {
      blockers: ["invalid-dream-memory-relay-base-url"],
      summary: {
        configured: true,
        https: false,
        redacted: true,
      },
    };
  }
};

const approvalStatusFor = (
  approvalSignoff: string | undefined
): "approved" | "invalid" | "required" => {
  if (approvalSignoff === undefined) {
    return "required";
  }

  return approvalSignoff === signoffPhrase ? "approved" : "invalid";
};

const startupSummary = async (
  path: string
): Promise<{
  readonly blockers: readonly string[];
  readonly sourceRootCount: number;
  readonly status: "blocked" | "ready";
  readonly tokenConfigured: boolean;
}> => {
  const parsed = StartupEnvArtifactSchema.safeParse(await readJsonOrNull(path));
  if (!parsed.success) {
    return {
      blockers: ["local-relay-startup-env-invalid"],
      sourceRootCount: 0,
      status: "blocked",
      tokenConfigured: false,
    };
  }

  try {
    const config = trustedLocalDreamMemoryRelayHttpConfigFromEnv(parsed.data);

    return {
      blockers: [],
      sourceRootCount: config.memoryFabric.sourceRoots.length,
      status: "ready",
      tokenConfigured: config.expectedBearerToken.length > 0,
    };
  } catch {
    return {
      blockers: ["local-relay-startup-env-invalid"],
      sourceRootCount: 0,
      status: "blocked",
      tokenConfigured: parsed.data["MEMORY_RELAY_TOKEN"] !== undefined,
    };
  }
};

const readinessSummary = async (
  path: string
): Promise<{
  readonly blockers: readonly string[];
  readonly status: "failed" | "missing" | "passed";
}> => {
  const parsed = await readJsonOrNull(path);
  if (parsed === null) {
    return {
      blockers: ["local-relay-readiness-missing"],
      status: "missing",
    };
  }

  const result = DreamRelayLocalReadinessProofReceiptSchema.safeParse(parsed);
  if (!result.success || result.data.status !== "passed") {
    return {
      blockers: ["local-relay-readiness-not-passed"],
      status: "failed",
    };
  }

  return {
    blockers: [],
    status: "passed",
  };
};

const provisioningPreflightSummary = async (
  path: string
): Promise<{
  readonly checkedAt?: string;
  readonly blockers: readonly string[];
  readonly status: "blocked" | "missing" | "ready";
}> => {
  const parsed = await readJsonOrNull(path);
  if (parsed === null) {
    return {
      blockers: ["provisioning-preflight-missing"],
      status: "missing",
    };
  }

  const result = DreamRelayProvisioningPreflightReceiptSchema.safeParse(parsed);
  if (!result.success) {
    return {
      blockers: ["provisioning-preflight-invalid"],
      status: "missing",
    };
  }

  const localBlockers = [
    ...(result.data.localRelayProof.status === "passed"
      ? []
      : ["local-relay-proof-not-passed"]),
    ...(result.data.localRelayStartup.status === "ready"
      ? []
      : ["local-relay-startup-config-missing"]),
    ...(result.data.localRelayReadiness.status === "passed"
      ? []
      : ["local-relay-readiness-not-passed"]),
  ];

  return {
    blockers: localBlockers,
    checkedAt: result.data.checkedAt,
    status: localBlockers.length === 0 ? "ready" : "blocked",
  };
};

const approvalBlockersFor = (
  approvalStatus: "approved" | "invalid" | "required"
): readonly string[] => {
  if (approvalStatus === "approved") {
    return [];
  }

  return approvalStatus === "invalid"
    ? ["invalid-owner-signoff"]
    : ["missing-exact-owner-signoff"];
};

const provisioningCommands = (
  blockers: readonly string[]
): DreamRelayApprovedProvisioningRequestReceipt["commands"] => {
  const commandBlockers = [...blockers];
  const status =
    commandBlockers.length === 0 ? "ready-after-signoff" : "blocked";

  return [
    {
      blockedBy: commandBlockers,
      commandTemplate:
        "printf '%s' \"$MEMORY_RELAY_TOKEN\" | pnpm exec wrangler secret put MEMORY_RELAY_TOKEN --config wrangler.jsonc",
      redacted: true,
      requiresSignoff: true,
      sideEffectClass: "secret-write",
      status,
      stepId: "provision-worker-relay-token",
    },
    {
      blockedBy: commandBlockers,
      commandTemplate:
        'MEMORY_RELAY_BASE_URL="$MEMORY_RELAY_BASE_URL" MEMORY_RELAY_APPROVAL_SIGNOFF="$MEMORY_RELAY_APPROVAL_SIGNOFF" pnpm app:deploy -- --skip-migrations --skip-secrets --skip-seed --dream-relay-approval-signoff="$MEMORY_RELAY_APPROVAL_SIGNOFF"',
      redacted: true,
      requiresSignoff: true,
      sideEffectClass: "worker-config",
      status,
      stepId: "deploy-worker-relay-url",
    },
    {
      blockedBy: commandBlockers,
      commandTemplate: "pnpm app:dream:preflight",
      redacted: true,
      requiresSignoff: true,
      sideEffectClass: "remote-verification",
      status,
      stepId: "verify-worker-facing-relay-healthz",
    },
    {
      blockedBy: commandBlockers,
      commandTemplate:
        'pnpm app:dream:run --submit --dream-relay-approval-signoff="$MEMORY_RELAY_APPROVAL_SIGNOFF"',
      redacted: true,
      requiresSignoff: true,
      sideEffectClass: "live-workflow-submit",
      status,
      stepId: "submit-live-dream",
    },
  ];
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

export const runDreamRelayApprovedProvisioningRequestCli = async (
  input: DreamRelayApprovedProvisioningRequestCliInput
): Promise<DreamRelayApprovedProvisioningRequestReceipt> => {
  const processEnv = input.processEnv ?? process.env;
  const args = parseArgs(input.argv, processEnv);
  const approvalStatus = approvalStatusFor(args.approvalSignoff);
  const relayEndpoint = relayUrlSummary(args.relayBaseUrl);
  const startup = await startupSummary(
    resolve(input.repoRoot, args.localRelayStartupEnvPath)
  );
  const readiness = await readinessSummary(
    resolve(input.repoRoot, args.localRelayReadinessPath)
  );
  const provisioningPreflight = await provisioningPreflightSummary(
    resolve(input.repoRoot, args.provisioningPreflightPath)
  );
  const blockers = [
    ...approvalBlockersFor(approvalStatus),
    ...relayEndpoint.blockers,
    ...startup.blockers,
    ...readiness.blockers,
    ...provisioningPreflight.blockers,
  ];
  const uniqueBlockers = [...new Set(blockers)];
  const receipt = DreamRelayApprovedProvisioningRequestReceiptSchema.parse({
    approval: {
      required: true,
      signoffPhrase,
      signoffProvided: approvalStatus === "approved",
      status: approvalStatus,
    },
    blockers: uniqueBlockers,
    checkedAt: input.now?.() ?? new Date().toISOString(),
    commands: provisioningCommands(uniqueBlockers),
    localRelay: {
      localReadinessPath: safeLocalArtifactRef(args.localRelayReadinessPath),
      localReadinessStatus: readiness.status,
      localStartupEnvRef: safeLocalArtifactRef(args.localRelayStartupEnvPath),
      localStartupStatus: startup.status,
      ...(provisioningPreflight.checkedAt === undefined
        ? {}
        : { provisioningPreflightCheckedAt: provisioningPreflight.checkedAt }),
      provisioningPreflightPath: safeLocalArtifactRef(
        args.provisioningPreflightPath
      ),
      provisioningPreflightStatus: provisioningPreflight.status,
      sourceRootCount: startup.sourceRootCount,
      tokenConfigured: startup.tokenConfigured,
    },
    noSideEffectsPerformed: true,
    redacted: true,
    relayEndpoint: relayEndpoint.summary,
    requiredSecretBindings: ["MEMORY_RELAY_TOKEN"],
    requiredWorkerVars: ["MEMORY_RELAY_BASE_URL"],
    schemaVersion:
      "trusted.dream-memory-relay.approved-provisioning-request.v1",
    status: uniqueBlockers.length === 0 ? "ready-to-provision" : "blocked",
  });

  const receiptPath = resolve(input.repoRoot, args.receiptPath);
  await writeJson(receiptPath, receipt);

  const log = input.log ?? console.log;
  log(JSON.stringify(receipt, null, 2));
  log(`wrote ${receiptPath}`);

  return receipt;
};

if (isMain()) {
  try {
    await runDreamRelayApprovedProvisioningRequestCli({
      argv: process.argv.slice(2),
      repoRoot: process.cwd(),
    });
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          error: {
            code: "dream_relay_approved_provisioning_request_failed",
            message:
              error instanceof Error
                ? error.message
                : "Dream relay approved provisioning request failed.",
            redacted: true,
          },
          redacted: true,
          schemaVersion:
            "trusted.dream-memory-relay.approved-provisioning-request-error.v1",
          status: "failed",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}
