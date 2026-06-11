import { MemorySourceProfileSchema } from "../../app/domain/source-profile.ts";
import type {
  MemoryCoverageHorizon,
  MemoryRelayOperation,
  MemoryRuntime,
  MemorySourceFamily,
  MemorySourcePack,
  MemorySourceProfile,
} from "../../app/domain/source-profile.ts";
import { memoryFabricPackageMetadata } from "./package-seed.ts";

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

/**
 * Output effects this profile requires beyond its allowed relay operations.
 * Effect coverage is profile data: the platform reads the required set from
 * the installed profile instead of memory-fabric constants.
 */
export const dreamTranscriptReviewRequiredOutputEffects = [
  "refinement-proposals",
  "hitl-decision-seed",
  "hitl-follow-up-run-request",
  "hitl-report",
] as const;

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

const memoryFabricWorkflowNodePalette =
  memoryFabricPackageMetadata.exports.flatMap((exportRecord) =>
    exportRecord.kind === "workflow-node" && exportRecord.nodeType !== undefined
      ? [exportRecord.nodeType]
      : []
  );

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
    plannerGuidance: {
      intent:
        "Run Dreaming as a real Cloudflare-generated dynamic workflow over the installed workflow/memory-fabric cartridge: mine redacted correction/friction/decision/workflow signals, search T-shaped across near-term and far-term memory, hydrate redacted receipts, correlate evidence, emit refinement proposals for kernel/package/workflow/schema/access-lease changes, render the canonical Dream HITL report, and publish the report through Wzrrd only after verifier acceptance.",
      requestedPackageIds: [
        "badass-courses/claw-kernel",
        "joelhooks/configured-familiar-kernel",
        "workflow/memory-fabric",
      ],
      stochasticNotes: [
        "Use only generated workflow.node.invoke states for Dream cartridge work; do not use static Dream branches in the runner.",
        'Per-node config contract: joelclaw.memory.signals and joelclaw.memory.search steps MUST set config.query to a non-empty string (default "dream workflow" if unsure). joelclaw.memory.signals config.signalKinds, when present, must be a subset of exactly: agent-failure, correction, decision, friction, preference, workflow-pattern. Use "workflow-pattern", never "workflow".',
        `Dream cartridge node palette: ${memoryFabricWorkflowNodePalette.join(", ")}. The planner may choose order, branching, loops, parallelism, and Think lanes when justified by the task, but verifier proof must show run/artifact capture receipts, signal mining, memory search, hydration, correlation, refinement proposals, HITL report, HITL decision seed, and HITL follow-up run request effects happened through generated workflow.node.invoke states.`,
        'Use outputTarget {"kind":"wzrrd","reviewPath":"review/summary.json","primaryDocument":{"artifactPath":"report/hitl-report.mdsvx","publishPath":"report.mdsvx","mediaType":"text/mdsvx","title":"This dream found work to do.","template":{"templateId":"joel/tufte-mdsvx","version":"0.1.0","format":"mdsvx","noindex":true,"defaultExpiresIn":"24h","rendererId":"joel/static-tufte-mdsvx-preview@0.1.0"}}}.',
        "Public Wzrrd output must be noindex, redacted, and proof-below-dreams using docs/dream-report-canon.md.",
        "Accepted dreams must be reviewable as memory.hitl-decision.v1 decisions with reasoning, rating, recommendation, receipt metadata, Brain/package/workflow artifact update targets, and next-workflow seed constraints. The generated workflow must then produce memory.hitl-decision-workflow-seed.v1 and draft memory.hitl-follow-up-run-request.v1 with submitted:false; the draft is planner input for the next run, not a hidden mutation or live submission.",
      ],
      workItemId: "work-item:memory-fabric",
    },
    profileId: "joelhooks/dream-transcript-review",
    purpose:
      "Review agent transcripts and adjacent agent-run artifacts across the JoelClaw network, then surface source-backed kernel/package/workflow refinements.",
    requiredOutputEffects: [...dreamTranscriptReviewRequiredOutputEffects],
    requiredRuntimes: [...dreamTranscriptReviewRequiredRuntimes],
    requiresGeneratedWorkflowProof: true,
    schemaVersion: "memory.source-profile.v1",
    sourceFamiliesExpected: [...dreamTranscriptReviewSourceFamilies],
    sourcePacks: [...dreamTranscriptReviewSourcePacks],
    timeHorizons: [...dreamTranscriptReviewTimeHorizons],
    title: "Dream Transcript Review",
    workflowId: "dream.transcript-review",
  });

export const memoryFabricSourceProfiles = [
  dreamTranscriptReviewSourceProfile,
] as const satisfies readonly MemorySourceProfile[];
