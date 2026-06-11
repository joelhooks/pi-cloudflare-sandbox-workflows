import { z } from "zod";

import type { CloudflareWorkflowCartridgeInstaller } from "../../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import { createArtifactBackedWorkflowCartridgeAdapter } from "../../app/workflow-nodes/artifact-backed-cartridge-adapter.ts";
import { createMemoryGeneratedWorkflowProofRecorder } from "../../app/workflow-nodes/generated-workflow-proof.ts";
import {
  createCloudflareMemoryFabricRelay,
  createCloudflareMemoryRelayTokenResolver,
} from "./cloudflare-relay.ts";
import { buildWorkflowHitlReportAuditProofCheck } from "./hitl-report-audit-proof-check.ts";
import { memoryFabricPackageMetadata } from "./package-seed.ts";
import { dreamTranscriptReviewSourceProfile } from "./source-profile.ts";
import { createMemoryFabricWorkflowNodeAdapter } from "./workflow-node-adapter.ts";

export const MemoryFabricCloudflareEnvBindingSchema = z.object({
  MEMORY_RELAY_BASE_URL: z.url().optional(),
  MEMORY_RELAY_SECRET_REF: z.string().min(1).default("secretref:memory-relay"),
  MEMORY_RELAY_TOKEN: z.string().optional(),
  MEMORY_RELAY_USER_AGENT: z
    .string()
    .min(1)
    .default("pi-cloudflare-sandbox-workflows/0.0.0"),
});

export type MemoryFabricCloudflareEnvBindings = z.infer<
  typeof MemoryFabricCloudflareEnvBindingSchema
>;

const memoryFabricPackageRef = memoryFabricPackageMetadata.latestArtifactRef;

export const memoryFabricCloudflareCartridgeInstaller: CloudflareWorkflowCartridgeInstaller<MemoryFabricCloudflareEnvBindings> =
  {
    cartridgeId: "workflow/memory-fabric",
    resolve({ bindings }) {
      const relayBaseUrl = bindings.MEMORY_RELAY_BASE_URL;
      if (relayBaseUrl === undefined) {
        return {};
      }

      return {
        createPostExecutionArtifactRecorders: ({ artifacts }) => [
          {
            binding: {
              kind: "profile-id",
              packageId: dreamTranscriptReviewSourceProfile.packageId,
              profileId: dreamTranscriptReviewSourceProfile.profileId,
            },
            recorder: createMemoryGeneratedWorkflowProofRecorder({
              artifacts,
              buildAdditionalProofChecks: async ({ executionProof }) => [
                await buildWorkflowHitlReportAuditProofCheck({
                  artifacts,
                  executionProof,
                }),
              ],
              expectedPackageRef: memoryFabricPackageRef,
              expectedSourceProfile: dreamTranscriptReviewSourceProfile,
              expectedSourceProfileExportId:
                "dream-transcript-review-source-profile",
            }),
          },
        ],
        createWorkflowNodeAdapter: ({ analysisReasoningLane, artifacts }) => {
          const memoryRelay = createCloudflareMemoryFabricRelay({
            relayBaseUrl,
            relaySecretRef: bindings.MEMORY_RELAY_SECRET_REF,
            secretResolver: createCloudflareMemoryRelayTokenResolver({
              secret: bindings.MEMORY_RELAY_TOKEN ?? "",
              secretRef: bindings.MEMORY_RELAY_SECRET_REF,
            }),
            userAgent: bindings.MEMORY_RELAY_USER_AGENT,
          });

          return createArtifactBackedWorkflowCartridgeAdapter({
            artifacts,
            // Thread the run's reasoning lane through so the propose-refinements
            // node REASONS over the analysis-method kernel skill when a real
            // lane is available; absent, it falls back to mechanical template
            // fill labeled honestly. This is the production "dream thinks" wire.
            delegate: createMemoryFabricWorkflowNodeAdapter({
              ...(analysisReasoningLane === undefined
                ? {}
                : { analysisReasoningLane }),
              artifacts,
              memoryCapture: memoryRelay,
              memoryCorrelation: memoryRelay,
              memoryRetrieval: memoryRelay,
              memorySignals: memoryRelay,
            }),
          });
        },
      };
    },
  };
