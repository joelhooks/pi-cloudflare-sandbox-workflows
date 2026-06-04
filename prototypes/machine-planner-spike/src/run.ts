/* eslint-disable func-style, no-use-before-define */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { planJob } from "./planner.ts";
import { PlannerReceiptSchema } from "./schema.ts";
import type {
  PlannedWorkflow,
  PlannerReceipt,
  PolicyCheck,
  RejectedPlan,
} from "./schema.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixtureDir = resolve(
  repoRoot,
  "prototypes/machine-planner-spike/fixtures"
);
const outPath = resolve(
  repoRoot,
  "prototypes/machine-planner-spike/out/latest-receipt.json"
);
const fixtureFiles = [
  "wzrrd-report.json",
  "github-pr.json",
  "artifact-only.json",
];
const unsafeFixture = "unsafe-machine-code.json";

async function main() {
  const plans: PlannedWorkflow[] = [];
  for (const fixtureFile of fixtureFiles) {
    const result = planJob(await readJson(resolve(fixtureDir, fixtureFile)));
    if (isRejected(result)) {
      throw new Error(
        `Expected ${fixtureFile} to plan, got rejection: ${result.reason}`
      );
    }
    plans.push(result);
  }

  const unsafeResult = planJob(
    await readJson(resolve(fixtureDir, unsafeFixture))
  );
  if (!isRejected(unsafeResult)) {
    throw new Error(
      "Unsafe machine code fixture planned successfully; expected rejection."
    );
  }

  const receipt = PlannerReceiptSchema.parse({
    checks: buildReceiptChecks(plans, unsafeResult),
    generatedAt: new Date().toISOString(),
    plans,
    prototype: "machine-planner-spike",
    question:
      "Can a planner turn a job spec into a validated lifecycle plan using a known pattern library, without executing arbitrary generated machine code?",
    rejected: [unsafeResult],
    schemaVersion: "machine-planner-receipt.v1",
  });
  assertAllChecksPassed(receipt);
  await writeJson(outPath, receipt);
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`wrote ${outPath}`);
}

function buildReceiptChecks(
  plans: PlannedWorkflow[],
  unsafeResult: RejectedPlan
): PolicyCheck[] {
  const githubPlan = requirePlan(plans, "github_pr");
  const wzrrdPlan = requirePlan(plans, "wzrrd_review");
  const artifactPlan = requirePlan(plans, "artifact_only");
  const allPlanPolicyChecks = plans.flatMap((plan) => plan.policyChecks);
  return [
    {
      id: "all-fixtures-planned",
      status: plans.length === 3 ? "passed" : "failed",
      summary:
        "Wzrrd report, GitHub PR, and artifact-only fixtures all planned successfully.",
    },
    {
      id: "generic-output-delivery-state",
      status: plans.every(
        (plan) => plan.machine.outputDeliveryState === "deliveringOutput"
      )
        ? "passed"
        : "failed",
      summary:
        "Every plan uses generic deliveringOutput state for target delivery.",
    },
    {
      id: "github-pr-no-wzrrd-state",
      status: githubPlan.machine.states.some((state) =>
        /wzrrd/iu.test(state.id)
      )
        ? "failed"
        : "passed",
      summary: "GitHub PR plan has no Wzrrd-specific state names.",
    },
    {
      id: "github-pr-token-policy",
      status: githubPlan.policyChecks.some(
        (check) =>
          check.id === "github-auth-managed-by-broker" &&
          check.status === "passed"
      )
        ? "passed"
        : "failed",
      summary:
        "GitHub PR plan manages bot/PAT tokens through GitHub App or broker policy, not raw values.",
    },
    {
      id: "wzrrd-static-site-target",
      status:
        wzrrdPlan.harness.steps.some(
          (step) => step.id === "build-sveltekit-static-html"
        ) &&
        wzrrdPlan.harness.steps.some((step) =>
          step.policy.includes("publish-to-wzrrd")
        )
          ? "passed"
          : "failed",
      summary:
        "Wzrrd output target plans a professional SvelteKit static HTML build and Wzrrd push.",
    },
    {
      id: "artifact-only-no-external-publish",
      status: artifactPlan.harness.steps.every(
        (step) =>
          !step.policy.includes("publish-to-wzrrd") &&
          step.targetKind !== "github_pr"
      )
        ? "passed"
        : "failed",
      summary:
        "Artifact-only plan has no external Wzrrd or GitHub publish step.",
    },
    {
      id: "unsafe-code-rejected",
      status:
        unsafeResult.rejectedUnsafeFields.length > 0 ? "passed" : "failed",
      summary:
        "Arbitrary machine TypeScript/code fixture is rejected before planning.",
    },
    {
      id: "policy-checks-pass",
      status: allPlanPolicyChecks.every((check) => check.status === "passed")
        ? "passed"
        : "failed",
      summary: "All per-plan policy checks passed.",
    },
  ];
}

function assertAllChecksPassed(receipt: PlannerReceipt) {
  const failed = [
    ...receipt.checks,
    ...receipt.plans.flatMap((plan) => plan.policyChecks),
  ].filter((check) => check.status !== "passed");
  if (failed.length > 0) {
    throw new Error(
      `Planner receipt had failed checks: ${JSON.stringify(failed, null, 2)}`
    );
  }
}

function isRejected(
  value: PlannedWorkflow | RejectedPlan
): value is RejectedPlan {
  return "reason" in value;
}

function requirePlan(
  plans: PlannedWorkflow[],
  targetKind: PlannedWorkflow["outputTarget"]["kind"]
): PlannedWorkflow {
  const plan = plans.find(
    (candidate) => candidate.outputTarget.kind === targetKind
  );
  if (!plan) {
    throw new Error(`Missing plan for ${targetKind}`);
  }
  return plan;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
