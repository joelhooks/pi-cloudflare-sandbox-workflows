import { z } from "zod";

import {
  ActorSchema,
  ArtifactRefSchema,
  IsoDateTimeSchema,
  Sha256HexSchema,
} from "../../app/domain/schemas.ts";
import {
  MemoryCoverageHorizonSchema,
  MemorySourceFamilySchema,
  MemorySourceScopeSchema,
} from "../../app/domain/source-profile.ts";

export const AiHeroSupportSweepSourceFamilySchema = z.enum([
  "brain",
  "support",
  "comms",
  "people-org-memory",
]);

export const AiHeroSupportSweepPrivacyTierSchema =
  z.literal("customer-private");

export const AiHeroSupportSweepSourceRootSchema = z.object({
  family: AiHeroSupportSweepSourceFamilySchema,
  includeExtensions: z.array(z.string().min(1)).min(1),
  label: z.string().min(1),
  privacyTier: AiHeroSupportSweepPrivacyTierSchema,
  scope: MemorySourceScopeSchema,
  sourceId: z.string().min(1),
  sourceRootRef: z.string().min(1),
  sourceSystem: z.string().min(1),
});

export const AiHeroSupportSweepReceiptSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  family: AiHeroSupportSweepSourceFamilySchema,
  hash: Sha256HexSchema.optional(),
  privacyTier: AiHeroSupportSweepPrivacyTierSchema,
  receiptId: z.string().min(1),
  redactedLocator: z.string().min(1).optional(),
  sourceId: z.string().min(1),
  timestamp: IsoDateTimeSchema.optional(),
});

export const AiHeroSupportSweepNodeReceiptSchema = z.object({
  nodeType: z.string().min(1),
  receiptId: z.string().min(1),
  redacted: z.literal(true),
  sourceReceipts: z.array(AiHeroSupportSweepReceiptSchema).default([]),
  summary: z.string().min(1),
});

