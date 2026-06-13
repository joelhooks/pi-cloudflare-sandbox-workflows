import { MemorySourceProfileSchema } from "../../app/domain/source-profile.ts";
import type {
  MemoryCoverageHorizon,
  MemoryRelayOperation,
  MemorySourceFamily,
  MemorySourceFamilyExpectation,
  MemorySourceProfile,
} from "../../app/domain/source-profile.ts";
import { aiHeroSupportSweepPackageMetadata } from "./package-seed.ts";
import type {
  AiHeroSupportSweepSourceFamily,
  AiHeroSupportSweepSourceRoot,
} from "./schemas.ts";
import { aiHeroSupportSweepNodeConfigContractNotes } from "./workflow-node-adapter.ts";

export const aiHeroSupportSweepWorkflowId = "aihero.support-sweep";
export const aiHeroSupportSweepPackageId = "workflow/aihero-support-sweep";

export const aiHeroSupportSweepSourceFamilies = [
  "brain",
  "support",
  "comms",
  "people-org-memory",
] as const satisfies readonly AiHeroSupportSweepSourceFamily[];

export const aiHeroSupportSweepSourceFamilyExpectations = [
  { criticality: "primary", family: "brain" },
  { criticality: "primary", family: "support" },
  { criticality: "primary", family: "comms" },
  { criticality: "primary", family: "people-org-memory" },
] as const satisfies readonly MemorySourceFamilyExpectation[];

export const aiHeroSupportSweepTimeHorizons = [
  "24h",
  "7d",
  "30d",
  "quarter",
  "all-time",
] as const satisfies readonly MemoryCoverageHorizon[];

export const aiHeroSupportSweepRelayOperations = [
  "hydrate",
  "search",
  "signals",
] as const satisfies readonly MemoryRelayOperation[];

export const aiHeroSupportSweepRequiredOutputEffects = [
  "source-inventory",
  "derived-index-health",
  "signal-search",
  "evidence-hydration",
  "support-recommendations",
  "draft-side-effects",
] as const;

export const aiHeroSupportSweepSourceRoots = [
  {
    family: "brain",
    includeExtensions: [".svx"],
    label: "AIHero Support Brain",
    privacyTier: "customer-private",
    scope: {
      organizationId: "org:badass-courses",
      projectId: "aihero-support",
    },
    sourceId: "source:brain:badass-courses:aihero-support",
    sourceRootRef: "source:brain:badass-courses:aihero-support",
    sourceSystem: "local:brain",
  },
  {
    family: "support",
    includeExtensions: [".json", ".jsonl"],
    label: "AIHero Front support snapshots",
    privacyTier: "customer-private",
    scope: {
      organizationId: "org:badass-courses",
      projectId: "aihero-support",
    },
    sourceId: "source:support:badass-courses:aihero-front-snapshot",
    sourceRootRef: "source:support:badass-courses:aihero-front-snapshot",
    sourceSystem: "local:front-snapshot",
  },
  {
    family: "comms",
    includeExtensions: [".json", ".jsonl", ".md", ".txt"],
    label: "AIHero internal comms archive",
    privacyTier: "customer-private",
    scope: {
      organizationId: "org:badass-courses",
      projectId: "aihero-support",
    },
    sourceId: "source:comms:badass-courses:aihero-internal-comms",
    sourceRootRef: "source:comms:badass-courses:aihero-internal-comms",
    sourceSystem: "local:internal-comms-archive",
  },
  {
    family: "people-org-memory",
    includeExtensions: [".svx", ".md", ".json"],
    label: "AIHero CRM and org memory Brain",
    privacyTier: "customer-private",
    scope: {
      organizationId: "org:badass-courses",
      projectId: "aihero-support",
    },
    sourceId: "source:people-org-memory:badass-courses:aihero-crm",
    sourceRootRef: "source:people-org-memory:badass-courses:aihero-crm",
    sourceSystem: "local:brain-crm",
  },
] as const satisfies readonly AiHeroSupportSweepSourceRoot[];

