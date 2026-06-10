import type {
  Actor,
  PackageMetadata,
  WorkflowRunRequest,
} from "../../src/app/domain/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/dream-memory-fabric/source-profile.ts";

export const integrationTestActor = {
  id: "actor:integration-test-agent",
  organizationId: "org:badass-courses",
  roleIds: ["workflow.operator", "discord.dry-run"],
  sessionId: "session:integration-test",
  trustTier: "reviewed",
  type: "agent",
} satisfies Actor;

export const integrationTestPackageMetadata = [
  {
    description:
      "Default operating law, receipt-first behavior, package mount rules, and capability lease vocabulary.",
    exports: [
      {
        contractRef: "contract://claw-kernel/operator-law.v1",
        exportId: "operator-law",
        kind: "prompt",
      },
    ],
    kind: "kernel",
    latestArtifactRef: "artifact://packages/badass-courses/claw-kernel/refs/v1",
    latestVersion: "1.0.0",
    manifestPath: "package.json",
    ownerRef: "org:badass-courses",
    packageId: "badass-courses/claw-kernel",
    title: "Claw Kernel",
    trustTier: "reviewed",
  },
  {
    description:
      "Configured familiar identity, voice, memory habits, adapter rules, and personal kernel overlays.",
    exports: [
      {
        contractRef: "contract://joelhooks/kernel-overlay.v1",
        exportId: "kernel-overlay",
        kind: "prompt",
      },
    ],
    kind: "kernel",
    latestArtifactRef: "artifact://packages/joelhooks/shitrat-kernel/refs/v1",
    latestVersion: "1.0.0",
    manifestPath: "package.json",
    ownerRef: "user:joel",
    packageId: "@joelhooks/shitrat-kernel",
    title: "Configured Familiar Kernel",
    trustTier: "reviewed",
  },
  {
    description:
      "Research/review workflow with optional Discord notification through a capability lease.",
    exports: [
      {
        contractRef: "contract://workflow/research-review-discord.v1",
        exportId: "research-review-discord",
        kind: "workflow",
      },
      {
        contractRef: "contract://workflow/nodes/integration-fixture.v1",
        exportId: "integration-fixture-node",
        kind: "workflow-node",
        nodeType: "com.joelclaw.integration-fixture",
      },
    ],
    kind: "workflow-pack",
    latestArtifactRef:
      "artifact://packages/workflows/research-review-discord/refs/v1",
    latestVersion: "1.0.0",
    manifestPath: "package.json",
    ownerRef: "org:badass-courses",
    packageId: "workflow/research-review-discord",
    title: "Research Review Discord Workflow",
    trustTier: "reviewed",
  },
] satisfies PackageMetadata[];

export const integrationTestDreamWorkflowPackageMetadata = {
  description:
    "Dream memory fabric workflow nodes for source inventory, source health, recovery-only backfill planning and receipts, run/artifact capture receipts, memory search, redacted hydration, and HITL reports.",
  exports: [
    {
      contractRef:
        "contract://workflow/dream-memory-fabric/source-profile/dream-transcript-review.v1",
      exportId: "dream-transcript-review-source-profile",
      kind: "source-profile",
    },
    {
      contractRef:
        "contract://workflow/dream-memory-fabric/source-inventory.v1",
      exportId: "dream-source-inventory",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.source-inventory",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/source-health.v1",
      exportId: "dream-source-health",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.source-health",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/backfill-plan.v1",
      exportId: "dream-backfill-plan",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.backfill-plan",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/backfill-run.v1",
      exportId: "dream-backfill-run",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.backfill-run",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/capture-run.v1",
      exportId: "dream-capture-run",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.capture-run",
    },
    {
      contractRef:
        "contract://workflow/dream-memory-fabric/capture-artifact.v1",
      exportId: "dream-capture-artifact",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.capture-artifact",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/memory-search.v1",
      exportId: "dream-memory-search",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.memory-search",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/signals.v1",
      exportId: "dream-signals",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.signals",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/hydration.v1",
      exportId: "dream-hydration",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.hydrate",
    },
    {
      contractRef:
        "contract://workflow/dream-memory-fabric/correlation-graph.v1",
      exportId: "dream-correlation-graph",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.correlate",
    },
    {
      contractRef:
        "contract://workflow/dream-memory-fabric/refinement-proposals.v1",
      exportId: "dream-refinement-proposals",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.refinement-proposals",
    },
    {
      contractRef: "contract://workflow/dream-memory-fabric/hitl-report.v1",
      exportId: "dream-hitl-report",
      kind: "workflow-node",
      nodeType: "joelclaw.dream.hitl-report",
    },
  ],
  kind: "workflow-pack",
  latestArtifactRef:
    "artifact://packages/workflows/dream-memory-fabric/refs/v1",
  latestVersion: "0.1.0",
  manifestPath: "package.json",
  ownerRef: "org:joelhooks",
  packageId: "workflow/dream-memory-fabric",
  title: "Dream Memory Fabric Workflow",
  trustTier: "reviewed",
} satisfies PackageMetadata;

export const buildIntegrationTestRunRequest = (): WorkflowRunRequest => ({
  actor: integrationTestActor,
  planProposal: {
    discordMessage: {
      body: "Workflow dry-run captured: research/review spine executed through a capability lease.",
      channelRef: "discord:channel:integration-test-review",
      dryRun: true,
      serverRef: "discord:server:integration-test",
    },
    intent:
      "Run a source-grounded research/review workflow and notify the review channel through a leased Discord capability.",
    requestedPackageIds: integrationTestPackageMetadata.map(
      (packageRecord) => packageRecord.packageId
    ),
    stochasticNotes: [
      "The plan proposal may be stochastic.",
      "Execution reads only the pinned plan artifact.",
      "Discord notification must go through a capability lease even in dry-run.",
    ],
  },
  runId: `run-integration-${new Date().toISOString().slice(0, 10)}`,
  workItemId: "work-item:integration-test-research-review",
});

export const buildIntegrationTestDreamRunRequest = (): WorkflowRunRequest => {
  const request = buildIntegrationTestRunRequest();

  return {
    ...request,
    planProposal: {
      ...request.planProposal,
      requestedPackageIds: [
        ...request.planProposal.requestedPackageIds,
        integrationTestDreamWorkflowPackageMetadata.packageId,
      ],
      stochasticNotes: [
        ...request.planProposal.stochasticNotes,
        `Use source profile ${dreamTranscriptReviewSourceProfile.profileId}: families ${dreamTranscriptReviewSourceProfile.sourceFamiliesExpected.join(", ")}; runtimes ${dreamTranscriptReviewSourceProfile.requiredRuntimes.join(", ")}; machines ${dreamTranscriptReviewSourceProfile.requiredMachineIds.join(", ")}; horizons ${dreamTranscriptReviewSourceProfile.timeHorizons.join(", ")}.`,
        `Generated Dream retrieval steps must declare dreamCoverageHorizons: ${dreamTranscriptReviewSourceProfile.timeHorizons.join(", ")}.`,
      ],
    },
    workItemId: "work-item:integration-test-dream",
  };
};
