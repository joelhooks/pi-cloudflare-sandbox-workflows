import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import { sha256Hex } from "../../src/app/domain/hash.ts";
import {
  renderKernelSkillsPromptSection,
  resolveKernelSkills,
} from "../../src/app/domain/kernel-skills.ts";
import type { ResolvedKernelSkill } from "../../src/app/domain/kernel-skills.ts";
import type {
  Actor,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  PinnedPackage,
} from "../../src/app/domain/schemas.ts";
import {
  DynamicWorkflowMachineDocumentSchema,
  DynamicWorkflowPlanDocumentSchema,
  DynamicWorkflowStepSchema,
  KERNEL_SKILL_BODY_MAX_CHARS,
  PackageExportSchema,
  PinnedPackageSchema,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForLane } from "../../src/app/domain/trace-context.ts";
import { plannerPromptFor } from "../../src/app/infrastructure/cloudflare-agent-lane-adapters.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const KERNEL_SKILL_BODY = [
  "# Dream Workflow Shape",
  "",
  "Shape a transcript-review dream as a deterministic envelope around stochastic",
  "reasoning: search -> hydrate -> correlate -> propose -> hitl-report -> STOP.",
].join("\n");

const SKILL_BODY_MARKER = "deterministic envelope around stochastic";

const pinnedKernelWithSkill = (): PinnedPackage =>
  PinnedPackageSchema.parse({
    artifactRef:
      "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
    fileHashes: { "package.json": sha256Hex("claw-kernel@1.0.0") },
    manifestHash: sha256Hex("claw-kernel-manifest"),
    metadata: {
      description: "Claw kernel with a workflow-shape skill.",
      exports: [
        {
          contractRef: "contract://claw-kernel/operator-law.v1",
          exportId: "operator-law",
          kind: "prompt",
        },
        {
          contractRef: "contract://claw-kernel/workflow-shape-skill.v1",
          exportId: "workflow-shape-skill",
          kind: "skill",
          skill: {
            body: KERNEL_SKILL_BODY,
            skillId: "dream.workflow-shape",
            title: "Dream Workflow Shape",
          },
        },
      ],
      kind: "kernel",
      latestArtifactRef:
        "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
      latestVersion: "1.0.0",
      manifestPath: "package.json",
      ownerRef: "org:badass-courses",
      packageId: "badass-courses/claw-kernel",
      title: "Claw Kernel",
      trustTier: "reviewed",
    },
    pinnedAt: "2026-06-11T00:00:00.000Z",
    version: "1.0.0",
  });

const pinnedKernelWithoutSkill = (): PinnedPackage =>
  PinnedPackageSchema.parse({
    artifactRef:
      "artifact://cloudflare-artifacts/pkg-joelhooks-configured-familiar-kernel/package.json",
    fileHashes: { "package.json": sha256Hex("familiar-kernel@1.0.0") },
    manifestHash: sha256Hex("familiar-kernel-manifest"),
    metadata: {
      description: "Configured familiar kernel, no skill exports.",
      exports: [
        {
          contractRef: "contract://joelhooks/kernel-overlay.v1",
          exportId: "kernel-overlay",
          kind: "prompt",
        },
      ],
      kind: "kernel",
      latestArtifactRef:
        "artifact://cloudflare-artifacts/pkg-joelhooks-configured-familiar-kernel/package.json",
      latestVersion: "1.0.0",
      manifestPath: "package.json",
      ownerRef: "user:joel",
      packageId: "joelhooks/configured-familiar-kernel",
      title: "Configured Familiar Kernel",
      trustTier: "reviewed",
    },
    pinnedAt: "2026-06-11T00:00:00.000Z",
    version: "1.0.0",
  });

const RUN_ID = "run:kernel-skill-consumption";
const WORK_ITEM_ID = "work:kernel-skill-consumption";
const ZERO_HASH = "0".repeat(64);

const minimalMachineDocument = (): DynamicWorkflowMachineDocument =>
  DynamicWorkflowMachineDocumentSchema.parse({
    createdAt: "2026-06-11T00:00:00.000Z",
    machineId: "machine:kernel-skill-consumption",
    planner: { kind: "stochastic", nonce: "nonce", source: "test" },
    runId: RUN_ID,
    schemaVersion: "workflow.xstate-machine.v1",
    stepOrder: ["correlate"],
    workItemId: WORK_ITEM_ID,
    xstate: {
      id: "machine:kernel-skill-consumption",
      initial: "ready",
      states: {
        done: { meta: { summary: "done" }, on: {}, type: "final" },
        ready: { meta: { summary: "ready" }, on: { NEXT: { target: "done" } } },
      },
    },
  });

