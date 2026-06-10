/* eslint-disable func-style, no-use-before-define, sort-keys */

import type {
  AccessRef,
  CandidateCoreMemory,
  Capability,
  ComponentPack,
  CrawlPlan,
  DeploymentDesiredState,
  DreamEvent,
  DreamManifest,
  FlowRatification,
  GraphEdge,
  GraphNode,
  MemoryPack,
  Receipt,
  WorkflowPlan,
} from "./schema.ts";
import type { SourceSnapshot } from "./snapshot.ts";

export interface ArtifactFile {
  content: string;
  path: string;
}

export interface DreamArtifactBundle {
  access: AccessRef[];
  candidates: CandidateCoreMemory[];
  capabilities: Capability[];
  components: ComponentPack[];
  crawlPlan: CrawlPlan;
  deployments: DeploymentDesiredState[];
  edges: GraphEdge[];
  events: DreamEvent[];
  files: ArtifactFile[];
  flowRatifications: FlowRatification[];
  manifest: DreamManifest;
  memory: MemoryPack[];
  nodes: GraphNode[];
  receipts: Receipt[];
  workflowPlan: WorkflowPlan;
}

export function buildDreamArtifactBundle(input: {
  createdAt: string;
  focus: string;
  receipts: Receipt[];
  runId: string;
  snapshot: SourceSnapshot;
  sourceRepoPath: string;
}): DreamArtifactBundle {
  const crawlPlan = buildCrawlPlan(input.focus);
  const candidates = buildCandidateCoreMemories(input.receipts);
  const flowRatifications = buildFlowRatifications(input.receipts);
  const nodes = buildNodes();
  const components = buildComponents(input.sourceRepoPath);
  const access = buildAccessRefs();
  const memory = buildMemoryPacks();
  const capabilities = buildCapabilities();
  const deployments = buildDeploymentDesiredStates();
  const edges = buildEdges(input.receipts);
  const workflowPlan = buildWorkflowPlan(input.runId);
  const manifest: DreamManifest = {
    candidateCount: candidates.length,
    createdAt: input.createdAt,
    focus: input.focus,
    graphNodeCount: nodes.length,
    runId: input.runId,
    schemaVersion: "shitrat-dream.manifest.v0",
    scope: "system",
    snapshotId: input.snapshot.snapshotId,
    status: "captured",
    workflowLaneCount: workflowPlan.lanes.length,
  };
  const events = buildEvents({
    createdAt: input.createdAt,
    manifest,
    receiptCount: input.receipts.length,
  });
  const files = [
    jsonFile("manifest.json", manifest),
    jsonFile("crawl-plan.json", crawlPlan),
    jsonlFile("hydration-receipts.jsonl", input.receipts),
    jsonlFile("candidate-core-memories.jsonl", candidates),
    jsonlFile("flow-ratifications.jsonl", flowRatifications),
    jsonFile("workflow-plan.json", workflowPlan),
    jsonFile("review-decisions.json", {
      decisions: [],
      status: "pending_operator_review",
    }),
    jsonFile("snapshot.json", {
      ...input.snapshot,
      files: input.snapshot.files.slice(0, 200),
      note:
        input.snapshot.files.length > 200
          ? "Snapshot manifest truncated to first 200 files in this local prototype artifact. Full snapshots belong in Cloudflare Artifacts later."
          : "Full manifest included.",
      schemaVersion: "shitrat.operating-graph-snapshot.v0",
    }),
    jsonFile("graph/nodes.json", nodes),
    jsonFile("graph/components.json", components),
    jsonFile("graph/capabilities.json", capabilities),
    jsonFile("graph/memory.json", memory),
    jsonFile("graph/access.json", access),
    jsonlFile("graph/edges.jsonl", edges),
    ...deployments.map((deployment) =>
      jsonFile(`deployments/${deployment.host}/desired.json`, deployment)
    ),
    jsonlFile("events.jsonl", events),
    jsonlFile("receipts.jsonl", input.receipts),
    {
      content: renderReviewSummary({
        candidates,
        manifest: { ...manifest, artifactRepoPath: undefined },
        workflowPlan,
      }),
      path: "summaries/review.md",
    },
    {
      content: renderCommitMessage({ focus: input.focus, runId: input.runId }),
      path: "summaries/commit-message.md",
    },
    {
      content: renderMachineReceipt(),
      path: "workflows/machine.ts",
    },
    {
      content:
        "# ShitRat dream artifact\n\nRead `manifest.json` first. Structured JSON/JSONL is canonical; Markdown is generated review gravy. 🐀\n",
      path: "README.md",
    },
  ];

  return {
    access,
    candidates,
    capabilities,
    components,
    crawlPlan,
    deployments,
    edges,
    events,
    files,
    flowRatifications,
    manifest,
    memory,
    nodes,
    receipts: input.receipts,
    workflowPlan,
  };
}

