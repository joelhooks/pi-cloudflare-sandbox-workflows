import {
  packageMetadataForSeedTemplate,
  PackageSeedTemplateSchema,
} from "../../app/infrastructure/cloudflare-package-seeder.ts";
import type { PackageSeedTemplate } from "../../app/infrastructure/cloudflare-package-seeder.ts";

export const aiHeroSupportSweepPackageSeedTemplate: PackageSeedTemplate =
  PackageSeedTemplateSchema.parse({
    description:
      "AIHero customer-private support sweep workflow nodes for source inventory, derived-index health, redacted signal search, redacted evidence hydration, HITL support recommendations, and lease-gated draft-only side effects.",
    exports: [
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/source-profile.v1",
        exportId: "aihero-support-sweep-source-profile",
        kind: "source-profile",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/source-inventory.v1",
        effects: ["source-inventory"],
        exportId: "aihero-support-source-inventory",
        kind: "workflow-node",
        nodeType: "aihero.support-sweep.source-inventory",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/derived-index-health.v1",
        effects: ["derived-index-health"],
        exportId: "aihero-support-derived-index-health",
        kind: "workflow-node",
        nodeType: "aihero.support-sweep.derived-index-health",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/signal-search.v1",
        effects: ["signal-search"],
        exportId: "aihero-support-signal-search",
        kind: "workflow-node",
        nodeType: "aihero.support-sweep.signal-search",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/evidence-hydration.v1",
        effects: ["evidence-hydration"],
        exportId: "aihero-support-evidence-hydration",
        kind: "workflow-node",
        nodeType: "aihero.support-sweep.evidence-hydration",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/hitl-recommendations.v1",
        effects: ["support-recommendations"],
        exportId: "aihero-support-hitl-recommendations",
        kind: "workflow-node",
        nodeType: "aihero.support-sweep.hitl-recommendations",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/draft-side-effects.v1",
        effects: ["draft-side-effects"],
        exportId: "aihero-support-draft-side-effects",
        kind: "workflow-node",
        nodeType: "aihero.support-sweep.draft-side-effects",
      },
      {
        contractRef:
          "contract://workflow/aihero-support-sweep/recommendation-schema.v1",
        exportId: "aihero-support-recommendation-schema",
        kind: "schema",
      },
    ],
    kind: "workflow-pack",
    latestVersion: "0.1.0",
    manifestPath: "package.json",
    ownerRef: "org:badass-courses",
    packageId: "workflow/aihero-support-sweep",
    repoName: "pkg-workflow-aihero-support-sweep",
    title: "AIHero Support Sweep Workflow",
    trustTier: "reviewed",
  });

export const aiHeroSupportSweepPackageMetadata = packageMetadataForSeedTemplate(
  aiHeroSupportSweepPackageSeedTemplate
);
