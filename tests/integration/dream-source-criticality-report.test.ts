import { describe, expect, it } from "vitest";

import type {
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import {
  WorkflowExecutionProofDocumentSchema,
  WorkflowNodeTypeSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactPin,
  ArtifactRef,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../src/app/domain/schemas.ts";
import {
  primarySourceFamiliesOf,
  sourceFamilyCriticalityOf,
} from "../../src/app/domain/source-profile.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { buildWorkflowHitlReportAuditProofCheck } from "../../src/cartridges/memory-fabric/hitl-report-audit-proof-check.ts";
import {
  MemoryCorrelationGraphDocumentSchema,
  MemoryHydrationDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  MemorySearchDocumentSchema,
  WorkflowHitlReportDocumentSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import type {
  MemorySearchDocument,
  MemorySearchHit,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";
import { createMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const at = "2026-06-11T09:00:00.000Z";
const hash = "9".repeat(64);
const mediaType = "application/json";
const runId = "run-dream-source-criticality-test";
const workItemId = "work-item:dream-source-criticality-test";

const artifactPin = (path: string): ArtifactPin => ({
  artifactRef: `artifact://dream-source-criticality-test/${path}`,
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
  receiptRef: "artifact://dream-source-criticality-test/planner/receipt.json",
  redacted: true,
  runtime: "integration-test",
  startedAt: at,
  status: "completed",
  transcript: artifactPin("planner/transcript.jsonl"),
} satisfies AgentLaneReceipt;

const reportStep = {
  config: {
    primarySourceFamilies: [
      ...primarySourceFamiliesOf(dreamTranscriptReviewSourceProfile),
    ],
  },
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.hitl-report"),
  outputPath: "report/hitl-report.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "render-hitl-report",
  summary: "Render the Dream HITL report over hydrated, correlated evidence.",
} satisfies WorkflowNodeInvocationStep;

const machine = {
  createdAt: at,
  machineId: "machine:dream-source-criticality-test",
  planner: {
    kind: "stochastic",
    nonce: "nonce:dream-source-criticality-test",
    source: "integration-test",
  },
  runId,
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: [reportStep.stepId],
  workItemId,
  xstate: {
    id: "dream-source-criticality-test",
    initial: "report",
    states: {
      done: {
        meta: {},
        on: {},
        type: "final",
      },
      report: {
        meta: {
          stepId: reportStep.stepId,
          stepKind: reportStep.kind,
          summary: reportStep.summary,
        },
        on: {
          STEP_DONE: {
            target: "done",
          },
        },
      },
    },
  },
} satisfies DynamicWorkflowMachineDocument;

const plan = {
  actor: integrationTestActor,
  createdAt: at,
  harness: {
    artifactRef:
      "artifact://dream-source-criticality-test/workflows/harness.ts",
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:dream-source-criticality-test",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef:
      "artifact://dream-source-criticality-test/workflows/machine.config.json",
    hash,
    machineId: machine.machineId,
    sourceArtifactRef:
      "artifact://dream-source-criticality-test/workflows/machine.ts",
    sourceHash: hash,
  },
  outputTarget: {
    kind: "artifact-only",
    path: "review/summary.json",
  },
  pinnedPackages: [],
  planId: "plan:dream-source-criticality-test",
  planner: machine.planner,
  plannerLane,
  proposal: {
    intent:
      "Review agent transcripts; a dead primary source must block instead of masquerading.",
    requestedPackageIds: ["workflow/memory-fabric"],
    stochasticNotes: [
      "The report node enforces the source-criticality contract over loaded search receipts.",
    ],
  },
  runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: [reportStep],
  verificationContract: {
    artifactRef:
      "artifact://dream-source-criticality-test/run/verification-contract.json",
    contractId: "contract:dream-source-criticality-test",
    hash,
    mediaType,
  },
  workItemId,
} satisfies DynamicWorkflowPlanDocument;

const transcriptReceipt = {
  family: "agent-transcripts",
  hash,
  receiptId: "receipt:pi:dream-1",
  redactedLocator: "redacted://joelclaw-session/dream-1",
  runtime: "pi",
  sourceId: "source:joelclaw-sessions",
  timestamp: at,
} as const;

const brainReceipt = {
  family: "brain",
  hash,
  receiptId: "receipt:brain:dream-1",
  redactedLocator: "redacted://memory-source/brain/dream-1",
  sourceId: "source:brain",
  timestamp: at,
} as const;

const repoReceipt = {
  family: "repo-outputs",
  hash,
  receiptId: "receipt:repo:dream-1",
  redactedLocator: "redacted://memory-source/repo/dream-1",
  sourceId: "source:repo-outputs",
  timestamp: at,
} as const;

const transcriptHit = {
  horizon: "all-time",
  receipts: [transcriptReceipt],
  redactedExcerpt: "A dream over transcripts must read the real session index.",
  score: 0.88,
  summary: "Agent transcript reinforces transcript-review intent.",
} satisfies MemorySearchHit;

const brainHit = {
  horizon: "30d",
  receipts: [brainReceipt],
  redactedExcerpt: "Brain note about the dream report shape.",
  score: 0.71,
  summary: "Brain note correlates with the dream report.",
} satisfies MemorySearchHit;

const repoHit = {
  horizon: "7d",
  receipts: [repoReceipt],
  redactedExcerpt: "Repo output about the dream report renderer.",
  score: 0.66,
  summary: "Repo output adds a supplementary report-rendering signal.",
} satisfies MemorySearchHit;

const searchDocumentWith = (input: {
  readonly hits: readonly MemorySearchHit[];
  readonly skippedSources: readonly string[];
}): MemorySearchDocument =>
  MemorySearchDocumentSchema.parse({
    generatedAt: at,
    hits: [...input.hits],
    query: "dream workflow",
    redacted: true,
    runId,
    schemaVersion: "memory.search.v1",
    skippedSources: [...input.skippedSources],
    workItemId,
  });

const hydrationDocumentFor = (hits: readonly MemorySearchHit[]) =>
  MemoryHydrationDocumentSchema.parse({
    generatedAt: at,
    hydrated: hits.map((hit) => ({
      fullTranscriptReturned: false,
      receipt: hit.receipts[0],
      redactedExcerpt: hit.redactedExcerpt ?? "Redacted hydration excerpt.",
      summary: `Hydrated redacted evidence for ${hit.receipts[0]?.sourceId}.`,
    })),
    redacted: true,
    runId,
    schemaVersion: "memory.hydration.v1",
    workItemId,
  });

const correlationDocumentFor = (hits: readonly MemorySearchHit[]) =>
  MemoryCorrelationGraphDocumentSchema.parse({
    edges: hits.map((hit, index) => ({
      edgeId: `edge:hit-${index}`,
      evidence: [hit.receipts[0]],
      fromNodeId: `memory-hit:${index + 1}`,
      relationship: "supports_finding",
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
      ...hits.map((hit, index) => ({
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
  });

const seedReportInputs = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly hits: readonly MemorySearchHit[];
  readonly skippedSources: readonly string[];
}): Promise<{
  readonly correlationRef: ArtifactRef;
  readonly hydrationRef: ArtifactRef;
  readonly searchRef: ArtifactRef;
}> => {
  const searchWrite = await input.artifacts.writeJson({
    path: "dream/search.json",
    redacted: true,
    runId,
    value: searchDocumentWith({
      hits: input.hits,
      skippedSources: input.skippedSources,
    }),
  });
  const hydrationWrite = await input.artifacts.writeJson({
    path: "dream/hydration.json",
    redacted: true,
    runId,
    value: hydrationDocumentFor(input.hits),
  });
  const correlationWrite = await input.artifacts.writeJson({
    path: "dream/correlation.json",
    redacted: true,
    runId,
    value: correlationDocumentFor(input.hits),
  });

  return {
    correlationRef: correlationWrite.artifactRef,
    hydrationRef: hydrationWrite.artifactRef,
    searchRef: searchWrite.artifactRef,
  };
};

const reasonedRefinementProposalDocumentFor = (
  sourceRefs: readonly ArtifactRef[]
) =>
  MemoryRefinementProposalDocumentSchema.parse({
    generatedAt: at,
    nextWorkflowSeed: {
      plannerInstructions: [
        "Patch report cards from accepted refinement proposals before publishing.",
      ],
      proposalIds: [
        "proposal:agentic:report-node-improvement:1:report-cards",
        "proposal:agentic:dynamic-workflow-pattern:2:tunnel-guard",
      ],
      requiredCapabilityKinds: [],
      sourceRefs,
    },
    proposalCount: 2,
    proposals: [
      {
        proposalId: "proposal:agentic:report-node-improvement:1:report-cards",
        proposedNextStep:
          "Change the HITL report node to render proposal-backed finding cards before raw search-hit leads.",
        rating: 9,
        reasoning:
          "The evidence shows search-hit cards can swamp the report and hide the reasoned refinement output.",
        receipts: [transcriptReceipt],
        recommendation: "turn-into-work",
        sourceRefs,
        summary:
          "Report cards must be sourced from reasoned refinement proposals, not every search hit.",
        targetKind: "report-node-improvement",
        title: "Render proposal-backed report cards first",
      },
      {
        proposalId: "proposal:agentic:dynamic-workflow-pattern:2:tunnel-guard",
        proposedNextStep:
          "Reject ephemeral relay tunnel URLs for live deploys unless an operator uses a deliberate emergency override.",
        rating: 6,
        reasoning:
          "The tunnel issue is blocking future live runs but is separable from report rendering.",
        receipts: [brainReceipt],
        recommendation: "turn-into-work",
        sourceRefs,
        summary:
          "Live run setup should not deploy a relay URL that dies with a quick tunnel.",
        targetKind: "dynamic-workflow-pattern",
        title: "Guard live runs from dead quick tunnels",
      },
    ],
    reasoningMode: "agentic",
    reasoningNote: "Integration fixture: proposal-backed report card contract.",
    redacted: true,
    runId,
    schemaVersion: "memory.refinement-proposals.v1",
    sourceRefs,
    workItemId,
  });

const executeReportNode = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly config: Record<string, unknown>;
  readonly refs: {
    readonly correlationRef: ArtifactRef;
    readonly hydrationRef: ArtifactRef;
    readonly searchRef: ArtifactRef;
  };
}) => {
  const adapter = createMemoryFabricWorkflowNodeAdapter({
    artifacts: input.artifacts,
  });

  return adapter.execute({
    actor: integrationTestActor,
    dependencyArtifactRefs: {
      "correlate-memories": input.refs.correlationRef,
      "hydrate-memories": input.refs.hydrationRef,
      "search-memories": input.refs.searchRef,
    },
    machine,
    plan,
    step: {
      ...reportStep,
      config: {
        ...input.config,
        correlationRef: input.refs.correlationRef,
        hydrationRef: input.refs.hydrationRef,
        searchRef: input.refs.searchRef,
      },
    },
  } satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0]);
};

const searchAgentTranscriptsStep = {
  config: {
    maxHits: 5,
    query: "dream workflow agent transcripts",
    sourceFamilies: ["agent-transcripts"],
  },
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.search"),
  outputPath: "dream/search-agent-transcripts.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "search-agent-transcripts",
  summary: "Search agent transcript receipts across one horizon.",
} satisfies WorkflowNodeInvocationStep;

const searchBrainStep = {
  config: {
    maxHits: 5,
    query: "dream workflow brain",
    sourceFamilies: ["brain"],
  },
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.search"),
  outputPath: "dream/search-brain.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "search-brain",
  summary: "Search Brain receipts.",
} satisfies WorkflowNodeInvocationStep;

const searchRepoOutputsStep = {
  config: {
    maxHits: 5,
    query: "dream workflow repo outputs",
    sourceFamilies: ["repo-outputs"],
  },
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.search"),
  outputPath: "dream/search-repo-outputs.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "search-repo-outputs",
  summary: "Search repo-output receipts last.",
} satisfies WorkflowNodeInvocationStep;

const hydrateAgentTranscriptsStep = {
  config: {
    searchStepId: searchAgentTranscriptsStep.stepId,
  },
  dependsOn: [searchAgentTranscriptsStep.stepId],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.hydrate"),
  outputPath: "dream/hydrate-agent-transcripts.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "hydrate-agent-transcripts",
  summary: "Hydrate agent transcript receipts.",
} satisfies WorkflowNodeInvocationStep;

const correlateMemoriesStep = {
  config: {},
  dependsOn: [
    searchAgentTranscriptsStep.stepId,
    searchBrainStep.stepId,
    searchRepoOutputsStep.stepId,
    hydrateAgentTranscriptsStep.stepId,
  ],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.correlate"),
  outputPath: "dream/correlation.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "correlate-memories",
  summary: "Correlate the union of searched and hydrated memories.",
} satisfies WorkflowNodeInvocationStep;

const multiSearchPlan = {
  ...plan,
  proposal: {
    ...plan.proposal,
    stochasticNotes: [
      ...plan.proposal.stochasticNotes,
      "Production fan-out searches primary agent transcripts before supplementary families.",
    ],
  },
  steps: [
    searchAgentTranscriptsStep,
    searchBrainStep,
    searchRepoOutputsStep,
    hydrateAgentTranscriptsStep,
    correlateMemoriesStep,
    reportStep,
  ],
} satisfies DynamicWorkflowPlanDocument;

const seedMultiSearchReportInputs = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly searchAgentTranscriptHits: readonly MemorySearchHit[];
  readonly searchAgentTranscriptSkippedSources: readonly string[];
  readonly searchBrainHits: readonly MemorySearchHit[];
  readonly searchBrainSkippedSources: readonly string[];
  readonly searchRepoHits: readonly MemorySearchHit[];
  readonly searchRepoSkippedSources: readonly string[];
}): Promise<{
  readonly brainSearchRef: ArtifactRef;
  readonly correlationRef: ArtifactRef;
  readonly hydrationRef: ArtifactRef;
  readonly repoSearchRef: ArtifactRef;
  readonly transcriptSearchRef: ArtifactRef;
}> => {
  const transcriptSearchWrite = await input.artifacts.writeJson({
    path: searchAgentTranscriptsStep.outputPath,
    redacted: true,
    runId,
    value: searchDocumentWith({
      hits: input.searchAgentTranscriptHits,
      skippedSources: input.searchAgentTranscriptSkippedSources,
    }),
  });
  const brainSearchWrite = await input.artifacts.writeJson({
    path: searchBrainStep.outputPath,
    redacted: true,
    runId,
    value: searchDocumentWith({
      hits: input.searchBrainHits,
      skippedSources: input.searchBrainSkippedSources,
    }),
  });
  const repoSearchWrite = await input.artifacts.writeJson({
    path: searchRepoOutputsStep.outputPath,
    redacted: true,
    runId,
    value: searchDocumentWith({
      hits: input.searchRepoHits,
      skippedSources: input.searchRepoSkippedSources,
    }),
  });
  const allHits = [
    ...input.searchAgentTranscriptHits,
    ...input.searchBrainHits,
    ...input.searchRepoHits,
  ];
  const hydrationWrite = await input.artifacts.writeJson({
    path: hydrateAgentTranscriptsStep.outputPath,
    redacted: true,
    runId,
    value: hydrationDocumentFor(input.searchAgentTranscriptHits),
  });
  const correlationWrite = await input.artifacts.writeJson({
    path: correlateMemoriesStep.outputPath,
    redacted: true,
    runId,
    value: correlationDocumentFor(allHits),
  });

  return {
    brainSearchRef: brainSearchWrite.artifactRef,
    correlationRef: correlationWrite.artifactRef,
    hydrationRef: hydrationWrite.artifactRef,
    repoSearchRef: repoSearchWrite.artifactRef,
    transcriptSearchRef: transcriptSearchWrite.artifactRef,
  };
};

const executeMultiSearchReportNode = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly refs: Awaited<ReturnType<typeof seedMultiSearchReportInputs>>;
}) =>
  createMemoryFabricWorkflowNodeAdapter({
    artifacts: input.artifacts,
  }).execute({
    actor: integrationTestActor,
    completedStepArtifactRefs: {
      [searchAgentTranscriptsStep.stepId]: input.refs.transcriptSearchRef,
      [searchBrainStep.stepId]: input.refs.brainSearchRef,
      [searchRepoOutputsStep.stepId]: input.refs.repoSearchRef,
      [hydrateAgentTranscriptsStep.stepId]: input.refs.hydrationRef,
      [correlateMemoriesStep.stepId]: input.refs.correlationRef,
    },
    dependencyArtifactRefs: {},
    machine,
    plan: multiSearchPlan,
    step: {
      ...reportStep,
      config: {
        primarySourceFamilies: ["agent-transcripts"],
      },
    },
  } satisfies Parameters<WorkflowNodeAdapterPort["execute"]>[0]);

describe("Dream source criticality enforcement", () => {
  it("declares agent-transcripts PRIMARY and the rest supplementary in the dream profile", () => {
    expect({
      agentTranscripts: sourceFamilyCriticalityOf({
        family: "agent-transcripts",
        profile: dreamTranscriptReviewSourceProfile,
      }),
      brain: sourceFamilyCriticalityOf({
        family: "brain",
        profile: dreamTranscriptReviewSourceProfile,
      }),
      cloudflareRuns: sourceFamilyCriticalityOf({
        family: "cloudflare-runs",
        profile: dreamTranscriptReviewSourceProfile,
      }),
      primary: primarySourceFamiliesOf(dreamTranscriptReviewSourceProfile),
    }).toStrictEqual({
      agentTranscripts: "primary",
      brain: "supplementary",
      cloudflareRuns: "supplementary",
      primary: ["agent-transcripts"],
    });
  });

  it("BLOCKS the report when a PRIMARY family (agent-transcripts) resolved zero receipts", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-primary-dead"
    );
    const refs = await seedReportInputs({
      artifacts,
      // Only a supplementary brain hit resolved; the primary transcript source
      // is unavailable, recorded as a skipped-source caveat.
      hits: [brainHit],
      skippedSources: ["source:joelclaw-sessions:joelclaw-index-unavailable"],
    });

    const result = await executeReportNode({
      artifacts,
      config: {
        primarySourceFamilies: ["agent-transcripts"],
      },
      refs,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("Expected the report node to block.");
    }

    expect({
      code: result.blocker.code,
      mentionsCaveat: result.blocker.message.includes(
        "source:joelclaw-sessions:joelclaw-index-unavailable"
      ),
      mentionsFamily: result.blocker.message.includes("agent-transcripts"),
      mentionsZeroReceipts: result.blocker.message.includes(
        "resolved zero receipts"
      ),
      redacted: result.blocker.redacted,
    }).toStrictEqual({
      code: "stale_package",
      mentionsCaveat: true,
      mentionsFamily: true,
      mentionsZeroReceipts: true,
      redacted: true,
    });
  });

  it("renders the report normally when the PRIMARY family is present", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-primary-present"
    );
    const refs = await seedReportInputs({
      artifacts,
      hits: [transcriptHit, brainHit],
      skippedSources: [],
    });

    const result = await executeReportNode({
      artifacts,
      config: {
        primarySourceFamilies: ["agent-transcripts"],
      },
      refs,
    });

    expect(result.status).toBe("executed");
    if (result.status !== "executed") {
      throw new Error("Expected the report node to execute.");
    }

    const reportRef = result.outputRefs.at(0);
    if (reportRef === undefined) {
      throw new Error("Expected a HITL report output ref.");
    }

    const report = WorkflowHitlReportDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: reportRef })
    );

    expect({
      findingCount: report.findingCount,
      schemaVersion: report.schemaVersion,
    }).toStrictEqual({
      findingCount: 2,
      schemaVersion: "workflow.hitl-report.v1",
    });
  });

  it("renders proposal-backed findings instead of dumping raw search hits", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-proposal-findings"
    );
    const refs = await seedReportInputs({
      artifacts,
      hits: [transcriptHit, brainHit, repoHit],
      skippedSources: [],
    });
    const refinementWrite = await artifacts.writeJson({
      path: "dream/refinement-proposals.json",
      redacted: true,
      runId,
      value: reasonedRefinementProposalDocumentFor([
        refs.searchRef,
        refs.hydrationRef,
        refs.correlationRef,
      ]),
    });

    const result = await executeReportNode({
      artifacts,
      config: {
        primarySourceFamilies: ["agent-transcripts"],
        refinementProposalRef: refinementWrite.artifactRef,
      },
      refs,
    });

    expect(result.status).toBe("executed");
    if (result.status !== "executed") {
      throw new Error("Expected the report node to execute.");
    }

    const reportRef = result.outputRefs.at(0);
    if (reportRef === undefined) {
      throw new Error("Expected a HITL report output ref.");
    }

    const report = WorkflowHitlReportDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: reportRef })
    );

    expect({
      findingCount: report.findingCount,
      findings: report.findings.map((finding) => ({
        failureClass: finding.failureClass,
        sourceKind: finding.sourceKind,
        title: finding.title,
      })),
      genericNeedsReviewAbsent: report.findings.every(
        (finding) => !finding.title.includes("needs human review")
      ),
      mdsvxShowsFailureClass: report.mdsvx.includes(
        "**Failure class.** report-node-improvement"
      ),
      refinementProposalCount: report.refinementProposalCount,
    }).toStrictEqual({
      findingCount: 2,
      findings: [
        {
          failureClass: "report-node-improvement",
          sourceKind: "refinement-proposal",
          title: "Render proposal-backed report cards first",
        },
        {
          failureClass: "dynamic-workflow-pattern",
          sourceKind: "refinement-proposal",
          title: "Guard live runs from dead quick tunnels",
        },
      ],
      genericNeedsReviewAbsent: true,
      mdsvxShowsFailureClass: true,
      refinementProposalCount: 2,
    });
  });

  it("fails the report proof gate for generic all-10 search-hit dumps", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-garbage-report-gate"
    );
    const refs = await seedReportInputs({
      artifacts,
      hits: [transcriptHit, brainHit, repoHit],
      skippedSources: [],
    });
    const refinementDocument = reasonedRefinementProposalDocumentFor([
      refs.searchRef,
      refs.hydrationRef,
      refs.correlationRef,
    ]);
    const baselineResult = await executeReportNode({
      artifacts,
      config: {
        primarySourceFamilies: ["agent-transcripts"],
      },
      refs,
    });
    if (baselineResult.status !== "executed") {
      throw new Error("Expected baseline report node to execute.");
    }
    const baselineReportRef = baselineResult.outputRefs.at(0);
    if (baselineReportRef === undefined) {
      throw new Error("Expected a baseline HITL report ref.");
    }
    const baselineReport = WorkflowHitlReportDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: baselineReportRef })
    );
    const garbageFindings = Array.from({ length: 8 }, (_, index) => ({
      failureClass: "workflow-node-plugin" as const,
      rating: 10,
      reasoning:
        "The search hit score was high, so this fake card pretends to be analysis.",
      receipts: [transcriptReceipt],
      recommendation:
        "Review the receipts and decide whether this updates .brain.",
      sourceKind: "search-hit" as const,
      summary: `Search metadata row ${index + 1}.`,
      title: `Finding ${index + 1}: agent transcripts needs human review`,
    }));
    const garbageReport = WorkflowHitlReportDocumentSchema.parse({
      ...baselineReport,
      findingCount: garbageFindings.length,
      findings: garbageFindings,
      mdsvx: "# Garbage report\n\n## The actual findings\n\nneeds human review",
      refinementProposalCount: refinementDocument.proposalCount,
      refinementProposalRef:
        "artifact://dream-source-criticality-test/dream/refinement-proposals.json",
      refinementProposals: refinementDocument.proposals,
      refinementReasoningMode: "agentic",
    });
    const garbageWrite = await artifacts.writeJson({
      path: "report/hitl-report.json",
      redacted: true,
      runId,
      value: garbageReport,
    });
    const executionProof = WorkflowExecutionProofDocumentSchema.parse({
      completedStepIds: [reportStep.stepId],
      eventCount: 1,
      eventLogHash: hash,
      generatedAt: at,
      generatedStateSequence: ["report", "done"],
      harnessArtifact: plan.harness,
      machineArtifact: plan.machine,
      planArtifact: {
        artifactRef: "artifact://dream-source-criticality-test/run/plan.json",
        hash,
        pinnedAt: at,
        runId,
      },
      platform: "local-integration",
      proofId: "proof:dream-source-criticality-garbage-report-gate",
      reason: "Integration fixture for report quality proof gate.",
      redacted: true,
      requiredProof: ["report-quality"],
      runId,
      schemaVersion: "workflow.execution-proof.v1",
      status: "not-proven-local-integration",
      workItemId,
      workflowNodeOutputRefs: [garbageWrite.artifactRef],
    });

    const check = await buildWorkflowHitlReportAuditProofCheck({
      artifacts,
      executionProof,
    });

    expect({
      passed: check.passed,
      summaryMentionsAll10: check.summary.includes("all findings are rated"),
      summaryMentionsGeneric: check.summary.includes("generic review wording"),
      summaryMentionsMax7: check.summary.includes("max 7"),
      summaryMentionsNoProposalCards: check.summary.includes(
        "no finding card sourced from them"
      ),
    }).toStrictEqual({
      passed: false,
      summaryMentionsAll10: true,
      summaryMentionsGeneric: true,
      summaryMentionsMax7: true,
      summaryMentionsNoProposalCards: true,
    });
  });

  it("keeps a missing SUPPLEMENTARY family a non-blocking caveat", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-supplementary-missing"
    );
    const refs = await seedReportInputs({
      artifacts,
      // The PRIMARY transcript source resolved; a supplementary family was
      // skipped. The run must still render, surfacing the skip as a caveat.
      hits: [transcriptHit],
      skippedSources: ["source:cloudflare-runs:unavailable"],
    });

    const result = await executeReportNode({
      artifacts,
      config: {
        primarySourceFamilies: ["agent-transcripts"],
      },
      refs,
    });

    expect(result.status).toBe("executed");
    if (result.status !== "executed") {
      throw new Error("Expected the report node to execute.");
    }

    const reportRef = result.outputRefs.at(0);
    const mdsvxRef = result.outputRefs.at(1);
    if (reportRef === undefined || mdsvxRef === undefined) {
      throw new Error("Expected JSON + MDSvX report output refs.");
    }

    const mdsvx = await artifacts.readText({ artifactRef: mdsvxRef });

    expect(mdsvx).toContain("source:cloudflare-runs:unavailable");
    expect(mdsvx.toLowerCase()).toContain("caveat");
  });

  it("renders when agent-transcripts receipts are present only in a non-last search artifact", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-primary-union-present"
    );
    const refs = await seedMultiSearchReportInputs({
      artifacts,
      searchAgentTranscriptHits: [transcriptHit],
      searchAgentTranscriptSkippedSources: [],
      searchBrainHits: [brainHit],
      searchBrainSkippedSources: [],
      searchRepoHits: [repoHit],
      searchRepoSkippedSources: [],
    });

    const result = await executeMultiSearchReportNode({
      artifacts,
      refs,
    });

    expect(result.status).toBe("executed");
    if (result.status !== "executed") {
      throw new Error("Expected the multi-search report node to execute.");
    }

    const reportRef = result.outputRefs.at(0);
    if (reportRef === undefined) {
      throw new Error("Expected a HITL report output ref.");
    }

    const report = WorkflowHitlReportDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: reportRef })
    );

    expect({
      findingCount: report.findingCount,
      receiptCount: report.receiptCount,
      sourceRefs: report.sourceRefs,
      transcriptFamilyRendered: report.findings.some((finding) =>
        finding.receipts.some(
          (receipt) => receipt.family === "agent-transcripts"
        )
      ),
    }).toStrictEqual({
      findingCount: 3,
      receiptCount: 3,
      sourceRefs: [
        refs.repoSearchRef,
        refs.transcriptSearchRef,
        refs.brainSearchRef,
        refs.hydrationRef,
        refs.correlationRef,
      ],
      transcriptFamilyRendered: true,
    });
  });

  it("blocks when agent-transcripts receipts are absent across the full search union", async () => {
    const artifacts = createMemoryArtifactStore(
      "dream-source-criticality-primary-union-dead"
    );
    const refs = await seedMultiSearchReportInputs({
      artifacts,
      searchAgentTranscriptHits: [],
      searchAgentTranscriptSkippedSources: [
        "source:joelclaw-sessions:joelclaw-index-unavailable",
      ],
      searchBrainHits: [brainHit],
      searchBrainSkippedSources: ["source:brain:rate-limited"],
      searchRepoHits: [repoHit],
      searchRepoSkippedSources: [],
    });

    const result = await executeMultiSearchReportNode({
      artifacts,
      refs,
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      throw new Error("Expected the multi-search report node to block.");
    }

    expect({
      code: result.blocker.code,
      mentionsBrainCaveat: result.blocker.message.includes(
        "source:brain:rate-limited"
      ),
      mentionsFamily: result.blocker.message.includes("agent-transcripts"),
      mentionsTranscriptCaveat: result.blocker.message.includes(
        "source:joelclaw-sessions:joelclaw-index-unavailable"
      ),
      mentionsZeroReceipts: result.blocker.message.includes(
        "resolved zero receipts"
      ),
    }).toStrictEqual({
      code: "stale_package",
      mentionsBrainCaveat: true,
      mentionsFamily: true,
      mentionsTranscriptCaveat: true,
      mentionsZeroReceipts: true,
    });
  });
});
