import { describe, expect, it } from "vitest";

import type {
  WorkflowNodeAdapterPort,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import { hashJson } from "../../src/app/domain/hash.ts";
import { WorkflowNodeTypeSchema } from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneReceipt,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
  PinnedPackage,
} from "../../src/app/domain/schemas.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import { createArtifactBackedWorkflowCartridgeAdapter } from "../../src/app/workflow-nodes/artifact-backed-cartridge-adapter.ts";
import { createIntegrationTestAiHeroSupportSweepAdapter } from "../../src/cartridges/aihero-support-sweep/integration-test-adapters.ts";
import { aiHeroSupportSweepPackageMetadata } from "../../src/cartridges/aihero-support-sweep/package-seed.ts";
import {
  AiHeroSupportSweepDraftSideEffectDocumentSchema,
  AiHeroSupportSweepHydrationDocumentSchema,
  AiHeroSupportSweepRecommendationDocumentSchema,
} from "../../src/cartridges/aihero-support-sweep/schemas.ts";
import { createAiHeroSupportSweepWorkflowNodeAdapter } from "../../src/cartridges/aihero-support-sweep/workflow-node-adapter.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const at = "2026-06-12T12:00:00.000Z";
const hash = "0".repeat(64);
const mediaType = "application/json";

const packageRef = aiHeroSupportSweepPackageMetadata.latestArtifactRef;

const step = (input: {
  readonly config?: Record<string, unknown>;
  readonly dependsOn?: readonly string[];
  readonly nodeType: string;
  readonly outputPath: string;
  readonly stepId: string;
  readonly summary: string;
}): WorkflowNodeInvocationStep => ({
  config: input.config ?? {},
  dependsOn: [...(input.dependsOn ?? [])],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse(input.nodeType),
  outputPath: input.outputPath,
  packageRefs: [packageRef],
  stepId: input.stepId,
  summary: input.summary,
});

const supportSweepSteps = [
  step({
    nodeType: "aihero.support-sweep.source-inventory",
    outputPath: "aihero/inventory.json",
    stepId: "inventory-aihero-sources",
    summary: "Inventory customer-private AIHero support source roots.",
  }),
  step({
    config: {
      inventoryStepId: "inventory-aihero-sources",
      recoveryOnly: true,
    },
    dependsOn: ["inventory-aihero-sources"],
    nodeType: "aihero.support-sweep.derived-index-health",
    outputPath: "aihero/index-health.json",
    stepId: "check-derived-index-health",
    summary: "Check derived-index health and plan recovery-only backfills.",
  }),
  step({
    config: {
      axes: ["issue", "account", "person", "course-product"],
      horizons: ["24h", "7d", "30d", "quarter", "all-time"],
      indexHealthStepId: "check-derived-index-health",
      maxSignals: 12,
      query: "AIHero support sweep",
    },
    dependsOn: ["check-derived-index-health"],
    nodeType: "aihero.support-sweep.signal-search",
    outputPath: "aihero/signal-search.json",
    stepId: "search-support-signals",
    summary: "Search support, comms, customer, and product-context signals.",
  }),
  step({
    config: {
      maxReceipts: 8,
      signalSearchStepId: "search-support-signals",
    },
    dependsOn: ["search-support-signals"],
    nodeType: "aihero.support-sweep.evidence-hydration",
    outputPath: "aihero/hydration.json",
    stepId: "hydrate-selected-evidence",
    summary: "Hydrate selected receipts as redacted evidence only.",
  }),
  step({
    config: {
      hydrationStepId: "hydrate-selected-evidence",
      maxRecommendations: 5,
      signalSearchStepId: "search-support-signals",
    },
    dependsOn: ["hydrate-selected-evidence", "search-support-signals"],
    nodeType: "aihero.support-sweep.hitl-recommendations",
    outputPath: "aihero/recommendations.json",
    stepId: "recommend-support-actions",
    summary: "Emit concise HITL support recommendations.",
  }),
  step({
    config: {
      recommendationsStepId: "recommend-support-actions",
      requireCapabilityLease: true,
    },
    dependsOn: ["recommend-support-actions"],
    nodeType: "aihero.support-sweep.draft-side-effects",
    outputPath: "aihero/draft-side-effects.json",
    stepId: "draft-support-side-effects",
    summary: "Draft side effects behind capability leases only.",
  }),
] satisfies WorkflowNodeInvocationStep[];