const minimalPlanDocument = (): DynamicWorkflowPlanDocument => {
  const pinned = pinnedKernelWithSkill();
  const ref = (path: string): string => `artifact://memory/${RUN_ID}/${path}`;

  return DynamicWorkflowPlanDocumentSchema.parse({
    actor: integrationTestActor,
    createdAt: "2026-06-11T00:00:00.000Z",
    harness: {
      artifactRef: ref("workflows/harness.ts"),
      entrypoint: "workflows/harness.ts",
      harnessId: "harness:kernel-skill-consumption",
      hash: ZERO_HASH,
      language: "typescript",
    },
    machine: {
      artifactRef: ref("workflows/machine.config.json"),
      hash: ZERO_HASH,
      machineId: "machine:kernel-skill-consumption",
      sourceArtifactRef: ref("workflows/machine.ts"),
      sourceHash: ZERO_HASH,
    },
    outputTarget: { kind: "artifact-only", path: "reports/report.json" },
    pinnedPackages: [pinned],
    planId: "plan:kernel-skill-consumption",
    planner: { kind: "stochastic", nonce: "nonce", source: "test" },
    plannerLane: {
      authLease: {
        expiresAt: "2026-06-11T01:00:00.000Z",
        issuedAt: "2026-06-11T00:00:00.000Z",
        leaseId: `lease:pi-agent-auth:${RUN_ID}`,
        redacted: true,
        runId: RUN_ID,
        scope: "pi-agent-auth-json",
        secretRef: "secretref:pi-agent-auth-json",
        workItemId: WORK_ITEM_ID,
      },
      kind: "planner",
      laneId: `lane:planner:${RUN_ID}`,
      prompt: {
        artifactRef: ref("lanes/planner/prompt.md"),
        hash: ZERO_HASH,
        mediaType: "text/markdown",
      },
      realAgent: true,
      receiptRef: ref("receipts/planner-lane.json"),
      redacted: true,
      runtime: "pi-agent-cli",
      startedAt: "2026-06-11T00:00:00.000Z",
      status: "completed",
      traceContext: workflowTraceContextForLane({
        laneId: `lane:planner:${RUN_ID}`,
        runId: RUN_ID,
      }),
      transcript: {
        artifactRef: ref("lanes/planner/transcript.md"),
        hash: ZERO_HASH,
        mediaType: "text/markdown",
      },
    },
    proposal: {
      intent: "Dream over agent transcripts.",
      requestedPackageIds: [pinned.metadata.packageId],
      stochasticNotes: [],
    },
    runId: RUN_ID,
    safety: {
      capabilityLeasesRequired: true,
      durableState: "artifacts-d1-do-r2-only",
      scratchOnly: true,
    },
    schemaVersion: "workflow.dynamic-plan.v1",
    sideEffects: [],
    steps: [
      {
        config: {},
        dependsOn: [],
        kind: "workflow.node.invoke",
        nodeType: "joelclaw.memory.correlate",
        outputPath: "dream/correlate.json",
        packageRefs: [pinned.artifactRef],
        stepId: "correlate",
        summary: "Correlate hydrated memories.",
      },
    ],
    verificationContract: {
      artifactRef: ref("run/verification-contract.json"),
      contractId: "contract:kernel-skill-consumption",
      hash: ZERO_HASH,
      mediaType: "application/json",
    },
    workItemId: WORK_ITEM_ID,
  });
};

const plannerInputFor = (
  pinnedPackages: readonly PinnedPackage[]
): Parameters<typeof plannerPromptFor>[0] => ({
  actor: integrationTestActor satisfies Actor,
  availablePackages: pinnedPackages.map((pinned) => pinned.metadata),
  pinnedPackages,
  proposal: {
    intent: "Dream over agent transcripts and propose refinements.",
    requestedPackageIds: pinnedPackages.map(
      (pinned) => pinned.metadata.packageId
    ),
    stochasticNotes: [],
  },
  runId: RUN_ID,
  workItemId: WORK_ITEM_ID,
});