const aiHeroSupportSweepWorkflowNodePalette =
  aiHeroSupportSweepPackageMetadata.exports.flatMap((exportRecord) =>
    exportRecord.kind === "workflow-node" && exportRecord.nodeType !== undefined
      ? [exportRecord.nodeType]
      : []
  );

export const aiHeroSupportSweepSourceProfile = MemorySourceProfileSchema.parse({
  allowedRelayOperations: [...aiHeroSupportSweepRelayOperations],
  defaultQuery: "AIHero support sweep",
  outputBoundary: {
    noCustomerDataInPublicArtifacts: true,
    noRawCredentials: true,
    noRawPrivatePaths: true,
    noRawTranscripts: true,
  },
  packageId: aiHeroSupportSweepPackageId,
  plannerGuidance: {
    intent:
      "Run the AIHero support sweep as a generated workflow over customer-private support, comms, Brain, and CRM signals. Inventory the four source roots, check derived-index health with recovery-only backfill plans, search by issue/account/person/course-product context across the configured horizons, hydrate only selected redacted receipts, emit concise HITL support recommendations, then draft side-effect artifacts behind capability leases without submitting anything live.",
    requestedPackageIds: [aiHeroSupportSweepPackageId],
    stochasticNotes: [
      "Use only generated workflow.node.invoke states for AIHero support-sweep cartridge work; do not add AIHero branches to the runner or Dream cartridge.",
      ...aiHeroSupportSweepNodeConfigContractNotes(),
      `AIHero support-sweep node palette: ${aiHeroSupportSweepWorkflowNodePalette.join(", ")}.`,
      "All source families are customer-private primary sources for this profile. If any family resolves zero receipts, the HITL recommendations should be treated as blocked or caveated instead of confident support guidance.",
      "Evidence hydration is redaction-first: no raw support threads, customer emails/names, credentials, or private filesystem paths in report/public artifacts.",
      "Side effects are draft-only during burn-in. Front/GitHub/Linear/private Wzrrd actions are cartridge-local draft artifacts with submitted:false and leaseRequired:true.",
    ],
    workItemId: "work-item:aihero-support-sweep",
  },
  profileId: "badass-courses/aihero-support-sweep",
  purpose:
    "Review AIHero support, comms, customer, and org signals, then produce HITL support actions under scoped customer-private leases.",
  requiredOutputEffects: [...aiHeroSupportSweepRequiredOutputEffects],
  requiredRuntimes: ["cloudflare"],
  requiresGeneratedWorkflowProof: true,
  schemaVersion: "memory.source-profile.v1",
  sourceFamiliesExpected: [
    ...aiHeroSupportSweepSourceFamilies,
  ] satisfies MemorySourceFamily[],
  sourceFamilyExpectations: [...aiHeroSupportSweepSourceFamilyExpectations],
  sourcePacks: [
    {
      description:
        "Customer-private AIHero support, comms, Brain, and CRM source roots for the support sweep workflow.",
      packId: "source-pack:badass-courses:aihero-support-sweep",
      packageId: aiHeroSupportSweepPackageId,
      privacyTier: "customer-private",
      requiredCapabilityKinds: ["aihero.support-sweep.relay"],
      scope: {
        organizationId: "org:badass-courses",
        projectId: "aihero-support",
      },
      selectionPolicy: "default",
      sourceFamilies: [...aiHeroSupportSweepSourceFamilies],
      surfaces: ["brain", "front", "slack", "org-project-graph"],
      title: "AIHero Support Sweep Source Pack",
    },
  ],
  timeHorizons: [...aiHeroSupportSweepTimeHorizons],
  title: "AIHero Support Sweep",
  workflowId: aiHeroSupportSweepWorkflowId,
});

export const aiHeroSupportSweepSourceProfiles = [
  aiHeroSupportSweepSourceProfile,
] as const satisfies readonly MemorySourceProfile[];
