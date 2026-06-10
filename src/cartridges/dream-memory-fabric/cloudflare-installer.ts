import { z } from "zod";

import {
  createCloudflareDreamMemoryFabricRelay,
  createCloudflareDreamMemoryRelayTokenResolver,
} from "../../app/infrastructure/cloudflare-dream-memory-fabric-relay.ts";
import type { CloudflareWorkflowCartridgeInstaller } from "../../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import { createArtifactBackedWorkflowCartridgeAdapter } from "../../app/workflow-nodes/artifact-backed-cartridge-adapter.ts";
import { createDreamGeneratedWorkflowProofRecorder } from "../../app/workflow-nodes/dream-generated-workflow-proof.ts";
import { createDreamMemoryFabricWorkflowNodeAdapter } from "../../app/workflow-nodes/dream-memory-fabric.ts";
import { dreamMemoryFabricPackageMetadata } from "./package-seed.ts";
import { dreamTranscriptReviewSourceProfile } from "./source-profile.ts";

export const DreamMemoryFabricCloudflareEnvBindingSchema = z.object({
  DREAM_MEMORY_RELAY_BASE_URL: z.url().optional(),
  DREAM_MEMORY_RELAY_SECRET_REF: z
    .string()
    .min(1)
    .default("secretref:dream-memory-relay"),
  DREAM_MEMORY_RELAY_TOKEN: z.string().optional(),
  DREAM_MEMORY_RELAY_USER_AGENT: z
    .string()
    .min(1)
    .default("pi-cloudflare-sandbox-workflows/0.0.0"),
});

export type DreamMemoryFabricCloudflareEnvBindings = z.infer<
  typeof DreamMemoryFabricCloudflareEnvBindingSchema
>;

const dreamMemoryFabricPackageRef =
  dreamMemoryFabricPackageMetadata.latestArtifactRef;

export const dreamMemoryFabricCloudflareCartridgeInstaller: CloudflareWorkflowCartridgeInstaller<DreamMemoryFabricCloudflareEnvBindings> =
  {
    cartridgeId: "workflow/dream-memory-fabric",
    resolve({ bindings }) {
      const relayBaseUrl = bindings.DREAM_MEMORY_RELAY_BASE_URL;
      if (relayBaseUrl === undefined) {
        return {};
      }

      return {
        createPostExecutionArtifactRecorders: ({ artifacts }) => [
          createDreamGeneratedWorkflowProofRecorder({
            artifacts,
            expectedPackageRef: dreamMemoryFabricPackageRef,
            expectedSourceProfile: dreamTranscriptReviewSourceProfile,
            expectedSourceProfileExportId:
              "dream-transcript-review-source-profile",
          }),
        ],
        createWorkflowNodeAdapter: ({ artifacts }) => {
          const dreamMemoryRelay = createCloudflareDreamMemoryFabricRelay({
            relayBaseUrl,
            relaySecretRef: bindings.DREAM_MEMORY_RELAY_SECRET_REF,
            secretResolver: createCloudflareDreamMemoryRelayTokenResolver({
              secret: bindings.DREAM_MEMORY_RELAY_TOKEN ?? "",
              secretRef: bindings.DREAM_MEMORY_RELAY_SECRET_REF,
            }),
            userAgent: bindings.DREAM_MEMORY_RELAY_USER_AGENT,
          });

          return createArtifactBackedWorkflowCartridgeAdapter({
            artifacts,
            delegate: createDreamMemoryFabricWorkflowNodeAdapter({
              artifacts,
              dreamMemoryBackfill: dreamMemoryRelay,
              dreamMemoryCorrelation: dreamMemoryRelay,
              dreamMemoryFabric: dreamMemoryRelay,
              dreamMemoryRetrieval: dreamMemoryRelay,
            }),
          });
        },
      };
    },
  };