export function jsonFile(path: string, value: unknown): ArtifactFile {
  return { content: `${JSON.stringify(value, null, 2)}\n`, path };
}

export function jsonlFile(path: string, values: unknown[]): ArtifactFile {
  return {
    content: `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    path,
  };
}

function buildCrawlPlan(focus: string): CrawlPlan {
  return {
    focus,
    horizons: ["near_term", "long_term"],
    machineFacetPlan: {
      discoverMachinesFromTypesense: true,
      knownMachines: ["blaine", "dark-wizard", "flagg", "panda"],
      queryOncePerMachine: true,
    },
    queries: [
      focus,
      `${focus} ShitRat system graph`,
      `${focus} Cloudflare Artifacts`,
      `${focus} capability lease`,
      `${focus} prompt skill memory workflow`,
    ],
    schemaVersion: "shitrat-dream.crawl-plan.v0",
  };
}

function buildCandidateCoreMemories(
  receipts: Receipt[]
): CandidateCoreMemory[] {
  return [
    {
      affectedGraphNodes: ["workflow:dream", "artifact:core-memory-pack"],
      candidateId: "core-memory-dreams-are-dynamic-workflows",
      claim:
        "Dreams are dynamic workflows: they crawl, hydrate, classify, rank, assemble lanes, review per item, then apply/deploy/test/rollback accepted changes.",
      confidence: 0.94,
      requiredReceipts: receiptIds(receipts, [
        "dynamic-workflow-machine",
        "memory-distillation-dreams",
      ]),
      scope: "system",
      status: "candidate",
    },
    {
      affectedGraphNodes: [
        "memory:brain-svx",
        "artifact:operating-graph-snapshot",
      ],
      candidateId: "core-memory-brain-is-surface-not-graph",
      claim:
        "The ShitRat operating graph is broader than Brain: Brain/SVX is a human-readable memory/review surface inside a larger graph of prompts, skills, scripts, access, capabilities, workflows, hosts, artifacts, and memories.",
      confidence: 0.91,
      requiredReceipts: receiptIds(receipts, [
        "operating-graph-artifacts",
        "memory-distillation-dreams",
      ]),
      scope: "system",
      status: "candidate",
    },
    {
      affectedGraphNodes: [
        "access:shitrat-github",
        "access:slack",
        "workflow:capability-lease",
      ],
      candidateId: "core-memory-capability-leases-not-token-handoff",
      claim:
        "ShitRat workflows should use payload-bound capability leases for GitHub, Slack, and similar powers; sandboxes see operation permission and receipts, not raw tokens.",
      confidence: 0.88,
      requiredReceipts: receiptIds(receipts, [
        "operating-graph-artifacts",
        "sandbox-brain",
      ]),
      scope: "system",
      status: "candidate",
    },
  ];
}

function buildFlowRatifications(receipts: Receipt[]): FlowRatification[] {
  return [
    {
      decision: "ratified",
      flowId: "dream-as-workflow-not-report",
      reason:
        "Docs and Brain agree that the dream surface feeds dynamic workflow lanes instead of ending as a static report.",
      receiptIds: receiptIds(receipts, [
        "dynamic-workflow-machine",
        "operating-graph-artifacts",
      ]),
    },
    {
      decision: "ratified",
      flowId: "cloudflare-artifacts-for-versioned-agent-graph",
      reason:
        "Artifacts provide the Git-compatible versioned substrate for ShitRat snapshots, component packs, core memories, receipts, and rollback material.",
      receiptIds: receiptIds(receipts, [
        "operating-graph-artifacts",
        "memory-distillation-dreams",
      ]),
    },
    {
      decision: "rejected",
      flowId: "brain-as-monolithic-system-graph",
      reason:
        "Brain is important, but treating Brain as the whole graph hides access, capabilities, workflows, hosts, and deployment state. That blob would get fucky fast.",
      receiptIds: receiptIds(receipts, ["operating-graph-artifacts"]),
    },
  ];
}

function buildNodes(): GraphNode[] {
  return [
    {
      id: "prompt:shitrat-system",
      kind: "prompt",
      label: "ShitRat system/developer prompt layers",
      scope: "system",
    },
    {
      id: "skill:pi-subagents",
      kind: "skill",
      label: "Pi subagent orchestration skill",
      scope: "system",
    },
    {
      id: "skill:session-search",
      kind: "skill",
      label: "Session search/hydration skill",
      scope: "system",
    },
    {
      id: "script:joelclaw",
      kind: "script",
      label: "JoelClaw CLI/session bridge",
      scope: "system",
    },
    {
      id: "access:shitrat-github",
      kind: "access",
      label: "ShitRat GitHub App capability lease source",
      scope: "system",
    },
    {
      id: "access:slack",
      kind: "access",
      label: "Slack/Discord notification capability lease source",
      scope: "system",
    },
    {
      id: "capability:github-pr-output",
      kind: "capability",
      label: "Cloud broker creates GitHub PR output",
      scope: "system",
    },
    {
      id: "capability:memory-distillation",
      kind: "capability",
      label: "Dream memory distillation",
      scope: "system",
    },
    {
      id: "memory:joelclaw-typesense",
      kind: "memory",
      label: "Broad indexed session history",
      scope: "system",
    },
    {
      id: "memory:joelclaw-hydration",
      kind: "memory",
      label: "Receipt-grade transcript hydration",
      scope: "system",
    },
    {
      id: "memory:brain-svx",
      kind: "memory",
      label: "Human-readable Brain/SVX surface",
      scope: "system",
    },
    {
      id: "workflow:dream",
      kind: "workflow",
      label: "Dream dynamic workflow",
      scope: "system",
    },
    {
      id: "workflow:capability-lease",
      kind: "workflow",
      label: "Payload-bound capability lease broker",
      scope: "system",
    },
    { id: "host:blaine", kind: "host", label: "Blaine local runner" },
    {
      id: "host:panda",
      kind: "host",
      label: "Panda JoelClaw/Typesense source",
    },
    { id: "host:flagg", kind: "host", label: "Flagg scheduled runner" },
    {
      id: "host:cloudflare-workflows",
      kind: "host",
      label: "Cloudflare workflow runtime",
    },
    {
      id: "artifact:operating-graph-snapshot",
      kind: "artifact",
      label: "ShitRat operating graph snapshot",
      scope: "system",
    },
    {
      id: "artifact:core-memory-pack",
      kind: "artifact",
      label: "Accepted distilled core memories",
      scope: "system",
    },
  ];
}

function buildComponents(sourceRepoPath: string): ComponentPack[] {
  return [
    {
      componentId: "component:system-prompt-pack",
      kind: "system_prompt_pack",
      source: sourceRepoPath,
      version: "snapshot-v0",
    },
    {
      componentId: "component:skills-pack",
      kind: "skills_pack",
      source: `${sourceRepoPath}/.pi/agent/skills`,
      version: "snapshot-v0",
    },
    {
      componentId: "component:scripts-pack",
      kind: "scripts_pack",
      source: "joelclaw/shitrat local CLIs",
      version: "snapshot-v0",
    },
    {
      componentId: "component:access-pack",
      kind: "access_pack",
      source: "secret refs only",
      version: "snapshot-v0",
    },
    {
      componentId: "component:workflow-patterns-pack",
      kind: "workflow_patterns_pack",
      source: "pi-cloudflare-sandbox-workflows",
      version: "snapshot-v0",
    },
    {
      componentId: "component:runner-config-pack",
      kind: "runner_config_pack",
      source: "per-host desired manifests",
      version: "snapshot-v0",
    },
  ];
}

function buildAccessRefs(): AccessRef[] {
  return [
    {
      accessId: "access:shitrat-github",
      capabilityLeasePolicy:
        "payload-bound github_pr_output only; repo/branch/filesRef/bodyHash/expiry bound",
      exposesPlaintextToSandbox: false,
      secretRef: "agent-secrets:shitrat_github_app",
    },
    {
      accessId: "access:slack",
      capabilityLeasePolicy:
        "message-or-review-link delivery only after scoped workflow approval",
      exposesPlaintextToSandbox: false,
      secretRef: "agent-secrets:slack_bot_token",
    },
    {
      accessId: "access:typesense",
      capabilityLeasePolicy:
        "query-shaped JoelClaw bridge or tailnet runner; no raw public Typesense exposure",
      exposesPlaintextToSandbox: false,
      secretRef: "agent-secrets:typesense_api_key",
    },
  ];
}

function buildMemoryPacks(): MemoryPack[] {
  return [
    {
      memoryId: "memory:joelclaw-typesense",
      source: "joelclaw_typesense",
      storesRawTranscript: false,
      summary:
        "Broad scout substrate for indexed session chunks across machines.",
    },
    {
      memoryId: "memory:joelclaw-hydration",
      source: "joelclaw_hydration",
      storesRawTranscript: false,
      summary:
        "Receipt-grade excerpts/pointers used before durable memory claims are accepted.",
    },
    {
      memoryId: "memory:cloudflare-artifacts-core",
      source: "cloudflare_artifacts",
      storesRawTranscript: false,
      summary:
        "Accepted distilled core memories and deployable component graph state.",
    },
    {
      memoryId: "memory:brain-svx",
      source: "brain_svx",
      storesRawTranscript: false,
      summary:
        "Human-readable review/durable memory projection, not the whole graph.",
    },
  ];
}

function buildCapabilities(): Capability[] {
  return [
    {
      accessRefs: ["access:shitrat-github"],
      capabilityId: "capability:github-pr-output",
      componentRefs: [
        "component:workflow-patterns-pack",
        "component:access-pack",
      ],
      memoryRefs: ["memory:cloudflare-artifacts-core"],
      summary:
        "Create GitHub PR output from a cloud broker using a payload-bound capability lease.",
    },
    {
      accessRefs: ["access:typesense"],
      capabilityId: "capability:memory-distillation",
      componentRefs: [
        "component:system-prompt-pack",
        "component:skills-pack",
        "component:workflow-patterns-pack",
      ],
      memoryRefs: [
        "memory:joelclaw-typesense",
        "memory:joelclaw-hydration",
        "memory:brain-svx",
      ],
      summary:
        "Run a Dream that scouts, hydrates, classifies, reviews, and applies memory/component graph changes.",
    },
    {
      accessRefs: ["access:slack"],
      capabilityId: "capability:review-notification",
      componentRefs: ["component:scripts-pack", "component:runner-config-pack"],
      memoryRefs: ["memory:brain-svx"],
      summary:
        "Notify Joel about private review surfaces without embedding raw transcripts or secrets.",
    },
  ];
}

function buildDeploymentDesiredStates(): DeploymentDesiredState[] {
  return [
    {
      appliesMutations: true,
      host: "blaine",
      pullBased: true,
      responsibilities: [
        "active local ShitRat runner",
        "pull/lease dream jobs",
        "apply operator-approved local patches",
      ],
      smokeChecks: [
        "joelclaw sessions chunks works",
        "pi-notes direct Bun CLI works",
      ],
    },
    {
      appliesMutations: false,
      host: "panda",
      pullBased: true,
      responsibilities: [
        "serve JoelClaw/Typesense over tailnet HTTP",
        "provide hydration receipts",
      ],
      smokeChecks: [
        "Typesense plain HTTP on 8108 responds from tailnet runner",
      ],
    },
    {
      appliesMutations: true,
      host: "flagg",
      pullBased: true,
      responsibilities: [
        "future scheduled Dream runner",
        "push observed state receipts",
      ],
      smokeChecks: ["runner can lease one no-op workflow job"],
    },
    {
      appliesMutations: false,
      host: "cloudflare-workflows",
      pullBased: true,
      responsibilities: [
        "Durable Object run state",
        "Artifacts repos",
        "Sandbox validation lanes",
        "capability lease broker",
      ],
      smokeChecks: [
        "Artifact repo commit exists",
        "sandbox validation receipt exists",
      ],
    },
  ];
}

function buildEdges(receipts: Receipt[]): GraphEdge[] {
  const proofReceipts = receiptIds(receipts, [
    "operating-graph-artifacts",
    "memory-distillation-dreams",
  ]);
  return [
    {
      from: "capability:memory-distillation",
      receiptIds: proofReceipts,
      to: "workflow:dream",
      type: "runs",
    },
    {
      from: "workflow:dream",
      receiptIds: proofReceipts,
      to: "memory:joelclaw-typesense",
      type: "reads",
    },
    {
      from: "workflow:dream",
      receiptIds: proofReceipts,
      to: "memory:joelclaw-hydration",
      type: "reads",
    },
    {
      from: "workflow:dream",
      receiptIds: proofReceipts,
      to: "artifact:core-memory-pack",
      type: "materializes",
    },
    {
      from: "artifact:operating-graph-snapshot",
      receiptIds: proofReceipts,
      to: "prompt:shitrat-system",
      type: "versions",
    },
    {
      from: "artifact:operating-graph-snapshot",
      receiptIds: proofReceipts,
      to: "skill:pi-subagents",
      type: "versions",
    },
    {
      from: "artifact:operating-graph-snapshot",
      receiptIds: proofReceipts,
      to: "workflow:capability-lease",
      type: "versions",
    },
    {
      from: "access:shitrat-github",
      receiptIds: proofReceipts,
      to: "capability:github-pr-output",
      type: "supports",
    },
    {
      from: "host:blaine",
      receiptIds: proofReceipts,
      to: "artifact:operating-graph-snapshot",
      type: "observes",
    },
    {
      from: "artifact:operating-graph-snapshot",
      receiptIds: proofReceipts,
      to: "host:cloudflare-workflows",
      type: "deploys_to",
    },
  ];
}

function buildWorkflowPlan(runId: string): WorkflowPlan {
  return {
    deterministicSafetyEnvelope: [
      "queued",
      "exploring",
      "review_ready",
      "applying",
      "captured",
      "failed",
    ],
    lanes: [
      {
        laneId: "scout-history-by-machine",
        pattern: "fan-out-scout-by-machine",
        proposedBy: "dream",
        requiresCapabilityLeases: ["access:typesense"],
        reviewGate: "no raw transcript in public artifacts",
        stochastic: true,
        target: "crawl-plan.json + hydration-receipts.jsonl",
      },
      {
        laneId: "assemble-operating-graph",
        pattern: "graph-hypothesis-builder",
        proposedBy: "dream",
        requiresCapabilityLeases: [],
        reviewGate: "graph schema validation",
        stochastic: true,
        target: "graph/*.json + graph/edges.jsonl",
      },
      {
        laneId: "classify-core-memory-candidates",
        pattern: "rank-and-classify-candidates",
        proposedBy: "dream",
        requiresCapabilityLeases: [],
        reviewGate: "per-item operator review",
        stochastic: true,
        target: "candidate-core-memories.jsonl",
      },
      {
        laneId: "apply-accepted-component-changes",
        pattern: "patch-validate-rollback-after-accept",
        proposedBy: "dream",
        requiresCapabilityLeases: ["access:shitrat-github", "access:slack"],
        reviewGate:
          "forward diff + rollback diff + validation output + apply receipt",
        stochastic: false,
        target:
          "patches/ rollback/ apply-receipts/ deployments/*/observed.json",
      },
    ],
    notes: [
      "The dream surface is intentionally stochastic: it may invent phases, connect weird evidence, and propose unexpected lanes.",
      "Only the safety envelope is deterministic: receipts, capability leases, review gates, artifact commits, rollback, and final status.",
      "Generated workflow code is receipt-only in this prototype; trusted local code writes the bundle.",
      "Brain/SVX is a review/memory projection, not the whole ShitRat operating graph.",
      "Capability leases are operation grants, not token handoff.",
    ],
    phases: [
      {
        intent:
          "wander across near-term and long-term traces looking for surprising cross-machine graph edges",
        phaseId: "stochastic-scout",
        stochastic: true,
      },
      {
        intent:
          "hydrate only enough receipts to keep candidate graph changes source-backed",
        phaseId: "receipt-hydration",
        stochastic: true,
      },
      {
        intent:
          "assemble whatever workflow lanes the evidence calls for, not a fixed DAG",
        phaseId: "lane-invention",
        stochastic: true,
      },
      {
        intent:
          "freeze accepted lanes behind deterministic review, lease, validation, and rollback gates",
        phaseId: "safety-envelope",
        stochastic: true,
      },
    ],
    runId,
    schemaVersion: "shitrat-dream.workflow-plan.v0",
    strategy: "stochastic-dream-surface-with-deterministic-safety-envelope",
  };
}

function buildEvents(input: {
  createdAt: string;
  manifest: DreamManifest;
  receiptCount: number;
}): DreamEvent[] {
  return [
    {
      data: { focus: input.manifest.focus },
      phaseId: "stochastic-scout",
      runId: input.manifest.runId,
      status: "exploring",
      ts: input.createdAt,
      type: "STOCHASTIC_PHASE_RECORDED",
    },
    {
      data: { receiptCount: input.receiptCount },
      phaseId: "receipt-hydration",
      runId: input.manifest.runId,
      status: "exploring",
      ts: input.createdAt,
      type: "STOCHASTIC_PHASE_RECORDED",
    },
    {
      data: { graphNodeCount: input.manifest.graphNodeCount },
      phaseId: "lane-invention",
      runId: input.manifest.runId,
      status: "exploring",
      ts: input.createdAt,
      type: "STOCHASTIC_PHASE_RECORDED",
    },
    {
      data: {
        candidateCount: input.manifest.candidateCount,
        workflowLaneCount: input.manifest.workflowLaneCount,
      },
      phaseId: "safety-envelope",
      runId: input.manifest.runId,
      status: "review_ready",
      ts: input.createdAt,
      type: "REVIEW_READY",
    },
    {
      data: {},
      runId: input.manifest.runId,
      status: "captured",
      ts: input.createdAt,
      type: "ARTIFACT_BUNDLE_WRITTEN",
    },
  ];
}

function renderReviewSummary(input: {
  candidates: CandidateCoreMemory[];
  manifest: DreamManifest;
  workflowPlan: WorkflowPlan;
}): string {
  return `${[
    "# ShitRat Dream Review",
    "",
    `Run: \`${input.manifest.runId}\``,
    `Focus: **${input.manifest.focus}**`,
    `Scope: \`${input.manifest.scope}\``,
    `Graph nodes: ${input.manifest.graphNodeCount}`,
    `Workflow lanes: ${input.workflowPlan.lanes.length}`,
    "",
    "## Grill answer",
    "",
    "Yes, dynamic workflows should carry a system operating graph. No, the graph should not be flattened into Brain. Brain/SVX is the readable review/memory surface. The graph also includes prompts, skills, scripts, access refs, capabilities, workflow patterns, hosts, component packs, artifact refs, receipts, and deployment state.",
    "",
    "## Candidate core memories",
    "",
    ...input.candidates.flatMap((candidate) => [
      `### ${candidate.candidateId}`,
      "",
      `- Scope: \`${candidate.scope}\``,
      `- Confidence: ${candidate.confidence.toFixed(2)}`,
      `- Status: \`${candidate.status}\``,
      `- Claim: ${candidate.claim}`,
      `- Affected graph nodes: ${candidate.affectedGraphNodes.map((node) => `\`${node}\``).join(", ")}`,
      "",
    ]),
    "## Canonical files",
    "",
    "Structured JSON/JSONL is canonical. This Markdown is just the human review projection.",
    "",
  ].join("\n")}\n`;
}

function renderCommitMessage(input: { focus: string; runId: string }): string {
  return `dream: ${input.focus} (${input.runId})\n\nArtifact-backed ShitRat operating graph snapshot.\n`;
}

function renderMachineReceipt(): string {
  return `// Receipt-only XState v5 safety envelope for this prototype.\n// The dream phase/lane graph is stochastic data in workflow-plan.json.\n// Trusted code only constrains review/apply/capture safety.\nexport const statuses = [\n  "queued",\n  "exploring",\n  "review_ready",\n  "applying",\n  "captured",\n  "failed",\n] as const;\n`;
}

function receiptIds(receipts: Receipt[], needles: string[]): string[] {
  const matches = receipts
    .filter((receipt) => needles.some((needle) => receipt.id.includes(needle)))
    .map((receipt) => receipt.id);
  return matches.length > 0
    ? matches
    : receipts.map((receipt) => receipt.id).slice(0, 2);
}
