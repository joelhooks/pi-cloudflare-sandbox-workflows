import { z } from "zod";

import { ArtifactRefSchema } from "./schemas.ts";

export const MemorySourceFamilySchema = z.enum([
  "agent-transcripts",
  "brain",
  "cloudflare-runs",
  "comms",
  "docs-pdf-brain",
  "people-org-memory",
  "repo-outputs",
  "support",
]);

export const MemoryRuntimeSchema = z.enum([
  "claude",
  "cloudflare",
  "codex",
  "pi",
]);

export const MemoryCoverageHorizonSchema = z.enum([
  "24h",
  "7d",
  "30d",
  "quarter",
  "all-time",
]);

export const MemoryPrivacyTierSchema = z.enum([
  "customer-private",
  "internal",
  "private",
  "public",
  "secret-adjacent",
]);

export const MemorySourceScopeSchema = z.object({
  machineId: z.string().min(1).optional(),
  organizationId: z.string().min(1),
  personId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
});

export const MemoryRelayOperationSchema = z.enum([
  "capture-artifact",
  "capture-run",
  "correlate",
  "hydrate",
  "search",
  "signals",
]);

export const MemorySourceSurfaceSchema = z.enum([
  "brain",
  "cloudflare-artifacts",
  "discord",
  "front",
  "github",
  "joelclaw-docs",
  "linear",
  "local-repo",
  "org-project-graph",
  "slack",
  "wzrrd",
]);

export const MemorySourcePackSelectionPolicySchema = z.enum([
  "default",
  "optional-lease",
  "separate-workflow",
]);

export const MemorySourcePackSchema = z.object({
  description: z.string().min(1),
  packId: z.string().min(1),
  packageId: z.string().min(1),
  privacyTier: MemoryPrivacyTierSchema,
  requiredCapabilityKinds: z.array(z.string().min(1)).min(1),
  scope: MemorySourceScopeSchema,
  selectionPolicy: MemorySourcePackSelectionPolicySchema,
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1),
  surfaces: z.array(MemorySourceSurfaceSchema).min(1),
  title: z.string().min(1),
});

export const MemorySourcePackDispositionStatusSchema = z.enum([
  "selected-by-default",
  "selected-with-lease",
  "separate-workflow-candidate",
  "skipped-missing-lease",
]);

export const MemorySourcePackDispositionSchema = z
  .object({
    capabilityKinds: z.array(z.string().min(1)).default([]),
    leaseRefs: z.array(ArtifactRefSchema).default([]),
    missingCapabilityKinds: z.array(z.string().min(1)).default([]),
    packId: z.string().min(1),
    packageId: z.string().min(1),
    reason: z.string().min(1),
    requiredCapabilityKinds: z.array(z.string().min(1)).min(1),
    selectionPolicy: MemorySourcePackSelectionPolicySchema,
    sourceFamilies: z.array(MemorySourceFamilySchema).min(1),
    status: MemorySourcePackDispositionStatusSchema,
    surfaces: z.array(MemorySourceSurfaceSchema).min(1),
  })
  .superRefine((disposition, context) => {
    if (disposition.status === "selected-with-lease") {
      if (disposition.leaseRefs.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            "Selected source packs require at least one capability lease receipt ref.",
          path: ["leaseRefs"],
        });
      }

      if (disposition.missingCapabilityKinds.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "Selected source packs must not declare missing capability kinds.",
          path: ["missingCapabilityKinds"],
        });
      }
    }

    if (disposition.status === "skipped-missing-lease") {
      if (disposition.leaseRefs.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "Skipped source packs must not carry capability lease receipt refs.",
          path: ["leaseRefs"],
        });
      }

      if (disposition.missingCapabilityKinds.length === 0) {
        context.addIssue({
          code: "custom",
          message:
            "Skipped source packs must declare missing capability kinds.",
          path: ["missingCapabilityKinds"],
        });
      }
    }
  });

export const MemoryWorkflowEffectSchema = z.enum([
  "capture-artifact",
  "capture-run",
  "correlate",
  "hitl-decision-seed",
  "hitl-follow-up-run-request",
  "hitl-report",
  "hydrate",
  "refinement-proposals",
  "search",
  "signals",
]);

export const MemoryFabricNodeTypeSchema = z.enum([
  "joelclaw.memory.correlate",
  "joelclaw.memory.capture-artifact",
  "joelclaw.memory.capture-run",
  "joelclaw.memory.hitl-decision-seed",
  "joelclaw.memory.hitl-follow-up-run-request",
  "joelclaw.memory.hitl-report",
  "joelclaw.memory.hydrate",
  "joelclaw.memory.search",
  "joelclaw.memory.refinement-proposals",
  "joelclaw.memory.signals",
]);

export const MemorySourceProfileSchema = z
  .object({
    allowedRelayOperations: z.array(MemoryRelayOperationSchema).min(1),
    defaultQuery: z.string().min(1),
    outputBoundary: z.object({
      noCustomerDataInPublicArtifacts: z.literal(true),
      noRawCredentials: z.literal(true),
      noRawPrivatePaths: z.literal(true),
      noRawTranscripts: z.literal(true),
    }),
    packageId: z.string().min(1),
    profileId: z.string().min(1),
    purpose: z.string().min(1),
    requiredRuntimes: z.array(MemoryRuntimeSchema).min(1),
    schemaVersion: z.literal("memory.source-profile.v1"),
    sourceFamiliesExpected: z.array(MemorySourceFamilySchema).min(1),
    sourcePacks: z.array(MemorySourcePackSchema).default([]),
    timeHorizons: z.array(MemoryCoverageHorizonSchema).min(1),
    title: z.string().min(1),
    workflowId: z.string().min(1),
  })
  .superRefine((profile, context) => {
    const packIds = new Set<string>();
    for (const [index, pack] of profile.sourcePacks.entries()) {
      if (packIds.has(pack.packId)) {
        context.addIssue({
          code: "custom",
          message:
            "Memory source profile sourcePacks packId values must be unique.",
          path: ["sourcePacks", index, "packId"],
        });
      }
      packIds.add(pack.packId);
    }
  });

export type MemoryCoverageHorizon = z.infer<typeof MemoryCoverageHorizonSchema>;
export type MemoryFabricNodeType = z.infer<typeof MemoryFabricNodeTypeSchema>;
export type MemoryPrivacyTier = z.infer<typeof MemoryPrivacyTierSchema>;
export type MemoryRelayOperation = z.infer<typeof MemoryRelayOperationSchema>;
export type MemoryRuntime = z.infer<typeof MemoryRuntimeSchema>;
export type MemorySourceFamily = z.infer<typeof MemorySourceFamilySchema>;
export type MemorySourcePack = z.infer<typeof MemorySourcePackSchema>;
export type MemorySourcePackDisposition = z.infer<
  typeof MemorySourcePackDispositionSchema
>;
export type MemorySourcePackDispositionStatus = z.infer<
  typeof MemorySourcePackDispositionStatusSchema
>;
export type MemorySourcePackSelectionPolicy = z.infer<
  typeof MemorySourcePackSelectionPolicySchema
>;
export type MemorySourceProfile = z.infer<typeof MemorySourceProfileSchema>;
export type MemorySourceScope = z.infer<typeof MemorySourceScopeSchema>;
export type MemorySourceSurface = z.infer<typeof MemorySourceSurfaceSchema>;
export type MemoryWorkflowEffect = z.infer<typeof MemoryWorkflowEffectSchema>;
