import { DreamSourceProfileSchema } from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";
import type {
  DreamCoverageHorizon,
  DreamMemoryRelayOperation,
  DreamRuntime,
  DreamSourceFamily,
} from "../../app/workflow-nodes/dream-memory-fabric-schemas.ts";

export const dreamTranscriptReviewSourceFamilies = [
  "agent-transcripts",
  "brain",
  "cloudflare-runs",
  "docs-pdf-brain",
  "repo-outputs",
] as const satisfies readonly DreamSourceFamily[];

export const dreamTranscriptReviewRequiredRuntimes = [
  "pi",
  "codex",
  "claude",
  "cloudflare",
] as const satisfies readonly DreamRuntime[];

export const dreamTranscriptReviewRequiredMachineIds = [
  "blaine",
  "panda",
  "flagg",
  "cloudflare",
] as const;

export const dreamTranscriptReviewRelayOperations = [
  "inventory",
  "source-health",
  "backfill-plan",
  "backfill-run",
  "capture-run",
  "capture-artifact",
  "signals",
  "search",
  "hydrate",
  "correlate",
] as const satisfies readonly DreamMemoryRelayOperation[];

export const dreamTranscriptReviewTimeHorizons = [
  "24h",
  "7d",
  "30d",
  "quarter",
  "all-time",
] as const satisfies readonly DreamCoverageHorizon[];

export const dreamTranscriptReviewSourceProfile =
  DreamSourceProfileSchema.parse({
    allowedRelayOperations: [...dreamTranscriptReviewRelayOperations],
    defaultQuery: "dream workflow",
    outputBoundary: {
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    packageId: "workflow/dream-memory-fabric",
    profileId: "joelhooks/dream-transcript-review",
    purpose:
      "Review agent transcripts and adjacent agent-run artifacts across the JoelClaw network, then surface source-backed kernel/package/workflow refinements.",
    requiredMachineIds: [...dreamTranscriptReviewRequiredMachineIds],
    requiredRuntimes: [...dreamTranscriptReviewRequiredRuntimes],
    schemaVersion: "dream.source-profile.v1",
    sourceFamiliesExpected: [...dreamTranscriptReviewSourceFamilies],
    timeHorizons: [...dreamTranscriptReviewTimeHorizons],
    title: "Dream Transcript Review",
    workflowId: "dream.memory-fabric",
  });
