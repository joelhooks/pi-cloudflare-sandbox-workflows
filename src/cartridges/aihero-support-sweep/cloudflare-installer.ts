/// <reference types="@cloudflare/workers-types" />

import { z } from "zod";

import type { CapabilityBlocker } from "../../app/domain/schemas.ts";
import type { CloudflareWorkflowCartridgeInstaller } from "../../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import { createArtifactBackedWorkflowCartridgeAdapter } from "../../app/workflow-nodes/artifact-backed-cartridge-adapter.ts";
import { createMemoryGeneratedWorkflowProofRecorder } from "../../app/workflow-nodes/generated-workflow-proof.ts";
import { buildAiHeroSupportSweepAuditProofCheck } from "./hitl-report-audit-proof-check.ts";
import { buildAiHeroSupportSweepHorizonCoverageProofCheck } from "./horizon-coverage-proof-check.ts";
import { aiHeroSupportSweepPackageMetadata } from "./package-seed.ts";
import {
  AiHeroSupportSweepHydrationDocumentSchema,
  AiHeroSupportSweepHydrationPayloadSchema,
  AiHeroSupportSweepIndexHealthDocumentSchema,
  AiHeroSupportSweepIndexHealthPayloadSchema,
  AiHeroSupportSweepInventoryDocumentSchema,
  AiHeroSupportSweepInventoryPayloadSchema,
  AiHeroSupportSweepSignalSearchDocumentSchema,
  AiHeroSupportSweepSignalSearchPayloadSchema,
} from "./schemas.ts";
import type {
  AiHeroSupportSweepHydrationDocument,
  AiHeroSupportSweepIndexHealthDocument,
  AiHeroSupportSweepInventoryDocument,
  AiHeroSupportSweepSignalSearchDocument,
} from "./schemas.ts";
import { aiHeroSupportSweepSourceProfile } from "./source-profile.ts";
import { createAiHeroSupportSweepWorkflowNodeAdapter } from "./workflow-node-adapter.ts";
import type {
  AiHeroSupportSweepDataPort,
  AiHeroSupportSweepResult,
} from "./workflow-node-adapter.ts";

export const AiHeroSupportSweepCloudflareEnvBindingSchema = z.object({
  AIHERO_SUPPORT_SWEEP_RELAY_BASE_URL: z.url().optional(),
  AIHERO_SUPPORT_SWEEP_RELAY_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:aihero-support-sweep-relay"),
  AIHERO_SUPPORT_SWEEP_RELAY_TOKEN: z.string().optional(),
  AIHERO_SUPPORT_SWEEP_RELAY_USER_AGENT: z
    .string()
    .min(1)
    .default("pi-cloudflare-sandbox-workflows/0.0.0"),
});

export type AiHeroSupportSweepCloudflareEnvBindings = z.infer<
  typeof AiHeroSupportSweepCloudflareEnvBindingSchema
>;

const aiHeroPackageRef = aiHeroSupportSweepPackageMetadata.latestArtifactRef;

const blocked = <TDocument>(
  code: CapabilityBlocker["code"],
  message: string
): AiHeroSupportSweepResult<TDocument> => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "blocked",
});

