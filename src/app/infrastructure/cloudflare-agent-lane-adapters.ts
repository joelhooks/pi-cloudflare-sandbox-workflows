import { z } from "zod";

import { AgentLaneAlreadyCompletedError } from "../application/admitted-agent-lane-runtime.ts";
import {
  PlannerBlueprintContractError,
  redactionSafeTopLevelKeyNames,
} from "../application/ports.ts";
import type {
  AgentAnalysisReasoningLanePort,
  AgentLaneRuntimeRequest,
  AgentLaneRuntimePort,
  AgentPlannerLanePort,
  AgentVerifierOutputEvidence,
  AgentVerifierLanePort,
  AgentWorkerLanePort,
  ArtifactStoreContract,
  DynamicWorkflowNotificationInput,
  PlannerBlueprintContractStage,
} from "../application/ports.ts";
import { hashJson } from "../domain/hash.ts";
import {
  renderKernelSkillsPromptSection,
  resolveKernelSkills,
} from "../domain/kernel-skills.ts";
import {
  AgentLaneReceiptSchema,
  AgentLaneDispatchReceiptSchema,
  DynamicWorkflowBlueprintSchema,
  PlannerLaneBlueprintDocumentSchema,
  ResearchReviewOutputDocumentSchema,
  VerificationResultArtifactSchema,
  VerificationResultDocumentSchema,
  WorkflowDriveLaneDispatchSchema,
  WorkflowDriveLaneStatusReceiptSchema,
  WorkflowObservabilityPackSchema,
} from "../domain/schemas.ts";
import type {
  Actor,
  AgentAuthLease,
  ArtifactRef,
  CapabilityLeaseReceipt,
  DynamicWorkflowBlueprint,
  DynamicWorkflowPlanDocument,
  DynamicWorkflowStep,
  PackageMetadata,
  PinnedPackage,
  PlanProposal,
  VerificationContractDocument,
} from "../domain/schemas.ts";
import { workflowTraceContextForLane } from "../domain/trace-context.ts";

interface CloudflarePiLaneAdapterConfig {
  readonly artifactRemote: string;
  readonly artifactStore: Pick<
    ArtifactStoreContract,
    "artifactRef" | "readJson" | "readText"
  >;
  readonly artifactTokenSecret: string;
  readonly authLease: AgentAuthLease;
  readonly leasedPiAuthJsonBase64: string;
  readonly model: string;
  readonly provider: "openai-codex";
  readonly runtime: AgentLaneRuntimePort;
  readonly timeoutMs: number;
}

const safePathSegment = (value: string): string =>
  value.replaceAll(/[^A-Za-z0-9_.-]/gu, "_");

/** Required top-level keys, derived from the production schemas (no drift). */
const PLANNER_OUTPUT_REQUIRED_KEYS = Object.keys(
  PlannerLaneBlueprintDocumentSchema.shape
);
const BLUEPRINT_REQUIRED_KEYS = Object.keys(
  DynamicWorkflowBlueprintSchema.shape
);

/**
 * Build a {@link PlannerBlueprintContractError} from a failed blueprint parse —
 * the place the carrier turns a raw `ZodError` (which upstream flattened into a
 * transient `adapter_unavailable` and re-drove for ~40 minutes, wound #27) into
 * a DETERMINISTIC, redaction-safe diagnostic naming what pi actually emitted.
 *
 * Only key NAMES and zod issue PATHS cross the boundary — never values — so the
 * surfaced block is safe to read yet self-diagnoses wrong-extraction (a session
 * header), an envelope (`result`), or a refusal (no object) without staring.
 *
 * @param input.raw - The parsed planner output that failed the schema.
 * @param input.requiredKeys - The schema's required top-level keys.
 * @param input.stage - Which parse failed: planner-output vs blueprint-assembly.
 * @param input.zodError - The schema failure, mined for issue paths only.
 * @returns A typed deterministic contract error for the application catch.
 */
export const plannerBlueprintContractError = (input: {
  readonly raw: unknown;
  readonly requiredKeys: readonly string[];
  readonly runId: string;
  readonly stage: PlannerBlueprintContractStage;
  readonly workItemId: string;
  readonly zodError: z.ZodError;
}): PlannerBlueprintContractError => {
  const presentKeys = redactionSafeTopLevelKeyNames(input.raw);
  const presentSet = new Set(presentKeys);
  const missingKeys = input.requiredKeys.filter((key) => !presentSet.has(key));
  const issuePaths = [
    ...new Set(
      input.zodError.issues
        .map((issue) => issue.path.map(String).join("."))
        .filter((path) => path.length > 0)
    ),
  ].slice(0, 12);
  return new PlannerBlueprintContractError({
    issuePaths,
    missingKeys,
    presentKeys,
    runId: input.runId,
    stage: input.stage,
    workItemId: input.workItemId,
  });
};

const plannerBlueprintJsonSchema = JSON.stringify(
  z.toJSONSchema(PlannerLaneBlueprintDocumentSchema, {
    target: "draft-7",
  }),
  null,
  2
);

const verificationResultJsonSchema = JSON.stringify(
  z.toJSONSchema(VerificationResultDocumentSchema, {
    target: "draft-7",
  }),
  null,
  2
);

const researchReviewOutputJsonSchema = JSON.stringify(
  z.toJSONSchema(ResearchReviewOutputDocumentSchema, {
    target: "draft-7",
  }),
  null,
  2
);

/**
 * Build the planner lane prompt. The "## Kernel Skills (use these to design the
 * workflow)" section is the kernel-consumption keystone: it resolves the inline
 * skill exports of the pinned kernel packages and injects their FULL bodies, so
 * the planner reasons over real workflow-design / data-access / analysis
 * guidance instead of `JSON.stringify(pinnedPackages)` + "copy these refs."
 * When no pinned package exports a skill the section is omitted entirely, so a
 * run without kernel skills reads exactly as it did before this wire existed.
 * Exported so the consumption path can be asserted directly in tests without
 * standing up a full lane runtime.
 */
