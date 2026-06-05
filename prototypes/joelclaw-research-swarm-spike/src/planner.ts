import { buildMachineReceipt } from "./machine.ts";
import {
  HarnessPlanSchema,
  OperatorApprovalSchema,
  PrelaunchPlanSchema,
  ResearchEnvelopeSchema,
  ResearchTaskSchema,
  ScoutSearchReceiptSchema,
  SourcePolicySchema,
  ThemeMapSchema,
  VerificationContractSchema,
} from "./schema.ts";
import type {
  ArtifactHashBundle,
  HarnessPlan,
  OperatorApproval,
  PrelaunchPlan,
  ResearchEnvelope,
  ResearchTask,
  ScoutSearchReceipt,
  SourcePolicy,
  ThemeCandidate,
  VerificationContract,
} from "./schema.ts";

const JOELCLAW_SEARCH_BASE = "https://joelclaw.com/api/docs/search";
const DEFAULT_PER_PAGE = 5;

const SOURCE_POLICY_TEXT =
  "Use JoelClaw aggressively as Joel's personal research library. Public output may quote, analyze, compare, transform, and use ideas/patterns/principles under fair use with clear source receipts; do not make output a substitute for original works.";

const COVERAGE_THEME_HINTS = [
  {
    sourceClasses: ["book_or_corpus", "official", "local_project"] as const,
    title: "Verification contract cards and acceptance criteria",
    tokens: ["contract", "minimum", "acceptance", "verifier"],
  },
  {
    sourceClasses: ["book_or_corpus", "official", "source_repo"] as const,
    title: "Workflow machine invariants and property tests",
    tokens: ["machine", "state", "property", "invariant"],
  },
  {
    sourceClasses: ["official", "source_repo", "field_report"] as const,
    title: "Cancel, cleanup, retry, and idempotency checks",
    tokens: ["cancel", "cleanup", "retry", "idempotency"],
  },
  {
    sourceClasses: ["official", "maintainer", "field_report"] as const,
    title: "HITL approvals, warnings, and blocking failures",
    tokens: ["human", "approval", "warning", "blocking", "HITL"],
  },
  {
    sourceClasses: ["book_or_corpus", "official", "local_project"] as const,
    title: "Source classes and claim support policy",
    tokens: ["source", "claim", "class", "support"],
  },
  {
    sourceClasses: ["book_or_corpus", "maintainer", "local_project"] as const,
    title: "Fair-use synthesis and Brain publication receipts",
    tokens: ["fair", "use", "quote", "Brain", "publication"],
  },
];

interface CreatePrelaunchPlanOptions {
  approve?: boolean;
  now?: Date;
  reviewPagePath?: string;
}

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, sortKeys(record[key])])
    );
  }
  return value;
};

const stableJson = (value: unknown): string =>
  JSON.stringify(sortKeys(value), null, 2);

const sha256 = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 48);

const buildSearchUrl = (query: string): string => {
  const url = new URL(JOELCLAW_SEARCH_BASE);
  url.searchParams.set("q", query);
  url.searchParams.set("perPage", String(DEFAULT_PER_PAGE));
  url.searchParams.set("page", "1");
  url.searchParams.set("semantic", "true");
  return url.toString();
};

const getResultRecord = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== "object") {
    return {};
  }
  const root = input as Record<string, unknown>;
  const { result } = root;
  return result && typeof result === "object"
    ? (result as Record<string, unknown>)
    : {};
};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const parseJoelClawHits = (input: unknown) => {
  const result = getResultRecord(input);
  const hits = Array.isArray(result["hits"]) ? result["hits"] : [];
  return hits.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const hit = item as Record<string, unknown>;
    const { id } = hit;
    const { docId } = hit;
    const { title } = hit;
    if (
      typeof id !== "string" ||
      typeof docId !== "string" ||
      typeof title !== "string"
    ) {
      return [];
    }
    return [
      {
        chunkId: id,
        chunkIndex:
          typeof hit["chunkIndex"] === "number" ? hit["chunkIndex"] : undefined,
        chunkType:
          typeof hit["chunkType"] === "string" ? hit["chunkType"] : undefined,
        docId,
        headingPath: asStringArray(hit["headingPath"]),
        score: typeof hit["score"] === "string" ? hit["score"] : undefined,
        snippet:
          typeof hit["snippet"] === "string" ? hit["snippet"] : undefined,
        title,
      },
    ];
  });
};

const searchJoelClaw = async (
  query: string,
  searchedAt: string
): Promise<ScoutSearchReceipt> => {
  const url = buildSearchUrl(query);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `JoelClaw search failed for ${query}: ${response.status} ${await response.text()}`
    );
  }
  const body = (await response.json()) as unknown;
  const result = getResultRecord(body);
  const found = typeof result["found"] === "number" ? result["found"] : 0;
  return ScoutSearchReceiptSchema.parse({
    found,
    hits: parseJoelClawHits(body),
    query,
    searchedAt,
    semantic: true,
    url,
  });
};

