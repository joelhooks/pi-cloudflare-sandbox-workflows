import { describe, expect, it } from "vitest";

import type {
  ArtifactStoreContract,
  WorkflowNodeInvocationStep,
} from "../../src/app/application/ports.ts";
import {
  ArtifactRefSchema,
  WorkflowNodeTypeSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  ArtifactRef,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../src/app/domain/schemas.ts";
import { createMemoryArtifactStore } from "../../src/app/infrastructure/memory-adapters.ts";
import {
  MemoryHydrationDocumentSchema,
  MemorySearchDocumentSchema,
} from "../../src/cartridges/memory-fabric/schemas.ts";
import { createMemoryFabricWorkflowNodeAdapter } from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";
import { integrationTestActor } from "./workflow-app-fixtures.ts";

const at = "2026-06-14T05:33:46.030Z";
const hash = "b".repeat(64);
const mediaType = "application/json";
const runId = "run-live-20260614T053346030Z-574f20a6";
const workItemId = "work-item:memory-fabric-carrier-wound";
const namespace = "memory-fabric-carrier-wound";

const notFound = (artifactRef: ArtifactRef): Error => {
  const error = new Error(`Artifact not found: ${artifactRef}`);
  Object.defineProperty(error, "code", { value: "ENOENT" });

  return error;
};

const searchStep = {
  config: {
    maxHits: 5,
    query: "agent transcripts",
    sourceFamilies: ["agent-transcripts"],
  },
  dependsOn: [],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.search"),
  outputPath: "dream/search-agent-transcripts.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "search-agent-transcripts",
  summary: "Search agent transcripts.",
} satisfies WorkflowNodeInvocationStep;

const hydrateStep = {
  config: {
    searchRef: ArtifactRefSchema.parse(
      `artifact://${namespace}/runs/${runId}/dream/planner-declared-search.json`
    ),
    searchStepId: searchStep.stepId,
  },
  dependsOn: [searchStep.stepId],
  inputRefs: [],
  kind: "workflow.node.invoke",
  nodeType: WorkflowNodeTypeSchema.parse("joelclaw.memory.hydrate"),
  outputPath: "dream/hydrate-agent-transcripts.json",
  packageRefs: ["artifact://packages/workflows/memory-fabric/refs/v1"],
  stepId: "hydrate-agent-transcripts",
  summary: "Hydrate agent transcript receipts.",
} satisfies WorkflowNodeInvocationStep;

const machine = {
  createdAt: at,
  machineId: "machine:memory-fabric-carrier-wound",
  planner: {
    kind: "stochastic",
    nonce: "nonce:memory-fabric-carrier-wound",
    source: "integration-test",
  },
  runId,
  schemaVersion: "workflow.xstate-machine.v1",
  stepOrder: [searchStep.stepId, hydrateStep.stepId],
  workItemId,
  xstate: {
    id: "memory-fabric-carrier-wound",
    initial: "search",
    states: {
      done: {
        meta: {},
        on: {},
        type: "final",
      },
      hydrate: {
        meta: {
          stepId: hydrateStep.stepId,
          stepKind: hydrateStep.kind,
          summary: hydrateStep.summary,
        },
        on: {
          STEP_DONE: {
            target: "done",
          },
        },
      },
      search: {
        meta: {
          stepId: searchStep.stepId,
          stepKind: searchStep.kind,
          summary: searchStep.summary,
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
    artifactRef: `artifact://${namespace}/runs/${runId}/workflows/harness.ts`,
    entrypoint: "workflows/harness.ts",
    harnessId: "harness:memory-fabric-carrier-wound",
    hash,
    language: "typescript",
  },
  machine: {
    artifactRef: `artifact://${namespace}/runs/${runId}/workflows/machine.config.json`,
    hash,
    machineId: machine.machineId,
    sourceArtifactRef: `artifact://${namespace}/runs/${runId}/workflows/machine.ts`,
    sourceHash: hash,
  },
  outputTarget: {
    kind: "artifact-only",
    path: "review/summary.json",
  },
  pinnedPackages: [],
  planId: "plan:memory-fabric-carrier-wound",
  planner: machine.planner,
  plannerLane: {
    kind: "planner",
    laneId: "lane:planner",
    outputPins: [],
    outputRefs: [],
    prompt: {
      artifactRef: `artifact://${namespace}/runs/${runId}/planner/prompt.md`,
      hash,
      mediaType: "text/markdown",
    },
    realAgent: false,
    receiptRef: `artifact://${namespace}/runs/${runId}/planner/receipt.json`,
    redacted: true,
    runtime: "integration-test",
    startedAt: at,
    status: "completed",
    transcript: {
      artifactRef: `artifact://${namespace}/runs/${runId}/planner/transcript.md`,
      hash,
      mediaType: "text/markdown",
    },
  },
  proposal: {
    intent: "Reproduce the memory-fabric hydrate carrier wound.",
    requestedPackageIds: ["workflow/memory-fabric"],
    stochasticNotes: ["Planner refs can be plausible but unwritten."],
  },
  runId,
  safety: {
    capabilityLeasesRequired: true,
    durableState: "artifacts-d1-do-r2-only",
    scratchOnly: true,
  },
  schemaVersion: "workflow.dynamic-plan.v1",
  sideEffects: [],
  steps: [searchStep, hydrateStep],
  verificationContract: {
    artifactRef: `artifact://${namespace}/runs/${runId}/run/verification-contract.json`,
    contractId: "contract:memory-fabric-carrier-wound",
    hash,
    mediaType,
  },
  workItemId,
} satisfies DynamicWorkflowPlanDocument;

const receipt = {
  artifactRef: `artifact://${namespace}/runs/${runId}/receipts/agent-transcript-1.json`,
  family: "agent-transcripts",
  hash,
  receiptId: "receipt:agent-transcript:1",
  redactedLocator: "redacted://agent-transcript/1",
  runtime: "pi",
  sourceId: "source:agent-transcripts",
  timestamp: at,
} as const;

const searchDocument = MemorySearchDocumentSchema.parse({
  generatedAt: at,
  hits: [
    {
      horizon: "7d",
      receipts: [receipt],
      redactedExcerpt: "Redacted transcript excerpt.",
      score: 0.91,
      summary: "A completed agent transcript search hit.",
    },
  ],
  query: "agent transcripts",
  redacted: true,
  runId,
  schemaVersion: "memory.search.v1",
  workItemId,
});

const hydrationDocument = MemoryHydrationDocumentSchema.parse({
  generatedAt: at,
  hydrated: [
    {
      evidenceRef: receipt.artifactRef,
      fullTranscriptReturned: false,
      receipt,
      redactedExcerpt: "Hydrated redacted transcript excerpt.",
      summary: "Hydrated transcript summary.",
    },
  ],
  redacted: true,
  runId,
  schemaVersion: "memory.hydration.v1",
  workItemId,
});

const dependencySearchRef = ArtifactRefSchema.parse(
  `artifact://${namespace}/runs/${runId}/dream/dependency-declared-search.json`
);
const completedSearchRef = ArtifactRefSchema.parse(
  `artifact://${namespace}/runs/${runId}/dream/real-search-agent-transcripts.json`
);

const hostileArtifactStore = (
  input: {
    readonly blockedRefs?: ReadonlySet<ArtifactRef>;
    readonly documents?: ReadonlyMap<ArtifactRef, unknown>;
    readonly throwForEveryRead?: boolean;
  } = {}
): {
  readonly artifacts: ArtifactStoreContract;
  readonly readAttempts: readonly ArtifactRef[];
} => {
  const base = createMemoryArtifactStore(namespace);
  const readAttempts: ArtifactRef[] = [];
  const documents = input.documents ?? new Map<ArtifactRef, unknown>();
  for (const [artifactRef, document] of documents) {
    base.setJson(artifactRef, document);
  }

  return {
    artifacts: {
      artifactRef: (artifactInput) => base.artifactRef(artifactInput),
      readJson(readInput) {
        readAttempts.push(readInput.artifactRef);
        if (
          input.throwForEveryRead === true ||
          input.blockedRefs?.has(readInput.artifactRef) === true
        ) {
          return Promise.reject(notFound(readInput.artifactRef));
        }

        return base.readJson(readInput);
      },
      readText: (readInput) => base.readText(readInput),
      writeJson: (writeInput) => base.writeJson(writeInput),
      writeText: (writeInput) => base.writeText(writeInput),
    },
    readAttempts,
  };
};

const executeHydrate = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly completedStepArtifactRefs?: Readonly<Record<string, ArtifactRef>>;
  readonly dependencyArtifactRefs?: Readonly<Record<string, ArtifactRef>>;
  readonly step?: WorkflowNodeInvocationStep;
}) =>
  createMemoryFabricWorkflowNodeAdapter({
    artifacts: input.artifacts,
    memoryRetrieval: {
      hydrateMemories(payload) {
        expect(payload.receipts).toStrictEqual([receipt]);

        return Promise.resolve({
          document: hydrationDocument,
          status: "ready",
        });
      },
      searchMemories() {
        throw new Error("Search node should not run in hydrate tests.");
      },
    },
  }).execute({
    actor: integrationTestActor,
    completedStepArtifactRefs: input.completedStepArtifactRefs ?? {},
    dependencyArtifactRefs: input.dependencyArtifactRefs ?? {},
    machine,
    plan,
    step: input.step ?? hydrateStep,
  });

describe("memory-fabric workflow node adapter carrier wound hardening", () => {
  it("recovers hydrate search loading when planner-declared refs are not found but the completed upstream search output is readable", async () => {
    const blockedRefs = new Set<ArtifactRef>([
      hydrateStep.config.searchRef,
      dependencySearchRef,
    ]);
    const { artifacts, readAttempts } = hostileArtifactStore({
      blockedRefs,
      documents: new Map([[completedSearchRef, searchDocument]]),
    });

    const result = await executeHydrate({
      artifacts,
      completedStepArtifactRefs: {
        [searchStep.stepId]: completedSearchRef,
      },
      dependencyArtifactRefs: {
        [searchStep.stepId]: dependencySearchRef,
      },
    });

    expect(result.status).toBe("executed");
    expect(readAttempts).toStrictEqual([
      hydrateStep.config.searchRef,
      dependencySearchRef,
      completedSearchRef,
    ]);
  });

  it("names schema_mismatch with a zod path when the search artifact bytes load but fail the search document contract", async () => {
    const invalidSearch = {
      ...searchDocument,
      hits: [
        {
          ...searchDocument.hits[0],
          score: "not-a-number",
        },
      ],
    };
    const schemaMismatchRef = ArtifactRefSchema.parse(
      `artifact://${namespace}/runs/${runId}/dream/schema-mismatch-search.json`
    );
    const { artifacts } = hostileArtifactStore({
      documents: new Map([[schemaMismatchRef, invalidSearch]]),
    });

    const result = await executeHydrate({
      artifacts,
      step: {
        ...hydrateStep,
        config: {
          searchRef: schemaMismatchRef,
        },
      },
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.blocker.code).toBe("stale_package");
    expect(result.blocker.message).toContain("cause: schema_mismatch");
    expect(result.blocker.message).toContain("zod_path: hits.0.score");
    expect(result.blocker.message).not.toContain("not-a-number");
  });

  it("names not_found when every hydrate search candidate fails to resolve", async () => {
    const { artifacts } = hostileArtifactStore({
      throwForEveryRead: true,
    });

    const result = await executeHydrate({
      artifacts,
      completedStepArtifactRefs: {
        [searchStep.stepId]: completedSearchRef,
      },
      dependencyArtifactRefs: {
        [searchStep.stepId]: dependencySearchRef,
      },
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") {
      return;
    }
    expect(result.blocker.code).toBe("stale_package");
    expect(result.blocker.message).toContain("cause: not_found");
    expect(result.blocker.message).toContain(
      "ref_tail: real-search-agent-transcripts.json"
    );
  });
});