export const plannerPromptFor = (input: {
  readonly actor: Actor;
  readonly availablePackages: readonly PackageMetadata[];
  readonly notification?: DynamicWorkflowNotificationInput;
  readonly pinnedPackages: readonly PinnedPackage[];
  readonly proposal: PlanProposal;
  readonly runId: string;
  readonly workItemId: string;
}): string => {
  const kernelSkillsSection = renderKernelSkillsPromptSection(
    resolveKernelSkills(input.pinnedPackages)
  );

  return [
    "# Pi Planner Lane",
    "",
    "Generate a DynamicWorkflowBlueprint for the requested run. Emit only JSON. Do not wrap the JSON in Markdown. Do not call tools, perform side effects, or materialize secrets.",
    "",
    "## Strict Structured Output Contract",
    "",
    "Return a JSON object with exactly these top-level keys: machine, harness, plan, verificationContract.",
    "Do not include plannerLane. The supervisor attaches real planner lane evidence from the Cloudflare Sandbox receipt.",
    "The JSON Schema below is generated from the production Zod schema PlannerLaneBlueprintDocumentSchema and is the source of truth.",
    "No additional properties are allowed. Any schema violation blocks the run before worker lanes execute.",
    "The plan must use schemaVersion workflow.dynamic-plan.v1, the machine must use workflow.xstate-machine.v1, the harness must use workflow.generated-harness.v1, and the verification contract must use workflow.verification-contract.v1.",
    "The generated XState machine owns run-specific order. The plan owns typed step data, package refs, side-effect declarations, review gates, and output target.",
    "Every side effect must be represented as a side-effect declaration and a capability step. Never treat Discord, GitHub, Wzrrd, Linear, email, deploy, or any external apply/send action as direct tool access.",
    "",
    "## Binding Rules",
    "",
    `Use runId exactly ${JSON.stringify(input.runId)} in machine, harness, plan, and verificationContract.`,
    `Use workItemId exactly ${JSON.stringify(input.workItemId)} in machine, harness, plan, and verificationContract.`,
    "Copy plan.actor exactly from Run Binding actor.",
    "Copy plan.pinnedPackages exactly from Pinned Packages. Do not rename it to packages.",
    "Copy plan.proposal.intent, requestedPackageIds, and stochasticNotes exactly from Run Binding proposal.",
    "Use one shared planner object across machine, harness, and plan with kind stochastic, a fresh nonce, and source pi-planner-lane.",
    "Use createdAt values as ISO UTC datetimes ending in Z.",
    'Default to verificationContract.verifier {"kind":"agent-lane","runtime":"pi-agent-cli"}. Do not use integration-test.',
    'If Run Binding proposal.stochasticNotes explicitly asks for a deterministic verifier, artifact-evidence verifier, or builtin:artifact-evidence-integrity.v1, use verificationContract.verifier {"kind":"deterministic","source":"builtin:artifact-evidence-integrity.v1"} instead.',
    "When using builtin:artifact-evidence-integrity.v1, verificationContract.checks must use only these blocking checkId values: deterministic-output-evidence-present, deterministic-output-evidence-hashes-match, deterministic-side-effect-receipts-cover-plan, deterministic-observability-pack-present.",
    "Do not put semantic/source-grounding checks into a deterministic verification contract. Use the default agent-lane verifier when the contract requires judgment beyond artifact evidence integrity.",
    'Use verificationContract.outputPath exactly "artifacts/verification/result.json". This is the verifier result artifact path, not the review summary path.',
    "verificationContract.outputPath must not equal any plan.steps[*].outputPath, outputTarget.path, or outputTarget.reviewPath.",
    "review/summary.json belongs to the review gate after verifier acceptance; do not require it as pre-verifier output evidence.",
    "Treat plan.steps with kind review.summary as a reserved post-verifier review-gate marker. It does not produce pre-verifier worker output evidence.",
    'Use outputTarget {"kind":"wzrrd","reviewPath":"review/summary.json"} when the run asks for Wzrrd/proposal/review-surface reconciliation.',
    'When a generated workflow renders a public report artifact, include outputTarget.primaryDocument with artifactPath, publishPath, mediaType, and title, for example {"artifactPath":"reports/hitl-report.mdsvx","publishPath":"report.mdsvx","mediaType":"text/mdsvx","title":"<report title>"}. Prefer explicit primaryDocument values from stochasticNotes when present.',
    'Use outputTarget {"kind":"github-pr","repositoryRef":"<owner/repo>","branchName":"<branch>","baseBranch":"main"} when the run asks for GitHub PR delivery. Prefer explicit repositoryRef, branchName, and baseBranch values from stochasticNotes; otherwise use repositoryRef "joelhooks/pi-cloudflare-sandbox-workflows", branchName "workflow/<runId>", and baseBranch "main".',
    'Use outputTarget {"kind":"linear","issueRef":"<issue-id-or-key>"} when the run asks for Linear issue comment delivery. Prefer an explicit issueRef from stochasticNotes or the work item id when it is a Linear issue key.',
    "GitHub, Wzrrd, and Linear output targets describe app-owned review-surface delivery after verifier acceptance. Do not model outputTarget delivery as pre-verifier plan.sideEffects or capability steps.",
    "Do not require github.branch.commit, github.pull-request.create, wzrrd.site.publish, or linear issue/comment receipts in the verification contract; the app records those receipts after verifier acceptance.",
    "Otherwise use artifact-only.",
    "If Run Binding notification is not null, include exactly one plan.sideEffects entry matching the notification fields and exactly one capability.discord.message step with the same payloadHash, payloadRef, resource, reviewGate, secretRef, and dryRun.",
    "If Run Binding notification is null, plan.sideEffects must be [] and no capability.discord.message step should exist.",
    "Machine stepOrder must contain every plan.steps[*].stepId exactly once. Each XState state meta.stepId must refer to one of those step ids. The xstate object must contain only id, initial, and states.",
    "For every plan.steps entry with kind workflow.node.invoke, the config object is governed by that step's nodeType. The blueprint JSON Schema leaves config open, but the per-node config contracts in Run Binding proposal.stochasticNotes (one draft-7 JSON Schema per nodeType) are authoritative: set every required field, choose enum values only from the listed options, point ref/stepId fields at the producing step, and emit no fields the node's schema rejects.",
    "Generated harness source must be TypeScript text that explains the generated execution shape, imports no secrets, and performs no side effects.",
    "",
    "## XState Executor Protocol",
    "",
    "The supervisor starts the generated actor, sends NEXT once, executes the state identified by meta.stepId, then sends STEP_DONE or STEP_BLOCKED.",
    "Therefore xstate.initial must be a non-executable ready state with no meta.stepId.",
    "The initial ready state must have on.NEXT.target pointing to the first step state.",
    "Every executable step state must have meta.stepId, meta.stepKind, and meta.summary.",
    "Every executable step state must have on.STEP_DONE.target pointing to the next step state, or done for the final step.",
    "Every executable step state must have on.STEP_BLOCKED.target pointing to blocked.",
    "The machine must include done and blocked final states.",
    "Do not use NEXT to move between executable step states.",
    "",
    "## Allowed Step Shapes",
    "",
    JSON.stringify(
      {
        capabilityDiscordMessage: {
          dependsOn: ["research-review"],
          dryRun: true,
          kind: "capability.discord.message",
          payloadHash: "<notification.payloadHash>",
          payloadRef: "<notification.payloadRef>",
          resource: "<notification.resource>",
          reviewGate: "<notification.reviewGate>",
          secretRef: "<notification.secretRef>",
          stepId: "notify-review-channel",
          summary:
            "Notify the review channel through a leased Discord capability.",
        },
        researchReview: {
          dependsOn: [],
          kind: "research.review",
          outputPath: "outputs/research-review.json",
          packageRefs: ["<each pinnedPackages artifactRef>"],
          stepId: "research-review",
          summary:
            "Run source-grounded research/review using the pinned packages.",
        },
        reviewSummary: {
          dependsOn: ["research-review", "notify-review-channel"],
          kind: "review.summary",
          outputPath: "review/summary.json",
          stepId: "review-summary",
          summary:
            "Reserve post-verifier review summary capture; no pre-verifier artifact is produced by this step.",
        },
      },
      null,
      2
    ),
    "",
    "## PlannerLaneBlueprintDocument JSON Schema",
    "",
    plannerBlueprintJsonSchema,
    "",
    "## Run Binding",
    "",
    JSON.stringify(
      {
        actor: input.actor,
        notification: input.notification ?? null,
        proposal: input.proposal,
        runId: input.runId,
        workItemId: input.workItemId,
      },
      null,
      2
    ),
    "",
    "## Available Package Metadata",
    "",
    JSON.stringify(input.availablePackages, null, 2),
    "",
    ...kernelSkillsSection,
    ...(kernelSkillsSection.length > 0 ? [""] : []),
    "## Pinned Packages",
    "",
    JSON.stringify(input.pinnedPackages, null, 2),
  ].join("\n");
};

