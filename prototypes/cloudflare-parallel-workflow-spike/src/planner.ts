import { buildMachineReceipt } from "./machine.ts";
import {
  HarnessPlanSchema,
  JobSpecSchema,
  ParallelPlanSchema,
  VerificationContractSchema,
} from "./schema.ts";
import type {
  HarnessPlan,
  JobSpec,
  LanePlan,
  ParallelPlan,
  PolicyCheck,
} from "./schema.ts";

const LANE_TOPICS = [
  {
    laneId: "cloudflare-primitives",
    role: "researcher" as const,
    topic:
      "Cloudflare Workers, Durable Objects, Queues, Sandbox, and Artifacts primitive map",
  },
  {
    laneId: "xstate-machines",
    role: "researcher" as const,
    topic:
      "XState v5 state machine shape, event names, snapshots, cancellation, and fan-in states",
  },
  {
    laneId: "secret-leases",
    role: "scout" as const,
    topic:
      "Secret reference to task-scoped auth materialization and no plaintext secret receipts",
  },
  {
    laneId: "artifact-memory",
    role: "researcher" as const,
    topic:
      "Artifacts-backed plan, lane, synthesis, verifier, and output receipt storage",
  },
  {
    laneId: "output-targets",
    role: "scout" as const,
    topic:
      "Generic output target delivery, especially implementation_plan without Wzrrd-as-core language",
  },
  {
    laneId: "failure-backpressure",
    role: "researcher" as const,
    topic:
      "Queue retries, lane degradation, bounded hot concurrency, and supervisor admission/backpressure",
  },
  {
    laneId: "queue-do-admission",
    role: "scout" as const,
    topic:
      "Queue consumer asks Durable Object for lane slot admission and requeues when cap is full",
  },
  {
    laneId: "sandbox-artifacts",
    role: "researcher" as const,
    topic:
      "Cloudflare Sandbox lane execution and Git push to Cloudflare Artifacts",
  },
];

const buildLanePrompt = (jobSpec: JobSpec, topic: string): string =>
  [
    `Task: ${jobSpec.task}`,
    `Lane topic: ${topic}`,
    "Return concise implementation-plan notes with concrete Cloudflare primitive implications.",
    "Use the pinned dynamic workflow scale catalog context ref as the source seed.",
    "Do not claim infinite hot concurrency. Say bounded hot concurrency.",
  ].join("\n");

const buildLanes = (jobSpec: JobSpec): LanePlan[] => {
  const requested = LANE_TOPICS.slice(0, jobSpec.parallel.plannedLaneCount);
  const required = new Set(jobSpec.parallel.fanIn.requiredLaneIds);
  return requested.map((lane) => ({
    inputRef: `run/lane-inputs/${lane.laneId}.json`,
    laneId: lane.laneId,
    prompt: buildLanePrompt(jobSpec, lane.topic),
    required: required.has(lane.laneId),
    role: lane.role,
    topic: lane.topic,
  }));
};

const buildHarness = (jobSpec: JobSpec, lanes: LanePlan[]): HarnessPlan =>
  HarnessPlanSchema.parse({
    executionSubstrate:
      "cloudflare-worker-durable-object-queue-sandbox-artifacts",
    generatedCodeRuntime: "none",
    steps: [
      {
        id: "generate-and-validate-plan",
        kind: "plan",
        outputs: ["run/plan.json", "workflows/machine.json"],
        policy: ["known-pattern-library", "no-generated-typescript-exec"],
      },
      {
        id: "commit-plan-artifacts",
        kind: "commit-plan-artifacts",
        outputs: [
          "run/plan.json",
          "workflows/machine.json",
          "workflows/harness.json",
          "run/verification-contract.json",
          "run/manifest.json",
        ],
        policy: ["pin-before-lane-sandbox"],
      },
      {
        id: "enqueue-lanes",
        kind: "enqueue-lanes",
        outputs: lanes.map((lane) => `queue:${lane.laneId}`),
        policy: ["cloudflare-queue", "at-least-once", "idempotent-lanes"],
      },
      {
        id: "admit-lanes",
        kind: "admit-lane",
        outputs: ["run/admission-log.jsonl"],
        policy: [
          `concurrency-cap:${jobSpec.parallel.concurrencyCap}`,
          "durable-object-supervisor",
        ],
      },
      {
        id: "run-sandbox-lanes",
        kind: "run-sandbox-lane",
        outputs: lanes.map(
          (lane) => `artifacts/lanes/${lane.laneId}/receipt.json`
        ),
        policy: ["real-cloudflare-sandbox", "artifacts-git-push"],
      },
      {
        id: "fan-in",
        kind: "fan-in",
        outputs: ["artifacts/synthesis/fan-in.json"],
        policy: [
          `fan-in:${jobSpec.parallel.fanIn.strategy}`,
          "required-lanes-before-synthesis",
        ],
      },
      {
        id: "synthesize-results",
        kind: "synthesize",
        outputs: ["artifacts/synthesis/implementation-plan.md"],
        policy: ["real-cloudflare-sandbox"],
      },
      {
        id: "verify-synthesis",
        kind: "verify",
        outputs: ["artifacts/verification/result.json"],
        policy: [`contract:${jobSpec.verificationContract}`],
      },
      {
        id: "deliver-implementation-plan",
        kind: "deliver-output",
        outputs: ["artifacts/output-target/implementation-plan/receipt.json"],
        policy: ["output-target:implementation_plan"],
      },
      {
        id: "cleanup-sandboxes",
        kind: "cleanup",
        outputs: ["run/cleanup-receipts.json"],
        policy: ["destroy-active-sandboxes"],
      },
    ],
  });

