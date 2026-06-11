import { z } from "zod";

import type {
  AgentLaneRuntimePort,
  AgentPlannerLanePort,
  AgentVerifierOutputEvidence,
  AgentVerifierLanePort,
  AgentWorkerLanePort,
  ArtifactStoreContract,
  DynamicWorkflowNotificationInput,
} from "../application/ports.ts";
import { hashJson } from "../domain/hash.ts";
import {
  AgentLaneReceiptSchema,
  DynamicWorkflowBlueprintSchema,
  PlannerLaneBlueprintDocumentSchema,
  ResearchReviewOutputDocumentSchema,
  VerificationResultArtifactSchema,
  VerificationResultDocumentSchema,
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

const plannerPromptFor = (input: {
  readonly actor: Actor;
  readonly availablePackages: readonly PackageMetadata[];
  readonly notification?: DynamicWorkflowNotificationInput;
  readonly pinnedPackages: readonly PinnedPackage[];
  readonly proposal: PlanProposal;
  readonly runId: string;
  readonly workItemId: string;
}): string =>
  [
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
    "## Pinned Packages",
    "",
    JSON.stringify(input.pinnedPackages, null, 2),
  ].join("\n");

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
      throw new Error(
        "Planner lane did not return a completed real-agent receipt."
      );
    }
    const artifactCommitSha = requireLaneCommitSha(receipt, "Planner");

    const outputPin = receipt.outputPins.at(0);
    if (outputPin === undefined) {
      throw new Error("Planner lane did not return a pinned blueprint output.");
    }

    const plannerOutput = PlannerLaneBlueprintDocumentSchema.parse(
      await config.artifactStore.readJson({
        artifactCommitSha,
        artifactRef: outputPin.artifactRef,
      })
    );
    const transcript = await config.artifactStore.readText({
      artifactCommitSha,
      artifactRef: receipt.transcript.artifactRef,
    });
    const blueprint = DynamicWorkflowBlueprintSchema.parse({
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
    });
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

export const createCloudflarePiWorkerLaneAdapter = (
  config: CloudflarePiLaneAdapterConfig
): AgentWorkerLanePort => ({
  laneKind: "worker",
  async runStep(input) {
    const stepPath = safePathSegment(input.step.stepId);
    const outputPath = workerOutputPathFor(input.step);
    const laneId = `lane:worker:${input.plan.runId}:${input.step.stepId}`;
    const receipt = AgentLaneReceiptSchema.parse(
      await config.runtime.runLane({
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
        outputPath,
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
      })
    );

    return {
      outputRefs: receipt.outputRefs,
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
  const outputEvidence = input.outputEvidence.map((evidence) => ({
    artifactCommitSha: evidence.artifactCommitSha,
    artifactRef: evidence.artifactRef,
    extractedObservabilityPack: extractObservabilityEvidence(evidence.text),
    hash: evidence.hash,
    mediaType: evidence.mediaType,
    text:
      evidence.text.length > 12_000
        ? `${evidence.text.slice(0, 12_000)}\n[truncated]`
        : evidence.text,
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

export const createCloudflarePiVerifierLaneAdapter = (
  config: CloudflarePiLaneAdapterConfig
): AgentVerifierLanePort => ({
  laneKind: "verifier",
  runtime: config.runtime.runtime,
  async verify(input) {
    const laneId = `lane:verifier:${input.plan.runId}`;
    const receipt = AgentLaneReceiptSchema.parse(
      await config.runtime.runLane({
        artifactRef: (artifactInput) =>
          config.artifactStore.artifactRef(artifactInput),
        artifactRemote: config.artifactRemote,
        artifactTokenSecret: config.artifactTokenSecret,
        authLease: config.authLease,
        branchName: "verifier",
        kind: "verifier",
        laneId,
        leasedPiAuthJsonBase64: config.leasedPiAuthJsonBase64,
        model: config.model,
        outputMediaType: "application/json",
        outputPath: input.contract.outputPath,
        packageMounts: input.plan.pinnedPackages,
        prompt: verifierPromptFor(input),
        promptPath: "lanes/verifier/prompt.md",
        provider: config.provider,
        receiptPath: "receipts/verifier-lane.json",
        runId: input.plan.runId,
        timeoutMs: config.timeoutMs,
        traceContext: workflowTraceContextForLane({
          laneId,
          runId: input.plan.runId,
        }),
        transcriptPath: "lanes/verifier/transcript.md",
        workItemId: input.plan.workItemId,
      })
    );
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
