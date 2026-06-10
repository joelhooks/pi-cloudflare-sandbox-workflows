import { MemorySourceProfileSchema } from "../../app/domain/source-profile.ts";
import type {
  MemoryCoverageHorizon,
  MemoryRelayOperation,
  MemoryRuntime,
  MemorySourceFamily,
  MemorySourcePack,
} from "../../app/domain/source-profile.ts";

export const dreamTranscriptReviewSourceFamilies = [
  "agent-transcripts",
  "brain",
  "cloudflare-runs",
  "docs-pdf-brain",
  "repo-outputs",
] as const satisfies readonly MemorySourceFamily[];

export const dreamTranscriptReviewRequiredRuntimes = [
  "pi",
  "codex",
  "claude",
  "cloudflare",
] as const satisfies readonly MemoryRuntime[];

export const dreamTranscriptReviewRelayOperations = [
  "capture-run",
  "capture-artifact",
  "signals",
  "search",
  "hydrate",
  "correlate",
] as const satisfies readonly MemoryRelayOperation[];

export const dreamTranscriptReviewTimeHorizons = [
  "24h",
  "7d",
  "30d",
  "quarter",
  "all-time",
] as const satisfies readonly MemoryCoverageHorizon[];

export const dreamTranscriptReviewSourcePacks = [
  {
    description:
      "Optional JoelHooks work graph surfaces for correlating agent-run memories with GitHub, Slack, Linear, support, and org/project graph signals when scoped leases are available.",
    packId: "source-pack:joelhooks:work-graph",
    packageId: "source-pack/joelhooks-work-graph",
    privacyTier: "private",
    requiredCapabilityKinds: [
      "memory.relay",
      "github.read",
      "linear.read",
      "slack.search",
    ],
    scope: {
      organizationId: "org:joelhooks",
    },
    selectionPolicy: "optional-lease",
    sourceFamilies: ["comms", "people-org-memory", "repo-outputs", "support"],
    surfaces: ["github", "linear", "slack", "org-project-graph"],
    title: "JoelHooks Work Graph Source Pack",
  },
  {
    description:
      "Saved AIHero support/comms/customer/org source pack candidate. This belongs to an AIHero support-sweep workflow, not Dream transcript-review readiness.",
    packId: "source-pack:badass-courses:aihero-support-sweep",
    packageId: "workflow/aihero-support-sweep",
    privacyTier: "customer-private",
    requiredCapabilityKinds: [
      "memory.relay",
      "front.read",
      "slack.search",
      "support.review",
    ],
    scope: {
      organizationId: "org:badass-courses",
      projectId: "aihero-support",
    },
    selectionPolicy: "separate-workflow",
    sourceFamilies: ["brain", "comms", "people-org-memory", "support"],
    surfaces: ["brain", "front", "slack", "org-project-graph"],
    title: "AIHero Support Sweep Source Pack Candidate",
  },
] as const satisfies readonly MemorySourcePack[];

export const dreamTranscriptReviewSourceProfile =
  MemorySourceProfileSchema.parse({
    allowedRelayOperations: [...dreamTranscriptReviewRelayOperations],
    defaultQuery: "dream workflow",
    outputBoundary: {
      noCustomerDataInPublicArtifacts: true,
      noRawCredentials: true,
      noRawPrivatePaths: true,
      noRawTranscripts: true,
    },
    packageId: "workflow/memory-fabric",
    profileId: "joelhooks/dream-transcript-review",
    purpose:
      "Review agent transcripts and adjacent agent-run artifacts across the JoelClaw network, then surface source-backed kernel/package/workflow refinements.",
    requiredRuntimes: [...dreamTranscriptReviewRequiredRuntimes],
    schemaVersion: "memory.source-profile.v1",
    sourceFamiliesExpected: [...dreamTranscriptReviewSourceFamilies],
    sourcePacks: [...dreamTranscriptReviewSourcePacks],
    timeHorizons: [...dreamTranscriptReviewTimeHorizons],
    title: "Dream Transcript Review",
    workflowId: "dream.memory-fabric",
  });