const buildVerificationContract = (jobSpec: JobSpec) =>
  VerificationContractSchema.parse({
    criteria: [
      {
        id: "required-lane-outputs-present",
        severity: "blocking",
        summary:
          "Every required fan-in lane must commit a lane receipt and report before synthesis.",
        type: "lane-output-presence",
      },
      {
        id: "synthesis-output-present",
        severity: "blocking",
        summary: "Synthesis sandbox must commit implementation-plan.md.",
        type: "synthesis-presence",
      },
      {
        id: "fan-in-policy-satisfied",
        severity: "blocking",
        summary: `Fan-in policy ${jobSpec.parallel.fanIn.strategy} must be satisfied before verifier runs.`,
        type: "fan-in-policy",
      },
      {
        id: "verification-report-present",
        severity: "blocking",
        summary: "Verifier sandbox must commit a verification result artifact.",
        type: "verification-report-presence",
      },
    ],
    id: jobSpec.verificationContract,
    statusPolicy: {
      blocked: "blocked",
      verified: "verified",
      warnings: "warnings",
    },
  });

const check = (id: string, passed: boolean, summary: string): PolicyCheck => ({
  id,
  status: passed ? "passed" : "failed",
  summary,
});

const buildPolicyChecks = (
  jobSpec: JobSpec,
  lanes: LanePlan[],
  machineStateIds: Set<string>
): PolicyCheck[] => [
  check(
    "pattern-selected-fanout-synthesis",
    true,
    "Planner selected fanout_synthesis from the known pattern library."
  ),
  check(
    "lane-count-exceeds-concurrency-cap",
    lanes.length > jobSpec.parallel.concurrencyCap,
    "Planned lanes exceed hot concurrency cap, proving backpressure is required."
  ),
  check(
    "required-lanes-exist",
    jobSpec.parallel.fanIn.requiredLaneIds.every((laneId) =>
      lanes.some((lane) => lane.laneId === laneId)
    ),
    "Every required fan-in lane id exists in the planned lane set."
  ),
  check(
    "cloudflare-real-substrate",
    true,
    "Harness uses Worker + Durable Object + Queue + Sandbox + Artifacts."
  ),
  check(
    "machine-has-parallel-lifecycle",
    [
      "admittingLanes",
      "enqueueingLaneJobs",
      "runningFanoutLanes",
      "waitingFanIn",
      "synthesizingResults",
      "runningVerifier",
      "deliveringOutput",
      "destroyingSandboxes",
      "cancelled",
    ].every((state) => machineStateIds.has(state)),
    "Machine includes lane admission, queueing, fanout, fan-in, synthesis, verifier, delivery, cleanup, and cancel states."
  ),
  check(
    "no-wzrrd-state",
    ![...machineStateIds].some((state) => /wzrrd/iu.test(state)),
    "Implementation-plan output has no Wzrrd-specific lifecycle state."
  ),
];

export const createParallelPlan = (input: unknown): ParallelPlan => {
  const jobSpec = JobSpecSchema.parse(input);
  const lanes = buildLanes(jobSpec);
  const machine = buildMachineReceipt(jobSpec);
  const machineStateIds = new Set(machine.states.map((state) => state.id));
  const plan = ParallelPlanSchema.parse({
    generatedAt: new Date().toISOString(),
    harness: buildHarness(jobSpec, lanes),
    jobSpec,
    lanes,
    machine,
    outputTarget: jobSpec.outputTarget,
    pattern: "fanout_synthesis",
    policyChecks: buildPolicyChecks(jobSpec, lanes, machineStateIds),
    schemaVersion: "parallel-plan.v1",
    verification: buildVerificationContract(jobSpec),
  });

  const failed = plan.policyChecks.filter(
    (policy) => policy.status !== "passed"
  );
  if (failed.length > 0) {
    throw new Error(
      `Parallel plan failed policy checks: ${JSON.stringify(failed)}`
    );
  }

  return plan;
};
