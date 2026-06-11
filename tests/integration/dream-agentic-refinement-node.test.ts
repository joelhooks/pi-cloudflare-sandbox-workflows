import { describe, expect, it } from "vitest";

import type {
  AgentAnalysisReasoningLanePort,
  AgentAnalysisReasoningResult,
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import { sha256Hex } from "../../src/app/domain/hash.ts";
import { resolveKernelSkills } from "../../src/app/domain/kernel-skills.ts";
import { WorkflowNodeTypeSchema } from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactPin,
  ArtifactRef,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  PinnedPackage,
} from "../../src/app/domain/schemas.ts";
import {
  defaultPackageSeedTemplates,
  packageMetadataForSeedTemplate,
} from "../../src/app/infrastructure/cloudflare-package-seeder.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import {
  MemoryAgenticRefinementOutputSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  MemorySearchDocumentSchema,
  MemorySignalDocumentSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import type {
  MemoryAgenticRefinementOutput,
  MemorySearchHit,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import { createMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const at = "2026-06-11T12:00:00.000Z";
const hash = "7".repeat(64);
const mediaType = "application/json";
const runId = "run-dream-agentic-refinement-test";
const workItemId = "work-item:dream-agentic-refinement-test";

const artifactPin = (path: string): ArtifactPin => ({
  artifactRef: `artifact://dream-agentic-refinement-test/${path}`,
  hash,
  mediaType,
});

const plannerLane = {
  kind: "planner",
  laneId: "lane:planner",
  outputPins: [],
  outputRefs: [],
  prompt: artifactPin("planner/prompt.txt"),
  realAgent: false,
  receiptRef: "artifact://dream-agentic-refinement-test/planner/receipt.json",
  redacted: true,
  runtime: "integration-test",
  startedAt: at,
  status: "completed",
  transcript: artifactPin("planner/transcript.jsonl"),
} satisfies AgentLaneReceipt;

// The pinned claw-kernel carrying the REAL authored analysis-method skill, so
// the agentic node resolves it via the consumption path exactly as production.
const seededClawKernel = (): PinnedPackage => {
  const template = defaultPackageSeedTemplates.find(
    (candidate) => candidate.packageId === "badass-courses/claw-kernel"
  );
  if (template === undefined) {
    throw new Error("Expected a seeded badass-courses/claw-kernel template.");
  }
  const metadata = packageMetadataForSeedTemplate(template);

  return {
    artifactRef: metadata.latestArtifactRef,
    fileHashes: { "package.json": sha256Hex("seeded-claw-kernel@1.0.0") },
    manifestHash: sha256Hex("seeded-claw-kernel-manifest"),
    metadata,
    pinnedAt: at,
    version: metadata.latestVersion,
  };
};

const refinementStep = {
  config: {},
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse(
    "joelclaw.memory.refinement-proposals"
  ),
  outputPath: "dream/refinement-proposals.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "propose-refinements",
  summary: "Propose refinements over the hydrated, correlated evidence.",
} satisfies WorkflowNodeInvocationStep;

const machine = {
  createdAt: at,
  machineId: "machine:dream-agentic-refinement-test",
  planner: {
    kind: "stochastic",
    nonce: "nonce:dream-agentic-refinement-test",
    source: "integration-test",
  },
  runId,
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: [refinementStep.stepId],
  workItemId,
  xstate: {
    id: "dream-agentic-refinement-test",
    initial: "propose",
    states: {
      done: { meta: {}, on: {}, type: "final" },
      propose: {
        meta: {
          stepId: refinementStep.stepId,
          stepKind: refinementStep.kind,
          summary: refinementStep.summary,
        },
        on: { STEP_DONE: { target: "done" } },
      },
    },
  },
} satisfies DynamicWorkflowMachineDocument;

const planWith = (
  pinnedPackages: readonly PinnedPackage[]
): DynamicWorkflowPlanDocument => ({
  actor: integrationTestActor,
  createdAt: at,
  harness: {
    artifactRef:
      "artifact://dream-agentic-refinement-test/workflows/harness.ts",
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:dream-agentic-refinement-test",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef:
      "artifact://dream-agentic-refinement-test/workflows/machine.config.json",
    hash,
    machineId: machine.machineId,
    sourceArtifactRef:
      "artifact://dream-agentic-refinement-test/workflows/machine.ts",
    sourceHash: hash,
  },
  outputTarget: { kind: "artifact-only", path: "review/summary.json" },
  pinnedPackages: [...pinnedPackages],
  planId: "plan:dream-agentic-refinement-test",
  planner: machine.planner,
  plannerLane,
  proposal: {
    intent:
      "Review agent transcripts for recurring friction and propose concrete refinements.",
    requestedPackageIds: ["workflow/memory-fabric"],
    stochasticNotes: ["Reason over hydrated evidence; do not template-fill."],
  },
  runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: [refinementStep],
  verificationContract: {
    artifactRef:
      "artifact://dream-agentic-refinement-test/run/verification-contract.json",
    contractId: "contract:dream-agentic-refinement-test",
    hash,
    mediaType,
  },
  workItemId,
});

const typesenseReceipt = {
  family: "agent-transcripts",
  hash,
  receiptId: "receipt:pi:typesense-env",
  redactedLocator: "redacted://joelclaw-session/typesense-env",
  runtime: "pi",
  sourceId: "source:joelclaw-sessions",
  timestamp: at,
} as const;

const postReviewReceipt = {
  family: "agent-transcripts",
  hash,
  receiptId: "receipt:pi:post-review-nodes",
  redactedLocator: "redacted://joelclaw-session/post-review-nodes",
  runtime: "pi",
  sourceId: "source:joelclaw-sessions",
  timestamp: at,
} as const;

const cosmeticReceipt = {
  family: "brain",
  hash,
  receiptId: "receipt:brain:label-nit",
  redactedLocator: "redacted://memory-source/brain/label-nit",
  sourceId: "source:brain",
  timestamp: at,
} as const;

const typesenseHit = {
  horizon: "all-time",
  receipts: [typesenseReceipt],
  redactedExcerpt: "Agent re-derived the typesense env every session.",
  score: 0.92,
  summary: "The agent kept re-deriving the typesense env each session.",
} satisfies MemorySearchHit;

const postReviewHit = {
  horizon: "30d",
  receipts: [postReviewReceipt],
  redactedExcerpt: "Planner kept emitting post-review nodes inline.",
  score: 0.81,
  summary: "The planner kept emitting post-review nodes in the same machine.",
} satisfies MemorySearchHit;

const cosmeticHit = {
  horizon: "7d",
  receipts: [cosmeticReceipt],
  redactedExcerpt: "A one-off label casing nit.",
  score: 0.4,
  summary: "A one-off cosmetic label casing nit.",
} satisfies MemorySearchHit;

const evidenceHits = [typesenseHit, postReviewHit, cosmeticHit];

const seedRefinementInputs = async (
  artifacts: ArtifactStoreContract
): Promise<{
  readonly correlationRef: ArtifactRef;
  readonly hydrationRef: ArtifactRef;
  readonly searchRef: ArtifactRef;
  readonly signalsRef: ArtifactRef;
}> => {
  const searchWrite = await artifacts.writeJson({
    path: "dream/search.json",
    redacted: true,
    runId,
    value: MemorySearchDocumentSchema.parse({
      generatedAt: at,
      hits: evidenceHits,
      query: "dream workflow",
      redacted: true,
      runId,
      schemaVersion: "memory.search.v1",
      skippedSources: [],
      workItemId,
    }),
  });
  const signalsWrite = await artifacts.writeJson({
    path: "dream/signals.json",
    redacted: true,
    runId,
    value: MemorySignalDocumentSchema.parse({
      generatedAt: at,
      redacted: true,
      runId,
      schemaVersion: "memory.signals.v1",
      signals: [
        {
          confidence: 0.9,
          kind: "friction",
          rating: 5,
          reasoning: "Recurring typesense env re-derivation across sessions.",
          receipts: [typesenseReceipt],
          signalId: "signal:typesense-env",
          summary: "Typesense env re-derived every session.",
        },
      ],
      workItemId,
    }),
  });
  const hydrationWrite = await artifacts.writeJson({
    path: "dream/hydration.json",
    redacted: true,
    runId,
    value: MemoryHydrationDocumentSchema.parse({
      generatedAt: at,
      hydrated: evidenceHits.map((hit) => ({
        fullTranscriptReturned: false,
        receipt: hit.receipts[0],
        redactedExcerpt: hit.redactedExcerpt,
        summary: `Hydrated redacted evidence for ${hit.receipts[0]?.receiptId}.`,
      })),
      redacted: true,
      runId,
      schemaVersion: "memory.hydration.v1",
      workItemId,
    }),
  });
  const correlationWrite = await artifacts.writeJson({
    path: "dream/correlation.json",
    redacted: true,
    runId,
    value: MemoryCorrelationGraphDocumentSchema.parse({
      edges: evidenceHits.map((hit, index) => ({
        edgeId: `edge:hit-${index}`,
        evidence: [hit.receipts[0]],
        fromNodeId: `memory-hit:${index + 1}`,
        relationship: "repeats_pattern",
        toNodeId: "report:hitl-review",
      })),
      generatedAt: at,
      nodes: [
        {
          label: "HITL human review",
          nodeId: "report:hitl-review",
          nodeType: "project",
          redacted: true,
        },
        ...evidenceHits.map((hit, index) => ({
          label: hit.summary,
          nodeId: `memory-hit:${index + 1}`,
          nodeType: "memory" as const,
          redacted: true as const,
        })),
      ],
      redacted: true,
      runId,
      schemaVersion: "memory.correlation-graph.v1",
      workItemId,
    }),
  });

  return {
    correlationRef: correlationWrite.artifactRef,
    hydrationRef: hydrationWrite.artifactRef,
    searchRef: searchWrite.artifactRef,
    signalsRef: signalsWrite.artifactRef,
  };
};

// A discriminating, receipt-tied reasoned output: ratings spread 9 / 6 / 2, each
// tied to a real receipt key from the evidence, one finding deliberately citing
// a HALLUCINATED key so the node's receipt-binding boundary is exercised.
const reasonedOutput = (): MemoryAgenticRefinementOutput =>
  MemoryAgenticRefinementOutputSchema.parse({
    findings: [
      {
        proposedChange:
          "Add a data-access kernel skill documenting the typesense env (panda:8108).",
        rating: 9,
        reasoning:
          "Recurring friction across sessions: the agent re-derived the env every time.",
        receiptKeys: ["source:joelclaw-sessions:receipt:pi:typesense-env"],
        recommendation: "turn-into-work",
        summary: "Typesense env re-derived every session wastes a step.",
        targetKind: "kernel-memory",
        title: "Document the typesense env in a data-access skill",
      },
      {
        proposedChange:
          "Planner should emit post-review nodes as a separate machine.",
        rating: 6,
        reasoning:
          "Pattern recurred but only blocked once; medium impact, medium recurrence.",
        receiptKeys: ["source:joelclaw-sessions:receipt:pi:post-review-nodes"],
        recommendation: "hold",
        summary: "Post-review nodes belong to a separate workflow.",
        targetKind: "dynamic-workflow-pattern",
        title: "Split post-review nodes into a separate machine",
      },
      {
        proposedChange:
          "Normalize label casing in the report renderer contract.",
        rating: 2,
        reasoning: "One-off cosmetic nit, low impact.",
        receiptKeys: ["source:brain:receipt:brain:label-nit"],
        recommendation: "hold",
        summary: "A cosmetic label casing nit.",
        targetKind: "report-node-improvement",
        title: "Normalize label casing",
      },
      {
        proposedChange: "Fix the thing the agent invented.",
        rating: 8,
        reasoning: "This finding cites a receipt that is not in the evidence.",
        receiptKeys: ["source:fabricated:receipt:does-not-exist"],
        recommendation: "accept",
        summary: "A fabricated finding with no real receipt.",
        targetKind: "schema-change",
        title: "Hallucinated finding",
      },
    ],
    schemaVersion: "memory.agentic-refinement-output.v1",
  });

interface CapturedReason {
  readonly outputPath: string;
  readonly prompt: string;
}

// Fake reasoning lane: captures the assembled prompt, writes the reasoned output
// to the artifact store at the requested outputPath (so the production read path
// is exercised), and returns a real-agent-shaped receipt. The seam the stage
// promises: tests inject a fake lane; the production lane is the real wire.
const fakeReasoningLane = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly captured: CapturedReason[];
  readonly output: MemoryAgenticRefinementOutput;
}): AgentAnalysisReasoningLanePort => ({
  laneKind: "analysis",
  async reason(reasonInput) {
    input.captured.push({
      outputPath: reasonInput.outputPath,
      prompt: reasonInput.prompt,
    });
    const write = await input.artifacts.writeJson({
      path: reasonInput.outputPath,
      redacted: true,
      runId: reasonInput.runId,
      value: input.output,
    });
    const receipt = {
      artifactCommitSha: "deadbeefcafef00d",
      kind: "worker",
      laneId: reasonInput.laneId,
      outputPins: [
        { artifactRef: write.artifactRef, hash: write.contentHash, mediaType },
      ],
      outputRefs: [write.artifactRef],
      prompt: artifactPin(reasonInput.promptPath),
      realAgent: true,
      receiptRef: artifactPin(reasonInput.receiptPath).artifactRef,
      redacted: true,
      runtime: "pi-agent-cli",
      startedAt: at,
      status: "completed",
      transcript: artifactPin(reasonInput.transcriptPath),
    } satisfies AgentLaneReceipt;

    return {
      outputRefs: [write.artifactRef],
      parsed: reasonInput.outputSchema.parse(
        await input.artifacts.readJson({ artifactRef: write.artifactRef })
      ),
      receipt,
    } satisfies AgentAnalysisReasoningResult<
      ReturnType<typeof reasonInput.outputSchema.parse>
    >;
  },
  runtime: "pi-agent-cli",
});