const pickRelevantQueries = (
  question: string,
  receipts: ScoutSearchReceipt[],
  index: number
): ScoutSearchReceipt[] => {
  const lowerQuestion = question.toLowerCase();
  const matched = receipts.filter((receipt) =>
    receipt.query
      .toLowerCase()
      .split(/\s+/u)
      .some((term) => term.length > 4 && lowerQuestion.includes(term))
  );
  if (matched.length > 0) {
    return matched;
  }
  const fallback = receipts[index % receipts.length];
  return fallback ? [fallback] : [];
};

const buildThemeCandidates = (
  task: ResearchTask,
  receipts: ScoutSearchReceipt[]
): ThemeCandidate[] =>
  task.requiredCoverageQuestions.map((question, index) => {
    const relevantReceipts = pickRelevantQueries(question, receipts, index);
    const hint = COVERAGE_THEME_HINTS[index % COVERAGE_THEME_HINTS.length];
    const themeSlug = slugify(hint?.title ?? question);
    const evidenceDocIds = [
      ...new Set(
        relevantReceipts.flatMap((receipt) =>
          receipt.hits.map((hit) => hit.docId)
        )
      ),
    ].slice(0, 12);
    const sourceDensity = relevantReceipts.reduce(
      (sum, receipt) => sum + receipt.found,
      0
    );
    return {
      coverageQuestionIds: [`coverage-${index + 1}`],
      evidenceDocIds,
      laneId: `research-${themeSlug}`,
      researchQuestion: question,
      seedQueries: relevantReceipts.map((receipt) => receipt.query),
      sourceClasses: [...(hint?.sourceClasses ?? ["book_or_corpus"])],
      sourceDensity,
      themeId: themeSlug,
      title: hint?.title ?? question,
      whyThisLane:
        sourceDensity > 0
          ? `Scout receipts found ${sourceDensity} JoelClaw hits across ${relevantReceipts.length} seed query/queries.`
          : "Coverage question has weak JoelClaw density and needs broader official/source-repo expansion.",
    };
  });

const buildSourcePolicy = (): SourcePolicy =>
  SourcePolicySchema.parse({
    fairUse: true,
    publicOutputGuidance: SOURCE_POLICY_TEXT,
    sourceClasses: [
      "official",
      "source_repo",
      "maintainer",
      "book_or_corpus",
      "field_report",
      "local_project",
    ],
  });

const buildEnvelope = (task: ResearchTask): ResearchEnvelope =>
  ResearchEnvelopeSchema.parse({
    constructiveLimits: task.constructiveLimits,
    desiredOutcome: task.desiredOutcome,
    observerTarget: task.observerTarget,
    planMode: "adaptive-scout-then-hot-research",
    requiredCoverageQuestions: task.requiredCoverageQuestions,
    researchTask: task.researchTask,
    targetBrainPage: task.targetBrainPage,
    workItemId: task.workItemId,
  });