const assertPlannerBlueprintBoundToRequest = (input: {
  readonly actor: Actor;
  readonly blueprint: DynamicWorkflowBlueprint;
  readonly pinnedPackages: readonly PinnedPackage[];
  readonly runId: string;
  readonly workItemId: string;
}): void => {
  if (
    input.blueprint.plan.runId !== input.runId ||
    input.blueprint.machine.runId !== input.runId ||
    input.blueprint.harness.runId !== input.runId ||
    input.blueprint.verificationContract.runId !== input.runId
  ) {
    throw new Error("Planner blueprint is not bound to the requested run.");
  }

  if (
    input.blueprint.plan.workItemId !== input.workItemId ||
    input.blueprint.machine.workItemId !== input.workItemId ||
    input.blueprint.harness.workItemId !== input.workItemId ||
    input.blueprint.verificationContract.workItemId !== input.workItemId
  ) {
    throw new Error(
      "Planner blueprint is not bound to the requested work item."
    );
  }

  const expectedPackageRefs = new Set(
    input.pinnedPackages.map((pinnedPackage) => pinnedPackage.artifactRef)
  );
  const plannedPackageRefs = new Set(
    input.blueprint.plan.pinnedPackages.map(
      (pinnedPackage) => pinnedPackage.artifactRef
    )
  );
  if (
    expectedPackageRefs.size !== plannedPackageRefs.size ||
    [...expectedPackageRefs].some(
      (artifactRef) => !plannedPackageRefs.has(artifactRef)
    )
  ) {
    throw new Error(
      "Planner blueprint did not preserve the supervisor-pinned packages."
    );
  }

  if (hashJson(input.blueprint.plan.actor) !== hashJson(input.actor)) {
    throw new Error(
      "Planner blueprint actor does not match the request actor."
    );
  }
};

const requireLaneCommitSha = (
  receipt: { readonly artifactCommitSha?: string | undefined },
  laneKind: string
): string => {
  if (receipt.artifactCommitSha === undefined) {
    throw new Error(`${laneKind} lane did not return an Artifacts commit SHA.`);
  }

  return receipt.artifactCommitSha;
};