describe("kernel-skill content contract", () => {
  it("parses a skill export with inline skillId, title, and body", () => {
    const parsed = PackageExportSchema.parse({
      contractRef: "contract://claw-kernel/workflow-shape-skill.v1",
      exportId: "workflow-shape-skill",
      kind: "skill",
      skill: {
        body: KERNEL_SKILL_BODY,
        skillId: "dream.workflow-shape",
        title: "Dream Workflow Shape",
      },
    });

    expect(parsed.kind).toBe("skill");
    expect(parsed.skill?.skillId).toBe("dream.workflow-shape");
    expect(parsed.skill?.body).toContain(SKILL_BODY_MARKER);
  });

  it("rejects a skill export with no inline skill content", () => {
    expect(
      PackageExportSchema.safeParse({
        contractRef: "contract://claw-kernel/workflow-shape-skill.v1",
        exportId: "workflow-shape-skill",
        kind: "skill",
      }).success
    ).toBeFalsy();
  });

  it("rejects a non-skill export that smuggles inline skill content", () => {
    expect(
      PackageExportSchema.safeParse({
        contractRef: "contract://claw-kernel/operator-law.v1",
        exportId: "operator-law",
        kind: "prompt",
        skill: {
          body: KERNEL_SKILL_BODY,
          skillId: "dream.workflow-shape",
          title: "Dream Workflow Shape",
        },
      }).success
    ).toBeFalsy();
  });

  it("rejects a skill body that exceeds the inline size cap", () => {
    expect(
      PackageExportSchema.safeParse({
        contractRef: "contract://claw-kernel/oversize.v1",
        exportId: "oversize",
        kind: "skill",
        skill: {
          body: "x".repeat(KERNEL_SKILL_BODY_MAX_CHARS + 1),
          skillId: "dream.oversize",
          title: "Oversize",
        },
      }).success
    ).toBeFalsy();
  });
});

describe("kernel-skill resolution", () => {
  it("resolves inline skill exports from pinned packages with provenance", () => {
    const resolved = resolveKernelSkills([
      pinnedKernelWithSkill(),
      pinnedKernelWithoutSkill(),
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      packageId: "badass-courses/claw-kernel",
      redacted: true,
      skillId: "dream.workflow-shape",
      trustTier: "reviewed",
    });
    expect(resolved[0]?.body).toContain(SKILL_BODY_MARKER);
  });

  it("resolves to [] when no pinned package exports a skill", () => {
    expect(resolveKernelSkills([pinnedKernelWithoutSkill()])).toStrictEqual([]);
  });
});

describe("planner prompt kernel-skill consumption", () => {
  it("injects the pinned kernel's skill body into the prompt", () => {
    const prompt = plannerPromptFor(plannerInputFor([pinnedKernelWithSkill()]));

    expect(prompt).toContain(
      "## Kernel Skills (use these to design the workflow)"
    );
    expect(prompt).toContain("dream.workflow-shape — Dream Workflow Shape");
    expect(prompt).toContain("Source: badass-courses/claw-kernel");
    expect(prompt).toContain(SKILL_BODY_MARKER);
  });

  it("omits the Kernel Skills section when no skill resolves", () => {
    const prompt = plannerPromptFor(
      plannerInputFor([pinnedKernelWithoutSkill()])
    );

    expect(prompt).not.toContain("## Kernel Skills");
    expect(prompt).toContain("## Pinned Packages");
  });
});

describe("node-adapter kernel-skill exposure", () => {
  it("renders a prompt section a node adapter can hand to an analysis lane", () => {
    const section = renderKernelSkillsPromptSection(
      resolveKernelSkills([pinnedKernelWithSkill()])
    );

    expect(section.join("\n")).toContain(SKILL_BODY_MARKER);
    expect(renderKernelSkillsPromptSection([])).toStrictEqual([]);
  });

  it("exposes resolvedKernelSkills on the node execution input", async () => {
    let capturedSkills: readonly ResolvedKernelSkill[] | undefined;
    const capturingAdapter: WorkflowNodeAdapterPort = {
      execute(input): Promise<WorkflowNodeExecutionResult> {
        capturedSkills = input.resolvedKernelSkills;

        return Promise.resolve({
          outputRefs: [],
          status: "executed",
        });
      },
    };

    const parsedStep = DynamicWorkflowStepSchema.parse({
      config: {},
      dependsOn: [],
      kind: "workflow.node.invoke",
      nodeType: "joelclaw.memory.correlate",
      outputPath: "dream/correlate.json",
      packageRefs: [
        "artifact://cloudflare-artifacts/pkg-badass-courses-claw-kernel/package.json",
      ],
      stepId: "correlate",
      summary: "Correlate hydrated memories.",
    });
    if (parsedStep.kind !== "workflow.node.invoke") {
      throw new Error("Expected a workflow.node.invoke step.");
    }
    const step: WorkflowNodeInvocationStep = parsedStep;

    await capturingAdapter.execute({
      actor: integrationTestActor satisfies Actor,
      dependencyArtifactRefs: {},
      machine: minimalMachineDocument(),
      plan: minimalPlanDocument(),
      resolvedKernelSkills: resolveKernelSkills([pinnedKernelWithSkill()]),
      step,
    });

    expect(capturedSkills).toHaveLength(1);
    expect(capturedSkills?.[0]?.skillId).toBe("dream.workflow-shape");
    expect(capturedSkills?.[0]?.body).toContain(SKILL_BODY_MARKER);
  });
});