const buildHarness = (themes: ThemeCandidate[]): HarnessPlan =>
  HarnessPlanSchema.parse({
    executionSubstrate:
      "cloudflare-worker-durable-object-queue-sandbox-artifacts",
    generatedCodeRuntime: "none",
    steps: [
      {
        id: "prepare-prelaunch-envelope",
        kind: "prepare-prelaunch",
        outputs: ["run/research-envelope.json", "run/source-policy.json"],
        policy: ["operator-shaped", "no-hot-lanes-before-approval"],
      },
      {
        id: "scout-joelclaw-corpus",
        kind: "scout-joelclaw",
        outputs: ["run/scout-receipts.json"],
        policy: ["joelclaw-personal-library", "fair-use-source-receipts"],
      },
      {
        id: "map-deep-dive-themes",
        kind: "map-themes",
        outputs: ["run/theme-map.json"],
        policy: ["lane-count-from-evidence", "no-duplicate-search-lines"],
      },
      {
        id: "render-prelaunch-review-page",
        kind: "render-review",
        outputs: [".brain/reviews/joelclaw-research-swarm-<run>.svx"],
        policy: ["pi-notes-first", "no-custom-ui-yet"],
      },
      {
        id: "record-hash-bound-approval",
        kind: "operator-approval",
        outputs: ["run/operator-approval.json"],
        policy: ["hash-bound-approval", "respect-operator-attention"],
      },
      {
        id: "commit-approved-artifacts",
        kind: "commit-plan-artifacts",
        outputs: [
          "run/research-envelope.json",
          "workflows/machine.json",
          "workflows/harness.json",
          "run/source-policy.json",
          "run/verification-contract.json",
          "run/operator-approval.json",
        ],
        policy: ["pin-before-hot-sandbox-lanes"],
      },
      {
        id: "publish-public-observer",
        kind: "publish-observer",
        outputs: ["artifacts/observer/public-event-log/receipt.json"],
        policy: ["public-redacted", "no-secrets", "no-bearer-links"],
      },
      {
        id: "enqueue-hot-research-lanes",
        kind: "enqueue-hot-research-lanes",
        outputs: themes.map((theme) => `queue:${theme.laneId}`),
        policy: ["cloudflare-queue", "real-sandbox-research-lanes"],
      },
      {
        id: "run-hot-research-lanes",
        kind: "run-sandbox-research-lane",
        outputs: themes.map(
          (theme) => `artifacts/research/${theme.laneId}/receipt.json`
        ),
        policy: ["real-cloudflare-sandbox", "artifacts-git-push"],
      },
      {
        id: "fan-in-research-lanes",
        kind: "fan-in",
        outputs: ["artifacts/synthesis/source-map.json"],
        policy: ["source-classed-fan-in", "coverage-gap-reporting"],
      },
      {
        id: "synthesize-brain-page",
        kind: "synthesize-brain-page",
        outputs: ["artifacts/synthesis/workflow-verifier-evals-playbook.svx"],
        policy: ["brain-mdsvx", "diagrams-when-useful"],
      },
      {
        id: "verify-brain-page",
        kind: "verify-brain-page",
        outputs: ["artifacts/verification/result.json"],
        policy: ["claim-source-checks", "fair-use-attribution"],
      },
      {
        id: "render-brain-page",
        kind: "render-brain-page",
        outputs: [".brain/resources/workflow-verifier-evals-playbook.svx"],
        policy: ["pi-notes-brain-check"],
      },
      {
        id: "cleanup-sandboxes",
        kind: "cleanup",
        outputs: ["run/cleanup-receipts.json"],
        policy: ["destroy-active-sandboxes"],
      },
    ],
  });

const buildVerificationContract = (): VerificationContract =>
  VerificationContractSchema.parse({
    criteria: [
      {
        id: "claims-have-source-support",
        severity: "blocking",
        summary:
          "Every implementation or pattern claim in the Brain page must point to one or more selected source refs.",
        type: "claim-source-support",
      },
      {
        id: "source-classes-match-claim-types",
        severity: "blocking",
        summary:
          "Implementation/API claims require official or source_repo support; field reports may only support risk notes.",
        type: "source-class-policy",
      },
      {
        id: "fair-use-attribution-present",
        severity: "blocking",
        summary:
          "Fair-use excerpts and transformed ideas must carry clear source attribution and not substitute for original works.",
        type: "fair-use-attribution",
      },
      {
        id: "fresh-official-docs-checked",
        severity: "warning",
        summary:
          "Current implementation claims should include freshness/date receipts for official docs or source repos.",
        type: "freshness-check",
      },
      {
        id: "brain-page-renders",
        severity: "blocking",
        summary: "pi_notes_brain_check must pass after writing the Brain page.",
        type: "brain-render-check",
      },
      {
        id: "public-observer-is-redacted",
        severity: "blocking",
        summary:
          "Public observer output must expose workflow state/events without secrets, bearer-ish links, private approval tokens, or large raw corpus chunks.",
        type: "public-observer-redaction",
      },
      {
        id: "sandbox-cleanup-receipts-present",
        severity: "blocking",
        summary:
          "Every hot research, synthesis, verifier, and delivery sandbox must have a cleanup receipt.",
        type: "cleanup-receipts",
      },
    ],
    id: "workflow-verifier-evals-playbook-contract-v1",
    statusPolicy: {
      blocked: "blocked",
      verified: "verified",
      warnings: "warnings",
    },
  });

const buildApproval = (
  artifacts: ArtifactHashBundle,
  approve: boolean,
  nowIso: string
): OperatorApproval =>
  OperatorApprovalSchema.parse({
    approvedArtifacts: artifacts,
    ...(approve
      ? {
          decidedAt: nowIso,
          decidedBy: "operator",
          decision: "approved",
          notes:
            "Prototype demo approval generated only because JOELCLAW_SWARM_APPROVE=1 was set by the operator.",
        }
      : {
          decision: "pending",
          notes:
            "Review the Brain pre-launch page and rerun with JOELCLAW_SWARM_APPROVE=1 only after operator approval.",
        }),
  });