export const createCloudflarePiPlannerLaneAdapter = (
  config: CloudflarePiLaneAdapterConfig
): AgentPlannerLanePort => ({
  laneKind: "planner",
  proposePlan: async (input) => {
    const prompt = plannerPromptFor(input);
    const outputPath = "run/planner-blueprint.json";
    const laneId = `lane:planner:${input.runId}`;
    const receipt = AgentLaneReceiptSchema.parse(
      await config.runtime.runLane({
        artifactRef: (artifactInput) =>
          config.artifactStore.artifactRef(artifactInput),
        artifactRemote: config.artifactRemote,
        artifactTokenSecret: config.artifactTokenSecret,
        authLease: config.authLease,
        branchName: "planner",
        kind: "planner",
        laneId,
        leasedPiAuthJsonBase64: config.leasedPiAuthJsonBase64,
        model: config.model,
        outputMediaType: "application/json",
        outputPath,
        packageMounts: input.pinnedPackages,
        prompt,
        promptPath: "lanes/planner/prompt.md",
        provider: config.provider,
        receiptPath: "receipts/planner-lane.json",
        runId: input.runId,
        timeoutMs: config.timeoutMs,
        traceContext: workflowTraceContextForLane({
          laneId,
          runId: input.runId,
        }),
        transcriptPath: "lanes/planner/transcript.md",
        workItemId: input.workItemId,
      })
    );
    if (
      receipt.kind !== "planner" ||
      receipt.status !== "completed" ||
      !receipt.realAgent ||
      receipt.runtime === "integration-test"
    ) {
      // Mirror the verifier adapter: a planner lane that committed a receipt but
      // could not normalize its blueprint is "pi produced no parseable plan", a
      // real planner failure — NOT the blind generic throw that upstream forged
      // into `adapter_unavailable` (transport down) and re-drove for 40 minutes
      // (wound #25). Surface the real reason so the blocker is honest.
      const normalization = receipt.outputNormalization;
      let cause: string;
      if (normalization?.normalized === false) {
        const stopReasonSuffix =
          normalization.agentStopReason !== null &&
          normalization.agentStopReason !== ""
            ? `, stopReason: ${normalization.agentStopReason}`
            : "";
        cause = `planner produced no parseable blueprint (reason: ${
          normalization.reason ?? "unknown"
        }${stopReasonSuffix})`;
      } else if (receipt.status === "completed") {
        cause = `receipt completed but was kind:"${receipt.kind}", realAgent:${receipt.realAgent}, runtime:"${receipt.runtime}"`;
      } else {
        cause = `receipt status was "${receipt.status}"`;
      }
      throw new Error(
        `Planner lane did not return a completed real-agent receipt: ${cause}.`
      );
    }
    const artifactCommitSha = requireLaneCommitSha(receipt, "Planner");

    const outputPin = receipt.outputPins.at(0);
    if (outputPin === undefined) {
      throw new Error("Planner lane did not return a pinned blueprint output.");
    }

    // The lane RAN and pinned an output; whether that output IS a blueprint is a
    // deterministic content question. A raw `.parse` throw here was flattened
    // upstream into transient `adapter_unavailable` and blind-re-driven for ~40
    // minutes (wound #27). `safeParse` + a typed contract error names what pi
    // actually emitted so the next read is a diagnosis, not a guess.
    const plannerOutputRaw = await config.artifactStore.readJson({
      artifactCommitSha,
      artifactRef: outputPin.artifactRef,
    });
    const plannerOutputResult =
      PlannerLaneBlueprintDocumentSchema.safeParse(plannerOutputRaw);
    if (!plannerOutputResult.success) {
      throw plannerBlueprintContractError({
        raw: plannerOutputRaw,
        requiredKeys: PLANNER_OUTPUT_REQUIRED_KEYS,
        runId: input.runId,
        stage: "planner-output",
        workItemId: input.workItemId,
        zodError: plannerOutputResult.error,
      });
    }
    const plannerOutput = plannerOutputResult.data;
    const transcript = await config.artifactStore.readText({
      artifactCommitSha,
      artifactRef: receipt.transcript.artifactRef,
    });
    const assembledBlueprint = {
      ...plannerOutput,
      plannerLane: {
        ...(receipt.completedAt === undefined
          ? {}
          : { completedAt: receipt.completedAt }),
        artifactCommitSha,
        ...(receipt.authLease === undefined
          ? {}
          : { authLease: receipt.authLease }),
        kind: receipt.kind,
        laneId: receipt.laneId,
        outputPins: receipt.outputPins,
        outputRefs: receipt.outputRefs,
        ...(receipt.packageMounts === undefined
          ? {}
          : { packageMounts: receipt.packageMounts }),
        prompt: {
          mediaType: receipt.prompt.mediaType,
          path: "lanes/planner/prompt.md",
          redacted: true,
          value: prompt,
        },
        realAgent: receipt.realAgent,
        redacted: true,
        runtime: receipt.runtime,
        ...(receipt.sandboxAccounting === undefined
          ? {}
          : { sandboxAccounting: receipt.sandboxAccounting }),
        ...(receipt.sandboxRef === undefined
          ? {}
          : { sandboxRef: receipt.sandboxRef }),
        startedAt: receipt.startedAt,
        status: receipt.status,
        ...(receipt.traceContext === undefined
          ? {}
          : { traceContext: receipt.traceContext }),
        transcript: {
          mediaType: receipt.transcript.mediaType,
          path: "lanes/planner/transcript.md",
          redacted: true,
          value: transcript,
        },
      },
    };
    // Second deterministic contract gate: the planner output parsed, but the
    // assembled blueprint (output + supervisor-attached plannerLane) must also
    // satisfy the full schema. Same honest-vs-flattened distinction as above.
    const blueprintResult =
      DynamicWorkflowBlueprintSchema.safeParse(assembledBlueprint);
    if (!blueprintResult.success) {
      throw plannerBlueprintContractError({
        raw: assembledBlueprint,
        requiredKeys: BLUEPRINT_REQUIRED_KEYS,
        runId: input.runId,
        stage: "blueprint-assembly",
        workItemId: input.workItemId,
        zodError: blueprintResult.error,
      });
    }
    const blueprint = blueprintResult.data;
    assertPlannerBlueprintBoundToRequest({
      actor: input.actor,
      blueprint,
      pinnedPackages: input.pinnedPackages,
      runId: input.runId,
      workItemId: input.workItemId,
    });

    return blueprint;
  },
  runtime: config.runtime.runtime,
});