const executeRefinementNode = (input: {
  readonly adapter: WorkflowNodeAdapterPort;
  readonly pinnedPackages: readonly PinnedPackage[];
  readonly refs: {
    readonly correlationRef: ArtifactRef;
    readonly hydrationRef: ArtifactRef;
    readonly searchRef: ArtifactRef;
    readonly signalsRef: ArtifactRef;
  };
}) =>
  input.adapter.execute({
    actor: integrationTestActor,
    dependencyArtifactRefs: {},
    machine,
    plan: planWith(input.pinnedPackages),
    resolvedKernelSkills: resolveKernelSkills(input.pinnedPackages),
    step: {
      ...refinementStep,
      config: {
        correlationRef: input.refs.correlationRef,
        hydrationRef: input.refs.hydrationRef,
        maxProposals: 8,
        searchRef: input.refs.searchRef,
        signalsRef: input.refs.signalsRef,
      },
    },
  });

const loadDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly result: Awaited<ReturnType<WorkflowNodeAdapterPort["execute"]>>;
}) => {
  if (input.result.status !== "executed") {
    throw new Error("Expected the refinement node to execute.");
  }
  const ref = input.result.outputRefs.at(0);
  if (ref === undefined) {
    throw new Error("Expected a refinement proposal output ref.");
  }

  return MemoryRefinementProposalDocumentSchema.parse(
    await input.artifacts.readJson({ artifactRef: ref })
  );
};