const relayUrl = (baseUrl: string, path: string): string => {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  return new URL(path.replace(/^\//u, ""), normalizedBase).toString();
};

const relayResponseSchema = <TDocument extends z.ZodType>(
  documentSchema: TDocument
) =>
  z.object({
    document: documentSchema,
    redacted: z.literal(true),
    schemaVersion: z.literal("aihero.support-sweep.relay-response.v1"),
  });

const createCloudflareAiHeroSupportSweepRelay = (input: {
  readonly relayBaseUrl: string;
  readonly relaySecretRef: string;
  readonly token: string | undefined;
  readonly userAgent: string;
}): AiHeroSupportSweepDataPort => {
  const postRelay = async <TDocument>(payload: {
    readonly body: unknown;
    readonly documentSchema: z.ZodType<TDocument>;
    readonly operation: string;
    readonly path: string;
  }): Promise<AiHeroSupportSweepResult<TDocument>> => {
    if (input.token === undefined || input.token.length === 0) {
      return blocked(
        "secret_denied",
        `AIHero support-sweep relay token is unavailable for ${input.relaySecretRef}.`
      );
    }

    let response: Response;
    try {
      response = await fetch(relayUrl(input.relayBaseUrl, payload.path), {
        body: JSON.stringify({
          operation: payload.operation,
          payload: payload.body,
          redactionPolicy: {
            noCustomerDataInPublicArtifacts: true,
            noRawCredentials: true,
            noRawPrivatePaths: true,
            noRawSupportThreads: true,
          },
          schemaVersion: "aihero.support-sweep.relay-request.v1",
        }),
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-type": "application/json",
          "user-agent": input.userAgent,
        },
        method: "POST",
      });
    } catch {
      return blocked(
        "adapter_unavailable",
        `AIHero support-sweep relay ${payload.operation} failed before response.`
      );
    }

    if (response.status === 401 || response.status === 403) {
      return blocked(
        "secret_denied",
        "AIHero support-sweep relay rejected the token."
      );
    }

    if (!response.ok) {
      return blocked(
        "adapter_unavailable",
        `AIHero support-sweep relay ${payload.operation} failed with HTTP ${response.status}.`
      );
    }

    try {
      const parsed = relayResponseSchema(payload.documentSchema).parse(
        await response.json()
      );

      return { document: parsed.document, status: "ready" };
    } catch {
      return blocked(
        "adapter_unavailable",
        `AIHero support-sweep relay ${payload.operation} returned invalid JSON.`
      );
    }
  };

  return {
    checkIndexHealth(payload) {
      return postRelay<AiHeroSupportSweepIndexHealthDocument>({
        body: AiHeroSupportSweepIndexHealthPayloadSchema.parse(payload),
        documentSchema: AiHeroSupportSweepIndexHealthDocumentSchema,
        operation: "derived-index-health",
        path: "/aihero-support-sweep/derived-index-health",
      });
    },
    hydrateEvidence(payload) {
      return postRelay<AiHeroSupportSweepHydrationDocument>({
        body: AiHeroSupportSweepHydrationPayloadSchema.parse(payload),
        documentSchema: AiHeroSupportSweepHydrationDocumentSchema,
        operation: "evidence-hydration",
        path: "/aihero-support-sweep/evidence-hydration",
      });
    },
    inventorySources(payload) {
      return postRelay<AiHeroSupportSweepInventoryDocument>({
        body: AiHeroSupportSweepInventoryPayloadSchema.parse(payload),
        documentSchema: AiHeroSupportSweepInventoryDocumentSchema,
        operation: "source-inventory",
        path: "/aihero-support-sweep/source-inventory",
      });
    },
    searchSignals(payload) {
      return postRelay<AiHeroSupportSweepSignalSearchDocument>({
        body: AiHeroSupportSweepSignalSearchPayloadSchema.parse(payload),
        documentSchema: AiHeroSupportSweepSignalSearchDocumentSchema,
        operation: "signal-search",
        path: "/aihero-support-sweep/signal-search",
      });
    },
  };
};

export const aiHeroSupportSweepCloudflareCartridgeInstaller: CloudflareWorkflowCartridgeInstaller<AiHeroSupportSweepCloudflareEnvBindings> =
  {
    cartridgeId: "workflow/aihero-support-sweep",
    resolve({ bindings }) {
      const relayBaseUrl = bindings.AIHERO_SUPPORT_SWEEP_RELAY_BASE_URL;
      if (relayBaseUrl === undefined) {
        return {};
      }

      return {
        createPostExecutionArtifactRecorders: ({ artifacts }) => [
          {
            binding: {
              kind: "profile-id",
              packageId: aiHeroSupportSweepSourceProfile.packageId,
              profileId: aiHeroSupportSweepSourceProfile.profileId,
            },
            recorder: createMemoryGeneratedWorkflowProofRecorder({
              artifacts,
              buildAdditionalProofChecks: async ({
                executionProof,
                plan,
                planArtifact,
              }) => [
                await buildAiHeroSupportSweepAuditProofCheck({
                  artifacts,
                  executionProof,
                }),
                buildAiHeroSupportSweepHorizonCoverageProofCheck({
                  plan,
                  planArtifact,
                }),
              ],
              expectedPackageRef: aiHeroPackageRef,
              expectedSourceProfile: aiHeroSupportSweepSourceProfile,
              expectedSourceProfileExportId:
                "aihero-support-sweep-source-profile",
            }),
          },
        ],
        createWorkflowNodeAdapter: ({ artifacts }) =>
          createArtifactBackedWorkflowCartridgeAdapter({
            artifacts,
            delegate: createAiHeroSupportSweepWorkflowNodeAdapter({
              artifacts,
              data: createCloudflareAiHeroSupportSweepRelay({
                relayBaseUrl,
                relaySecretRef: bindings.AIHERO_SUPPORT_SWEEP_RELAY_SECRET_REF,
                token: bindings.AIHERO_SUPPORT_SWEEP_RELAY_TOKEN,
                userAgent: bindings.AIHERO_SUPPORT_SWEEP_RELAY_USER_AGENT,
              }),
            }),
          }),
      };
    },
  };