const plannerLane = {
  kind: "planner",
  laneId: "lane:planner:aihero-support-sweep",
  outputPins: [],
  outputRefs: [],
  prompt: {
    artifactRef: "artifact://aihero-support-sweep-test/planner/prompt.md",
    hash,
    mediaType: "text/markdown",
  },
  realAgent: false,
  receiptRef: "artifact://aihero-support-sweep-test/planner/receipt.json",
  redacted: true,
  runtime: "integration-test",
  startedAt: at,
  status: "completed",
  transcript: {
    artifactRef:
      "artifact://aihero-support-sweep-test/planner/transcript.jsonl",
    hash,
    mediaType: "application/jsonl",
  },
} satisfies AgentLaneReceipt;

const pinnedPackage = {
  artifactRef: packageRef,
  fileHashes: {
    "package.json": hashJson(aiHeroSupportSweepPackageMetadata),
  },
  manifestHash: hashJson(aiHeroSupportSweepPackageMetadata),
  metadata: aiHeroSupportSweepPackageMetadata,
  pinnedAt: at,
  version: aiHeroSupportSweepPackageMetadata.latestVersion,
} satisfies PinnedPackage;

const machine = {
  createdAt: at,
  machineId: "machine:aihero-support-sweep-test",
  planner: {
    kind: "stochastic",
    nonce: "nonce:aihero-support-sweep-test",
    source: "integration-test",
  },
  runId: "run-aihero-support-sweep-test",
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: supportSweepSteps.map((candidate) => candidate.stepId),
  workItemId: "work-item:aihero-support-sweep-test",
  xstate: {
    id: "aihero-support-sweep-test",
    initial: "inventory",
    states: {
      done: {
        meta: {},
        on: {},
        type: "final",
      },
      draft: {
        meta: {
          stepId: "draft-support-side-effects",
          stepKind: "workflow.node.invoke",
          summary: "Draft side effects behind capability leases only.",
        },
        on: {
          STEP_DONE: {
            target: "done",
          },
        },
      },
      health: {
        meta: {
          stepId: "check-derived-index-health",
          stepKind: "workflow.node.invoke",
          summary:
            "Check derived-index health and plan recovery-only backfills.",
        },
        on: {
          STEP_DONE: {
            target: "signals",
          },
        },
      },
      hydrate: {
        meta: {
          stepId: "hydrate-selected-evidence",
          stepKind: "workflow.node.invoke",
          summary: "Hydrate selected receipts as redacted evidence only.",
        },
        on: {
          STEP_DONE: {
            target: "recommend",
          },
        },
      },
      inventory: {
        meta: {
          stepId: "inventory-aihero-sources",
          stepKind: "workflow.node.invoke",
          summary: "Inventory customer-private AIHero support source roots.",
        },
        on: {
          STEP_DONE: {
            target: "health",
          },
        },
      },
      recommend: {
        meta: {
          stepId: "recommend-support-actions",
          stepKind: "workflow.node.invoke",
          summary: "Emit concise HITL support recommendations.",
        },
        on: {
          STEP_DONE: {
            target: "draft",
          },
        },
      },
      signals: {
        meta: {
          stepId: "search-support-signals",
          stepKind: "workflow.node.invoke",
          summary:
            "Search support, comms, customer, and product-context signals.",
        },
        on: {
          STEP_DONE: {
            target: "hydrate",
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
    artifactRef: "artifact://aihero-support-sweep-test/workflows/harness.ts",
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:aihero-support-sweep-test",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef:
      "artifact://aihero-support-sweep-test/workflows/machine.config.json",
    hash,
    machineId: machine.machineId,
    sourceArtifactRef:
      "artifact://aihero-support-sweep-test/workflows/machine.ts",
    sourceHash: hash,
  },
  outputTarget: {
    kind: "artifact-only",
    path: "review/aihero-support-sweep.json",
  },
  pinnedPackages: [pinnedPackage],
  planId: "plan:aihero-support-sweep-test",
  planner: machine.planner,
  plannerLane,
  proposal: {
    intent:
      "Exercise the AIHero support sweep cartridge through all six workflow-node steps.",
    requestedPackageIds: [aiHeroSupportSweepPackageMetadata.packageId],
    stochasticNotes: [
      "No live side effects; all support actions remain draft-only.",
    ],
  },
  runId: machine.runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: supportSweepSteps,
  verificationContract: {
    artifactRef:
      "artifact://aihero-support-sweep-test/run/verification-contract.json",
    contractId: "contract:aihero-support-sweep-test",
    hash,
    mediaType,
  },
  workItemId: machine.workItemId,
} satisfies DynamicWorkflowPlanDocument;

const createSupportSweepCartridgeAdapter = () => {
  const artifacts = createMemoryArtifactStore("aihero-support-sweep-test");
  const adapter = createArtifactBackedWorkflowCartridgeAdapter({
    artifacts,
    delegate: createAiHeroSupportSweepWorkflowNodeAdapter({
      artifacts,
      data: createIntegrationTestAiHeroSupportSweepAdapter(),
    }),
  });

  return { adapter, artifacts };
};

const executeAllSteps = async (input: {
  readonly adapter: WorkflowNodeAdapterPort;
}) => {
  const completedStepArtifactRefs: Record<string, string> = {};

  for (const currentStep of supportSweepSteps) {
    const dependencyArtifactRefs = Object.fromEntries(
      currentStep.dependsOn.flatMap((stepId) => {
        const artifactRef = completedStepArtifactRefs[stepId];

        return artifactRef === undefined ? [] : [[stepId, artifactRef]];
      })
    );
    const result = await input.adapter.execute({
      actor: integrationTestActor,
      completedStepArtifactRefs,
      dependencyArtifactRefs,
      machine,
      plan,
      step: currentStep,
    });
    if (result.status === "blocked") {
      throw new Error(result.blocker.message);
    }

    const [documentRef] = result.outputRefs;
    if (documentRef === undefined) {
      throw new Error(`Step ${currentStep.stepId} did not return output refs.`);
    }
    completedStepArtifactRefs[currentStep.stepId] = documentRef;
  }

  return completedStepArtifactRefs;
};

describe("AIHero support-sweep cartridge", () => {
  it("drives the full six-step shape end to end and captures HITL recommendations", async () => {
    const { adapter, artifacts } = createSupportSweepCartridgeAdapter();
    const refs = await executeAllSteps({ adapter });
    const recommendationsRef = refs["recommend-support-actions"];
    const draftsRef = refs["draft-support-side-effects"];
    if (recommendationsRef === undefined || draftsRef === undefined) {
      throw new Error("Expected recommendation and draft refs.");
    }

    const recommendations =
      AiHeroSupportSweepRecommendationDocumentSchema.parse(
        await artifacts.readJson({ artifactRef: recommendationsRef })
      );
    const drafts = AiHeroSupportSweepDraftSideEffectDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: draftsRef })
    );

    expect(recommendations.recommendationCount).toBeGreaterThan(0);
    expect(
      recommendations.recommendations.every(
        (recommendation) => recommendation.receiptTrail.length > 0
      )
    ).toBeTruthy();
    expect(drafts.draftActions).toHaveLength(
      recommendations.recommendationCount
    );
    expect(artifacts.records.size).toBeGreaterThanOrEqual(
      supportSweepSteps.length * 2
    );
  });

  it("keeps customer-private evidence out of artifact content", async () => {
    const { adapter, artifacts } = createSupportSweepCartridgeAdapter();
    const refs = await executeAllSteps({ adapter });
    const hydrationRef = refs["hydrate-selected-evidence"];
    if (hydrationRef === undefined) {
      throw new Error("Expected hydration ref.");
    }

    const hydration = AiHeroSupportSweepHydrationDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: hydrationRef })
    );
    const serializedArtifacts = JSON.stringify(
      [...artifacts.records.values()],
      null,
      2
    );

    expect(
      hydration.evidence.every(
        (evidence) =>
          !evidence.rawSupportThreadReturned &&
          !evidence.customerIdentifiersReturned
      )
    ).toBeTruthy();
    expect(serializedArtifacts).not.toContain(
      "/Users/joel/Code/badass-courses/aihero-support"
    );
    expect(serializedArtifacts).not.toMatch(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu
    );
    expect(serializedArtifacts).not.toContain("BEGIN PRIVATE KEY");
  });

  it("lease-gates every draft side effect and never submits live actions", async () => {
    const { adapter, artifacts } = createSupportSweepCartridgeAdapter();
    const refs = await executeAllSteps({ adapter });
    const draftsRef = refs["draft-support-side-effects"];
    if (draftsRef === undefined) {
      throw new Error("Expected draft side-effects ref.");
    }

    const drafts = AiHeroSupportSweepDraftSideEffectDocumentSchema.parse(
      await artifacts.readJson({ artifactRef: draftsRef })
    );

    expect(drafts.submitted).toBeFalsy();
    expect(drafts.privateReviewSurface).toStrictEqual({
      noindex: true,
      privacyTier: "customer-private",
      submitted: false,
    });
    expect(
      drafts.draftActions.every(
        (action) =>
          !action.submitted &&
          action.leaseGate.leaseRequired &&
          !action.leaseGate.leaseGranted &&
          action.leaseGate.reviewRequired
      )
    ).toBeTruthy();
  });
});