const workerOutputPathFor = (step: DynamicWorkflowStep): string => {
  if (step.kind === "research.review" || step.kind === "review.summary") {
    return step.outputPath;
  }

  return `outputs/${safePathSegment(step.stepId)}.md`;
};

const workerPromptFor = (input: {
  readonly plan: DynamicWorkflowPlanDocument;
  readonly step: DynamicWorkflowStep;
}): string =>
  [
    "# Pi Worker Lane",
    "",
    "Execute exactly the pinned dynamic workflow step. Do not perform side effects directly. If a side effect is needed, return the requested payload and let the supervisor lease the capability.",
    "",
    `Run: ${input.plan.runId}`,
    `Work item: ${input.plan.workItemId}`,
    `Plan: ${input.plan.planId}`,
    `Step: ${input.step.stepId}`,
    `Step kind: ${input.step.kind}`,
    "",
    "## Pinned Packages",
    "",
    ...input.plan.pinnedPackages.map(
      (pinnedPackage) =>
        `- ${pinnedPackage.metadata.packageId}@${pinnedPackage.version}: ${pinnedPackage.artifactRef}`
    ),
    "",
    "## Step JSON",
    "",
    JSON.stringify(input.step, null, 2),
    ...(input.step.kind === "research.review"
      ? [
          "",
          "## Strict Structured Output Contract",
          "",
          "Emit only JSON. Do not wrap the JSON in Markdown. Do not include prose before or after the JSON.",
          "Return a JSON object matching ResearchReviewOutputDocumentSchema, the production Zod schema for workflow.research-review-output.v1.",
          "No additional properties are allowed. Schema violations block the run before verification.",
          `Use schemaVersion exactly ${JSON.stringify("workflow.research-review-output.v1")}.`,
          `Use runId exactly ${JSON.stringify(input.plan.runId)}.`,
          `Use workItemId exactly ${JSON.stringify(input.plan.workItemId)}.`,
          `Use stepId exactly ${JSON.stringify(input.step.stepId)}.`,
          "Use generatedAt as an ISO UTC datetime ending in Z.",
          "Use summary for the concise source-grounded review.",
          "Use findings for specific claims, evidence, and sourceRefs. sourceRefs may be artifact refs, package refs, URLs, file paths, or other cited receipt refs.",
          "Use risks for unresolved concerns or missing evidence.",
          "Use nextActions for concrete follow-up work.",
          "",
          "## ResearchReviewOutputDocument JSON Schema",
          "",
          researchReviewOutputJsonSchema,
        ]
      : []),
  ].join("\n");

const workerLaneRequestFor = (
  config: CloudflarePiLaneAdapterConfig,
  input: {
    readonly plan: DynamicWorkflowPlanDocument;
    readonly step: DynamicWorkflowStep;
  }
): AgentLaneRuntimeRequest => {
  const stepPath = safePathSegment(input.step.stepId);
  const laneId = `lane:worker:${input.plan.runId}:${input.step.stepId}`;

  return {
    artifactRef: (artifactInput) =>
      config.artifactStore.artifactRef(artifactInput),
    artifactRemote: config.artifactRemote,
    artifactTokenSecret: config.artifactTokenSecret,
    authLease: config.authLease,
    branchName: `worker-${safePathSegment(input.step.stepId)}`,
    kind: "worker",
    laneId,
    leasedPiAuthJsonBase64: config.leasedPiAuthJsonBase64,
    model: config.model,
    outputMediaType:
      input.step.kind === "research.review"
        ? "application/json"
        : "text/markdown",
    outputPath: workerOutputPathFor(input.step),
    packageMounts: input.plan.pinnedPackages,
    prompt: workerPromptFor(input),
    promptPath: `lanes/${stepPath}/prompt.md`,
    provider: config.provider,
    receiptPath: `receipts/worker-${stepPath}-lane.json`,
    runId: input.plan.runId,
    timeoutMs: config.timeoutMs,
    traceContext: workflowTraceContextForLane({
      laneId,
      runId: input.plan.runId,
    }),
    transcriptPath: `lanes/${stepPath}/transcript.md`,
    workItemId: input.plan.workItemId,
  };
};

const agentLaneDispatchReceiptFor = (
  dispatch: ReturnType<typeof WorkflowDriveLaneDispatchSchema.parse>
) =>
  AgentLaneDispatchReceiptSchema.parse({
    ...dispatch,
    schemaVersion: "agent-lane.dispatch-receipt.v1",
  });