const buildArtifactHashes = async (
  researchEnvelope: ResearchEnvelope,
  machine: unknown,
  harness: unknown,
  sourcePolicy: SourcePolicy,
  verificationContract: VerificationContract
): Promise<ArtifactHashBundle> => ({
  harnessSha256: await sha256(harness),
  machineSha256: await sha256(machine),
  researchEnvelopeSha256: await sha256(researchEnvelope),
  sourcePolicySha256: await sha256(sourcePolicy),
  verificationContractSha256: await sha256(verificationContract),
});

export const buildReviewPage = (plan: PrelaunchPlan): string => {
  const themeRows = plan.themeMap.themes
    .map(
      (theme) =>
        `| ${theme.laneId} | ${theme.title} | ${theme.sourceDensity} | ${theme.sourceClasses.join(", ")} |`
    )
    .join("\n");
  const coverageItems = plan.researchEnvelope.requiredCoverageQuestions
    .map((question) => `- ${question}`)
    .join("\n");
  const hashItems = Object.entries(plan.artifacts)
    .map(([key, value]) => `- \`${key}\`: \`${value}\``)
    .join("\n");

  return `---
title: "JoelClaw Research Swarm Prelaunch Review"
type: "review"
status: "active"
created_at: "${plan.generatedAt.slice(0, 10)}"
tags:
  - review
  - prototype
  - joelclaw
---

# JoelClaw Research Swarm Prelaunch Review

This is the operator approval surface for \`joelclaw-research-swarm-spike\`.

## Decision

Current decision: **${plan.approval.decision}**

Hot Cloudflare Sandbox research lanes must not launch until this approval is \`approved\` and bound to the hashes below.

## Target

- Target Brain page: \`${plan.researchEnvelope.targetBrainPage}\`
- Desired outcome: ${plan.researchEnvelope.desiredOutcome}
- Observer target: \`${plan.researchEnvelope.observerTarget.kind}\` / \`${plan.researchEnvelope.observerTarget.visibility}\`

## Required coverage questions

${coverageItems}

## Constructive limits

\`\`\`json
${JSON.stringify(plan.researchEnvelope.constructiveLimits, null, 2)}
\`\`\`

## Theme map from JoelClaw scouts

| Lane | Theme | Source density | Source classes |
| --- | --- | ---: | --- |
${themeRows}

## Public observer surface

The full run should publish a public redacted observer URL for live logs/events. It may show run state, plan revisions, scout wave status, lane counts, lane statuses, sandbox ids, source classes, artifact refs, verifier status, blocked/warning reasons, and cleanup receipts. It must not show secrets, private Artifacts tokens, approval callback tokens, bearer-ish links, unredacted private operator notes, or large raw corpus chunks.

## Source policy

${plan.sourcePolicy.publicOutputGuidance}

## Verifier contract

${plan.verificationContract.criteria
  .map(
    (criterion) =>
      `- **${criterion.id}** (${criterion.severity}): ${criterion.summary}`
  )
  .join("\n")}

## Approval hash bundle

${hashItems}

## Operator actions

- Approve: rerun the planning command with \`JOELCLAW_SWARM_APPROVE=1\` after reviewing this page.
- Edit request: update the fixture or PRD, rerun planning, and review new hashes.
- Reject: do not launch the hot swarm.
`;
};

export const createPrelaunchPlan = async (
  input: unknown,
  options: CreatePrelaunchPlanOptions = {}
): Promise<PrelaunchPlan> => {
  const task = ResearchTaskSchema.parse(input);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const scoutReceipts = await Promise.all(
    task.seedQueries.map((query) => searchJoelClaw(query, nowIso))
  );
  const themeMap = ThemeMapSchema.parse({
    generatedAt: nowIso,
    scoutReceipts,
    themes: buildThemeCandidates(task, scoutReceipts),
  });
  const researchEnvelope = buildEnvelope(task);
  const sourcePolicy = buildSourcePolicy();
  const machine = buildMachineReceipt(task);
  const harness = buildHarness(themeMap.themes);
  const verificationContract = buildVerificationContract();
  const artifacts = await buildArtifactHashes(
    researchEnvelope,
    machine,
    harness,
    sourcePolicy,
    verificationContract
  );
  const approval = buildApproval(artifacts, options.approve ?? false, nowIso);

  return PrelaunchPlanSchema.parse({
    approval,
    artifacts,
    generatedAt: nowIso,
    harness,
    machine,
    researchEnvelope,
    reviewPagePath:
      options.reviewPagePath ??
      `.brain/reviews/joelclaw-research-swarm-${slugify(task.workItemId)}.svx`,
    schemaVersion: "joelclaw-research-swarm-prelaunch.v1",
    sourcePolicy,
    themeMap,
    verificationContract,
  });
};

export const stringifyStableJson = stableJson;
