import { getPatternDefinition, PATTERN_LIBRARY } from "./patterns.ts";
import {
  HarnessPlanSchema,
  JobSpecSchema,
  PlannedMachineSchema,
  PlannedWorkflowSchema,
  VerificationContractPlanSchema,
} from "./schema.ts";
import type {
  HarnessPlan,
  JobSpec,
  OutputTarget,
  PlannedMachine,
  PlannedWorkflow,
  PolicyCheck,
  RejectedPlan,
  VerificationContractPlan,
  WorkflowPattern,
} from "./schema.ts";

const CODE_FIELD_NAMES = new Set([
  "code",
  "eval",
  "functionBody",
  "machineCode",
  "machineTs",
  "requestedMachineCode",
  "script",
]);

const CODE_STRING_PATTERNS = [
  /[=]>/u,
  /\bfunction\b/u,
  /\bimport\b/u,
  /\beval\s*\(/u,
  /\bprocess\./u,
  /\brequire\s*\(/u,
];
const SECRETISH_KEY_PATTERN =
  /(?:password|token|secret|api[_-]?key|refresh[_-]?token)/iu;
const WZRRD_STATE_PATTERN = /wzrrd/iu;

const walk = (
  value: unknown,
  path: string[],
  visit: (path: string[], value: unknown) => void
): void => {
  visit(path, value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walk(item, [...path, String(index)], visit);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      walk(child, [...path, key], visit);
    }
  }
};

const issuePaths = (issues: { path: PropertyKey[] }[]): string[] =>
  issues.map((issue) => issue.path.join(".")).filter((path) => path.length > 0);

const readMaybeWorkItemId = (input: unknown): string | undefined => {
  if (input && typeof input === "object" && "workItemId" in input) {
    const value = input.workItemId;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
};

const detectUnsafeFields = (input: unknown): string[] => {
  const findings: string[] = [];
  walk(input, [], (path, value) => {
    const key = path.at(-1);
    if (key && CODE_FIELD_NAMES.has(key)) {
      findings.push(path.join("."));
      return;
    }
    if (
      typeof value === "string" &&
      CODE_STRING_PATTERNS.some((pattern) => pattern.test(value))
    ) {
      findings.push(path.join(".") || "<root>");
    }
  });
  return [...new Set(findings)].toSorted();
};

const findPlaintextSecretFields = (value: unknown): string[] => {
  const findings: string[] = [];
  walk(value, [], (path, leaf) => {
    const key = path.at(-1) ?? "";
    if (!SECRETISH_KEY_PATTERN.test(key)) {
      return;
    }
    if (/^[A-Z0-9_]+$/u.test(key)) {
      return;
    }
    if (["secretRefs", "secretRef"].includes(key)) {
      return;
    }
    if (typeof leaf === "string" && leaf.length > 0) {
      findings.push(path.join("."));
    }
  });
  return findings;
};

const check = (id: string, passed: boolean, summary: string): PolicyCheck => ({
  id,
  status: passed ? "passed" : "failed",
  summary,
});

const statusPolicy = () => ({
  blocked: "blocked" as const,
  needsHumanReview: "needs_human_review" as const,
  verified: "verified" as const,
  warnings: "warnings" as const,
});

const firstWorkState = (pattern: WorkflowPattern): string => {
  if (pattern === "edit_verify_pr") {
    return "runningEditLane";
  }
  if (pattern === "fanout_synthesis") {
    return "runningFanout";
  }
  if (pattern === "generate_filter") {
    return "generatingCandidates";
  }
  return "runningPrimaryLane";
};

const tagsForState = (state: string): string[] => {
  const tags: string[] = [];
  if (state.includes("Verifier") || state === "evaluatingVerification") {
    tags.push("verification");
  }
  if (state === "deliveringOutput") {
    tags.push("output-target");
  }
  if (state === "destroyingSandbox" || state === "cancelling") {
    tags.push("cleanup");
  }
  return tags;
};

const nextLinearTransition = (state: string): Record<string, string> =>
  state === "planning" ? { PLAN_PINNED: "resolvingContext" } : {};

const buildTransitionsForState = (
  state: string,
  pattern: WorkflowPattern
): Record<string, string> => {
  const cancel =
    state === "destroyingSandbox" ? {} : { CANCEL_REQUESTED: "cancelling" };
  const transitions: Record<string, string> =
    {
      cancelling: { SANDBOX_DESTROYED: "cancelled" },
      capturingArtifacts: { ARTIFACTS_CAPTURED: "runningVerifier" },
      deliveringOutput: { OUTPUT_DELIVERED: "destroyingSandbox" },
      destroyingSandbox: { SANDBOX_DESTROYED: "captured" },
      evaluatingVerification: {
        NEEDS_HUMAN_REVIEW:
          pattern === "human_review_gate" ? "waitingHumanReview" : "blocked",
        VERIFICATION_BLOCKED: "blocked",
        VERIFICATION_VERIFIED: "deliveringOutput",
        VERIFICATION_WARNINGS: "deliveringOutput",
      },
      filteringCandidates: { FILTER_DONE: "runningVerifier" },
      generatingCandidates: { CANDIDATES_GENERATED: "filteringCandidates" },
      materializingSecrets: { SECRETS_MATERIALIZED: "preparingWorkspace" },
      planning: { PLAN_PINNED: "resolvingContext" },
      preparingWorkspace: { WORKSPACE_PREPARED: firstWorkState(pattern) },
      resolvingContext: { CONTEXT_RESOLVED: "materializingSecrets" },
      runningEditLane: { EDIT_LANE_DONE: "runningTests" },
      runningFanout: { FANOUT_DONE: "synthesizingResults" },
      runningPrimaryLane: {
        PRIMARY_LANE_DONE:
          pattern === "artifact_only_capture"
            ? "capturingArtifacts"
            : "runningVerifier",
      },
      runningTests: { TESTS_DONE: "runningVerifier" },
      runningVerifier: { VERIFIER_DONE: "evaluatingVerification" },
      synthesizingResults: { SYNTHESIS_DONE: "runningVerifier" },
      waitingHumanReview: {
        HUMAN_APPROVED: "deliveringOutput",
        HUMAN_REJECTED: "blocked",
      },
    }[state] ?? nextLinearTransition(state);

  return state === "cancelling" ? transitions : { ...cancel, ...transitions };
};

const buildMachine = (
  pattern: WorkflowPattern,
  outputTarget: OutputTarget
): PlannedMachine => {
  const definition = getPatternDefinition(pattern);
  const stateIds = [
    ...new Set([...definition.requiredStates, "cancelling"]),
  ].filter((state) => state !== "cancelled");
  stateIds.push("cancelled");
  const states = stateIds.map((id) => {
    if (id === "captured" || id === "blocked" || id === "cancelled") {
      return { id, kind: "final" as const, on: {}, tags: [] };
    }

    return {
      id,
      kind: "normal" as const,
      on: buildTransitionsForState(id, pattern),
      tags: tagsForState(id),
    };
  });
  const events = [
    ...new Set(states.flatMap((state) => Object.keys(state.on))),
  ].toSorted();

  return PlannedMachineSchema.parse({
    cancellationEvent: "CANCEL_REQUESTED",
    contextKeys: [
      "workItemId",
      "contextPackRefs",
      "secretRefs",
      "verificationContract",
      "outputTarget",
    ],
    events,
    id: `${pattern}:${outputTarget.kind}`,
    initial: "planning",
    outputDeliveryState: "deliveringOutput",
    receiptOnly: true,
    states,
    xstateVersion: "v5",
  });
};

const buildHarness = (
  pattern: WorkflowPattern,
  jobSpec: JobSpec
): HarnessPlan => {
  const steps: Record<string, unknown>[] = [
    {
      id: "resolve-context-packs",
      inputs: jobSpec.contextPackRefs,
      kind: "resolve-context",
      outputs: ["run/context-pack-selection.json"],
      policy: ["pin-context-before-sandbox"],
    },
    {
      id: "materialize-secret-refs",
      inputs: jobSpec.secretRefs,
      kind: "materialize-secret-ref",
      outputs: ["run/secret-leases.json"],
      policy: ["refs-only", "task-scoped-materialization"],
    },
    {
      id: "prepare-workspace",
      kind: "prepare-workspace",
      outputs: ["run/manifest.json", "workflows/machine.json"],
      policy: ["receipt-only-machine", "no-runtime-generated-code"],
    },
  ];

  if (pattern === "edit_verify_pr") {
    steps.push(
      {
        id: "edit-repository-lane",
        kind: "run-pi-lane",
        outputs: [
          "artifacts/patch.diff",
          "artifacts/implementation-summary.md",
        ],
        policy: ["single-writer", "branch-from-base"],
      },
      {
        id: "run-tests",
        kind: "run-tests",
        outputs: ["artifacts/test-results.json"],
        policy: ["tests-required-before-pr"],
      }
    );
  } else if (pattern === "fanout_synthesis") {
    steps.push({
      id: "bounded-fanout-and-synthesis",
      kind: "run-pi-lane",
      outputs: ["artifacts/source-slices.json", "artifacts/synthesis.md"],
      policy: ["concurrency-cap", "fan-in-before-verification"],
    });
  } else if (pattern === "generate_filter") {
    steps.push({
      id: "generate-and-filter-candidates",
      kind: "run-pi-lane",
      outputs: ["artifacts/candidates.json", "artifacts/selected-output.md"],
      policy: ["candidate-receipts", "filter-before-delivery"],
    });
  } else {
    steps.push({
      id: "primary-lane",
      kind: "run-pi-lane",
      outputs: ["artifacts/report.md", "artifacts/sources.json"],
      policy: ["bounded-run"],
    });
  }

  steps.push({
    id: "verify-output",
    kind: "verify-output",
    outputs: ["artifacts/verification/result.json"],
    policy: [`contract:${jobSpec.verificationContract}`],
  });

  if (jobSpec.outputTarget.kind === "wzrrd_review") {
    steps.push(
      {
        id: "build-sveltekit-static-html",
        kind: "deliver-output",
        outputs: ["artifacts/output-target/wzrrd/site/index.html"],
        policy: ["professional-clean-style", "static-html-only"],
        targetKind: "wzrrd_review",
      },
      {
        id: "push-output-target",
        kind: "deliver-output",
        outputs: ["run/output-target-receipt.json"],
        policy: ["publish-to-wzrrd", "claim-url-private"],
        targetKind: "wzrrd_review",
      }
    );
  } else if (jobSpec.outputTarget.kind === "github_pr") {
    steps.push({
      id: "deliver-github-pr",
      kind: "deliver-output",
      outputs: ["run/output-target-receipt.json"],
      policy: [
        "github-app-installation-preferred",
        "pat-only-through-secret-broker",
        "no-raw-pat",
        "commit-as-shitratgit",
      ],
      targetKind: "github_pr",
    });
  } else {
    steps.push({
      id: "deliver-output-target",
      kind: "deliver-output",
      outputs: ["run/output-target-receipt.json"],
      policy: [`target-kind:${jobSpec.outputTarget.kind}`],
      targetKind: jobSpec.outputTarget.kind,
    });
  }

  steps.push({
    id: "cleanup-sandbox",
    kind: "cleanup",
    outputs: ["run/destroy-receipt.json"],
    policy: ["destroy-or-sleep-after-commit"],
  });

  return HarnessPlanSchema.parse({ generatedCodeRuntime: "none", steps });
};

const buildVerificationContract = (
  jobSpec: JobSpec
): VerificationContractPlan => {
  if (jobSpec.verificationContract === "tests-pass-and-diff-reviewed") {
    return VerificationContractPlanSchema.parse({
      criteria: [
        {
          id: "tests-pass",
          severity: "blocking",
          summary: "Configured tests must pass before PR delivery.",
        },
        {
          id: "diff-reviewed",
          severity: "blocking",
          summary: "Generated diff must be reviewed against requested scope.",
        },
      ],
      id: jobSpec.verificationContract,
      statusPolicy: statusPolicy(),
    });
  }

  if (jobSpec.verificationContract === "artifact-presence-v1") {
    return VerificationContractPlanSchema.parse({
      criteria: [
        {
          id: "required-artifacts-present",
          severity: "blocking",
          summary: "Required artifact refs must exist before capture.",
        },
      ],
      id: jobSpec.verificationContract,
      statusPolicy: statusPolicy(),
    });
  }

  return VerificationContractPlanSchema.parse({
    criteria: [
      {
        id: "source-grounding",
        severity: "blocking",
        summary: "Visible claims must cite source artifacts or source URLs.",
      },
      {
        id: "output-target-readable",
        severity: "warning",
        summary:
          "Delivered output should be cleanly formatted for the requested target.",
      },
    ],
    id: jobSpec.verificationContract,
    statusPolicy: statusPolicy(),
  });
};

const validatePlan = (plan: PlannedWorkflow): PolicyCheck[] => {
  const stateIds = new Set(plan.machine.states.map((state) => state.id));
  const definition = PATTERN_LIBRARY[plan.pattern];
  const serializedPlan = JSON.stringify(plan);
  const checks: PolicyCheck[] = [
    check(
      "allowed-pattern",
      Boolean(definition),
      `Selected pattern ${plan.pattern} is in the allowed pattern library.`
    ),
    check(
      "target-supported-by-pattern",
      definition.supportedTargets.includes(plan.outputTarget.kind),
      `Pattern ${plan.pattern} supports output target ${plan.outputTarget.kind}.`
    ),
    check(
      "secret-refs-only",
      plan.jobSpec.secretRefs.every((secretRef) =>
        /^[a-zA-Z][a-zA-Z0-9:_-]*$/u.test(secretRef)
      ),
      "Secret inputs stay as stable refs, not secret values."
    ),
    check(
      "no-plaintext-secret-fields",
      findPlaintextSecretFields(plan).length === 0,
      "Planned output contains no plaintext secret-shaped fields."
    ),
    check(
      "required-states-exist",
      [
        "resolvingContext",
        "materializingSecrets",
        firstWorkState(plan.pattern),
        "runningVerifier",
        "evaluatingVerification",
        "deliveringOutput",
        "destroyingSandbox",
      ].every((state) => stateIds.has(state)),
      "Machine includes context, secret materialization, work, verification, delivery, and cleanup states."
    ),
    check(
      "cancellation-path-exists",
      plan.machine.events.includes("CANCEL_REQUESTED") &&
        stateIds.has("cancelled"),
      "Machine includes cancellation event and cancelled final state."
    ),
    check(
      "no-arbitrary-code-strings",
      !CODE_STRING_PATTERNS.some((pattern) => pattern.test(serializedPlan)),
      "Machine config/harness plan are JSON-like receipts, not executable code."
    ),
    check(
      "generic-output-state",
      plan.machine.outputDeliveryState === "deliveringOutput" &&
        stateIds.has("deliveringOutput"),
      "Output delivery is modeled with generic deliveringOutput state."
    ),
    check(
      "wzrrd-not-hardcoded-state",
      plan.outputTarget.kind === "wzrrd_review" ||
        ![...stateIds].some((state) => WZRRD_STATE_PATTERN.test(state)),
      "Non-Wzrrd targets have no Wzrrd-specific state names."
    ),
  ];

  if (plan.outputTarget.kind === "github_pr") {
    const policies = new Set(plan.harness.steps.flatMap((step) => step.policy));
    checks.push(
      check(
        "github-auth-managed-by-broker",
        plan.jobSpec.secretRefs.includes("githubAppInstallation") &&
          policies.has("github-app-installation-preferred") &&
          policies.has("no-raw-pat") &&
          policies.has("commit-as-shitratgit"),
        "GitHub PR delivery uses GitHub App/PAT-through-broker policy and ShitRat commit actor."
      )
    );
  }

  if (plan.outputTarget.kind === "wzrrd_review") {
    checks.push(
      check(
        "wzrrd-target-builds-static-site",
        plan.harness.steps.some(
          (step) => step.id === "build-sveltekit-static-html"
        ) &&
          plan.harness.steps.some((step) =>
            step.policy.includes("publish-to-wzrrd")
          ),
        "Wzrrd target plans a clean SvelteKit static HTML build and Wzrrd publish step."
      )
    );
  }

  return checks;
};

export const selectPattern = (jobSpec: JobSpec): WorkflowPattern => {
  if (jobSpec.outputTarget.kind === "github_pr") {
    return "edit_verify_pr";
  }
  if (jobSpec.outputTarget.kind === "artifact_only") {
    return "artifact_only_capture";
  }
  if (jobSpec.verificationContract.includes("human-review")) {
    return "human_review_gate";
  }
  const task = jobSpec.task.toLowerCase();
  if (task.includes("fan out")) {
    return "fanout_synthesis";
  }
  if (task.includes("generate") && task.includes("filter")) {
    return "generate_filter";
  }
  return "reader_verifier";
};

export const planJob = (input: unknown): PlannedWorkflow | RejectedPlan => {
  const unsafeFields = detectUnsafeFields(input);
  const parsed = JobSpecSchema.safeParse(input);
  if (!parsed.success) {
    return {
      reason: parsed.error.issues.map((issue) => issue.message).join("; "),
      rejectedUnsafeFields: [
        ...new Set([...unsafeFields, ...issuePaths(parsed.error.issues)]),
      ],
      workItemId: readMaybeWorkItemId(input),
    };
  }

  if (unsafeFields.length > 0) {
    return {
      reason: "Job spec tried to provide executable/generated code fields.",
      rejectedUnsafeFields: unsafeFields,
      workItemId: parsed.data.workItemId,
    };
  }

  const jobSpec = parsed.data;
  const pattern = selectPattern(jobSpec);
  const machine = buildMachine(pattern, jobSpec.outputTarget);
  const harness = buildHarness(pattern, jobSpec);
  const verification = buildVerificationContract(jobSpec);
  const basePlan = PlannedWorkflowSchema.parse({
    harness,
    jobSpec,
    machine,
    outputTarget: jobSpec.outputTarget,
    pattern,
    policyChecks: [
      { id: "placeholder", status: "passed", summary: "filled later" },
    ],
    rejectedUnsafeFields: [],
    verification,
  });
  const policyChecks = validatePlan({ ...basePlan, policyChecks: [] });
  return PlannedWorkflowSchema.parse({ ...basePlan, policyChecks });
};