export const createCloudflarePiWorkerLaneAdapter = (
  config: CloudflarePiLaneAdapterConfig
): AgentWorkerLanePort => {
  const adapter: AgentWorkerLanePort = {
    async cleanupStep(input) {
      await config.runtime.cleanupLane?.({
        dispatch: agentLaneDispatchReceiptFor(input.dispatch),
        reason: input.reason,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
      });
    },
    laneKind: "worker",
    async runStep(input) {
      const receipt = AgentLaneReceiptSchema.parse(
        await config.runtime.runLane(workerLaneRequestFor(config, input))
      );

      return {
        outputRefs: receipt.outputRefs,
        receipt,
      };
    },
    runtime: config.runtime.runtime,
  };

  if (
    config.runtime.dispatchLane !== undefined &&
    config.runtime.pollLane !== undefined &&
    config.runtime.readLaneReceipt !== undefined
  ) {
    adapter.dispatchStep = async (input) => {
      const dispatch = await config.runtime.dispatchLane?.(
        workerLaneRequestFor(config, input)
      );
      if (dispatch === undefined) {
        throw new Error("Agent lane runtime does not support async dispatch.");
      }

      return WorkflowDriveLaneDispatchSchema.parse({
        ...dispatch,
        dispatchKey: `${input.nodeIndex}:${input.step.stepId}`,
        nodeIndex: input.nodeIndex,
        schemaVersion: "workflow.drive-lane-dispatch.v1",
        status: "lane-dispatched",
        stepId: input.step.stepId,
      });
    };

    adapter.pollStep = async (input) => {
      const statusReceipt = await config.runtime.pollLane?.({
        dispatch: agentLaneDispatchReceiptFor(input.dispatch),
      });
      if (statusReceipt === undefined) {
        throw new Error("Agent lane runtime does not support async polling.");
      }

      return WorkflowDriveLaneStatusReceiptSchema.parse({
        ...statusReceipt,
        dispatchKey: input.dispatch.dispatchKey,
        nodeIndex: input.dispatch.nodeIndex,
        ...(input.dispatch.nodeType === undefined
          ? {}
          : { nodeType: input.dispatch.nodeType }),
        schemaVersion: "workflow.drive-lane-status.v1",
        stepId: input.dispatch.stepId,
      });
    };

    adapter.readStepReceipt = async (input) => {
      const receipt = await config.runtime.readLaneReceipt?.({
        artifacts: config.artifactStore,
        dispatch: agentLaneDispatchReceiptFor(input.dispatch),
      });
      if (receipt === undefined) {
        throw new Error(
          "Agent lane runtime does not support receipt recovery."
        );
      }
      if (receipt === null) {
        return null;
      }

      return {
        outputRefs: receipt.outputRefs,
        receipt,
      };
    };
  }

  return adapter;
};

/**
 * Production analysis reasoning lane: the "dream thinks" seam wired to the same
 * {@link AgentLaneRuntimePort} the planner and worker lanes use. The calling
 * analytical node assembles the prompt (redacted evidence + analysis-method
 * kernel skill + run goal) and the output schema; this adapter runs a REAL
 * agent over that prompt, reads the pinned JSON output at the lane's commit,
 * validates it against the node's schema, and returns the parsed reasoning with
 * the lane receipt. It invents no new runtime — it reuses `runLane`, the
 * admitted-runtime lease gate, and the artifact store exactly like the other
 * lanes — so the deterministic envelope (hash-pin, capability/lease gate,
 * redaction) wraps the reasoning unchanged. The lane runs as a `worker`-kind
 * AgentLaneKind because it is a per-step reasoning lane, not the run planner.
 */
export const createCloudflarePiAnalysisReasoningLaneAdapter = (
  config: CloudflarePiLaneAdapterConfig
): AgentAnalysisReasoningLanePort => ({
  laneKind: "analysis",
  async reason(input) {
    const receipt = AgentLaneReceiptSchema.parse(
      await config.runtime.runLane({
        artifactRef: (artifactInput) =>
          config.artifactStore.artifactRef(artifactInput),
        artifactRemote: config.artifactRemote,
        artifactTokenSecret: config.artifactTokenSecret,
        authLease: config.authLease,
        branchName: `analysis-${safePathSegment(input.laneId)}`,
        kind: "worker",
        laneId: input.laneId,
        leasedPiAuthJsonBase64: config.leasedPiAuthJsonBase64,
        model: config.model,
        outputMediaType: "application/json",
        outputPath: input.outputPath,
        packageMounts: input.packageMounts,
        prompt: input.prompt,
        promptPath: input.promptPath,
        provider: config.provider,
        receiptPath: input.receiptPath,
        runId: input.runId,
        timeoutMs: config.timeoutMs,
        traceContext: workflowTraceContextForLane({
          laneId: input.laneId,
          runId: input.runId,
        }),
        transcriptPath: input.transcriptPath,
        workItemId: input.workItemId,
      })
    );
    if (
      receipt.status !== "completed" ||
      !receipt.realAgent ||
      receipt.runtime === "integration-test"
    ) {
      throw new Error(
        "Analysis reasoning lane did not return a completed real-agent receipt."
      );
    }
    const artifactCommitSha = requireLaneCommitSha(receipt, "Analysis");

    const outputPin = receipt.outputPins.at(0);
    if (outputPin === undefined) {
      throw new Error(
        "Analysis reasoning lane did not return a pinned reasoning output."
      );
    }

    const parsed = input.outputSchema.parse(
      await config.artifactStore.readJson({
        artifactCommitSha,
        artifactRef: outputPin.artifactRef,
      })
    );

    return {
      outputRefs: receipt.outputRefs,
      parsed,
      receipt,
    };
  },
  runtime: config.runtime.runtime,
});

const extractObservabilityEvidence = (
  text: string
): null | {
  readonly laneReceipts: unknown;
  readonly metrics: unknown;
  readonly requiredSignals: unknown;
  readonly schemaVersion: string;
  readonly statusProjection: unknown;
  readonly summary: string;
  readonly telemetrySinks: unknown;
} => {
  try {
    const parsed = WorkflowObservabilityPackSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return null;
    }

    return {
      laneReceipts: parsed.data.laneReceipts,
      metrics: parsed.data.metrics,
      requiredSignals: parsed.data.requiredSignals,
      schemaVersion: parsed.data.schemaVersion,
      statusProjection: parsed.data.statusProjection,
      summary: parsed.data.summary,
      telemetrySinks: parsed.data.telemetrySinks,
    };
  } catch {
    return null;
  }
};

