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
          createMemoryGeneratedWorkflowProofRecorder({
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
        ],
        createWorkflowNodeAdapter: ({ artifacts }) => {
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
            delegate: createMemoryFabricWorkflowNodeAdapter({
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
