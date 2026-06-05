import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  buildReviewPage,
  createPrelaunchPlan,
  stringifyStableJson,
} from "./planner.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const prototypeDir = resolve(
  repoRoot,
  "prototypes/joelclaw-research-swarm-spike"
);
const fixturePath = resolve(
  prototypeDir,
  "fixtures/workflow-verifier-evals-task.json"
);
const outDir = resolve(prototypeDir, "out/latest-prelaunch");
const latestPlanPath = resolve(prototypeDir, "out/latest-prelaunch-plan.json");
const latestApprovalPath = resolve(
  prototypeDir,
  "out/latest-operator-approval.json"
);

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${stringifyStableJson(value)}\n`, "utf-8");
};

const writeText = async (path: string, value: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf-8");
};

const fixture = JSON.parse(await readFile(fixturePath, "utf-8")) as unknown;
const approve = process.env["JOELCLAW_SWARM_APPROVE"] === "1";
const plan = await createPrelaunchPlan(fixture, { approve });

await writeJson(
  resolve(outDir, "run/research-envelope.json"),
  plan.researchEnvelope
);
await writeJson(resolve(outDir, "workflows/machine.json"), plan.machine);
await writeJson(resolve(outDir, "workflows/harness.json"), plan.harness);
await writeJson(resolve(outDir, "run/source-policy.json"), plan.sourcePolicy);
await writeJson(
  resolve(outDir, "run/verification-contract.json"),
  plan.verificationContract
);
await writeJson(resolve(outDir, "run/theme-map.json"), plan.themeMap);
await writeJson(resolve(outDir, "run/operator-approval.json"), plan.approval);
await writeJson(latestPlanPath, plan);
await writeJson(latestApprovalPath, plan.approval);

const reviewPagePath = resolve(repoRoot, plan.reviewPagePath);
await writeText(reviewPagePath, buildReviewPage(plan));

console.log(
  JSON.stringify(
    {
      approval: plan.approval.decision,
      plannedHotResearchLanes: plan.themeMap.themes.length,
      reviewPagePath: plan.reviewPagePath,
      targetBrainPage: plan.researchEnvelope.targetBrainPage,
      themeIds: plan.themeMap.themes.map((theme) => theme.themeId),
      wrote: {
        approval: latestApprovalPath,
        plan: latestPlanPath,
        prelaunchDir: outDir,
      },
    },
    null,
    2
  )
);

if (!approve) {
  console.log(
    "Pending operator approval. Review the Brain page, then rerun with JOELCLAW_SWARM_APPROVE=1 to record hash-bound approval."
  );
}