describe("Dream agentic refinement-proposals node", () => {
  it("REASONS via the injected lane: prompt carries evidence + analysis skill, output is discriminating, hash-pinned, mechanical-free", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-agentic-refinement-agentic"
    );
    const refs = await seedRefinementInputs(artifacts);
    const captured: CapturedReason[] = [];
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      analysisReasoningLane: fakeReasoningLane({
        artifacts,
        captured,
        output: reasonedOutput(),
      }),
      artifacts,
    });

    const result = await executeRefinementNode({
      adapter,
      pinnedPackages: [seededClawKernel()],
      refs,
    });
    const document = await loadDocument({ artifacts, result });

    // The prompt the node assembled carried the run goal, the analysis-method
    // kernel skill body, the redacted evidence, and the citable receipt keys.
    const prompt = captured.at(0)?.prompt ?? "";
    expect({
      capturedCount: captured.length,
      hasAnalysisSkill: prompt.includes("Analysis method (kernel skill"),
      hasCitableReceiptKey: prompt.includes(
        "source:joelclaw-sessions:receipt:pi:typesense-env"
      ),
      hasRecurrenceGuidance: prompt.includes("rate by recurrence"),
      hasRedactedEvidence: prompt.includes(
        "The agent kept re-deriving the typesense env each session."
      ),
    }).toStrictEqual({
      capturedCount: 1,
      hasAnalysisSkill: true,
      hasCitableReceiptKey: true,
      hasRecurrenceGuidance: true,
      hasRedactedEvidence: true,
    });

    // The output is the REASONED set: marked agentic, ratings discriminate (not a
    // uniform 10/10 wall), the hallucinated finding was dropped at the receipt-
    // binding boundary, and every surviving proposal cites a real evidence
    // receipt — so no fabricated receipt reaches the hash-pinned record.
    const citableIds = new Set([
      "receipt:pi:typesense-env",
      "receipt:pi:post-review-nodes",
      "receipt:brain:label-nit",
    ]);
    expect({
      allReceiptsCitable: document.proposals.every((proposal) =>
        proposal.receipts.every((receipt) => citableIds.has(receipt.receiptId))
      ),
      everyProposalHasReceipts: document.proposals.every(
        (proposal) => proposal.receipts.length > 0
      ),
      hallucinationDropped: document.proposals.every(
        (proposal) => !proposal.title.includes("Hallucinated")
      ),
      ratings: document.proposals.map((proposal) => proposal.rating),
      reasoningMode: document.reasoningMode,
      reasoningNoteNamesDrop:
        document.reasoningNote?.includes("1 finding(s) were dropped") ?? false,
      redacted: document.redacted,
    }).toStrictEqual({
      allReceiptsCitable: true,
      everyProposalHasReceipts: true,
      hallucinationDropped: true,
      ratings: [9, 6, 2],
      reasoningMode: "agentic",
      reasoningNoteNamesDrop: true,
      redacted: true,
    });
  });

  it("falls back to the MECHANICAL path and labels it honestly when no lane is configured", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-agentic-refinement-mechanical"
    );
    const refs = await seedRefinementInputs(artifacts);
    const adapter = createMemoryFabricWorkflowNodeAdapter({ artifacts });

    const result = await executeRefinementNode({
      adapter,
      pinnedPackages: [seededClawKernel()],
      refs,
    });
    const document = await loadDocument({ artifacts, result });

    expect(document.reasoningMode).toBe("mechanical");
    expect(document.reasoningNote).toBeUndefined();
    expect(document.proposalCount).toBeGreaterThan(0);
    // Mechanical proposals carry the deterministic agentic-free proposalId shape.
    expect(
      document.proposals.every(
        (proposal) => !proposal.proposalId.startsWith("proposal:agentic:")
      )
    ).toBeTruthy();
  });

  it("falls back to MECHANICAL when the lane is configured but no analysis skill is in scope", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-agentic-refinement-no-skill"
    );
    const refs = await seedRefinementInputs(artifacts);
    const captured: CapturedReason[] = [];
    const adapter = createMemoryFabricWorkflowNodeAdapter({
      analysisReasoningLane: fakeReasoningLane({
        artifacts,
        captured,
        output: reasonedOutput(),
      }),
      artifacts,
    });

    // No pinned packages -> resolveKernelSkills() is [] -> no analysis skill ->
    // the node must not invoke the lane and must record mechanical output.
    const result = await executeRefinementNode({
      adapter,
      pinnedPackages: [],
      refs,
    });
    const document = await loadDocument({ artifacts, result });

    expect(captured).toHaveLength(0);
    expect(document.reasoningMode).toBe("mechanical");
  });
});