const verifierPromptFor = (input: {
  readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
  readonly contract: VerificationContractDocument;
  readonly outputEvidence: readonly AgentVerifierOutputEvidence[];
  readonly outputRefs: readonly ArtifactRef[];
  readonly plan: DynamicWorkflowPlanDocument;
}): string => {
  const evidenceTextLimit = 2500;
  // The hitl-report MDSvX is the safety-critical redaction target: the verifier
  // must confirm NOTHING un-redacted lives anywhere in it, that noindex is set
  // via the declared template, and that proof sits below dreams. None of that is
  // confirmable from a head-truncated view — raw content could hide in the tail
  // and be falsely blessed, then published. So the report is presented in FULL up
  // to a runaway-backstop ceiling.
  //
  // The bound is DERIVED, not guessed. The report's variable bulk is the findings
  // section, emitted by a SINGLE analysis-lane agent response, so it is bounded by
  // that lane's output-token budget plus a fixed template and a bounded D2 figure.
  // A verbose lane response renders the report in the ~60–90k char range — the
  // original 60_000 ceiling was a vibes-estimate of "bounded by construction" and
  // live run run-live-20260615T003009433Z-0ba8dd24 overflowed it and blocked, so
  // the GUESS was the bug, falsified in production. The verifier is a pi/Claude
  // agent with a 200k+ token context and the prompt is delivered via @file (no
  // argv/E2BIG limit, wound #35), so a full report even at this ceiling is a small
  // fraction of context. The ceiling therefore sits far above any legitimate
  // report; only a pathological generator runaway can trip it, and on overflow we
  // emit a LEGIBLE block-marker (not a silent "[truncated]") so the verifier
  // blocks rather than accepting an unseen, possibly-unredacted tail.
  const reportEvidenceTextLimit = 262_144;
  const truncateEvidenceText = (text: string, mediaType: string): string => {
    if (mediaType === "text/mdsvx") {
      return text.length > reportEvidenceTextLimit
        ? `${text.slice(0, reportEvidenceTextLimit)}\n[REPORT TRUNCATED — exceeds verifier inline budget; redaction and noindex completeness cannot be confirmed for the omitted tail, so this report must block rather than be accepted]`
        : text;
    }
    return text.length > evidenceTextLimit
      ? `${text.slice(0, evidenceTextLimit)}\n[truncated]`
      : text;
  };
  const outputEvidence = input.outputEvidence.map((evidence) => ({
    artifactCommitSha: evidence.artifactCommitSha,
    artifactRef: evidence.artifactRef,
    extractedObservabilityPack: extractObservabilityEvidence(evidence.text),
    hash: evidence.hash,
    mediaType: evidence.mediaType,
    text: truncateEvidenceText(evidence.text, evidence.mediaType),
  }));

  return [
    "# Pi Verifier Lane",
    "",
    "Verify the pinned outputs against the verification contract. Emit only JSON. Do not wrap the JSON in Markdown.",
    "",
    "## Strict Structured Output Contract",
    "",
    "Return a JSON object matching VerificationResultDocumentSchema, the production Zod schema for workflow.verification-result.v1.",
    "No additional properties are allowed. Any schema violation blocks the run after worker lanes execute.",
    `Use runId exactly ${JSON.stringify(input.plan.runId)}.`,
    `Use contractId exactly ${JSON.stringify(input.contract.contractId)}.`,
    `Use resultId exactly ${JSON.stringify(`verification-result:${input.plan.runId}`)}.`,
    "Use schemaVersion exactly workflow.verification-result.v1.",
    "Use checkedAt as an ISO UTC datetime ending in Z.",
    "Use status accepted when all blocking checks pass, accepted_with_warnings when only warning checks fail, and blocked when any blocking check fails.",
    "Use failures as an array. If no checks fail, failures must be []. Each failure must include checkId, message, and severity.",
    `Use verifierLaneId exactly ${JSON.stringify(`lane:verifier:${input.plan.runId}`)}.`,
    "Use the Output Evidence Snapshots section as the source of artifact content. Do not block only because artifact refs are not present as local files in the verifier sandbox.",
    "Do not require final review surface evidence, review-surface delivery evidence, or this verifier lane's own receipt before acceptance; those are post-verifier capture artifacts.",
    "When plan.steps includes kind review.summary, treat that step as a post-verifier review-gate reservation. Do not require its outputPath, outputTarget.path, or outputTarget.reviewPath in Output Evidence Snapshots before acceptance.",
    "Ignore review.summary steps when deciding whether worker-lane output evidence is present; validate worker-produced output refs and pre-verifier capability receipts instead.",
    "For outputTarget delivery, including github.branch.commit, github.pull-request.create, wzrrd.site.publish, and linear.comment.create, accept that receipts are unavailable in verifier evidence because the app executes those leases only after verifier acceptance.",
    "If Capability Receipt Evidence is empty, treat it as no pre-verifier side effects executed; do not convert an empty array into a missing output-target delivery failure.",
    "For workflow.observability-pack.v1 evidence, inspect extractedObservabilityPack before the truncated text snapshot; telemetrySinks is the structured log sink evidence, and laneReceipts[*].packageMounts is the pinned package mount evidence for planner and worker lanes.",
    "For workflow.generated-machine-execution-receipt.v1 evidence, treat cloudflare-workers-generated-machine-supervisor as the pre-verifier receipt that the pinned workflow.xstate-machine.v1 was loaded, started at ready, advanced with NEXT, executed planned meta.stepId states with STEP_DONE/STEP_BLOCKED semantics, and reached done; do not require the post-verifier run/execution-proof.json before acceptance.",
    "Use the Capability Receipt Evidence section as the source of leased side-effect evidence.",
    `The verification output path is ${JSON.stringify(input.contract.outputPath)}; do not require that file to exist before this verifier lane writes it.`,
    "",
    `Run: ${input.plan.runId}`,
    `Plan: ${input.plan.planId}`,
    "",
    "## VerificationResultDocument JSON Schema",
    "",
    verificationResultJsonSchema,
    "",
    "## Verification Contract",
    "",
    JSON.stringify(input.contract, null, 2),
    "",
    "## Dynamic Plan Snapshot",
    "",
    JSON.stringify(input.plan, null, 2),
    "",
    "## Output Refs To Inspect",
    "",
    ...input.outputRefs.map((outputRef) => `- ${outputRef}`),
    "",
    "## Output Evidence Snapshots",
    "",
    JSON.stringify(outputEvidence, null, 2),
    "",
    "## Capability Receipt Evidence",
    "",
    JSON.stringify(input.capabilityReceipts, null, 2),
  ].join("\n");
};

