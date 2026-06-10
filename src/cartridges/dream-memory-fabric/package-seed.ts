import {
  packageMetadataForSeedTemplate,
  PackageSeedTemplateSchema,
} from "../../app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageSeedTemplate } from "../../app/infrastructure/cloudflare-package-seeder.ts";

export const dreamMemoryFabricPackageSeedTemplate: PackageSeedTemplate =
  PackageSeedTemplateSchema.parse({
    description:
      "Dream memory fabric workflow nodes for run/artifact capture receipts, memory search, redacted hydration, correlation, refinement proposals, HITL reports, HITL decision receipts, HITL decision workflow seeds, and HITL follow-up run request drafts.",
    exports: [
      {
        contractRef:
          "contract://workflow/dream-memory-fabric/source-profile/dream-transcript-review.v1",
        exportId: "dream-transcript-review-source-profile",
        kind: "source-profile",
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
      {
        contractRef:
          "contract://workflow/dream-memory-fabric/hitl-decision-workflow-seed.v1",
        exportId: "dream-hitl-decision-workflow-seed",
        kind: "workflow-node",
        nodeType: "joelclaw.dream.hitl-decision-seed",
      },
      {
        contractRef:
          "contract://workflow/dream-memory-fabric/hitl-follow-up-run-request.v1",
        exportId: "dream-hitl-follow-up-run-request",
        kind: "workflow-node",
        nodeType: "joelclaw.dream.hitl-follow-up-run-request",
      },
      {
        contractRef: "contract://workflow/dream-memory-fabric/hitl-decision.v1",
        exportId: "dream-hitl-decision-schema",
        kind: "schema",
      },
    ],
    kind: "workflow-pack",
    latestVersion: "0.1.0",
    manifestPath: "package.json",
    ownerRef: "org:joelhooks",
    packageId: "workflow/dream-memory-fabric",
    repoName: "pkg-workflow-dream-memory-fabric",
    title: "Dream Memory Fabric Workflow",
    trustTier: "reviewed",
  });

export const dreamMemoryFabricPackageMetadata = packageMetadataForSeedTemplate(
  dreamMemoryFabricPackageSeedTemplate
);
