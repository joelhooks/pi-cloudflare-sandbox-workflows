import { z } from "zod";

import type { CloudflareWorkflowCartridgeInstaller } from "../../app/infrastructure/cloudflare-workflow-cartridge-installer.ts";
import { createArtifactBackedWorkflowCartridgeAdapter } from "../../app/workflow-nodes/artifact-backed-cartridge-adapter.ts";
import {
  createCloudflareDreamMemoryFabricRelay,
  createCloudflareDreamMemoryRelayTokenResolver,
} from "./cloudflare-relay.ts";
import { createDreamGeneratedWorkflowProofRecorder } from "./generated-workflow-proof.ts";
import { dreamMemoryFabricPackageMetadata } from "./package-seed.ts";
import { dreamTranscriptReviewSourceProfile } from "./source-profile.ts";
import { createDreamMemoryFabricWorkflowNodeAdapter } from "./workflow-node-adapter.ts";

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
              dreamMemoryCapture: dreamMemoryRelay,
              dreamMemoryCorrelation: dreamMemoryRelay,
              dreamMemoryRetrieval: dreamMemoryRelay,
              dreamMemorySignals: dreamMemoryRelay,
            }),
          });
        },
      };
    },
  };