const AiHeroSupportSweepDocumentBaseSchema = z.object({
  generatedAt: IsoDateTimeSchema,
  nodeReceipt: AiHeroSupportSweepNodeReceiptSchema,
  receipts: z.array(AiHeroSupportSweepReceiptSchema).default([]),
  redacted: z.literal(true),
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const AiHeroSupportSweepInventoryDocumentSchema =
  AiHeroSupportSweepDocumentBaseSchema.extend({
    schemaVersion: z.literal("aihero.support-sweep.inventory.v1"),
    sourceRoots: z.array(AiHeroSupportSweepSourceRootSchema).min(1),
    summary: z.string().min(1),
  });

export const AiHeroSupportSweepIndexStatusSchema = z.enum([
  "healthy",
  "missing",
  "stale",
]);

export const AiHeroSupportSweepIndexHealthDocumentSchema =
  AiHeroSupportSweepDocumentBaseSchema.extend({
    recoveryOnlyBackfillPlan: z
      .array(
        z.object({
          backfillId: z.string().min(1),
          reason: z.string().min(1),
          sourceId: z.string().min(1),
          status: z.literal("planned"),
        })
      )
      .default([]),
    schemaVersion: z.literal("aihero.support-sweep.index-health.v1"),
    sourceIndexes: z.array(
      z.object({
        family: AiHeroSupportSweepSourceFamilySchema,
        lastIndexedAt: IsoDateTimeSchema.optional(),
        recoveryOnly: z.literal(true),
        sourceId: z.string().min(1),
        status: AiHeroSupportSweepIndexStatusSchema,
        summary: z.string().min(1),
      })
    ),
    summary: z.string().min(1),
  });

export const AiHeroSupportSweepSearchAxisSchema = z.enum([
  "account",
  "course-product",
  "issue",
  "person",
]);

export const AiHeroSupportSweepSignalSchema = z.object({
  axis: AiHeroSupportSweepSearchAxisSchema,
  horizon: MemoryCoverageHorizonSchema,
  rating: z.number().int().min(1).max(10),
  receipts: z.array(AiHeroSupportSweepReceiptSchema).min(1),
  redactedExcerpt: z.string().min(1).optional(),
  signalId: z.string().min(1),
  summary: z.string().min(1),
});

export const AiHeroSupportSweepSignalSearchDocumentSchema =
  AiHeroSupportSweepDocumentBaseSchema.extend({
    axes: z.array(AiHeroSupportSweepSearchAxisSchema).min(1),
    horizons: z.array(MemoryCoverageHorizonSchema).min(1),
    query: z.string().min(1),
    schemaVersion: z.literal("aihero.support-sweep.signal-search.v1"),
    signals: z.array(AiHeroSupportSweepSignalSchema).default([]),
    skippedSources: z.array(z.string().min(1)).default([]),
  });

export const AiHeroSupportSweepHydratedEvidenceSchema = z.object({
  customerIdentifiersReturned: z.literal(false),
  evidenceRef: ArtifactRefSchema.optional(),
  rawSupportThreadReturned: z.literal(false),
  receipt: AiHeroSupportSweepReceiptSchema,
  redactedExcerpt: z.string().min(1).optional(),
  summary: z.string().min(1),
});

export const AiHeroSupportSweepHydrationDocumentSchema =
  AiHeroSupportSweepDocumentBaseSchema.extend({
    evidence: z.array(AiHeroSupportSweepHydratedEvidenceSchema).default([]),
    schemaVersion: z.literal("aihero.support-sweep.hydration.v1"),
    selectedReceiptCount: z.number().int().min(0),
  });

export const AiHeroSupportSweepRecommendationSchema = z.object({
  evidenceRefs: z.array(ArtifactRefSchema).default([]),
  rating: z.number().int().min(1).max(10),
  reasoning: z.string().min(1),
  receiptTrail: z.array(AiHeroSupportSweepReceiptSchema).min(1),
  recommendation: z.string().min(1),
  recommendationId: z.string().min(1),
  summary: z.string().min(1),
});

export const AiHeroSupportSweepRecommendationDocumentSchema =
  AiHeroSupportSweepDocumentBaseSchema.extend({
    recommendationCount: z.number().int().min(0),
    recommendations: z
      .array(AiHeroSupportSweepRecommendationSchema)
      .default([]),
    schemaVersion: z.literal("aihero.support-sweep.recommendations.v1"),
    summary: z.string().min(1),
  });

export const AiHeroSupportSweepDraftActionKindSchema = z.enum([
  "front-draft-reply",
  "front-draft-tag",
  "github-follow-up-draft",
  "linear-follow-up-draft",
  "private-wzrrd-review-draft",
]);

export const AiHeroSupportSweepDraftActionSchema = z.object({
  actionId: z.string().min(1),
  actionKind: AiHeroSupportSweepDraftActionKindSchema,
  draftArtifactRef: ArtifactRefSchema,
  leaseGate: z.object({
    capabilityKind: z.string().min(1),
    leaseGranted: z.literal(false),
    leaseRequired: z.literal(true),
    reviewRequired: z.literal(true),
  }),
  recommendationId: z.string().min(1),
  submitted: z.literal(false),
  summary: z.string().min(1),
});

export const AiHeroSupportSweepDraftSideEffectDocumentSchema =
  AiHeroSupportSweepDocumentBaseSchema.extend({
    draftActions: z.array(AiHeroSupportSweepDraftActionSchema).default([]),
    privateReviewSurface: z.object({
      noindex: z.literal(true),
      privacyTier: AiHeroSupportSweepPrivacyTierSchema,
      submitted: z.literal(false),
    }),
    schemaVersion: z.literal("aihero.support-sweep.draft-side-effects.v1"),
    submitted: z.literal(false),
    summary: z.string().min(1),
  });

export const AiHeroSupportSweepNodeOutputDocumentSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    AiHeroSupportSweepInventoryDocumentSchema,
    AiHeroSupportSweepIndexHealthDocumentSchema,
    AiHeroSupportSweepSignalSearchDocumentSchema,
    AiHeroSupportSweepHydrationDocumentSchema,
    AiHeroSupportSweepRecommendationDocumentSchema,
    AiHeroSupportSweepDraftSideEffectDocumentSchema,
  ]
);

