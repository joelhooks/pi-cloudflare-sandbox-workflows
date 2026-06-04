import { z } from "zod";

const IdentifierSchema = z.string().min(1);
const ArtifactPathSchema = z.string().min(1);

export const OutputTargetKindSchema = z.enum([
  "wzrrd_review",
  "github_pr",
  "artifact_only",
  "linear_update",
  "issue_comment",
  "email_draft",
  "prototype",
  "implementation_plan",
]);

export const OutputTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("wzrrd_review"),
    presentation: z
      .object({
        build: z.literal("sveltekit-static-html"),
        style: z.literal("professional-clean"),
      })
      .default({ build: "sveltekit-static-html", style: "professional-clean" }),
  }),
  z.object({
    base: z.string().min(1),
    branchPrefix: z.string().min(1).default("piwf"),
    commitActor: z.literal("shitratgit[bot]").default("shitratgit[bot]"),
    kind: z.literal("github_pr"),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  }),
  z.object({ kind: z.literal("artifact_only") }),
  z.object({
    kind: z.literal("linear_update"),
    teamKey: z.string().min(1).optional(),
  }),
  z.object({
    issueNumber: z.number().int().positive(),
    kind: z.literal("issue_comment"),
    repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  }),
  z.object({
    kind: z.literal("email_draft"),
    subjectHint: z.string().min(1).optional(),
    toHint: z.string().email().optional(),
  }),
  z.object({
    kind: z.literal("prototype"),
    nameHint: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("implementation_plan") }),
]);

export const JobSpecSchema = z
  .object({
    contextPackRefs: z.array(IdentifierSchema).min(1),
    outputTarget: OutputTargetSchema,
    secretRefs: z.array(IdentifierSchema).default([]),
    task: z.string().min(1),
    verificationContract: IdentifierSchema,
    workItemId: IdentifierSchema,
  })
  .strict();

export const WorkflowPatternSchema = z.enum([
  "reader_verifier",
  "edit_verify_pr",
  "fanout_synthesis",
  "generate_filter",
  "human_review_gate",
  "artifact_only_capture",
]);

export const MachineStateSchema = z.object({
  id: IdentifierSchema,
  kind: z.enum(["normal", "final"]),
  on: z.record(z.string(), IdentifierSchema).default({}),
  tags: z.array(z.string()).default([]),
});

export const PlannedMachineSchema = z.object({
  cancellationEvent: z.literal("CANCEL_REQUESTED"),
  contextKeys: z.array(IdentifierSchema).min(1),
  events: z.array(IdentifierSchema).min(1),
  id: IdentifierSchema,
  initial: IdentifierSchema,
  outputDeliveryState: z.literal("deliveringOutput"),
  receiptOnly: z.literal(true),
  states: z.array(MachineStateSchema).min(1),
  xstateVersion: z.literal("v5"),
});

export const HarnessStepSchema = z.object({
  id: IdentifierSchema,
  inputs: z.array(IdentifierSchema).default([]),
  kind: z.enum([
    "resolve-context",
    "materialize-secret-ref",
    "prepare-workspace",
    "run-pi-lane",
    "run-tests",
    "verify-output",
    "deliver-output",
    "cleanup",
  ]),
  outputs: z.array(ArtifactPathSchema).default([]),
  policy: z.array(IdentifierSchema).default([]),
  targetKind: OutputTargetKindSchema.optional(),
});

export const HarnessPlanSchema = z.object({
  generatedCodeRuntime: z.literal("none"),
  steps: z.array(HarnessStepSchema).min(1),
});

export const VerificationContractPlanSchema = z.object({
  criteria: z.array(
    z.object({
      id: IdentifierSchema,
      severity: z.enum(["warning", "blocking"]),
      summary: z.string().min(1),
    })
  ),
  id: IdentifierSchema,
  statusPolicy: z.object({
    blocked: z.literal("blocked"),
    needsHumanReview: z.literal("needs_human_review"),
    verified: z.literal("verified"),
    warnings: z.literal("warnings"),
  }),
});

export const PolicyCheckSchema = z.object({
  id: IdentifierSchema,
  status: z.enum(["passed", "failed"]),
  summary: z.string().min(1),
});

export const PlannedWorkflowSchema = z.object({
  harness: HarnessPlanSchema,
  jobSpec: JobSpecSchema,
  machine: PlannedMachineSchema,
  outputTarget: OutputTargetSchema,
  pattern: WorkflowPatternSchema,
  policyChecks: z.array(PolicyCheckSchema).min(1),
  rejectedUnsafeFields: z.array(IdentifierSchema).default([]),
  verification: VerificationContractPlanSchema,
});

export const RejectedPlanSchema = z.object({
  reason: z.string().min(1),
  rejectedUnsafeFields: z.array(IdentifierSchema).min(1),
  workItemId: z.string().min(1).optional(),
});

export const PlannerReceiptSchema = z.object({
  checks: z.array(PolicyCheckSchema).min(1),
  generatedAt: z.string().datetime(),
  plans: z.array(PlannedWorkflowSchema).min(1),
  prototype: z.literal("machine-planner-spike"),
  question: z.string().min(1),
  rejected: z.array(RejectedPlanSchema).min(1),
  schemaVersion: z.literal("machine-planner-receipt.v1"),
});

export type HarnessPlan = z.infer<typeof HarnessPlanSchema>;
export type JobSpec = z.infer<typeof JobSpecSchema>;
export type OutputTarget = z.infer<typeof OutputTargetSchema>;
export type PlannedMachine = z.infer<typeof PlannedMachineSchema>;
export type PlannedWorkflow = z.infer<typeof PlannedWorkflowSchema>;
export type PlannerReceipt = z.infer<typeof PlannerReceiptSchema>;
export type PolicyCheck = z.infer<typeof PolicyCheckSchema>;
export type RejectedPlan = z.infer<typeof RejectedPlanSchema>;
export type VerificationContractPlan = z.infer<
  typeof VerificationContractPlanSchema
>;
export type WorkflowPattern = z.infer<typeof WorkflowPatternSchema>;
