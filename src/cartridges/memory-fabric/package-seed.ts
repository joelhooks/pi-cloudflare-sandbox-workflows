import {
  packageMetadataForSeedTemplate,
  PackageSeedTemplateSchema,
} from "../../app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageSeedTemplate } from "../../app/infrastructure/cloudflare-package-seeder.ts";

export const memoryFabricPackageSeedTemplate: PackageSeedTemplate =
  PackageSeedTemplateSchema.parse({
    description:
      "Memory fabric workflow nodes for run/artifact capture receipts, memory search, redacted hydration, correlation, refinement proposals, HITL reports, HITL decision receipts, HITL decision workflow seeds, and HITL follow-up run request drafts.",
    exports: [
      {
        contractRef:
          "contract://workflow/memory-fabric/source-profile/dream-transcript-review.v1",
        exportId: "dream-transcript-review-source-profile",
        kind: "source-profile",
      },
      {
        contractRef: "contract://workflow/memory-fabric/capture-run.v1",
        effects: ["capture-run"],
        exportId: "memory-capture-run",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.capture-run",
      },
      {
        contractRef: "contract://workflow/memory-fabric/capture-artifact.v1",
        effects: ["capture-artifact"],
        exportId: "memory-capture-artifact",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.capture-artifact",
      },
      {
        contractRef: "contract://workflow/memory-fabric/memory-search.v1",
        effects: ["search"],
        exportId: "memory-search",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.search",
      },
      {
        contractRef: "contract://workflow/memory-fabric/signals.v1",
        effects: ["signals"],
        exportId: "memory-signals",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.signals",
      },
      {
        contractRef: "contract://workflow/memory-fabric/hydration.v1",
        effects: ["hydrate"],
        exportId: "memory-hydration",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.hydrate",
      },
      {
        contractRef: "contract://workflow/memory-fabric/correlation-graph.v1",
        effects: ["correlate"],
        exportId: "memory-correlation-graph",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.correlate",
      },
      {
        contractRef:
          "contract://workflow/memory-fabric/refinement-proposals.v1",
        effects: ["refinement-proposals"],
        exportId: "memory-refinement-proposals",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.refinement-proposals",
      },
      {
        contractRef: "contract://workflow/memory-fabric/hitl-report.v1",
        effects: ["hitl-report"],
        exportId: "memory-hitl-report",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.hitl-report",
      },
      {
        contractRef:
          "contract://workflow/memory-fabric/hitl-decision-workflow-seed.v1",
        effects: ["hitl-decision-seed"],
        exportId: "memory-hitl-decision-workflow-seed",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.hitl-decision-seed",
      },
      {
        contractRef:
          "contract://workflow/memory-fabric/hitl-follow-up-run-request.v1",
        effects: ["hitl-follow-up-run-request"],
        exportId: "memory-hitl-follow-up-run-request",
        kind: "workflow-node",
        nodeType: "joelclaw.memory.hitl-follow-up-run-request",
      },
      {
        contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
        exportId: "memory-hitl-decision-schema",
        kind: "schema",
      },
    ],
    kind: "workflow-pack",
    latestVersion: "0.1.0",
    manifestPath: "package.json",
    ownerRef: "org:joelhooks",
    packageId: "workflow/memory-fabric",
    repoName: "pkg-workflow-memory-fabric",
    title: "Memory Fabric Workflow",
    trustTier: "reviewed",
  });

export const memoryFabricPackageMetadata = packageMetadataForSeedTemplate(
  memoryFabricPackageSeedTemplate
);