export const AiHeroSupportSweepInventoryPayloadSchema = z.object({
  actor: ActorSchema,
  runId: z.string().min(1),
  sourceFamilies: z.array(MemorySourceFamilySchema).min(1).optional(),
  workItemId: z.string().min(1),
});

export const AiHeroSupportSweepIndexHealthPayloadSchema = z.object({
  actor: ActorSchema,
  inventory: AiHeroSupportSweepInventoryDocumentSchema,
  inventoryRef: ArtifactRefSchema,
  recoveryOnly: z.literal(true),
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const AiHeroSupportSweepSignalSearchPayloadSchema = z.object({
  actor: ActorSchema,
  axes: z.array(AiHeroSupportSweepSearchAxisSchema).min(1),
  horizons: z.array(MemoryCoverageHorizonSchema).min(1),
  indexHealth: AiHeroSupportSweepIndexHealthDocumentSchema,
  indexHealthRef: ArtifactRefSchema,
  maxSignals: z.number().int().min(1),
  query: z.string().min(1),
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

export const AiHeroSupportSweepHydrationPayloadSchema = z.object({
  actor: ActorSchema,
  maxReceipts: z.number().int().min(1),
  receipts: z.array(AiHeroSupportSweepReceiptSchema).min(1),
  runId: z.string().min(1),
  signalSearch: AiHeroSupportSweepSignalSearchDocumentSchema,
  signalSearchRef: ArtifactRefSchema,
  workItemId: z.string().min(1),
});

export type AiHeroSupportSweepDraftAction = z.infer<
  typeof AiHeroSupportSweepDraftActionSchema
>;
export type AiHeroSupportSweepDraftSideEffectDocument = z.infer<
  typeof AiHeroSupportSweepDraftSideEffectDocumentSchema
>;
export type AiHeroSupportSweepHydrationDocument = z.infer<
  typeof AiHeroSupportSweepHydrationDocumentSchema
>;
export type AiHeroSupportSweepIndexHealthDocument = z.infer<
  typeof AiHeroSupportSweepIndexHealthDocumentSchema
>;
export type AiHeroSupportSweepInventoryDocument = z.infer<
  typeof AiHeroSupportSweepInventoryDocumentSchema
>;
export type AiHeroSupportSweepInventoryPayload = z.infer<
  typeof AiHeroSupportSweepInventoryPayloadSchema
>;
export type AiHeroSupportSweepIndexHealthPayload = z.infer<
  typeof AiHeroSupportSweepIndexHealthPayloadSchema
>;
export type AiHeroSupportSweepHydrationPayload = z.infer<
  typeof AiHeroSupportSweepHydrationPayloadSchema
>;
export type AiHeroSupportSweepNodeOutputDocument = z.infer<
  typeof AiHeroSupportSweepNodeOutputDocumentSchema
>;
export type AiHeroSupportSweepReceipt = z.infer<
  typeof AiHeroSupportSweepReceiptSchema
>;
export type AiHeroSupportSweepRecommendation = z.infer<
  typeof AiHeroSupportSweepRecommendationSchema
>;
export type AiHeroSupportSweepRecommendationDocument = z.infer<
  typeof AiHeroSupportSweepRecommendationDocumentSchema
>;
export type AiHeroSupportSweepSearchAxis = z.infer<
  typeof AiHeroSupportSweepSearchAxisSchema
>;
export type AiHeroSupportSweepSignal = z.infer<
  typeof AiHeroSupportSweepSignalSchema
>;
export type AiHeroSupportSweepSignalSearchDocument = z.infer<
  typeof AiHeroSupportSweepSignalSearchDocumentSchema
>;
export type AiHeroSupportSweepSignalSearchPayload = z.infer<
  typeof AiHeroSupportSweepSignalSearchPayloadSchema
>;
export type AiHeroSupportSweepSourceFamily = z.infer<
  typeof AiHeroSupportSweepSourceFamilySchema
>;
export type AiHeroSupportSweepSourceRoot = z.infer<
  typeof AiHeroSupportSweepSourceRootSchema
>;