// Wound #35 legibility half: a committed-failed verifier receipt
// (outputNormalization.normalized === false) means the agent process emitted
// nothing parseable. Name WHY in the blocker — pi's nonzero exit, its stop
// reason, the raw-output sample, and the stderr tail — so a non-arrival (E2BIG
// before pi ran) reads differently than unparseable prose. Extracted to module
// scope so verify() stays under the complexity ceiling.
const describeNoParseableVerdict = (
  normalization: NonNullable<
    ReturnType<typeof AgentLaneReceiptSchema.parse>["outputNormalization"]
  >
): string => {
  const exitSuffix =
    normalization.piExitStatus !== null && normalization.piExitStatus !== 0
      ? `, pi exit: ${normalization.piExitStatus}`
      : "";
  const stopReasonSuffix =
    normalization.agentStopReason !== null &&
    normalization.agentStopReason !== ""
      ? `, stopReason: ${normalization.agentStopReason}`
      : "";
  const sampleSuffix =
    normalization.rawOutputSample !== null &&
    normalization.rawOutputSample !== ""
      ? `, raw output sample: ${normalization.rawOutputSample}`
      : "";
  const stderrSuffix =
    normalization.stderrSample !== null && normalization.stderrSample !== ""
      ? `, stderr: ${normalization.stderrSample}`
      : "";
  return `agent produced no parseable verdict (reason: ${
    normalization.reason ?? "unknown"
  }${exitSuffix}${stopReasonSuffix}${sampleSuffix}${stderrSuffix})`;
};

export const createCloudflarePiVerifierLaneAdapter = (
  config: CloudflarePiLaneAdapterConfig
): AgentVerifierLanePort => ({
  laneKind: "verifier",
  runtime: config.runtime.runtime,
  async verify(input) {
    const laneId = `lane:verifier:${input.plan.runId}`;
    const receiptPath = "receipts/verifier-lane.json";
    const receiptRef = config.artifactStore.artifactRef({
      path: receiptPath,
      runId: input.plan.runId,
    });
    const loadCompletedReceipt = async (
      artifactCommitSha: string
    ): Promise<ReturnType<typeof AgentLaneReceiptSchema.parse>> => {
      const receiptDocument = await config.artifactStore.readJson({
        artifactCommitSha,
        artifactRef: receiptRef,
      });
      if (typeof receiptDocument !== "object" || receiptDocument === null) {
        throw new TypeError(
          "Completed verifier lane receipt artifact was not a JSON object."
        );
      }

      return AgentLaneReceiptSchema.parse({
        ...receiptDocument,
        artifactCommitSha,
      });
    };
    const laneRequest: AgentLaneRuntimeRequest = {
      artifactRef: (artifactInput) =>
        config.artifactStore.artifactRef(artifactInput),
      artifactRemote: config.artifactRemote,
      artifactTokenSecret: config.artifactTokenSecret,
      authLease: config.authLease,
      branchName: "verifier",
      kind: "verifier" as const,
      laneId,
      leasedPiAuthJsonBase64: config.leasedPiAuthJsonBase64,
      model: config.model,
      outputMediaType: "application/json",
      outputPath: input.contract.outputPath,
      packageMounts: input.plan.pinnedPackages,
      prompt: verifierPromptFor(input),
      promptPath: "lanes/verifier/prompt.md",
      provider: config.provider,
      receiptPath,
      runId: input.plan.runId,
      timeoutMs: config.timeoutMs,
      traceContext: workflowTraceContextForLane({
        laneId,
        runId: input.plan.runId,
      }),
      transcriptPath: "lanes/verifier/transcript.md",
      workItemId: input.plan.workItemId,
    };
    let receipt: ReturnType<typeof AgentLaneReceiptSchema.parse>;
    try {
      receipt = AgentLaneReceiptSchema.parse(
        await config.runtime.runLane(laneRequest)
      );
    } catch (error) {
      if (
        error instanceof AgentLaneAlreadyCompletedError &&
        error.laneId === laneId &&
        error.artifactCommitSha !== undefined
      ) {
        receipt = await loadCompletedReceipt(error.artifactCommitSha);
      } else {
        throw error;
      }
    }
    if (
      receipt.kind !== "verifier" ||
      receipt.laneId !== laneId ||
      receipt.status !== "completed"
    ) {
      const normalization = receipt.outputNormalization;
      let cause: string;
      if (normalization?.normalized === false) {
        cause = describeNoParseableVerdict(normalization);
      } else if (receipt.status === "completed") {
        cause = `receipt kind/lane mismatch (kind: ${receipt.kind}, laneId: ${receipt.laneId})`;
      } else {
        cause = `receipt status was "${receipt.status}"`;
      }
      throw new Error(
        `Verifier lane did not return a completed receipt for the requested lane: ${cause}.`
      );
    }
    const resultPin = receipt.outputPins.at(0);
    if (resultPin === undefined) {
      throw new Error(
        "Verifier lane did not return a pinned verification result."
      );
    }
    const resultDocument = VerificationResultDocumentSchema.parse(
      await config.artifactStore.readJson({
        artifactCommitSha: requireLaneCommitSha(receipt, "Verifier"),
        artifactRef: resultPin.artifactRef,
      })
    );

    return {
      result: VerificationResultArtifactSchema.parse({
        artifactCommitSha: requireLaneCommitSha(receipt, "Verifier"),
        artifactRef: resultPin.artifactRef,
        hash: resultPin.hash,
        mediaType: "application/json",
        resultId: `verification-result:${input.plan.runId}`,
      }),
      resultDocument,
      verifierLaneReceipt: receipt,
    };
  },
});
