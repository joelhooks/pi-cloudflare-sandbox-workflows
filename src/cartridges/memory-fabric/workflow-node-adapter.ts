import { z } from "zod";

import type {
  AgentAnalysisReasoningLanePort,
  ArtifactStoreContract,
  WorkflowNodeAdapterPort,
  WorkflowNodeExecutionResult,
  WorkflowNodeInvocationStep,
} from "../../app/application/ports.ts";
import { hashJson, sha256Hex } from "../../app/domain/hash.ts";
import type { ResolvedKernelSkill } from "../../app/domain/kernel-skills.ts";
import {
  ArtifactPinSchema,
  ArtifactRefSchema,
} from "../../app/domain/schemas.ts";
import type {
  ArtifactPin,
  ArtifactRef,
  CapabilityBlocker,
  DynamicWorkflowMachineDocument,
  DynamicWorkflowPlanDocument,
} from "../../app/domain/schemas.ts";
import { MemorySourceFamilySchema } from "../../app/domain/source-profile.ts";
import type { MemorySourceFamily } from "../../app/domain/source-profile.ts";
import {
  WORKFLOW_HITL_REPORT_SECTION_ORDER,
  MemoryAgenticRefinementOutputSchema,
  MemoryCaptureReceiptDocumentSchema,
  MemoryCorrelationGraphDocumentSchema,
  MemoryHitlDecisionContractSchema,
  MemoryHitlDecisionDocumentSchema,
  MemoryHitlFollowUpRunRequestDocumentSchema,
  MemoryHitlDecisionWorkflowSeedDocumentSchema,
  WorkflowHitlReportDefinitionOfDoneAuditSchema,
  WorkflowHitlReportDocumentSchema,
  WorkflowHitlReportProofLevelSchema,
  MemoryHydrationDocumentSchema,
  MemoryRelayCaptureArtifactPayloadSchema,
  MemoryRelayCaptureRunPayloadSchema,
  MemoryRelayCorrelationPayloadSchema,
  MemoryRelayHydrationPayloadSchema,
  MemoryRelayLeaseReceiptSchema,
  MemoryRelaySearchPayloadSchema,
  MemoryRelaySignalsPayloadSchema,
  MemorySearchDocumentSchema,
  MemoryRefinementProposalDocumentSchema,
  MemorySignalDocumentSchema,
  MemorySignalKindSchema,
} from "./schemas.ts";
import type {
  MemoryAgenticRefinementProposal,
  MemoryCaptureReceiptDocument,
  MemoryCorrelationGraphDocument,
  MemoryHitlDecision,
  MemoryHitlDecisionArtifactUpdateTargetKind,
  MemoryHitlDecisionContract,
  MemoryHitlDecisionDocument,
  MemoryHitlFollowUpRunRequestDocument,
  MemoryHitlDecisionWorkflowSeedDocument,
  WorkflowHitlReportCard,
  WorkflowHitlReportDefinitionOfDoneAudit,
  WorkflowHitlReportDefinitionOfDoneAuditItem,
  WorkflowHitlReportDocument,
  WorkflowHitlReportProofLevel,
  MemoryHydrationDocument,
  MemoryRelayCaptureArtifactPayload,
  MemoryRelayCaptureRunPayload,
  MemoryRelayCorrelationPayload,
  MemoryRelayHydrationPayload,
  MemoryRelayLeaseReceipt,
  MemoryRelaySearchPayload,
  MemoryRelaySignalsPayload,
  MemorySearchDocument,
  MemorySearchHit,
  MemoryReceiptRef,
  MemoryRefinementProposal,
  MemoryRefinementProposalDocument,
  MemoryRefinementProposalRecommendation,
  MemoryRefinementProposalTargetKind,
  MemoryRefinementReasoningMode,
  MemorySignalDocument,
} from "./schemas.ts";

export type MemoryFabricResult<TDocument> =
  | {
      readonly blocker: CapabilityBlocker;
      readonly status: "blocked";
    }
  | {
      readonly document: TDocument;
      readonly relayLeaseReceipt?: MemoryRelayLeaseReceipt;
      readonly status: "ready";
    };

export interface MemoryRetrievalPort {
  hydrateMemories(
    input: MemoryRelayHydrationPayload
  ): Promise<MemoryFabricResult<MemoryHydrationDocument>>;

  searchMemories(
    input: MemoryRelaySearchPayload
  ): Promise<MemoryFabricResult<MemorySearchDocument>>;
}

export interface MemorySignalPort {
  mineSignals(
    input: MemoryRelaySignalsPayload
  ): Promise<MemoryFabricResult<MemorySignalDocument>>;
}

export interface MemoryCorrelationPort {
  correlateMemories(
    input: MemoryRelayCorrelationPayload
  ): Promise<MemoryFabricResult<MemoryCorrelationGraphDocument>>;
}

export interface MemoryCapturePort {
  captureArtifact(
    input: MemoryRelayCaptureArtifactPayload
  ): Promise<MemoryFabricResult<MemoryCaptureReceiptDocument>>;

  captureRun(
    input: MemoryRelayCaptureRunPayload
  ): Promise<MemoryFabricResult<MemoryCaptureReceiptDocument>>;
}

export interface MemoryFabricWorkflowNodeAdapterConfig {
  /**
   * The "dream thinks" lane. When present, the propose-refinements node REASONS
   * over the hydrated evidence and the analysis-method kernel skill through a
   * real agent lane instead of mechanical template-fill. When absent (the
   * integration-test runtime, or no Pi auth) the node falls back to the
   * deterministic path and records the output honestly as `mechanical`, so a
   * report never claims analysis it did not do.
   */
  readonly analysisReasoningLane?: AgentAnalysisReasoningLanePort;
  readonly artifacts: ArtifactStoreContract;
  readonly memoryCapture?: MemoryCapturePort;
  readonly memoryCorrelation?: MemoryCorrelationPort;
  readonly memoryRetrieval?: MemoryRetrievalPort;
  readonly memorySignals?: MemorySignalPort;
}

type BlockedWorkflowNodeExecutionResult = Extract<
  WorkflowNodeExecutionResult,
  { readonly status: "blocked" }
>;
type MemoryWorkflowNodeExecutionInput = Parameters<
  WorkflowNodeAdapterPort["execute"]
>[0];
interface LoadedArtifactDocument<TDocument> {
  readonly artifactRef: ArtifactRef;
  readonly document: TDocument;
  readonly status: "loaded";
}
type ArtifactLoadResult<TDocument> =
  | LoadedArtifactDocument<TDocument>
  | BlockedWorkflowNodeExecutionResult;
type ArtifactLoadFailureCause = "not_found" | "read_error" | "schema_mismatch";

const CAPTURABLE_ARTIFACT_MEDIA_TYPES = [
  "application/json",
  "text/html",
  "text/markdown",
  "text/mdsvx",
  "text/plain",
  "text/typescript",
] as const;

const MemoryCapturableArtifactMediaTypeSchema = z.enum(
  CAPTURABLE_ARTIFACT_MEDIA_TYPES,
  {
    error:
      "Memory capture artifact mediaType must be application/json or a supported text media type.",
  }
);

// The planner is a stochastic LLM lane that is never handed the per-node config
// schemas, so it guesses each shape. Every node config below gives the planner a
// structural floor: required strings default to a sensible value, enum arrays
// drop out-of-enum members instead of blocking, and ref-bearing fields fall back
// to a resolvable run artifact when the planner omits the concrete ref. The
// prompt nudges; these schemas guarantee. Leashing only tolerates config SHAPE;
// it never touches the capability/hash/redaction/review gates downstream.
//
// `MEMORY_FABRIC_FALLBACK_QUERY` mirrors the dream-transcript-review source
// profile `defaultQuery`. It stays a local constant so the adapter does not pull
// the package-seed graph in through source-profile.ts.
const MEMORY_FABRIC_FALLBACK_QUERY = "dream workflow";

// Draft-7 JSON Schema for the agentic propose-refinements output, derived from
// the production Zod schema so the contract the reasoning lane is told can never
// drift from the one the node parses its output against. Precomputed once.
const AGENTIC_REFINEMENT_OUTPUT_JSON_SCHEMA = JSON.stringify(
  z.toJSONSchema(MemoryAgenticRefinementOutputSchema, { target: "draft-7" }),
  null,
  2
);

// Node-budget bounding (the run-14 blocker). Each retrieval/correlation node runs
// as ONE relay round-trip whose work the planner sizes via maxHits/maxSignals/
// maxReceipts. Single-step gives every node its own fresh invocation, but a node
// can still order an unbounded payload — 152 real JoelClaw hits + per-receipt
// hydration + O(n^2) correlation is what blew a single invocation and got run 14
// reaped at node 3. These ceilings cap the largest payload a node will fetch so
// one node always fits one invocation's wall-clock + CPU budget. They CLAMP rather
// than reject (a leash, not a gate): a planner that asks for 100 hits gets the
// budgeted ceiling, not a parse error, and still reviews real — just bounded —
// evidence. Modest by design; raise once the node-by-node walk is green.
const MEMORY_SEARCH_MAX_HITS_CEILING = 25;
const MEMORY_SIGNALS_MAX_CEILING = 15;
const MEMORY_HYDRATION_MAX_RECEIPTS_CEILING = 12;

// Clamp a planner-supplied positive-integer budget to [1, ceiling]. Passes
// non-numbers (including `undefined`) through untouched so the field's `.default`
// still applies on omission; truncates and floors a number into the budget band.
const clampToBudgetCeiling =
  (ceiling: number) =>
  (value: unknown): unknown =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(Math.max(Math.trunc(value), 1), ceiling)
      : value;

const filterToValidSignalKinds = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value;
  }
  const valid = value.filter(
    (kind) => MemorySignalKindSchema.safeParse(kind).success
  );
  return valid.length > 0 ? valid : undefined;
};

// Drop any source family the planner hallucinated (e.g. "github" instead of a
// real MemorySourceFamily) so a plausible config conforms. An all-invalid array
// collapses to undefined, which every downstream payload treats as "all
// expected families", matching omission.
const filterToValidSourceFamilies = (value: unknown): unknown => {
  if (!Array.isArray(value)) {
    return value;
  }
  const valid = value.filter(
    (family) => MemorySourceFamilySchema.safeParse(family).success
  );
  return valid.length > 0 ? valid : undefined;
};

const LeashedSourceFamiliesSchema = z.preprocess(
  filterToValidSourceFamilies,
  z.array(MemorySourceFamilySchema).min(1).optional()
);

// Coerce the report node's `primarySourceFamilies` to a clean MemorySourceFamily
// array: a non-array (the planner emitting a bare string) or an all-hallucinated
// array collapses to `[]`, which means "no primary contract on this report" and
// preserves the legacy caveat-only behavior. Valid members survive. This stays
// SHAPE tolerance; it never relaxes the primary-source enforcement that runs on
// the parsed result.
const coercePrimarySourceFamilies = (value: unknown): MemorySourceFamily[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((family) => {
    const parsed = MemorySourceFamilySchema.safeParse(family);

    return parsed.success ? [parsed.data] : [];
  });
};

const MemoryReadabilitySchema = z
  .enum(["actor-private", "org-private", "public"])
  .default("actor-private");

const MemoryCaptureRunNodeConfigSchema = z.object({
  capturedRef: ArtifactPinSchema.optional(),
  readability: MemoryReadabilitySchema,
  sourceFamilies: LeashedSourceFamiliesSchema,
  sourceSystem: z.string().min(1).default("cloudflare-workflow-run"),
  targetRunId: z.string().min(1).optional(),
});

const MemoryCaptureArtifactNodeConfigSchema = z.object({
  artifactRef: ArtifactRefSchema.optional(),
  artifactStepId: z.string().min(1).optional(),
  mediaType:
    MemoryCapturableArtifactMediaTypeSchema.default("application/json"),
  readability: MemoryReadabilitySchema,
  sourceFamilies: LeashedSourceFamiliesSchema,
  sourceSystem: z.string().min(1).default("cloudflare-artifacts"),
});

const MemorySearchNodeConfigSchema = z.object({
  maxHits: z.preprocess(
    clampToBudgetCeiling(MEMORY_SEARCH_MAX_HITS_CEILING),
    z.number().int().min(1).max(MEMORY_SEARCH_MAX_HITS_CEILING).default(10)
  ),
  query: z.string().min(1).default(MEMORY_FABRIC_FALLBACK_QUERY),
  sourceFamilies: LeashedSourceFamiliesSchema,
});

const MemorySignalsNodeConfigSchema = z.object({
  maxSignals: z.preprocess(
    clampToBudgetCeiling(MEMORY_SIGNALS_MAX_CEILING),
    z.number().int().min(1).max(MEMORY_SIGNALS_MAX_CEILING).default(10)
  ),
  query: z.string().min(1).default(MEMORY_FABRIC_FALLBACK_QUERY),
  signalKinds: z.preprocess(
    filterToValidSignalKinds,
    z.array(MemorySignalKindSchema).min(1).optional()
  ),
  sourceFamilies: LeashedSourceFamiliesSchema,
});

const MemoryHydrationNodeConfigSchema = z.object({
  maxReceipts: z.preprocess(
    clampToBudgetCeiling(MEMORY_HYDRATION_MAX_RECEIPTS_CEILING),
    z
      .number()
      .int()
      .min(1)
      .max(MEMORY_HYDRATION_MAX_RECEIPTS_CEILING)
      .default(10)
  ),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
});

const MemoryCorrelationNodeConfigSchema = z.object({
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
});

const MemoryRefinementProposalNodeConfigSchema = z.object({
  correlationRef: ArtifactRefSchema.optional(),
  correlationStepId: z.string().min(1).optional(),
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  maxProposals: z.number().int().min(1).max(20).default(8),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
  signalsRef: ArtifactRefSchema.optional(),
  signalsStepId: z.string().min(1).optional(),
});

const WorkflowHitlReportNodeConfigSchema = z.object({
  correlationRef: ArtifactRefSchema.optional(),
  correlationStepId: z.string().min(1).optional(),
  dynamicGenerationProofLevel:
    WorkflowHitlReportProofLevelSchema.default("plan-derived"),
  hydrationRef: ArtifactRefSchema.optional(),
  hydrationStepId: z.string().min(1).optional(),
  // The source families this run EXISTS to read. The planner copies these from
  // the installed source profile's criticality contract (see the dream profile's
  // planner guidance). Defaulted to `[]` so a report that declares no primary
  // family keeps the legacy "coverage gaps are caveats" behavior; a primary
  // family that resolved zero receipts blocks the report instead of letting a
  // dead source masquerade as a confident review. Out-of-enum members the
  // planner hallucinates are dropped (leash), not blocked.
  primarySourceFamilies: z.preprocess(
    coercePrimarySourceFamilies,
    z.array(MemorySourceFamilySchema).default([])
  ),
  refinementProposalRef: ArtifactRefSchema.optional(),
  refinementProposalStepId: z.string().min(1).optional(),
  searchRef: ArtifactRefSchema.optional(),
  searchStepId: z.string().min(1).optional(),
  title: z.string().min(1).default("HITL review"),
});

const MemoryHitlDecisionWorkflowSeedNodeConfigSchema = z.object({
  decisionRef: ArtifactRefSchema.optional(),
  decisionStepId: z.string().min(1).optional(),
  refinementProposalRef: ArtifactRefSchema.optional(),
  refinementProposalStepId: z.string().min(1).optional(),
  reportRef: ArtifactRefSchema.optional(),
  reportStepId: z.string().min(1).optional(),
});

const MemoryHitlFollowUpRunRequestNodeConfigSchema = z.object({
  requestedPackageIds: z
    .array(z.string().min(1))
    .default([
      "badass-courses/claw-kernel",
      "joelhooks/configured-familiar-kernel",
      "workflow/memory-fabric",
    ]),
  runId: z.string().min(1).optional(),
  seedRef: ArtifactRefSchema.optional(),
  seedStepId: z.string().min(1).optional(),
  workItemId: z.string().min(1).optional(),
});

/**
 * Single source of truth: every memory-fabric workflow-node `nodeType` mapped to
 * the leashed Zod schema its execute fn parses `step.config` against. The adapter
 * dispatch, the planner prompt advertiser, and the plan validator must all read
 * the SAME schemas from here so the contract the planner is told matches the one
 * the adapter enforces. A coverage test asserts this registry holds an entry for
 * every nodeType in the memory-fabric package palette.
 */
export const MEMORY_FABRIC_NODE_CONFIG_SCHEMAS = {
  "joelclaw.memory.capture-artifact": MemoryCaptureArtifactNodeConfigSchema,
  "joelclaw.memory.capture-run": MemoryCaptureRunNodeConfigSchema,
  "joelclaw.memory.correlate": MemoryCorrelationNodeConfigSchema,
  "joelclaw.memory.hitl-decision-seed":
    MemoryHitlDecisionWorkflowSeedNodeConfigSchema,
  "joelclaw.memory.hitl-follow-up-run-request":
    MemoryHitlFollowUpRunRequestNodeConfigSchema,
  "joelclaw.memory.hitl-report": WorkflowHitlReportNodeConfigSchema,
  "joelclaw.memory.hydrate": MemoryHydrationNodeConfigSchema,
  "joelclaw.memory.refinement-proposals":
    MemoryRefinementProposalNodeConfigSchema,
  "joelclaw.memory.search": MemorySearchNodeConfigSchema,
  "joelclaw.memory.signals": MemorySignalsNodeConfigSchema,
} as const satisfies Record<string, z.ZodType>;

export type MemoryFabricNodeType =
  keyof typeof MEMORY_FABRIC_NODE_CONFIG_SCHEMAS;

/**
 * Advertised config contract for one workflow-node `nodeType`, derived from the
 * SAME leashed Zod schema the executor parses `step.config` against. `configJsonSchema`
 * is the draft-7 JSON Schema for that node's `config` object: it carries the field
 * names, which are required, enum options (e.g. the exact `signalKinds` subset), and
 * defaults the executor backfills. Deriving it from the registry guarantees the
 * contract the planner is told can never drift from the one the adapter enforces.
 */
export interface MemoryFabricNodeConfigContract {
  readonly configJsonSchema: Record<string, unknown>;
  readonly nodeType: string;
}

/**
 * Derive the per-node config contracts the planner must conform to, one entry per
 * registry `nodeType`, sorted for deterministic prompt output. The planner is a
 * stochastic LLM lane that is otherwise never handed these schemas, so without this
 * it guesses each `config` shape and blocks mid-walk. Advertising the registry's
 * JSON Schemas stops the guessing while keeping the executor as the single source
 * of truth.
 */
export const memoryFabricNodeConfigContracts =
  (): readonly MemoryFabricNodeConfigContract[] =>
    Object.entries(MEMORY_FABRIC_NODE_CONFIG_SCHEMAS)
      .map(([nodeType, schema]) => ({
        configJsonSchema: z.toJSONSchema(schema, {
          target: "draft-7",
        }) as Record<string, unknown>,
        nodeType,
      }))
      .toSorted((left, right) => left.nodeType.localeCompare(right.nodeType));

/**
 * Render the advertised per-node config contracts plus a worked example as planner
 * guidance notes. The signals/search note keeps the `query` + valid `signalKinds`
 * leash explicit, and the capture-artifact example shows pointing `artifactStepId`
 * at the generated-machine step so the planner stops emitting bare
 * `artifactKinds`/`capturePurpose` intent the executor cannot resolve to a ref.
 */
export const memoryFabricNodeConfigContractNotes = (): readonly string[] => {
  const contractLines = memoryFabricNodeConfigContracts().map(
    (contract) =>
      `- ${contract.nodeType}: ${JSON.stringify(contract.configJsonSchema)}`
  );

  const workedExample = JSON.stringify({
    captureGeneratedMachine: {
      config: {
        artifactStepId:
          "<stepId of the generated workflow.xstate-machine.v1 step>",
        readability: "actor-private",
      },
      dependsOn: ["<machine step id>"],
      kind: "workflow.node.invoke",
      nodeType: "joelclaw.memory.capture-artifact",
      outputPath: "dream/capture-artifact.json",
      packageRefs: ["<workflow/memory-fabric artifactRef>"],
      stepId: "capture-generated-machine",
      summary: "Capture the generated machine as durable memory.",
    },
    signalsScan: {
      config: {
        query: "dream workflow",
        signalKinds: ["correction", "friction", "workflow-pattern"],
      },
      dependsOn: [],
      kind: "workflow.node.invoke",
      nodeType: "joelclaw.memory.signals",
      outputPath: "dream/signals.json",
      packageRefs: ["<workflow/memory-fabric artifactRef>"],
      stepId: "mine-signals",
      summary: "Mine redacted correction/friction/workflow signals.",
    },
  });

  return [
    `Per-node config contract for workflow.node.invoke steps: each Dream cartridge nodeType below is followed by the draft-7 JSON Schema its config object must satisfy. These schemas are derived from the same Zod schemas the executor parses config against. Set every required field, choose enum values only from the listed options, and rely on the documented defaults when unsure. Fields not listed in a node's schema are rejected (additionalProperties:false).\n${contractLines.join("\n")}`,
    `Worked workflow.node.invoke config examples (copy this shape): ${workedExample}. For capture-artifact, point config.artifactStepId at the generated workflow.xstate-machine.v1 step instead of emitting bare artifactKinds/capturePurpose; the node needs a concrete artifact ref. For signals/search, always set config.query and only use signalKinds from the enum (use "workflow-pattern", never "workflow").`,
  ];
};

/**
 * Render one Zod issue as a redacted, operator-legible field clause naming the
 * config path and the expected constraint. Zod issue messages describe the
 * SCHEMA (e.g. "Too big: expected number to be <=25", "Invalid option:
 * expected one of ..."), never the offending value, so the clause carries no
 * planner payload — only the contract the config violated.
 */
const describePlanNodeConfigIssue = (issue: z.core.$ZodIssue): string => {
  const path = issue.path.map(String).join(".");
  const at = path.length > 0 ? `config.${path}` : "config";

  return `${at} (${issue.message})`;
};

/**
 * Fail-fast plan-config validation for one memory-fabric `workflow.node.invoke`
 * step, run at plan-load time before the first node executes. The step's config
 * is parsed against the SAME leashed registry schema its execute fn uses, so a
 * config the leash can repair (omitted defaults, out-of-enum members it drops)
 * passes and returns `null`; only a genuinely unrepairable config (e.g. a
 * non-string `query`) blocks — a numeric `maxHits` above the budget ceiling is
 * now clamped by the leash, not blocked. A `nodeType` the
 * registry does not cover also returns `null` — that step is not this adapter's
 * config to validate. On failure the blocker names the stepId, nodeType, and the
 * first violated field path + expected constraint so the run blocks legibly at
 * the start instead of mid-walk.
 */
export const validateMemoryFabricNodeConfig = (
  step: WorkflowNodeInvocationStep
): CapabilityBlocker | null => {
  const schema = (
    MEMORY_FABRIC_NODE_CONFIG_SCHEMAS as Record<string, z.ZodType | undefined>
  )[step.nodeType];
  if (schema === undefined) {
    return null;
  }

  const parsed = schema.safeParse(step.config);
  if (parsed.success) {
    return null;
  }

  const issue = parsed.error.issues.at(0);
  const detail =
    issue === undefined
      ? "config did not satisfy the node's contract"
      : describePlanNodeConfigIssue(issue);

  return {
    code: "plan_node_config_invalid",
    message: `Plan step ${step.stepId} (nodeType ${step.nodeType}) has invalid config: ${detail}.`,
    redacted: true,
  };
};

const blocker = (
  code: CapabilityBlocker["code"],
  message: string
): BlockedWorkflowNodeExecutionResult => ({
  blocker: {
    code,
    message,
    redacted: true,
  },
  status: "blocked",
});

const artifactRefTail = (artifactRef: ArtifactRef): string => {
  const tail = artifactRef.split("/").at(-1);

  return tail === undefined || tail.length === 0 ? "<unknown>" : tail;
};

const errorMessageFor = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === "string" ? error : "";
};

const errorNameFor = (error: unknown): string =>
  error instanceof Error ? error.name : "";

const errorCodeFor = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;

const artifactReadFailureCauseFor = (
  error: unknown
): ArtifactLoadFailureCause => {
  const code = errorCodeFor(error);
  if (code === "ENOENT" || code === "NOT_FOUND" || code === "not_found") {
    return "not_found";
  }

  const message = errorMessageFor(error).toLowerCase();
  const name = errorNameFor(error);
  if (
    name === "NotFoundError" ||
    message.includes("not found") ||
    message.includes("no such file") ||
    message.includes("outside this store")
  ) {
    return "not_found";
  }

  return "read_error";
};

const zodIssuePath = (issues: readonly z.core.$ZodIssue[]): string => {
  const issue = issues.at(0);
  if (issue === undefined) {
    return "<root>";
  }

  const path = issue.path.map(String).join(".");

  return path.length > 0 ? path : "<root>";
};

const artifactLoadBlocker = (input: {
  readonly artifactRef: ArtifactRef;
  readonly cause: ArtifactLoadFailureCause;
  readonly label: string;
  readonly zodPath?: string;
}): BlockedWorkflowNodeExecutionResult => {
  const schemaPath =
    input.zodPath === undefined ? "" : `, zod_path: ${input.zodPath}`;

  return blocker(
    "stale_package",
    `${input.label} artifact could not be loaded by the memory-fabric node (cause: ${input.cause}, ref_tail: ${artifactRefTail(input.artifactRef)}${schemaPath}).`
  );
};

const loadJsonDocument = async <TDocument>(input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
  readonly label: string;
  readonly schema: z.ZodType<TDocument>;
}): Promise<ArtifactLoadResult<TDocument>> => {
  let value: unknown;
  try {
    value = await input.artifacts.readJson({ artifactRef: input.artifactRef });
  } catch (error) {
    return artifactLoadBlocker({
      artifactRef: input.artifactRef,
      cause: artifactReadFailureCauseFor(error),
      label: input.label,
    });
  }

  const parsed = input.schema.safeParse(value);
  if (!parsed.success) {
    return artifactLoadBlocker({
      artifactRef: input.artifactRef,
      cause: "schema_mismatch",
      label: input.label,
      zodPath: zodIssuePath(parsed.error.issues),
    });
  }

  return {
    artifactRef: input.artifactRef,
    document: parsed.data,
    status: "loaded",
  };
};

const siblingArtifactPath = (input: {
  readonly extension: string;
  readonly outputPath: string;
}): string => {
  const lastDotIndex = input.outputPath.lastIndexOf(".");

  return lastDotIndex === -1
    ? `${input.outputPath}.${input.extension}`
    : `${input.outputPath.slice(0, lastDotIndex)}.${input.extension}`;
};

const relayLeaseReceiptPathFor = (step: WorkflowNodeInvocationStep): string =>
  `memory/relay-lease-receipts/${step.stepId}.json`;

const hitlReportJsonPathFor = (outputPath: string): string =>
  outputPath.endsWith(".mdsvx")
    ? siblingArtifactPath({ extension: "json", outputPath })
    : outputPath;

const hitlReportMdsvxPathFor = (outputPath: string): string =>
  outputPath.endsWith(".mdsvx")
    ? outputPath
    : siblingArtifactPath({
        extension: "mdsvx",
        outputPath,
      });

const hitlReportJsonArtifactRefFor = (artifactRef: ArtifactRef): ArtifactRef =>
  ArtifactRefSchema.parse(
    artifactRef.endsWith(".mdsvx")
      ? siblingArtifactPath({ extension: "json", outputPath: artifactRef })
      : artifactRef
  );

const writeDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document:
    | MemoryCaptureReceiptDocument
    | MemoryCorrelationGraphDocument
    | MemoryHitlFollowUpRunRequestDocument
    | MemoryHitlDecisionWorkflowSeedDocument
    | WorkflowHitlReportDocument
    | MemoryHydrationDocument
    | MemorySearchDocument
    | MemoryRefinementProposalDocument
    | MemorySignalDocument;
  readonly relayLeaseReceipt?: MemoryRelayLeaseReceipt | undefined;
  readonly step: WorkflowNodeInvocationStep;
}): Promise<WorkflowNodeExecutionResult> => {
  const write = await input.artifacts.writeJson({
    path: input.step.outputPath,
    redacted: true,
    runId: input.document.runId,
    value: input.document,
  });
  if (input.relayLeaseReceipt === undefined) {
    return { outputRefs: [write.artifactRef], status: "executed" };
  }

  const relayLeaseWrite = await input.artifacts.writeJson({
    path: relayLeaseReceiptPathFor(input.step),
    redacted: true,
    runId: input.document.runId,
    value: MemoryRelayLeaseReceiptSchema.parse(input.relayLeaseReceipt),
  });

  return {
    outputRefs: [write.artifactRef, relayLeaseWrite.artifactRef],
    status: "executed",
  };
};

const writeHitlReportDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly document: WorkflowHitlReportDocument;
  readonly step: WorkflowNodeInvocationStep;
}): Promise<WorkflowNodeExecutionResult> => {
  const jsonWrite = await input.artifacts.writeJson({
    path: hitlReportJsonPathFor(input.step.outputPath),
    redacted: true,
    runId: input.document.runId,
    value: input.document,
  });
  const mdsvxWrite = await input.artifacts.writeText({
    mediaType: "text/mdsvx",
    path: hitlReportMdsvxPathFor(input.step.outputPath),
    redacted: true,
    runId: input.document.runId,
    value: input.document.mdsvx,
  });

  return {
    outputRefs: [jsonWrite.artifactRef, mdsvxWrite.artifactRef],
    status: "executed",
  };
};

const dependencyRefFor = (input: {
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly stepId: string | undefined;
}): ArtifactRef | null => {
  if (input.stepId === undefined) {
    return null;
  }

  return input.dependencyArtifactRefs[input.stepId] ?? null;
};

const loadSearch = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemorySearchDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory search",
    schema: MemorySearchDocumentSchema,
  });

const loadHydration = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemoryHydrationDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory hydration",
    schema: MemoryHydrationDocumentSchema,
  });

const loadSignals = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemorySignalDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory signals",
    schema: MemorySignalDocumentSchema,
  });

const loadCorrelation = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemoryCorrelationGraphDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory correlation graph",
    schema: MemoryCorrelationGraphDocumentSchema,
  });

const loadRefinementProposals = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemoryRefinementProposalDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory refinement proposal",
    schema: MemoryRefinementProposalDocumentSchema,
  });

const loadHitlDecision = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemoryHitlDecisionDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory HITL decision",
    schema: MemoryHitlDecisionDocumentSchema,
  });

const loadHitlReport = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<WorkflowHitlReportDocument>> =>
  loadJsonDocument({
    artifactRef: hitlReportJsonArtifactRefFor(input.artifactRef),
    artifacts: input.artifacts,
    label: "Memory HITL report",
    schema: WorkflowHitlReportDocumentSchema,
  });

const loadHitlDecisionWorkflowSeed = (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly artifactRef: ArtifactRef;
}): Promise<ArtifactLoadResult<MemoryHitlDecisionWorkflowSeedDocument>> =>
  loadJsonDocument({
    artifactRef: input.artifactRef,
    artifacts: input.artifacts,
    label: "Memory HITL decision workflow seed",
    schema: MemoryHitlDecisionWorkflowSeedDocumentSchema,
  });

// Latest dependency artifact ref, ignoring order-insensitive map iteration by
// taking the last inserted value. Used as a fallback for the capture-artifact
// node when the planner declared `dependsOn` but never named the concrete ref.
const latestDependencyArtifactRef = (
  dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>
): ArtifactRef | null => {
  const refs = Object.values(dependencyArtifactRefs);
  return refs.at(-1) ?? null;
};

// The most recent prior output of a given upstream nodeType. plan.steps are in
// execution order, so the LAST completed node-invoke step of that type is the
// input this node should consume. Final fallback when the stochastic planner
// ordered the run correctly but omitted the explicit ref / stepId / dependsOn.
const upstreamRefByNodeType = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly nodeType: string;
  readonly plan: DynamicWorkflowPlanDocument;
}): ArtifactRef | null => {
  const completed = input.completedStepArtifactRefs;
  if (completed === undefined) {
    return null;
  }
  let resolved: ArtifactRef | null = null;
  for (const step of input.plan.steps) {
    if (step.kind !== "workflow.node.invoke") {
      continue;
    }
    const ref = completed[step.stepId];
    if (step.nodeType === input.nodeType && ref !== undefined) {
      resolved = ref;
    }
  }

  return resolved;
};

const uniqueArtifactRefCandidates = (
  artifactRefs: readonly (ArtifactRef | null | undefined)[]
): readonly ArtifactRef[] => {
  const seen = new Set<string>();
  const candidates: ArtifactRef[] = [];
  for (const ref of artifactRefs) {
    if (ref === null || ref === undefined || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    candidates.push(ref);
  }

  return candidates;
};

const allCompletedRefsForNodeType = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly nodeType: string;
  readonly plan: DynamicWorkflowPlanDocument;
}): readonly ArtifactRef[] => {
  const completed = input.completedStepArtifactRefs;
  if (completed === undefined) {
    return [];
  }

  return uniqueArtifactRefCandidates(
    input.plan.steps.flatMap((step) => {
      if (step.kind !== "workflow.node.invoke") {
        return [];
      }

      const ref = completed[step.stepId];
      return step.nodeType === input.nodeType && ref !== undefined ? [ref] : [];
    })
  );
};

const upstreamArtifactRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly explicitRef: ArtifactRef | undefined;
  readonly includeLatestDependency?: boolean;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly stepId: string | undefined;
  readonly upstreamNodeType: string;
}): readonly ArtifactRef[] =>
  uniqueArtifactRefCandidates([
    input.explicitRef,
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.stepId,
    }),
    upstreamRefByNodeType({
      completedStepArtifactRefs: input.completedStepArtifactRefs,
      nodeType: input.upstreamNodeType,
      plan: input.plan,
    }),
    input.includeLatestDependency === false
      ? null
      : latestDependencyArtifactRef(input.dependencyArtifactRefs),
  ]);

const reportArtifactRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly explicitRef: ArtifactRef | undefined;
  readonly includeAllCompletedRefs?: boolean;
  readonly includeLatestDependency?: boolean;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly stepId: string | undefined;
  readonly upstreamNodeType: string;
}): readonly ArtifactRef[] =>
  uniqueArtifactRefCandidates([
    ...upstreamArtifactRefCandidatesFor(input),
    ...(input.includeAllCompletedRefs === true
      ? allCompletedRefsForNodeType({
          completedStepArtifactRefs: input.completedStepArtifactRefs,
          nodeType: input.upstreamNodeType,
          plan: input.plan,
        })
      : []),
  ]);

const loadFirstArtifactCandidate = async <TDocument>(input: {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly load: (
    artifactRef: ArtifactRef
  ) => Promise<ArtifactLoadResult<TDocument>>;
  readonly missingBlockerMessage: string;
}): Promise<ArtifactLoadResult<TDocument>> => {
  let lastBlocker: BlockedWorkflowNodeExecutionResult | null = null;
  for (const artifactRef of input.artifactRefs) {
    const loaded = await input.load(artifactRef);
    if (loaded.status === "loaded") {
      return loaded;
    }
    lastBlocker = loaded;
  }

  return lastBlocker ?? blocker("stale_package", input.missingBlockerMessage);
};

const loadAllArtifactCandidates = async <TDocument>(input: {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly load: (
    artifactRef: ArtifactRef
  ) => Promise<ArtifactLoadResult<TDocument>>;
  readonly missingBlockerMessage: string;
}): Promise<
  | {
      readonly documents: readonly TDocument[];
      readonly refs: readonly ArtifactRef[];
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  const documents: TDocument[] = [];
  const refs: ArtifactRef[] = [];
  let lastBlocker: BlockedWorkflowNodeExecutionResult | null = null;

  for (const artifactRef of input.artifactRefs) {
    const loaded = await input.load(artifactRef);
    if (loaded.status === "loaded") {
      documents.push(loaded.document);
      refs.push(loaded.artifactRef);
      continue;
    }

    lastBlocker = loaded;
  }

  if (documents.length > 0) {
    return {
      documents,
      refs,
      status: "loaded",
    };
  }

  return lastBlocker ?? blocker("stale_package", input.missingBlockerMessage);
};

// The planner's capture-artifact intent is "capture the generated machine and
// harness" (it emits artifactKinds like workflow.xstate-machine.v1 /
// workflow.generated-harness.v1 and a capturePurpose, both ignored by the strip
// schema). We resolve that intent to an ORDERED candidate list — planner intent
// first, then the carrier-guaranteed generated machine artifacts — and pin the
// FIRST READABLE one downstream (captureArtifactPinFor). A stochastic planner
// can emit a well-formed but never-written `config.artifactRef`; committing to
// the first NON-NULL candidate without a readability check is what stalled
// run-live-20260613T143420421Z-9079dc15 terminally (capture-generated-machine /
// stale_package) even though the machine config was readable that exact drive.
// machine.config.json (artifactRef) and machine.ts (sourceArtifactRef) are
// always written and pushed by pinDynamicWorkflowBlueprint during planning, so
// the tail of this list is guaranteed to resolve on a healthy run. Shape
// tolerance only: whichever ref reads is still hashed, pinned, and leased
// through captureArtifactPinFor and the relay exactly as before.
const captureArtifactRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof MemoryCaptureArtifactNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): readonly ArtifactRef[] => {
  const ordered: readonly (ArtifactRef | null)[] = [
    input.config.artifactRef ?? null,
    dependencyRefFor({
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      stepId: input.config.artifactStepId,
    }),
    // A capture node placed AFTER a report renderer (capture-report-artifact)
    // means to capture the report, not the generated machine. Resolve the
    // upstream report first; it is null for an early capture-generated-artifacts
    // node (no report yet), which then correctly falls through to the machine.
    upstreamRefByNodeType({
      completedStepArtifactRefs: input.completedStepArtifactRefs,
      nodeType: "joelclaw.memory.hitl-report",
      plan: input.plan,
    }),
    // Carrier-guaranteed tail: the pinned generated machine config (JSON,
    // matching the default mediaType) and its TypeScript source. Both are
    // written + pushed by the carrier on every healthy planning pass.
    input.plan.machine.artifactRef,
    input.plan.machine.sourceArtifactRef,
    latestDependencyArtifactRef(input.dependencyArtifactRefs),
    input.plan.harness.artifactRef,
  ];

  return uniqueArtifactRefCandidates(ordered);
};

// Read one candidate ref into a pin, trying JSON first when the planner declared
// application/json (its common default even for text artifacts), then text.
// Returns null when the ref is unreadable — an unwritten path, or a ref outside
// this store's namespace (parseArtifactRef throws) — so the caller can fall
// through to the next candidate instead of stranding the run on one bad ref.
const readArtifactPinOrNull = async (input: {
  readonly artifactRef: ArtifactRef;
  readonly artifacts: ArtifactStoreContract;
  readonly mediaType: string;
}): Promise<ArtifactPin | null> => {
  if (input.mediaType === "application/json") {
    try {
      const value = await input.artifacts.readJson({
        artifactRef: input.artifactRef,
      });

      return ArtifactPinSchema.parse({
        artifactRef: input.artifactRef,
        hash: hashJson(value),
        mediaType: input.mediaType,
      });
    } catch {
      // The planner often defaults mediaType to application/json even when the
      // captured artifact is text (a rendered report, the machine source). Fall
      // through to a text read rather than discarding the candidate.
    }
  }

  try {
    const value = await input.artifacts.readText({
      artifactRef: input.artifactRef,
    });

    return ArtifactPinSchema.parse({
      artifactRef: input.artifactRef,
      hash: sha256Hex(value),
      mediaType: input.mediaType,
    });
  } catch {
    return null;
  }
};

// Pin the FIRST READABLE candidate from the ordered list. Only blocks when NONE
// of the resolved candidates read — on a healthy run the carrier-guaranteed
// machine refs at the tail always resolve, so a planner-hallucinated head ref no
// longer strands the capture node (the wound behind
// run-live-20260613T143420421Z-9079dc15). Reads within one invocation share the
// store's single cloned worktree, so walking a few candidates is cheap.
const captureArtifactPinFor = async (input: {
  readonly artifactRefs: readonly ArtifactRef[];
  readonly artifacts: ArtifactStoreContract;
  readonly mediaType: string;
}): Promise<
  | {
      readonly pin: ArtifactPin;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  for (const artifactRef of input.artifactRefs) {
    const pin = await readArtifactPinOrNull({
      artifactRef,
      artifacts: input.artifacts,
      mediaType: input.mediaType,
    });
    if (pin !== null) {
      return { pin, status: "loaded" };
    }
  }

  return blocker(
    "stale_package",
    "Memory capture artifact node requires a readable generated artifact ref."
  );
};

const searchRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof MemoryHydrationNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): readonly ArtifactRef[] =>
  upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.searchRef,
    plan: input.plan,
    stepId: input.config.searchStepId,
    upstreamNodeType: "joelclaw.memory.search",
  });

const correlationRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof MemoryCorrelationNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): {
  readonly hydrationRefs: readonly ArtifactRef[];
  readonly searchRefs: readonly ArtifactRef[];
} => ({
  hydrationRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.hydrationRef,
    plan: input.plan,
    stepId: input.config.hydrationStepId,
    upstreamNodeType: "joelclaw.memory.hydrate",
  }),
  searchRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.searchRef,
    plan: input.plan,
    stepId: input.config.searchStepId,
    upstreamNodeType: "joelclaw.memory.search",
  }),
});

const refinementProposalRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof MemoryRefinementProposalNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): {
  readonly correlationRefs: readonly ArtifactRef[];
  readonly hydrationRefs: readonly ArtifactRef[];
  readonly searchRefs: readonly ArtifactRef[];
  readonly signalsRefs: readonly ArtifactRef[];
} => ({
  correlationRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.correlationRef,
    plan: input.plan,
    stepId: input.config.correlationStepId,
    upstreamNodeType: "joelclaw.memory.correlate",
  }),
  hydrationRefs: reportArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.hydrationRef,
    includeAllCompletedRefs: true,
    plan: input.plan,
    stepId: input.config.hydrationStepId,
    upstreamNodeType: "joelclaw.memory.hydrate",
  }),
  searchRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.searchRef,
    plan: input.plan,
    stepId: input.config.searchStepId,
    upstreamNodeType: "joelclaw.memory.search",
  }),
  signalsRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.signalsRef,
    plan: input.plan,
    stepId: input.config.signalsStepId,
    upstreamNodeType: "joelclaw.memory.signals",
  }),
});

const reportRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof WorkflowHitlReportNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): {
  readonly correlationRefs: readonly ArtifactRef[];
  readonly hydrationRefs: readonly ArtifactRef[];
  readonly refinementProposalRefs: readonly ArtifactRef[];
  readonly searchRefs: readonly ArtifactRef[];
} => ({
  correlationRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.correlationRef,
    plan: input.plan,
    stepId: input.config.correlationStepId,
    upstreamNodeType: "joelclaw.memory.correlate",
  }),
  hydrationRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.hydrationRef,
    plan: input.plan,
    stepId: input.config.hydrationStepId,
    upstreamNodeType: "joelclaw.memory.hydrate",
  }),
  refinementProposalRefs: upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.refinementProposalRef,
    includeLatestDependency: false,
    plan: input.plan,
    stepId: input.config.refinementProposalStepId,
    upstreamNodeType: "joelclaw.memory.refinement-proposals",
  }),
  searchRefs: reportArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.searchRef,
    includeAllCompletedRefs: true,
    plan: input.plan,
    stepId: input.config.searchStepId,
    upstreamNodeType: "joelclaw.memory.search",
  }),
});

const hitlDecisionRefFor = (input: {
  readonly config: z.infer<
    typeof MemoryHitlDecisionWorkflowSeedNodeConfigSchema
  >;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly inputRefs: readonly ArtifactRef[];
}): ArtifactRef | null =>
  input.config.decisionRef ??
  dependencyRefFor({
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    stepId: input.config.decisionStepId,
  }) ??
  input.inputRefs.find((artifactRef) =>
    artifactRef.includes("/hitl-decision.json")
  ) ??
  null;

const hitlReportRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<
    typeof MemoryHitlDecisionWorkflowSeedNodeConfigSchema
  >;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
}): readonly ArtifactRef[] =>
  upstreamArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    explicitRef: input.config.reportRef,
    plan: input.plan,
    stepId: input.config.reportStepId,
    upstreamNodeType: "joelclaw.memory.hitl-report",
  });

const hitlRefinementProposalRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<
    typeof MemoryHitlDecisionWorkflowSeedNodeConfigSchema
  >;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly report: WorkflowHitlReportDocument;
}): readonly ArtifactRef[] =>
  uniqueArtifactRefCandidates([
    ...upstreamArtifactRefCandidatesFor({
      completedStepArtifactRefs: input.completedStepArtifactRefs,
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      explicitRef: input.config.refinementProposalRef,
      includeLatestDependency: false,
      plan: input.plan,
      stepId: input.config.refinementProposalStepId,
      upstreamNodeType: "joelclaw.memory.refinement-proposals",
    }),
    input.report.refinementProposalRef ?? null,
  ]);

const hitlDecisionWorkflowSeedRefCandidatesFor = (input: {
  readonly completedStepArtifactRefs:
    | Readonly<Record<string, ArtifactRef>>
    | undefined;
  readonly config: z.infer<typeof MemoryHitlFollowUpRunRequestNodeConfigSchema>;
  readonly dependencyArtifactRefs: Readonly<Record<string, ArtifactRef>>;
  readonly inputRefs: readonly ArtifactRef[];
  readonly plan: DynamicWorkflowPlanDocument;
}): readonly ArtifactRef[] =>
  uniqueArtifactRefCandidates([
    ...upstreamArtifactRefCandidatesFor({
      completedStepArtifactRefs: input.completedStepArtifactRefs,
      dependencyArtifactRefs: input.dependencyArtifactRefs,
      explicitRef: input.config.seedRef,
      plan: input.plan,
      stepId: input.config.seedStepId,
      upstreamNodeType: "joelclaw.memory.hitl-decision-seed",
    }),
    input.inputRefs.find((artifactRef) =>
      artifactRef.includes("/hitl-decision-workflow-seed.json")
    ) ?? null,
  ]);

interface LoadedReportInputs {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly correlationRef: ArtifactRef;
  readonly hydration: MemoryHydrationDocument;
  readonly hydrationRefs: readonly ArtifactRef[];
  readonly search: MemorySearchDocument;
  readonly searchRefs: readonly ArtifactRef[];
}

const requiredReportRefsPresent = (
  refs: ReturnType<typeof reportRefCandidatesFor>
): BlockedWorkflowNodeExecutionResult | null => {
  if (
    refs.correlationRefs.length === 0 ||
    refs.hydrationRefs.length === 0 ||
    refs.searchRefs.length === 0
  ) {
    return blocker(
      "stale_package",
      "Memory HITL report node requires search, hydration, and correlation artifact refs."
    );
  }

  return null;
};

const receiptKey = (receipt: MemoryReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}:${receipt.hash ?? ""}`;

const mergeSearchDocuments = (
  docs: readonly MemorySearchDocument[]
): MemorySearchDocument => {
  const representative = docs.at(0);
  if (representative === undefined) {
    throw new Error("Cannot merge zero memory search documents.");
  }

  return MemorySearchDocumentSchema.parse({
    ...representative,
    hits: docs.flatMap((doc) => doc.hits),
    skippedSources: [...new Set(docs.flatMap((doc) => doc.skippedSources))],
  });
};

const mergeHydrationDocuments = (
  docs: readonly MemoryHydrationDocument[]
): MemoryHydrationDocument => {
  const representative = docs.at(0);
  if (representative === undefined) {
    throw new Error("Cannot merge zero memory hydration documents.");
  }

  const seen = new Set<string>();
  const hydrated: MemoryHydrationDocument["hydrated"] = [];
  for (const doc of docs) {
    for (const entry of doc.hydrated) {
      const key = receiptKey(entry.receipt);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      hydrated.push(entry);
    }
  }

  return MemoryHydrationDocumentSchema.parse({
    ...representative,
    hydrated,
  });
};

const loadRequiredReportInputs = async (
  artifacts: ArtifactStoreContract,
  refs: ReturnType<typeof reportRefCandidatesFor>
): Promise<LoadedReportInputs | BlockedWorkflowNodeExecutionResult> => {
  const search = await loadAllArtifactCandidates({
    artifactRefs: refs.searchRefs,
    load: (artifactRef) => loadSearch({ artifactRef, artifacts }),
    missingBlockerMessage:
      "Memory HITL report node requires a memory search artifact ref.",
  });
  if (search.status === "blocked") {
    return search;
  }

  const hydration = await loadAllArtifactCandidates({
    artifactRefs: refs.hydrationRefs,
    load: (artifactRef) => loadHydration({ artifactRef, artifacts }),
    missingBlockerMessage:
      "Memory HITL report node requires a memory hydration artifact ref.",
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  const correlation = await loadFirstArtifactCandidate({
    artifactRefs: refs.correlationRefs,
    load: (artifactRef) => loadCorrelation({ artifactRef, artifacts }),
    missingBlockerMessage:
      "Memory HITL report node requires a memory correlation artifact ref.",
  });
  if (correlation.status === "blocked") {
    return correlation;
  }

  return {
    correlation: correlation.document,
    correlationRef: correlation.artifactRef,
    hydration: mergeHydrationDocuments(hydration.documents),
    hydrationRefs: hydration.refs,
    search: mergeSearchDocuments(search.documents),
    searchRefs: search.refs,
  };
};

const loadOptionalRefinementProposalDocument = async (input: {
  readonly artifacts: ArtifactStoreContract;
  readonly refinementProposalRefs: readonly ArtifactRef[];
}): Promise<
  | {
      readonly document: MemoryRefinementProposalDocument | null;
      readonly refinementProposalRef: ArtifactRef | null;
      readonly status: "loaded";
    }
  | BlockedWorkflowNodeExecutionResult
> => {
  if (input.refinementProposalRefs.length === 0) {
    return {
      document: null,
      refinementProposalRef: null,
      status: "loaded",
    };
  }

  const refinementProposals = await loadFirstArtifactCandidate({
    artifactRefs: input.refinementProposalRefs,
    load: (artifactRef) =>
      loadRefinementProposals({
        artifactRef,
        artifacts: input.artifacts,
      }),
    missingBlockerMessage:
      "Memory refinement proposal artifact ref could not be resolved.",
  });
  if (refinementProposals.status === "blocked") {
    return refinementProposals;
  }

  return {
    document: refinementProposals.document,
    refinementProposalRef: refinementProposals.artifactRef,
    status: "loaded",
  };
};

const hydrationReceiptsFor = (input: {
  readonly maxReceipts: number;
  readonly search: MemorySearchDocument;
}): MemoryReceiptRef[] => {
  const receipts: MemoryReceiptRef[] = [];
  const seen = new Set<string>();

  for (const hit of input.search.hits) {
    for (const receipt of hit.receipts) {
      const key = receiptKey(receipt);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      receipts.push(receipt);
      if (receipts.length >= input.maxReceipts) {
        return receipts;
      }
    }
  }

  return receipts;
};

const memoryFamilyLabels: Record<MemorySourceFamily, string> = {
  "agent-transcripts": "agent transcripts",
  brain: "Brain notes",
  "cloudflare-runs": "Cloudflare runs",
  comms: "comms",
  "docs-pdf-brain": "PDF brain",
  "people-org-memory": "people and org memory",
  "repo-outputs": "repo outputs",
  support: "support signals",
};

const d2Label = (value: string): string => JSON.stringify(value);

const mdsvxAttributeString = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const reportStateMachineFigureFor = (input: {
  readonly machine: DynamicWorkflowMachineDocument;
  readonly machineArtifact: DynamicWorkflowPlanDocument["machine"];
}): WorkflowHitlReportDocument["proof"]["stateMachineFigure"] => {
  if (input.machine.machineId !== input.machineArtifact.machineId) {
    throw new Error(
      `Generated report machine id mismatch: ${input.machine.machineId} != ${input.machineArtifact.machineId}.`
    );
  }

  const stateEntries = Object.entries(input.machine.xstate.states);
  const stateIds = new Map(
    stateEntries.map(([stateName], index) => [stateName, `s${index}`])
  );
  const transitions = stateEntries.flatMap(([stateName, state]) =>
    Object.entries(state.on).map(([eventName, transition]) => ({
      eventName,
      from: stateName,
      to: transition.target,
    }))
  );
  const maxFanOut = Math.max(
    0,
    ...stateEntries.map(([, state]) => Object.keys(state.on).length)
  );
  let aspectRatio = "4:5";
  if (stateEntries.length >= 10 && maxFanOut <= 2) {
    aspectRatio = "3:5";
  } else if (maxFanOut >= 3) {
    aspectRatio = "16:9";
  }
  const nodeLines = stateEntries.map(([stateName, state]) => {
    const stateId = stateIds.get(stateName);
    if (stateId === undefined) {
      throw new Error(`Generated machine state id missing for ${stateName}.`);
    }

    const stepSummary =
      state.meta.stepId === undefined ? "" : `\n${state.meta.stepId}`;
    const finalSummary = state.type === "final" ? "\nfinal" : "";

    return `${stateId}: ${d2Label(`${stateName}${stepSummary}${finalSummary}`)}`;
  });
  const edgeLines = transitions.map((transition) => {
    const fromId = stateIds.get(transition.from);
    const toId = stateIds.get(transition.to);
    if (fromId === undefined || toId === undefined) {
      throw new Error(
        `Generated machine transition references an unknown state: ${transition.from} -> ${transition.to}.`
      );
    }

    return `${fromId} -> ${toId}: ${d2Label(transition.eventName)}`;
  });
  const source = [
    "direction: down",
    ...nodeLines,
    ...edgeLines,
    `initial: ${d2Label(input.machine.xstate.initial)}`,
    `machine: ${d2Label(input.machine.machineId)}`,
  ].join("\n");

  return {
    aspectRatio,
    component: "D2",
    machineBinding: {
      machineArtifactHash: input.machineArtifact.hash,
      machineArtifactRef: input.machineArtifact.artifactRef,
      machineId: input.machineArtifact.machineId,
      machineSourceArtifactRef: input.machineArtifact.sourceArtifactRef,
      machineSourceHash: input.machineArtifact.sourceHash,
      status: "bound-to-generated-machine",
    },
    machineId: input.machine.machineId,
    source,
    sourceHash: sha256Hex(source),
    sourceKind: "generated-xstate-machine",
    stateCount: stateEntries.length,
    transitionCount: transitions.length,
  };
};

const frontMatterString = (value: string): string => JSON.stringify(value);

const receiptLineFor = (receipt: MemoryReceiptRef): string =>
  `- ${receipt.family} / ${receipt.sourceId} / ${receipt.receiptId}`;

const ratingForHit = (hit: MemorySearchHit): number =>
  Math.min(10, Math.max(1, Math.round(hit.score * 10)));

const targetKindForHit = (
  hit: MemorySearchHit
): MemoryRefinementProposalTargetKind => {
  const text = hit.summary.toLowerCase();
  const family = hit.receipts.at(0)?.family;

  if (family === "brain") {
    return "kernel-memory";
  }

  if (family === "cloudflare-runs") {
    return "dynamic-workflow-pattern";
  }

  if (family === "repo-outputs") {
    return "package-boundary";
  }

  if (text.includes("schema") || text.includes("type")) {
    return "schema-change";
  }

  if (text.includes("report") || text.includes("hitl")) {
    return "report-node-improvement";
  }

  if (text.includes("package")) {
    return "package-boundary";
  }

  if (text.includes("lease") || text.includes("capability")) {
    return "capability-lease";
  }

  if (text.includes("workflow")) {
    return "dynamic-workflow-pattern";
  }

  return "workflow-node-plugin";
};

const proposedNextStepFor = (
  targetKind: MemoryRefinementProposalTargetKind
): string => {
  if (targetKind === "capability-lease") {
    return "Review the capability boundary and decide whether the next generated workflow needs a new leased port.";
  }

  if (targetKind === "capture-ingest-fix") {
    return "Turn this into a capture or ingest repair task for the separate memory-fabric repair workflow.";
  }

  if (targetKind === "dynamic-workflow-pattern") {
    return "Feed this pattern into the next planner prompt as a generated workflow constraint with proof requirements.";
  }

  if (targetKind === "kernel-memory") {
    return "Promote the accepted claim into the appropriate Brain/kernel artifact with receipt refs.";
  }

  if (targetKind === "package-boundary") {
    return "Decide whether this belongs in a package manifest, export contract, or adapter boundary.";
  }

  if (targetKind === "report-node-improvement") {
    return "Patch the report node or Wzrrd renderer contract so future HITL artifacts are easier to act on.";
  }

  if (targetKind === "schema-change") {
    return "Update the Zod contract first, then regenerate inferred TypeScript surfaces and tests.";
  }

  return "Consider whether this should become an installable workflow-node plugin instead of report prose.";
};

const reportCardForHit = (input: {
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly hit: MemorySearchHit;
  readonly index: number;
}): WorkflowHitlReportCard => {
  const receipt = input.hit.receipts.at(0);
  const familyLabel =
    receipt === undefined
      ? "memory fabric"
      : memoryFamilyLabels[receipt.family];
  const hydrated = input.hit.receipts.some((candidate) =>
    input.hydratedReceiptKeys.has(receiptKey(candidate))
  );
  const targetKind = targetKindForHit(input.hit);

  return {
    failureClass: targetKind,
    rating: ratingForHit(input.hit),
    reasoning: hydrated
      ? "The search hit has matching redacted hydration, so the report can point at receipts without returning full transcripts."
      : "The search hit has receipt metadata but no matching hydration yet, so treat this as a lead instead of a claim.",
    receipts: input.hit.receipts,
    recommendation: `classify as ${targetKind}; ${proposedNextStepFor(
      targetKind
    )}`,
    sourceKind: "search-hit",
    summary: input.hit.summary,
    title: `Search lead ${input.index + 1}: ${familyLabel} -> ${targetKind}`,
  };
};

const reportCardForProposal = (
  proposal: MemoryRefinementProposal
): WorkflowHitlReportCard => ({
  failureClass: proposal.targetKind,
  rating: proposal.rating,
  reasoning: proposal.reasoning,
  receipts: proposal.receipts,
  recommendation: `${proposal.recommendation}: ${proposal.proposedNextStep}`,
  sourceKind: "refinement-proposal",
  summary: proposal.summary,
  title: proposal.title,
});

// Families that resolved at least one search hit carrying at least one receipt.
// A receipt is the proof a family was actually READ — a hit with no receipts is
// not authority. Used to decide whether a PRIMARY family is unread.
const familiesWithReceiptsIn = (
  search: MemorySearchDocument
): Set<MemorySourceFamily> => {
  const families = new Set<MemorySourceFamily>();
  for (const hit of search.hits) {
    for (const receipt of hit.receipts) {
      families.add(receipt.family);
    }
  }

  return families;
};

// The PRIMARY families that resolved zero receipts in this run: the families the
// workflow exists to read but could not. A non-empty result means a dead primary
// source — the run must not masquerade as a confident review over it.
const unreadPrimaryFamiliesFor = (input: {
  readonly primarySourceFamilies: readonly MemorySourceFamily[];
  readonly search: MemorySearchDocument;
}): MemorySourceFamily[] => {
  const resolved = familiesWithReceiptsIn(input.search);

  return input.primarySourceFamilies.filter((family) => !resolved.has(family));
};

// Block: a primary source the run exists to read resolved zero receipts. The
// message names the unread families and the skipped-source caveats that explain
// why (e.g. `...:joelclaw-index-unavailable`) so GET status surfaces a precise,
// redacted blocker instead of a confident bookshelf-review masquerade.
const deadPrimarySourceBlocker = (input: {
  readonly search: MemorySearchDocument;
  readonly unreadPrimaryFamilies: readonly MemorySourceFamily[];
}): BlockedWorkflowNodeExecutionResult => {
  const families = input.unreadPrimaryFamilies.join(", ");
  const skipped =
    input.search.skippedSources.length === 0
      ? "no skipped-source caveats were recorded"
      : `skipped-source caveats: ${input.search.skippedSources.join(", ")}`;

  return blocker(
    "stale_package",
    `Primary source family ${families} resolved zero receipts -- this run cannot be a confident review of it (${skipped}). Fix the source or remove it from the run's primary contract.`
  );
};

const reportCardsFor = (input: {
  readonly hydration: MemoryHydrationDocument;
  readonly refinementProposals: readonly MemoryRefinementProposal[];
  readonly search: MemorySearchDocument;
}): WorkflowHitlReportCard[] => {
  if (input.refinementProposals.length > 0) {
    return input.refinementProposals
      .filter((proposal) => proposal.receipts.length > 0)
      .slice(0, 7)
      .map(reportCardForProposal);
  }

  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) => receiptKey(hydrated.receipt))
  );

  return input.search.hits
    .filter((hit) => hit.receipts.length > 0)
    .slice(0, 7)
    .map((hit, index) =>
      reportCardForHit({
        hit,
        hydratedReceiptKeys,
        index,
      })
    );
};

const proposalSlugFor = (value: string): string => {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 40);

  return slug.length === 0 ? "memory" : slug;
};

const recommendationForProposal = (input: {
  readonly hydrated: boolean;
  readonly rating: number;
  readonly targetKind: MemoryRefinementProposalTargetKind;
}): MemoryRefinementProposalRecommendation => {
  if (input.targetKind === "capture-ingest-fix") {
    return "turn-into-work";
  }

  if (input.hydrated && input.rating >= 8) {
    return "accept";
  }

  if (input.rating >= 7) {
    return "turn-into-work";
  }

  return "hold";
};

const proposalForHit = (input: {
  readonly hit: MemorySearchHit;
  readonly hydratedReceiptKeys: ReadonlySet<string>;
  readonly index: number;
  readonly sourceRefs: readonly ArtifactRef[];
}): MemoryRefinementProposal => {
  const hydrated = input.hit.receipts.some((receipt) =>
    input.hydratedReceiptKeys.has(receiptKey(receipt))
  );
  const rating = ratingForHit(input.hit);
  const targetKind = targetKindForHit(input.hit);

  return {
    proposalId: `proposal:${targetKind}:${input.index + 1}:${proposalSlugFor(
      input.hit.summary
    )}`,
    proposedNextStep: proposedNextStepFor(targetKind),
    rating,
    reasoning: hydrated
      ? "This proposal is backed by redacted hydration, so it can be reviewed without returning raw transcripts."
      : "This proposal is backed by receipt metadata only. Treat it as a lead until hydration exists.",
    receipts: input.hit.receipts,
    recommendation: recommendationForProposal({
      hydrated,
      rating,
      targetKind,
    }),
    sourceRefs: [...input.sourceRefs],
    summary: input.hit.summary,
    targetKind,
    title: `Refine ${targetKind}: ${input.hit.summary}`,
  };
};

const targetKindForSignal = (
  signal: MemorySignalDocument["signals"][number]
): MemoryRefinementProposalTargetKind => {
  if (signal.kind === "workflow-pattern") {
    return "dynamic-workflow-pattern";
  }

  if (signal.kind === "agent-failure" || signal.kind === "friction") {
    return "workflow-node-plugin";
  }

  if (signal.kind === "correction" || signal.kind === "preference") {
    return "kernel-memory";
  }

  return "package-boundary";
};

const signalProposalFor = (input: {
  readonly index: number;
  readonly signal: MemorySignalDocument["signals"][number];
  readonly sourceRefs: readonly ArtifactRef[];
}): MemoryRefinementProposal => {
  const targetKind = targetKindForSignal(input.signal);

  return {
    proposalId: `proposal:${targetKind}:signal:${input.index + 1}:${proposalSlugFor(
      input.signal.signalId
    )}`,
    proposedNextStep: proposedNextStepFor(targetKind),
    rating: Math.min(10, Math.max(1, input.signal.rating * 2)),
    reasoning: input.signal.reasoning,
    receipts: input.signal.receipts,
    recommendation:
      targetKind === "workflow-node-plugin" || input.signal.rating >= 4
        ? "turn-into-work"
        : "hold",
    sourceRefs: [...input.sourceRefs],
    summary: input.signal.summary,
    targetKind,
    title: `Refine ${targetKind} from ${input.signal.kind}: ${input.signal.summary}`,
  };
};

// Assemble the hash-pinned refinement-proposals document from an already-built,
// already-sorted proposal list. Shared by BOTH paths: the deterministic
// template-fill path (reasoningMode "mechanical") and the agentic reasoning
// path (reasoningMode "agentic"). The deterministic envelope — nextWorkflowSeed,
// sourceRefs, redaction, the schema parse — is identical regardless of how the
// proposals were reasoned; only the proposals themselves and the honesty label
// differ. This is the "stochastic dream, deterministic envelope" boundary made
// literal: reasoning is upstream, recording is here.
const refinementProposalDocumentFromProposals = (input: {
  readonly proposals: readonly MemoryRefinementProposal[];
  readonly reasoningMode: MemoryRefinementReasoningMode;
  readonly reasoningNote?: string;
  readonly runId: string;
  readonly sourceRefs: readonly ArtifactRef[];
  readonly workItemId: string;
}): MemoryRefinementProposalDocument =>
  MemoryRefinementProposalDocumentSchema.parse({
    generatedAt: new Date().toISOString(),
    nextWorkflowSeed: {
      plannerInstructions: [
        "Use accepted refinement proposals as constraints for the next generated workflow.",
        "Do not treat proposal text as proof; follow sourceRefs and receipts before updating Brain or packages.",
        "Route capture or ingest gaps to the separate memory-fabric repair workflow instead of folding them into this workflow.",
      ],
      proposalIds: input.proposals.map((proposal) => proposal.proposalId),
      requiredCapabilityKinds: [
        ...new Set(
          input.proposals.flatMap((proposal) =>
            proposal.targetKind === "capability-lease"
              ? ["capability-lease.review"]
              : []
          )
        ),
      ],
      sourceRefs: [...input.sourceRefs],
    },
    proposalCount: input.proposals.length,
    proposals: [...input.proposals],
    reasoningMode: input.reasoningMode,
    ...(input.reasoningNote === undefined
      ? {}
      : { reasoningNote: input.reasoningNote }),
    redacted: true,
    runId: input.runId,
    schemaVersion: "memory.refinement-proposals.v1",
    sourceRefs: [...input.sourceRefs],
    workItemId: input.workItemId,
  });

const refinementProposalDocumentFor = (input: {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly correlationRef: ArtifactRef;
  readonly hydration: MemoryHydrationDocument;
  readonly hydrationRef: ArtifactRef;
  readonly maxProposals: number;
  readonly search: MemorySearchDocument;
  readonly searchRef: ArtifactRef;
  readonly signals: MemorySignalDocument;
  readonly signalsRef: ArtifactRef;
}): MemoryRefinementProposalDocument => {
  const sourceRefs = [
    input.signalsRef,
    input.searchRef,
    input.hydrationRef,
    input.correlationRef,
  ];
  const hydratedReceiptKeys = new Set(
    input.hydration.hydrated.map((hydrated) => receiptKey(hydrated.receipt))
  );
  const signalProposals = input.signals.signals.map((signal, index) =>
    signalProposalFor({
      index,
      signal,
      sourceRefs: [input.signalsRef],
    })
  );
  const hitProposals = input.search.hits.map((hit, index) =>
    proposalForHit({
      hit,
      hydratedReceiptKeys,
      index,
      sourceRefs: [input.searchRef, input.hydrationRef, input.correlationRef],
    })
  );
  const proposals = [...signalProposals, ...hitProposals]
    .toSorted((left, right) => right.rating - left.rating)
    .slice(0, input.maxProposals);

  return refinementProposalDocumentFromProposals({
    proposals,
    reasoningMode: "mechanical",
    runId: input.search.runId,
    sourceRefs,
    workItemId: input.search.workItemId,
  });
};

// A receipt's stable identity for agentic citation: sourceId:receiptId. The
// reasoning lane cites receipts by this key (it is given the same keys in the
// prompt), and the node binds the key back to the REAL loaded receipt object.
// An agentic finding that cites a key with no match in the evidence cited
// nothing real and its key is dropped; a finding left with no real receipt is
// discarded entirely. This is the boundary that stops a reasoning agent from
// smuggling a fabricated receipt past the hash-pinned recording.
const evidenceReceiptKey = (receipt: MemoryReceiptRef): string =>
  `${receipt.sourceId}:${receipt.receiptId}`;

// Build the citation index the reasoning lane is shown and the node binds
// against: every receipt that appears in a search hit or hydrated item, keyed by
// evidenceReceiptKey, first occurrence wins. Only these receipts are citable.
const evidenceReceiptIndexFor = (input: {
  readonly hydration: MemoryHydrationDocument;
  readonly search: MemorySearchDocument;
}): Map<string, MemoryReceiptRef> => {
  const index = new Map<string, MemoryReceiptRef>();
  const consider = (receipt: MemoryReceiptRef): void => {
    const key = evidenceReceiptKey(receipt);
    if (!index.has(key)) {
      index.set(key, receipt);
    }
  };
  for (const hit of input.search.hits) {
    for (const receipt of hit.receipts) {
      consider(receipt);
    }
  }
  for (const hydrated of input.hydration.hydrated) {
    consider(hydrated.receipt);
  }

  return index;
};

// The body of the analysis-method kernel skill the agentic node reasons WITH.
// This is the consumption path for nodes: the same `resolveKernelSkills` output
// the planner reads, filtered to the analysis skill so the lane is shaped by
// the authored "cluster -> friction -> rate by recurrence+impact -> tie to
// receipts -> propose a concrete change" guidance instead of guessing. Returns
// the joined bodies of every resolved skill whose id mentions "analysis", or
// every resolved skill when none match (a kit without an analysis skill still
// shapes the lane with whatever guidance it does carry); `null` when no kernel
// skill resolved at all, which the caller treats as "no skill to reason with".
const analysisSkillBodyFor = (
  skills: readonly ResolvedKernelSkill[]
): string | null => {
  if (skills.length === 0) {
    return null;
  }
  const analysisSkills = skills.filter((skill) =>
    skill.skillId.toLowerCase().includes("analysis")
  );
  const chosen = analysisSkills.length > 0 ? analysisSkills : skills;

  return chosen
    .map((skill) => `### ${skill.skillId} — ${skill.title}\n\n${skill.body}`)
    .join("\n\n");
};

// Assemble the agentic propose-refinements prompt: the run goal, the analysis
// skill, the citable receipt-key index, and the REDACTED evidence (search-hit
// summaries, hydrated redacted excerpts/summaries, correlation edges). No raw
// transcripts, locators, or credentials cross this boundary — only the redacted
// fields the relay already returned. The output contract is the agentic
// refinement schema; the node re-binds receipt keys afterward.
const agenticRefinementPromptFor = (input: {
  readonly analysisSkillBody: string;
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly hydration: MemoryHydrationDocument;
  readonly maxProposals: number;
  readonly outputJsonSchema: string;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly receiptIndex: ReadonlyMap<string, MemoryReceiptRef>;
  readonly search: MemorySearchDocument;
  readonly signals: MemorySignalDocument;
}): string => {
  const evidenceHits = input.search.hits.map((hit) => ({
    horizon: hit.horizon,
    receiptKeys: hit.receipts.map(evidenceReceiptKey),
    redactedExcerpt: hit.redactedExcerpt,
    score: hit.score,
    summary: hit.summary,
  }));
  const evidenceHydrated = input.hydration.hydrated.map((hydrated) => ({
    receiptKey: evidenceReceiptKey(hydrated.receipt),
    redactedExcerpt: hydrated.redactedExcerpt,
    summary: hydrated.summary,
  }));
  const evidenceSignals = input.signals.signals.map((signal) => ({
    kind: signal.kind,
    rating: signal.rating,
    reasoning: signal.reasoning,
    receiptKeys: signal.receipts.map(evidenceReceiptKey),
    summary: signal.summary,
  }));
  const evidenceCorrelationEdges = input.correlation.edges.map((edge) => ({
    receiptKeys: edge.evidence.map(evidenceReceiptKey),
    relationship: edge.relationship,
  }));

  return [
    "# Dream Analysis Lane: propose refinements",
    "",
    "You are the analytical reasoning step of a memory-fabric dream. Reason over the REDACTED evidence below and produce refinement proposals a human can act on. Emit only JSON matching the output schema. Do not wrap the JSON in Markdown. Do not call tools or perform side effects. The evidence is already redacted; never ask for raw transcripts.",
    "",
    "## Run goal",
    "",
    input.plan.proposal.intent,
    "",
    "## Analysis method (kernel skill — follow this)",
    "",
    input.analysisSkillBody,
    "",
    "## Citable receipts",
    "",
    "These are the ONLY receipt keys you may cite. Each finding's receiptKeys must be a non-empty subset of these. A finding citing a key not listed here will be dropped; cite only what the evidence proves.",
    "",
    JSON.stringify([...input.receiptIndex.keys()], null, 2),
    "",
    "## Evidence: search hits (redacted)",
    "",
    JSON.stringify(evidenceHits, null, 2),
    "",
    "## Evidence: hydrated receipts (redacted)",
    "",
    JSON.stringify(evidenceHydrated, null, 2),
    "",
    "## Evidence: mined signals (redacted)",
    "",
    JSON.stringify(evidenceSignals, null, 2),
    "",
    "## Evidence: correlation edges",
    "",
    JSON.stringify(evidenceCorrelationEdges, null, 2),
    "",
    "## Output requirements",
    "",
    `Return at most ${input.maxProposals} findings. Ratings MUST discriminate (do not flatten everything to 8+); derive each rating from recurrence + impact as the analysis method describes. Each finding ties to specific receiptKeys, ends in one concrete proposedChange naming the artifact and edit, and carries a recommendation and targetKind from the allowed enums. Fewer real findings beats a wall of high-rated slop.`,
    "",
    "## Output JSON Schema",
    "",
    input.outputJsonSchema,
  ].join("\n");
};

// Map ONE reasoned finding to a real MemoryRefinementProposal, binding its cited
// receiptKeys to the actual loaded receipts and dropping unknown keys. Returns
// null when the finding cites no real receipt — a claim with no receipt is a
// hallucination and is discarded, exactly as the analysis method demands.
const proposalFromAgenticFinding = (input: {
  readonly finding: MemoryAgenticRefinementProposal;
  readonly index: number;
  readonly receiptIndex: ReadonlyMap<string, MemoryReceiptRef>;
  readonly sourceRefs: readonly ArtifactRef[];
}): MemoryRefinementProposal | null => {
  const receipts = input.finding.receiptKeys.flatMap((key) => {
    const receipt = input.receiptIndex.get(key);

    return receipt === undefined ? [] : [receipt];
  });
  if (receipts.length === 0) {
    return null;
  }

  return {
    proposalId: `proposal:agentic:${input.finding.targetKind}:${input.index + 1}:${proposalSlugFor(
      input.finding.summary
    )}`,
    proposedNextStep: input.finding.proposedChange,
    rating: input.finding.rating,
    reasoning: input.finding.reasoning,
    receipts,
    recommendation: input.finding.recommendation,
    sourceRefs: [...input.sourceRefs],
    summary: input.finding.summary,
    targetKind: input.finding.targetKind,
    title: input.finding.title,
  };
};

// Bind a reasoned finding set to real receipts, drop hallucinated/unsupported
// findings, sort by rating, and cap. Returns the proposals plus the count
// dropped for the reasoning note, so the recorded document stays honest about
// how much of the agent's output survived the receipt-binding boundary.
const agenticProposalsFromReasoning = (input: {
  readonly findings: readonly MemoryAgenticRefinementProposal[];
  readonly maxProposals: number;
  readonly receiptIndex: ReadonlyMap<string, MemoryReceiptRef>;
  readonly sourceRefs: readonly ArtifactRef[];
}): {
  readonly droppedCount: number;
  readonly proposals: MemoryRefinementProposal[];
} => {
  const bound = input.findings.flatMap((finding, index) => {
    const proposal = proposalFromAgenticFinding({
      finding,
      index,
      receiptIndex: input.receiptIndex,
      sourceRefs: input.sourceRefs,
    });

    return proposal === null ? [] : [proposal];
  });
  const proposals = bound
    .toSorted((left, right) => right.rating - left.rating)
    .slice(0, input.maxProposals);

  return {
    droppedCount: input.findings.length - bound.length,
    proposals,
  };
};

const actionableHitlDecisionsFor = (
  document: MemoryHitlDecisionDocument
): MemoryHitlDecisionDocument["decisions"] =>
  document.decisions.filter(
    (decision) =>
      decision.decision === "accept" || decision.decision === "turn-into-work"
  );

const uniqueArtifactRefs = (refs: readonly ArtifactRef[]): ArtifactRef[] => [
  ...new Set(refs),
];

const uniqueStrings = (values: readonly string[]): string[] => [
  ...new Set(values),
];

type ActionableRefinementProposal = MemoryRefinementProposal & {
  readonly recommendation: "accept" | "turn-into-work";
};

const isActionableRefinementProposal = (
  proposal: MemoryRefinementProposal
): proposal is ActionableRefinementProposal =>
  proposal.recommendation === "accept" ||
  proposal.recommendation === "turn-into-work";

const artifactUpdateTargetKindForProposal = (
  targetKind: MemoryRefinementProposalTargetKind
): MemoryHitlDecisionArtifactUpdateTargetKind => {
  switch (targetKind) {
    case "capability-lease": {
      return "capability-lease";
    }
    case "kernel-memory": {
      return "brain";
    }
    case "package-boundary":
    case "workflow-node-plugin": {
      return "package";
    }
    case "report-node-improvement": {
      return "report";
    }
    case "schema-change": {
      return "schema";
    }
    case "capture-ingest-fix":
    case "dynamic-workflow-pattern": {
      return "workflow";
    }
    default: {
      const exhaustive: never = targetKind;
      return exhaustive;
    }
  }
};

const generatedHitlDraftDecisionPathFor = (
  step: WorkflowNodeInvocationStep
): string =>
  siblingArtifactPath({
    extension: "generated-draft-decision.json",
    outputPath: step.outputPath,
  });

const generatedDraftHitlDecisionDocumentFor = (input: {
  readonly actor: MemoryWorkflowNodeExecutionInput["actor"];
  readonly generatedAt: string;
  readonly refinementProposalRef: ArtifactRef | null;
  readonly refinementProposals: MemoryRefinementProposalDocument | null;
  readonly report: WorkflowHitlReportDocument;
  readonly reportRef: ArtifactRef;
}): MemoryHitlDecisionDocument => {
  const proposals =
    input.refinementProposals?.proposals ?? input.report.refinementProposals;
  const actionableProposals = proposals.filter(isActionableRefinementProposal);
  const sourceRefs = uniqueArtifactRefs([
    input.reportRef,
    ...(input.refinementProposalRef === null
      ? []
      : [input.refinementProposalRef]),
    ...input.report.sourceRefs,
    ...(input.refinementProposals?.sourceRefs ?? []),
    ...actionableProposals.flatMap((proposal) => proposal.sourceRefs),
  ]);
  const decisions: MemoryHitlDecision[] = actionableProposals.map(
    (proposal) => ({
      decision: proposal.recommendation,
      decisionId: `decision:draft:${proposalSlugFor(proposal.proposalId)}`,
      rating: proposal.rating,
      reasoning: `Generated draft from refinement proposal ${proposal.proposalId}: ${proposal.reasoning}`,
      receiptTrail: proposal.receipts,
      recommendation: `DRAFT, not human-approved: ${proposal.proposedNextStep}`,
      reviewedAt: input.generatedAt,
      sourceRefs: uniqueArtifactRefs([
        input.reportRef,
        ...(input.refinementProposalRef === null
          ? []
          : [input.refinementProposalRef]),
        ...proposal.sourceRefs,
      ]),
      summary: `Draft from refinement proposal: ${proposal.summary}`,
      targetId: proposal.proposalId,
      targetKind: "refinement-proposal",
      targetTitle: proposal.title,
    })
  );
  const nextWorkflowSourceRefs = uniqueArtifactRefs([
    ...sourceRefs,
    ...(input.refinementProposals?.nextWorkflowSeed.sourceRefs ?? []),
  ]);

  return MemoryHitlDecisionDocumentSchema.parse({
    decisionCount: decisions.length,
    decisions,
    generatedAt: input.generatedAt,
    nextWorkflowSeed: {
      artifactUpdateTargets: actionableProposals.map((proposal) => ({
        sourceRefs: uniqueArtifactRefs([
          input.reportRef,
          ...(input.refinementProposalRef === null
            ? []
            : [input.refinementProposalRef]),
          ...proposal.sourceRefs,
        ]),
        summary: `Generated draft from ${proposal.proposalId}: ${proposal.proposedNextStep}`,
        targetKind: artifactUpdateTargetKindForProposal(proposal.targetKind),
      })),
      decisionIds: decisions.map((decision) => decision.decisionId),
      plannerInstructions:
        decisions.length === 0
          ? []
          : uniqueStrings([
              "This is a generated draft seed from the Dream report and refinement proposals, not a human approval. Keep follow-up output reviewable and submitted:false until a human accepts it.",
              "Convert draft accepted/work-conversion proposals into source-backed Brain/package/workflow/schema/report/capability artifact update drafts; do not perform side effects without explicit leased review gates.",
              ...(input.refinementProposals?.nextWorkflowSeed
                .plannerInstructions ?? []),
            ]),
      requiredCapabilityKinds: uniqueStrings([
        ...(input.refinementProposals?.nextWorkflowSeed
          .requiredCapabilityKinds ?? []),
        ...(decisions.length === 0 ? [] : ["brain.update.review"]),
      ]),
      sourceRefs: decisions.length === 0 ? [] : nextWorkflowSourceRefs,
    },
    redacted: true,
    ...(input.refinementProposalRef === null
      ? {}
      : { refinementProposalRef: input.refinementProposalRef }),
    reportRef: input.reportRef,
    reviewer: input.actor,
    runId: input.report.runId,
    schemaVersion: "memory.hitl-decision.v1",
    sourceRefs,
    workItemId: input.report.workItemId,
  });
};

const hitlDecisionWorkflowSeedDocumentFor = (input: {
  readonly decision: MemoryHitlDecisionDocument;
  readonly decisionRef: ArtifactRef;
  readonly decisionSource?: "generated-draft" | "human-review";
}): MemoryHitlDecisionWorkflowSeedDocument => {
  const actionableDecisions = actionableHitlDecisionsFor(input.decision);
  const acceptedDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "accept")
    .map((decision) => decision.decisionId);
  const workItemDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "turn-into-work")
    .map((decision) => decision.decisionId);
  const heldDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "hold")
    .map((decision) => decision.decisionId);
  const rejectedDecisionIds = input.decision.decisions
    .filter((decision) => decision.decision === "reject")
    .map((decision) => decision.decisionId);
  const sourceRefs = uniqueArtifactRefs([
    input.decisionRef,
    input.decision.reportRef,
    ...(input.decision.refinementProposalRef === undefined
      ? []
      : [input.decision.refinementProposalRef]),
    ...input.decision.sourceRefs,
    ...input.decision.nextWorkflowSeed.sourceRefs,
    ...input.decision.decisions.flatMap((decision) => decision.sourceRefs),
    ...input.decision.nextWorkflowSeed.artifactUpdateTargets.flatMap(
      (target) => target.sourceRefs
    ),
  ]);
  const status =
    actionableDecisions.length === 0
      ? "no-actionable-decisions"
      : ("ready" as const);
  const sourceLabel =
    input.decisionSource === "generated-draft" ? "Generated draft" : "HITL";
  const summary =
    status === "ready"
      ? `${sourceLabel} accepted ${acceptedDecisionIds.length} decision(s) and turned ${workItemDecisionIds.length} decision(s) into work; the next generated workflow must consume ${input.decision.nextWorkflowSeed.plannerInstructions.length} planner instruction(s).`
      : `${sourceLabel} did not accept or turn any decision into work; the next generated workflow seed is intentionally empty.`;

  return MemoryHitlDecisionWorkflowSeedDocumentSchema.parse({
    acceptedDecisionIds,
    actionableDecisionCount: actionableDecisions.length,
    actionableDecisions,
    decisionRef: input.decisionRef,
    ...(input.decisionSource === undefined
      ? {}
      : { decisionSource: input.decisionSource }),
    generatedAt: new Date().toISOString(),
    heldDecisionIds,
    nextWorkflowSeed: input.decision.nextWorkflowSeed,
    redacted: true,
    ...(input.decision.refinementProposalRef === undefined
      ? {}
      : { refinementProposalRef: input.decision.refinementProposalRef }),
    rejectedDecisionIds,
    reportRef: input.decision.reportRef,
    runId: input.decision.runId,
    schemaVersion: "memory.hitl-decision-workflow-seed.v1",
    sourceRefs,
    status,
    summary,
    workItemDecisionIds,
    workItemId: input.decision.workItemId,
  });
};

const followUpRunRequestIntentFor = (
  seed: MemoryHitlDecisionWorkflowSeedDocument
): string =>
  seed.decisionSource === "generated-draft"
    ? `Run the next generated workflow from generated draft Dream decisions for ${seed.workItemId}. Convert the accepted/work-conversion draft decisions into reviewable Brain/package/workflow/schema/report/capability artifact updates, preserving source receipts and capability requirements; do not treat the draft as human approval.`
    : `Run the next generated workflow from accepted HITL decisions for ${seed.workItemId}. Convert the accepted/work-conversion decisions into reviewable Brain/package/workflow/schema/report/capability artifact updates, preserving source receipts and capability requirements.`;

const followUpRunRequestNotesFor = (input: {
  readonly seed: MemoryHitlDecisionWorkflowSeedDocument;
  readonly seedRef: ArtifactRef;
}): string[] => {
  const artifactTargets = input.seed.nextWorkflowSeed.artifactUpdateTargets.map(
    (target) =>
      `Artifact update target ${target.targetKind}: ${target.summary}; sourceRefs ${target.sourceRefs.join(", ")}.`
  );
  const capabilityKinds =
    input.seed.nextWorkflowSeed.requiredCapabilityKinds.length === 0
      ? ["No extra capability kinds were declared by the HITL seed."]
      : [
          `Required capability kinds before side effects: ${input.seed.nextWorkflowSeed.requiredCapabilityKinds.join(", ")}.`,
        ];

  return [
    `Consume HITL decision workflow seed ${input.seedRef}.`,
    input.seed.decisionSource === "generated-draft"
      ? "Decision source: generated draft from the Dream report/refinement proposals; this is planner input only and not human approval."
      : "Decision source: human HITL review artifact.",
    `Actionable decision ids: ${input.seed.nextWorkflowSeed.decisionIds.join(", ")}.`,
    ...input.seed.nextWorkflowSeed.plannerInstructions,
    ...capabilityKinds,
    ...artifactTargets,
    `Source refs for verification: ${input.seed.sourceRefs.join(", ")}.`,
    "Generate a fresh workflow.xstate-machine.v1 config, generated TypeScript source, generated harness source, and verifier proof for this follow-up work.",
    "Do not mutate Brain, packages, schemas, reports, source indexes, or capability policies unless the generated workflow has explicit leased side-effect receipts and review gates.",
    "Prefer reviewable artifact or GitHub PR delivery for repo-backed artifact updates; keep unleased updates as artifacts for human review.",
  ];
};

const hitlFollowUpRunRequestDocumentFor = (input: {
  readonly actor: MemoryWorkflowNodeExecutionInput["actor"];
  readonly config: z.infer<typeof MemoryHitlFollowUpRunRequestNodeConfigSchema>;
  readonly seed: MemoryHitlDecisionWorkflowSeedDocument;
  readonly seedRef: ArtifactRef;
}): MemoryHitlFollowUpRunRequestDocument => {
  const status =
    input.seed.status === "ready" && input.seed.actionableDecisionCount > 0
      ? "drafted"
      : ("no-actionable-decisions" as const);
  const requestedPackageIds = uniqueStrings(input.config.requestedPackageIds);
  const followUpRunId =
    input.config.runId ??
    `run-memory-hitl-follow-up-${proposalSlugFor(input.seed.runId)}`;
  const followUpWorkItemId =
    input.config.workItemId ??
    `work-item:memory-hitl-follow-up:${proposalSlugFor(input.seed.workItemId)}`;
  const request =
    status === "drafted"
      ? {
          actor: input.actor,
          planProposal: {
            intent: followUpRunRequestIntentFor(input.seed),
            requestedPackageIds,
            stochasticNotes: followUpRunRequestNotesFor({
              seed: input.seed,
              seedRef: input.seedRef,
            }),
          },
          runId: followUpRunId,
          workItemId: followUpWorkItemId,
        }
      : undefined;
  const summary =
    status === "drafted"
      ? `Drafted follow-up workflow request ${followUpRunId} from ${input.seed.actionableDecisionCount} actionable HITL decision(s).`
      : "No follow-up workflow request was drafted because the HITL decision seed had no actionable decisions.";

  return MemoryHitlFollowUpRunRequestDocumentSchema.parse({
    actionableDecisionCount: input.seed.actionableDecisionCount,
    artifactUpdateTargets: input.seed.nextWorkflowSeed.artifactUpdateTargets,
    decisionWorkflowSeedRef: input.seedRef,
    generatedAt: new Date().toISOString(),
    redacted: true,
    ...(request === undefined ? {} : { request }),
    requestedPackageIds,
    requiredCapabilityKinds:
      input.seed.nextWorkflowSeed.requiredCapabilityKinds,
    runId: input.seed.runId,
    schemaVersion: "memory.hitl-follow-up-run-request.v1",
    sourceRefs: uniqueArtifactRefs([input.seedRef, ...input.seed.sourceRefs]),
    status,
    submitted: false,
    summary,
    workItemId: input.seed.workItemId,
  });
};

const reportCardMdsvxFor = (finding: WorkflowHitlReportCard): string =>
  [
    `### ${finding.title}`,
    finding.summary,
    `**Failure class.** ${finding.failureClass}`,
    `**Source.** ${finding.sourceKind}`,
    `**Reasoning.** ${finding.reasoning}`,
    `**Rating.** ${finding.rating}/10`,
    `**Recommendation.** ${finding.recommendation}`,
    "**Receipts.**",
    finding.receipts.map(receiptLineFor).join("\n"),
  ].join("\n\n");

const reportActionLineFor = (finding: WorkflowHitlReportCard): string =>
  `- **${finding.title}** Rating ${finding.rating}/10. ${finding.recommendation}`;

const refinementProposalActionLineFor = (
  proposal: MemoryRefinementProposal
): string =>
  `- **${proposal.title}** ${proposal.rating}/10. ${proposal.recommendation}: ${proposal.proposedNextStep}`;

const hitlDecisionContractFor = (
  sourceRefs: readonly ArtifactRef[]
): MemoryHitlDecisionContract =>
  MemoryHitlDecisionContractSchema.parse({
    artifactPath: "report/hitl-decision.json",
    contractRef: "contract://workflow/memory-fabric/hitl-decision.v1",
    decisionSchemaVersion: "memory.hitl-decision.v1",
    exportId: "memory-hitl-decision-schema",
    nextWorkflowSeedRequiredFor: ["accept", "turn-into-work"],
    sourceRefs,
    targetKinds: ["finding-card", "refinement-proposal"],
  });

type WorkflowHitlReportDefinitionOfDoneAuditItemInput = Omit<
  WorkflowHitlReportDefinitionOfDoneAuditItem,
  "blockerRefs" | "evidenceRefs"
> & {
  readonly blockerRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
};

const reportAuditItem = (
  item: WorkflowHitlReportDefinitionOfDoneAuditItemInput
): WorkflowHitlReportDefinitionOfDoneAuditItem => ({
  blockerRefs: [...(item.blockerRefs ?? [])],
  evidenceRefs: [...(item.evidenceRefs ?? [])],
  requirement: item.requirement,
  requirementId: item.requirementId,
  status: item.status,
  summary: item.summary,
});

const reportAuditStatusFor = (
  items: readonly WorkflowHitlReportDefinitionOfDoneAuditItem[]
): WorkflowHitlReportDefinitionOfDoneAudit["status"] => {
  if (
    items.some((item) => item.status === "blocked" || item.status === "missing")
  ) {
    return "blocked";
  }

  return items.some((item) => item.status === "not-proven")
    ? "not-proven"
    : "captured";
};

const reportDefinitionOfDoneAuditFor = (input: {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly findingCount: number;
  readonly generatedAt: string;
  readonly hydration: MemoryHydrationDocument;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly proofLevel: WorkflowHitlReportProofLevel;
  readonly refinementProposalCount: number;
  readonly runId: string;
  readonly search: MemorySearchDocument;
  readonly sourceRefs: readonly ArtifactRef[];
  readonly stateMachineFigure: WorkflowHitlReportDocument["proof"]["stateMachineFigure"];
}): WorkflowHitlReportDefinitionOfDoneAudit => {
  const generatedArtifactRefs = [
    input.plan.machine.artifactRef,
    input.plan.machine.sourceArtifactRef,
    input.plan.harness.artifactRef,
    input.plan.verificationContract.artifactRef,
  ];
  const tShapedCoverageCaptured =
    input.search.hits.length > 0 &&
    input.hydration.hydrated.length > 0 &&
    input.correlation.edges.length > 0;
  const unsafeHydrationCount = input.hydration.hydrated.filter(
    (hydrated) => hydrated.fullTranscriptReturned
  ).length;
  const findingsAndRefinementsCaptured =
    input.findingCount > 0 && input.refinementProposalCount > 0;
  const tShapedGapSummary = input.search.skippedSources.map(
    (skippedSource) => `${skippedSource}:skipped-source`
  );

  const items = [
    reportAuditItem({
      evidenceRefs: ["node:joelclaw.memory.hitl-report", ...input.sourceRefs],
      requirement:
        "The HITL report is emitted by the installed workflow cartridge/package.",
      requirementId: "workflow-cartridge-package",
      status: "captured",
      summary:
        "`joelclaw.memory.hitl-report` produced the JSON/MDSvX report as a cartridge-owned workflow node.",
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "Cloudflare leases memory search/hydration/correlation capabilities through the trusted relay.",
      requirementId: "worker-facing-relay-capability-lease",
      status: "not-proven",
      summary:
        "This report consumes run artifacts but does not prove relay lease sidecars; `memory.generated-workflow-proof.v1` must verify them.",
    }),
    reportAuditItem({
      evidenceRefs: generatedArtifactRefs,
      requirement:
        "The run is submitted to and executed by the deployed Cloudflare workflow app.",
      requirementId: "live-cloudflare-execution",
      status: "not-proven",
      summary:
        "The report is not the Cloudflare execution receipt; require `workflow.execution-proof.v1` and verifier acceptance for the surrounding run.",
    }),
    reportAuditItem({
      evidenceRefs: generatedArtifactRefs,
      requirement:
        "A real planner generates and pins workflow.xstate-machine.v1 plus generated harness/source/hash artifacts.",
      requirementId: "generated-machine-and-harness",
      status:
        input.proofLevel === "generated-machine" &&
        input.stateMachineFigure.machineBinding.status ===
          "bound-to-generated-machine"
          ? "captured"
          : "not-proven",
      summary:
        input.proofLevel === "generated-machine"
          ? `Generated machine, source, harness, and verifier contract are hash-pinned; D2 source hash ${input.stateMachineFigure.sourceHash}.`
          : `Report proof level is ${input.proofLevel}, so generated machine execution is not proven by this report.`,
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "The run reads T-shaped across time horizons with hydration and correlation; coverage gaps are reported as caveats, never hidden.",
      requirementId: "t-shaped-memory-coverage",
      status: tShapedCoverageCaptured ? "captured" : "not-proven",
      summary: tShapedCoverageCaptured
        ? `Retrieval produced ${input.search.hits.length} search hit(s), ${input.hydration.hydrated.length} hydrated receipt(s), and ${input.correlation.edges.length} correlation edge(s).`
        : `Coverage gaps are explicit, not hidden: ${tShapedGapSummary.join(", ") || "missing search, hydration, or correlation evidence"}.`,
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "The run emits actionable findings and refinement proposals for kernel/package/workflow/schema/access/report changes.",
      requirementId: "findings-and-refinement-proposals",
      status: findingsAndRefinementsCaptured ? "captured" : "not-proven",
      summary: findingsAndRefinementsCaptured
        ? `Report contains ${input.findingCount} finding card(s) and ${input.refinementProposalCount} refinement proposal(s).`
        : `Report contains ${input.findingCount} finding card(s) and ${input.refinementProposalCount} refinement proposal(s); this is diagnostic, not a complete refinement loop.`,
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "Accepted findings produce HITL decision, workflow seed, and follow-up run request artifacts that feed the next generated workflow.",
      requirementId: "hitl-refinement-loop",
      status: "not-proven",
      summary:
        "The report emits the HITL decision contract; decision seed and follow-up run request artifacts are post-report workflow nodes.",
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "The Cloudflare workflow publishes the canonical Tufte/MDSvX Wzrrd HITL report through a leased side effect.",
      requirementId: "workflow-owned-wzrrd-output",
      status: "not-proven",
      summary:
        "The report node renders MDSvX only; leased `wzrrd.site.publish` delivery is a separate post-verifier side effect.",
    }),
    reportAuditItem({
      evidenceRefs: input.sourceRefs,
      requirement:
        "Public artifacts remain redacted: no raw credentials, raw private paths, or raw transcripts.",
      requirementId: "public-private-redaction-boundary",
      status: unsafeHydrationCount === 0 ? "captured" : "blocked",
      summary:
        unsafeHydrationCount === 0
          ? "Report and hydration artifacts assert redacted evidence only; raw transcripts were not returned."
          : `${unsafeHydrationCount} hydration item(s) returned full transcripts and must not be published.`,
    }),
  ];
  const summary = {
    blockedCount: items.filter((item) => item.status === "blocked").length,
    capturedCount: items.filter((item) => item.status === "captured").length,
    missingCount: items.filter((item) => item.status === "missing").length,
    notProvenCount: items.filter((item) => item.status === "not-proven").length,
    totalCount: items.length,
  };

  return WorkflowHitlReportDefinitionOfDoneAuditSchema.parse({
    generatedAt: input.generatedAt,
    items,
    redacted: true,
    runId: input.runId,
    schemaVersion: "workflow.hitl-report.definition-of-done-audit.v1",
    status: reportAuditStatusFor(items),
    summary,
  });
};

const reportDefinitionOfDoneAuditMdsvxFor = (
  audit: WorkflowHitlReportDefinitionOfDoneAudit
): string =>
  [
    `Audit status: ${audit.status}. Captured ${audit.summary.capturedCount}/${audit.summary.totalCount}; blocked ${audit.summary.blockedCount}; missing ${audit.summary.missingCount}; not proven ${audit.summary.notProvenCount}.`,
    "",
    ...audit.items.map(
      (item) => `- ${item.requirementId}: ${item.status} -- ${item.summary}`
    ),
  ].join("\n");

const reportMdsvxFor = (input: {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly definitionOfDoneAudit: WorkflowHitlReportDefinitionOfDoneAudit;
  readonly hitlDecisionContract: MemoryHitlDecisionContract;
  readonly findingCount: number;
  readonly findings: readonly WorkflowHitlReportCard[];
  readonly hydration: MemoryHydrationDocument;
  readonly plan: DynamicWorkflowPlanDocument;
  readonly proofLevel: WorkflowHitlReportProofLevel;
  readonly receiptCount: number;
  readonly refinementProposals: readonly MemoryRefinementProposal[];
  readonly refinementReasoningMode: MemoryRefinementReasoningMode;
  readonly search: MemorySearchDocument;
  readonly stateMachineFigure: WorkflowHitlReportDocument["proof"]["stateMachineFigure"];
  readonly title: string;
}): string => {
  const findingSection =
    input.findings.length === 0
      ? "No findings cleared the receipt threshold in this run."
      : input.findings.map(reportCardMdsvxFor).join("\n\n");
  let actionSection = "- Treat this run as a retrieval/capture diagnostic.";
  if (input.refinementProposals.length > 0) {
    actionSection = input.refinementProposals
      .map(refinementProposalActionLineFor)
      .join("\n");
  } else if (input.findings.length > 0) {
    actionSection = input.findings.map(reportActionLineFor).join("\n");
  }
  const skippedSourceSummary =
    input.search.skippedSources.length === 0
      ? "No sources were skipped by memory search."
      : `Skipped sources reported as caveats: ${input.search.skippedSources.join(", ")}.`;

  return [
    "---",
    `expiresIn: ${frontMatterString("24h")}`,
    "noindex: true",
    `template: ${frontMatterString("joel/tufte-mdsvx@0.1.0")}`,
    `title: ${frontMatterString(input.title)}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    "This is a human review surface, not an autopatcher. The report puts findings first, then proof, so the human can decide what to accept, hold, reject, or turn into work.",
    "",
    "## Run context",
    "",
    `Run ${input.search.runId} searched ${input.search.hits.length} memory hits, hydrated ${input.hydration.hydrated.length} redacted receipts, and produced ${input.findingCount} findings for human review.`,
    "",
    `Findings: ${input.findingCount}. Unique receipts: ${input.receiptCount}. Expiry: 24h, noindex.`,
    "",
    "## The actual findings",
    "",
    findingSection,
    "",
    "## What to do with these findings",
    "",
    "Use this as HITL input, not autopilot. Accept a finding only when the receipt trail is good enough to update .brain, create a capture fix, or refine a workflow/package decision.",
    "",
    input.refinementReasoningMode === "agentic"
      ? "Refinement proposals were REASONED by an agent lane over the analysis-method kernel skill and the hydrated evidence; ratings discriminate and each proposal is tied to receipts the agent could actually cite."
      : "Refinement proposals were produced MECHANICALLY (template-fill), not reasoned by an agent lane. Treat their ratings as structural, not analytical, and verify the receipt trail before acting.",
    "",
    `Refinement proposals emitted: ${input.refinementProposals.length}. Accepted proposals should become Brain/package changes or constraints for the next generated workflow.`,
    "",
    "### HITL decision receipt",
    "",
    `Write human decisions as \`${input.hitlDecisionContract.decisionSchemaVersion}\` at \`${input.hitlDecisionContract.artifactPath}\`, backed by this report and its source refs.`,
    "",
    `Schema export: \`${input.hitlDecisionContract.exportId}\` from \`${input.hitlDecisionContract.contractRef}\`.`,
    "",
    `Decisions that must feed the next generated workflow seed: ${input.hitlDecisionContract.nextWorkflowSeedRequiredFor.join(", ")}.`,
    "",
    "## Actionable line items",
    "",
    actionSection,
    "",
    "## Report node",
    "",
    "`joelclaw.memory.hitl-report` rendered this artifact as an installed workflow cartridge node. The JSON document is the machine contract; this sibling `text/mdsvx` artifact is the publishable HITL source.",
    "",
    "## Workflow state machine",
    "",
    "The D2 figure below is rendered from the pinned generated `workflow.xstate-machine.v1` config for this run, not from a static node list. It belongs below the findings so proof does not bury the human decision.",
    "",
    `<D2Fig aspectRatio="${mdsvxAttributeString(input.stateMachineFigure.aspectRatio)}" machineId="${mdsvxAttributeString(input.stateMachineFigure.machineId)}" sourceKind="${mdsvxAttributeString(input.stateMachineFigure.sourceKind)}" stateCount={${input.stateMachineFigure.stateCount}} title="Generated workflow state machine" transitionCount={${input.stateMachineFigure.transitionCount}}>`,
    "",
    "```d2",
    input.stateMachineFigure.source,
    "```",
    "",
    "</D2Fig>",
    "",
    "## Dynamic generation proof",
    "",
    `Dynamic generation proof level: ${input.proofLevel}.`,
    "",
    `Generated machine: ${input.plan.machine.artifactRef} hash ${input.plan.machine.hash}.`,
    "",
    `Generated machine source: ${input.plan.machine.sourceArtifactRef} hash ${input.plan.machine.sourceHash}.`,
    "",
    `Generated harness: ${input.plan.harness.artifactRef} hash ${input.plan.harness.hash}.`,
    "",
    `Verification contract: ${input.plan.verificationContract.artifactRef} hash ${input.plan.verificationContract.hash}.`,
    "",
    `D2 figure source hash: ${input.stateMachineFigure.sourceHash}. Binding: ${input.stateMachineFigure.machineBinding.status} to ${input.stateMachineFigure.machineBinding.machineArtifactRef} hash ${input.stateMachineFigure.machineBinding.machineArtifactHash}.`,
    "",
    `Planner lane: ${input.plan.planner.source}, nonce ${input.plan.planner.nonce}. Plan ${input.plan.planId} has ${input.plan.steps.length} step(s).`,
    "",
    "The report records report-level generated artifact refs and hashes. Final acceptance still depends on the surrounding `workflow.execution-proof.v1`, cartridge invocation proofs, post-execution `memory.generated-workflow-proof.v1`, and verifier result.",
    "",
    "## Definition of done audit",
    "",
    reportDefinitionOfDoneAuditMdsvxFor(input.definitionOfDoneAudit),
    "",
    "## Run coverage",
    "",
    skippedSourceSummary,
    "",
    `Correlation graph: ${input.correlation.nodes.length} nodes, ${input.correlation.edges.length} source-backed edges.`,
    "",
    "## Access adapter shape",
    "",
    "Memory access goes through the trusted Memory relay contract. Cloudflare receives redacted receipt metadata, source freshness, hashes, coverage counts, and follow-up refs; raw local paths, raw transcripts, and credentials stay behind the relay.",
    "",
    "## Report standard",
    "",
    "Template: `joel/tufte-mdsvx@0.1.0`. Public Wzrrd publication must remain `noindex` and expiring by default. The canonical source file is this MDSvX artifact, not a rendered preview.",
    "",
    "## What did not happen",
    "",
    "- Raw transcripts were not returned.",
    "- This report did not directly publish to Wzrrd; publication remains a separate leased `wzrrd.site.publish` side effect.",
    "- This report did not mutate Brain, packages, source indexes, or capability policies by itself.",
    "",
    "## Technical appendix",
    "",
    `Correlation graph: ${input.correlation.nodes.length} nodes, ${input.correlation.edges.length} source-backed edges.`,
    "",
    `Receipt count: ${input.receiptCount}. Raw transcripts returned: no.`,
    "",
    `Correlation graph schema: ${input.correlation.schemaVersion}. Refinement proposal count: ${input.refinementProposals.length}. Template seed: joel/tufte-mdsvx@0.1.0. Publish policy: noindex and 24h expiry by default.`,
  ].join("\n");
};

const uniqueReceiptCountFor = (search: MemorySearchDocument): number =>
  new Set(
    search.hits.flatMap((hit) =>
      hit.receipts.map((receipt) => receiptKey(receipt))
    )
  ).size;

const executeMemorySearchNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryRetrieval === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory search node requires a memory retrieval adapter."
    );
  }

  const nodeConfig = MemorySearchNodeConfigSchema.parse(input.step.config);
  const result = await config.memoryRetrieval.searchMemories(
    MemoryRelaySearchPayloadSchema.parse({
      actor: input.actor,
      maxHits: nodeConfig.maxHits,
      query: nodeConfig.query,
      runId: input.plan.runId,
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: MemorySearchDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeSignalsNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memorySignals === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory signals node requires a memory signal adapter."
    );
  }

  const nodeConfig = MemorySignalsNodeConfigSchema.parse(input.step.config);
  const result = await config.memorySignals.mineSignals(
    MemoryRelaySignalsPayloadSchema.parse({
      actor: input.actor,
      maxSignals: nodeConfig.maxSignals,
      query: nodeConfig.query,
      runId: input.plan.runId,
      ...(nodeConfig.signalKinds === undefined
        ? {}
        : { signalKinds: nodeConfig.signalKinds }),
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: MemorySignalDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeHydrationNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryRetrieval === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory hydration node requires a memory retrieval adapter."
    );
  }

  const nodeConfig = MemoryHydrationNodeConfigSchema.parse(input.step.config);
  const searchRefs = searchRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (searchRefs.length === 0) {
    return blocker(
      "stale_package",
      "Memory hydration node requires a memory search artifact ref."
    );
  }

  const search = await loadFirstArtifactCandidate({
    artifactRefs: searchRefs,
    load: (artifactRef) =>
      loadSearch({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory hydration node requires a memory search artifact ref.",
  });
  if (search.status === "blocked") {
    return search;
  }

  const receipts = hydrationReceiptsFor({
    maxReceipts: nodeConfig.maxReceipts,
    search: search.document,
  });
  if (receipts.length === 0) {
    return blocker(
      "stale_package",
      "Memory hydration node requires at least one receipt from memory search."
    );
  }

  const result = await config.memoryRetrieval.hydrateMemories(
    MemoryRelayHydrationPayloadSchema.parse({
      actor: input.actor,
      receipts,
      runId: input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: MemoryHydrationDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeCorrelationNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryCorrelation === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory correlation node requires a memory correlation adapter."
    );
  }

  const nodeConfig = MemoryCorrelationNodeConfigSchema.parse(input.step.config);
  const refs = correlationRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (refs.searchRefs.length === 0 || refs.hydrationRefs.length === 0) {
    return blocker(
      "stale_package",
      "Memory correlation node requires memory search and hydration artifact refs."
    );
  }

  const search = await loadFirstArtifactCandidate({
    artifactRefs: refs.searchRefs,
    load: (artifactRef) =>
      loadSearch({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory correlation node requires a memory search artifact ref.",
  });
  if (search.status === "blocked") {
    return search;
  }

  const hydration = await loadFirstArtifactCandidate({
    artifactRefs: refs.hydrationRefs,
    load: (artifactRef) =>
      loadHydration({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory correlation node requires a memory hydration artifact ref.",
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  const result = await config.memoryCorrelation.correlateMemories(
    MemoryRelayCorrelationPayloadSchema.parse({
      actor: input.actor,
      hydration: hydration.document,
      hydrationRef: hydration.artifactRef,
      runId: input.plan.runId,
      search: search.document,
      searchRef: search.artifactRef,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: MemoryCorrelationGraphDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

interface LoadedRefinementInputs {
  readonly correlation: MemoryCorrelationGraphDocument;
  readonly hydration: MemoryHydrationDocument;
  readonly search: MemorySearchDocument;
  readonly signals: MemorySignalDocument;
  readonly sourceRefs: readonly ArtifactRef[];
}

// Try the AGENTIC path: assemble the prompt from the redacted evidence + the
// analysis-method kernel skill + the run goal, invoke the reasoning lane, bind
// the reasoned findings back to real receipts, and return a reasoned, hash-
// pinnable proposal document. Returns null (never throws) when the agentic path
// cannot be taken or fails — no lane configured, no analysis skill in scope, the
// lane errored, or nothing the agent said bound to a real receipt — so the
// caller falls back to the deterministic path and labels the output mechanical.
const tryAgenticRefinementProposalDocument = async (input: {
  readonly config: MemoryFabricWorkflowNodeAdapterConfig;
  readonly execution: MemoryWorkflowNodeExecutionInput;
  readonly inputs: LoadedRefinementInputs;
  readonly maxProposals: number;
}): Promise<MemoryRefinementProposalDocument | null> => {
  const lane = input.config.analysisReasoningLane;
  if (lane === undefined) {
    return null;
  }
  const analysisSkillBody = analysisSkillBodyFor(
    input.execution.resolvedKernelSkills ?? []
  );
  if (analysisSkillBody === null) {
    return null;
  }

  const receiptIndex = evidenceReceiptIndexFor({
    hydration: input.inputs.hydration,
    search: input.inputs.search,
  });
  if (receiptIndex.size === 0) {
    return null;
  }

  const prompt = agenticRefinementPromptFor({
    analysisSkillBody,
    correlation: input.inputs.correlation,
    hydration: input.inputs.hydration,
    maxProposals: input.maxProposals,
    outputJsonSchema: AGENTIC_REFINEMENT_OUTPUT_JSON_SCHEMA,
    plan: input.execution.plan,
    receiptIndex,
    search: input.inputs.search,
    signals: input.inputs.signals,
  });

  try {
    const stepSlug = proposalSlugFor(input.execution.step.stepId);
    const reasoned = await lane.reason({
      actor: input.execution.actor,
      laneId: `lane:analysis:${input.execution.plan.runId}:${input.execution.step.stepId}`,
      outputPath: `lanes/analysis-${stepSlug}/refinement-output.json`,
      outputSchema: MemoryAgenticRefinementOutputSchema,
      packageMounts: input.execution.plan.pinnedPackages,
      prompt,
      promptPath: `lanes/analysis-${stepSlug}/prompt.md`,
      receiptPath: `receipts/analysis-${stepSlug}-lane.json`,
      runId: input.execution.plan.runId,
      transcriptPath: `lanes/analysis-${stepSlug}/transcript.md`,
      workItemId: input.execution.plan.workItemId,
    });
    const { droppedCount, proposals } = agenticProposalsFromReasoning({
      findings: reasoned.parsed.findings,
      maxProposals: input.maxProposals,
      receiptIndex,
      sourceRefs: input.inputs.sourceRefs,
    });
    if (proposals.length === 0) {
      // The lane reasoned but nothing it produced bound to a real receipt.
      // Falling through to mechanical is the honest move — better a labeled
      // template than an empty "reasoned" document that proves nothing.
      return null;
    }

    return refinementProposalDocumentFromProposals({
      proposals,
      reasoningMode: "agentic",
      reasoningNote:
        droppedCount > 0
          ? `Agent lane ${reasoned.receipt.laneId} reasoned over the analysis-method kernel skill; ${droppedCount} finding(s) were dropped for citing receipts not present in the evidence.`
          : `Agent lane ${reasoned.receipt.laneId} reasoned over the analysis-method kernel skill; all findings bound to real receipts.`,
      runId: input.inputs.search.runId,
      sourceRefs: input.inputs.sourceRefs,
      workItemId: input.inputs.search.workItemId,
    });
  } catch {
    // The reasoning lane is best-effort: any failure (lane unavailable mid-run,
    // malformed output, lease denied) degrades to the deterministic path rather
    // than blocking the dream. The output is then honestly labeled mechanical.
    return null;
  }
};

const executeRefinementProposalsNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = MemoryRefinementProposalNodeConfigSchema.parse(
    input.step.config
  );
  const refs = refinementProposalRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (
    refs.correlationRefs.length === 0 ||
    refs.hydrationRefs.length === 0 ||
    refs.searchRefs.length === 0 ||
    refs.signalsRefs.length === 0
  ) {
    return blocker(
      "stale_package",
      "Memory refinement proposal node requires signals, search, hydration, and correlation artifact refs."
    );
  }

  const search = await loadFirstArtifactCandidate({
    artifactRefs: refs.searchRefs,
    load: (artifactRef) =>
      loadSearch({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory refinement proposal node requires a memory search artifact ref.",
  });
  if (search.status === "blocked") {
    return search;
  }

  const signals = await loadFirstArtifactCandidate({
    artifactRefs: refs.signalsRefs,
    load: (artifactRef) =>
      loadSignals({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory refinement proposal node requires a memory signals artifact ref.",
  });
  if (signals.status === "blocked") {
    return signals;
  }

  const hydration = await loadFirstArtifactCandidate({
    artifactRefs: refs.hydrationRefs,
    load: (artifactRef) =>
      loadHydration({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory refinement proposal node requires a memory hydration artifact ref.",
  });
  if (hydration.status === "blocked") {
    return hydration;
  }

  const correlation = await loadFirstArtifactCandidate({
    artifactRefs: refs.correlationRefs,
    load: (artifactRef) =>
      loadCorrelation({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory refinement proposal node requires a memory correlation artifact ref.",
  });
  if (correlation.status === "blocked") {
    return correlation;
  }

  const sourceRefs = [
    signals.artifactRef,
    search.artifactRef,
    hydration.artifactRef,
    correlation.artifactRef,
  ];
  // Reason first (the dream thinks), fall back to template-fill (the dream stays
  // honest). The deterministic envelope — hash-pin, redaction, schema parse —
  // wraps both paths identically; only the reasoningMode label differs.
  const agenticDocument = await tryAgenticRefinementProposalDocument({
    config,
    execution: input,
    inputs: {
      correlation: correlation.document,
      hydration: hydration.document,
      search: search.document,
      signals: signals.document,
      sourceRefs,
    },
    maxProposals: nodeConfig.maxProposals,
  });
  const document =
    agenticDocument ??
    refinementProposalDocumentFor({
      correlation: correlation.document,
      correlationRef: correlation.artifactRef,
      hydration: hydration.document,
      hydrationRef: hydration.artifactRef,
      maxProposals: nodeConfig.maxProposals,
      search: search.document,
      searchRef: search.artifactRef,
      signals: signals.document,
      signalsRef: signals.artifactRef,
    });

  return await writeDocument({
    artifacts: config.artifacts,
    document,
    step: input.step,
  });
};

const executeHitlReportNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = WorkflowHitlReportNodeConfigSchema.parse(
    input.step.config
  );
  const refs = reportRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  const missingRequiredRefs = requiredReportRefsPresent(refs);
  if (missingRequiredRefs !== null) {
    return missingRequiredRefs;
  }

  const reportInputs = await loadRequiredReportInputs(config.artifacts, refs);
  if ("status" in reportInputs) {
    return reportInputs;
  }

  // Source-criticality contract: a PRIMARY family the run exists to read that
  // resolved zero receipts blocks the report. This is the boundary that stops a
  // dead primary source (e.g. agent-transcripts when the JoelClaw index is
  // unavailable) from masquerading as a confident transcript review. Families
  // with no primary contract (the default `[]`) skip this check entirely, so
  // supplementary staleness stays a non-blocking caveat as before.
  // Union the planner-provided config families with the profile-injected
  // backstop (input.primarySourceFamilies, derived deterministically from the
  // installed profile by the workflow app). The planner cannot weaken the
  // contract by omitting the field — the profile's primaries always enforce.
  const enforcedPrimarySourceFamilies = [
    ...new Set([
      ...nodeConfig.primarySourceFamilies,
      ...(input.primarySourceFamilies ?? []),
    ]),
  ];
  const unreadPrimaryFamilies = unreadPrimaryFamiliesFor({
    primarySourceFamilies: enforcedPrimarySourceFamilies,
    search: reportInputs.search,
  });
  if (unreadPrimaryFamilies.length > 0) {
    return deadPrimarySourceBlocker({
      search: reportInputs.search,
      unreadPrimaryFamilies,
    });
  }

  const refinementProposals = await loadOptionalRefinementProposalDocument({
    artifacts: config.artifacts,
    refinementProposalRefs: refs.refinementProposalRefs,
  });
  if (refinementProposals.status === "blocked") {
    return refinementProposals;
  }

  const findings = reportCardsFor({
    hydration: reportInputs.hydration,
    refinementProposals: refinementProposals.document?.proposals ?? [],
    search: reportInputs.search,
  });
  // Carry the consumed refinement doc's honesty label through to the report so a
  // published report never claims reasoned analysis it did not do. No proposals
  // (or a doc that predates the field) reads as the conservative "mechanical".
  const refinementReasoningMode: MemoryRefinementReasoningMode =
    refinementProposals.document?.reasoningMode ?? "mechanical";
  const receiptCount = uniqueReceiptCountFor(reportInputs.search);
  const stateMachineFigure = reportStateMachineFigureFor({
    machine: input.machine,
    machineArtifact: input.plan.machine,
  });
  const sourceRefs = uniqueArtifactRefCandidates([
    ...reportInputs.searchRefs,
    ...reportInputs.hydrationRefs,
    reportInputs.correlationRef,
    ...(refinementProposals.refinementProposalRef === null
      ? []
      : [refinementProposals.refinementProposalRef]),
  ]);
  const hitlDecisionContract = hitlDecisionContractFor(sourceRefs);
  const generatedAt = new Date().toISOString();
  const definitionOfDoneAudit = reportDefinitionOfDoneAuditFor({
    correlation: reportInputs.correlation,
    findingCount: findings.length,
    generatedAt,
    hydration: reportInputs.hydration,
    plan: input.plan,
    proofLevel: nodeConfig.dynamicGenerationProofLevel,
    refinementProposalCount: refinementProposals.document?.proposalCount ?? 0,
    runId: input.plan.runId,
    search: reportInputs.search,
    sourceRefs,
    stateMachineFigure,
  });
  const mdsvx = reportMdsvxFor({
    correlation: reportInputs.correlation,
    definitionOfDoneAudit,
    findingCount: findings.length,
    findings,
    hitlDecisionContract,
    hydration: reportInputs.hydration,
    plan: input.plan,
    proofLevel: nodeConfig.dynamicGenerationProofLevel,
    receiptCount,
    refinementProposals: refinementProposals.document?.proposals ?? [],
    refinementReasoningMode,
    search: reportInputs.search,
    stateMachineFigure,
    title: nodeConfig.title,
  });
  const document = WorkflowHitlReportDocumentSchema.parse({
    definitionOfDoneAudit,
    expiresIn: "24h",
    findingCount: findings.length,
    findings,
    generatedAt,
    hitlDecisionContract,
    mdsvx,
    noindex: true,
    proof: {
      dynamicGenerationProofLevel: nodeConfig.dynamicGenerationProofLevel,
      generatedArtifacts: {
        harness: input.plan.harness,
        machine: input.plan.machine,
        plan: {
          planId: input.plan.planId,
          planner: input.plan.planner,
          stepCount: input.plan.steps.length,
        },
        verificationContract: input.plan.verificationContract,
      },
      rawTranscriptsReturned: false,
      stateMachineFigure,
    },
    receiptCount,
    redacted: true,
    refinementProposalCount: refinementProposals.document?.proposalCount ?? 0,
    ...(refinementProposals.refinementProposalRef === null
      ? {}
      : { refinementProposalRef: refinementProposals.refinementProposalRef }),
    refinementProposals: refinementProposals.document?.proposals ?? [],
    refinementReasoningMode,
    runId: input.plan.runId,
    schemaVersion: "workflow.hitl-report.v1",
    sectionOrder: WORKFLOW_HITL_REPORT_SECTION_ORDER,
    sourceRefs,
    template: {
      defaultExpiresIn: "24h",
      format: "mdsvx",
      noindex: true,
      templateId: "joel/tufte-mdsvx",
      version: "0.1.0",
    },
    title: nodeConfig.title,
    workItemId: input.plan.workItemId,
  });

  return await writeHitlReportDocument({
    artifacts: config.artifacts,
    document,
    step: input.step,
  });
};

const executeHitlDecisionWorkflowSeedNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = MemoryHitlDecisionWorkflowSeedNodeConfigSchema.parse(
    input.step.config
  );
  const deriveGeneratedDraftSeed =
    async (): Promise<WorkflowNodeExecutionResult> => {
      const reportRefs = hitlReportRefCandidatesFor({
        completedStepArtifactRefs: input.completedStepArtifactRefs,
        config: nodeConfig,
        dependencyArtifactRefs: input.dependencyArtifactRefs,
        plan: input.plan,
      });
      if (reportRefs.length === 0) {
        return blocker(
          "stale_package",
          "Memory HITL decision seed node requires either a memory.hitl-decision.v1 artifact ref or a workflow.hitl-report.v1 artifact ref to derive a generated draft seed."
        );
      }

      const report = await loadFirstArtifactCandidate({
        artifactRefs: reportRefs,
        load: (artifactRef) =>
          loadHitlReport({
            artifactRef,
            artifacts: config.artifacts,
          }),
        missingBlockerMessage:
          "Memory HITL decision seed node requires a workflow.hitl-report.v1 artifact ref.",
      });
      if (report.status === "blocked") {
        return report;
      }

      const refinementProposalRefs = hitlRefinementProposalRefCandidatesFor({
        completedStepArtifactRefs: input.completedStepArtifactRefs,
        config: nodeConfig,
        dependencyArtifactRefs: input.dependencyArtifactRefs,
        plan: input.plan,
        report: report.document,
      });
      const refinementProposals = await loadOptionalRefinementProposalDocument({
        artifacts: config.artifacts,
        refinementProposalRefs,
      });
      if (refinementProposals.status === "blocked") {
        return refinementProposals;
      }

      const generatedAt = new Date().toISOString();
      const draftDecisionPath = generatedHitlDraftDecisionPathFor(input.step);
      const draftDecisionRef = config.artifacts.artifactRef({
        path: draftDecisionPath,
        runId: report.document.runId,
      });
      const draftDecision = generatedDraftHitlDecisionDocumentFor({
        actor: input.actor,
        generatedAt,
        refinementProposalRef: refinementProposals.refinementProposalRef,
        refinementProposals: refinementProposals.document,
        report: report.document,
        reportRef: report.artifactRef,
      });
      const seed = hitlDecisionWorkflowSeedDocumentFor({
        decision: draftDecision,
        decisionRef: draftDecisionRef,
        decisionSource: "generated-draft",
      });
      const draftDecisionWrite = await config.artifacts.writeJson({
        path: draftDecisionPath,
        redacted: true,
        runId: draftDecision.runId,
        value: draftDecision,
      });
      const seedWrite = await config.artifacts.writeJson({
        path: input.step.outputPath,
        redacted: true,
        runId: seed.runId,
        value: seed,
      });

      return {
        outputRefs: [seedWrite.artifactRef, draftDecisionWrite.artifactRef],
        status: "executed",
      };
    };
  const decisionRef = hitlDecisionRefFor({
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    inputRefs: input.step.inputRefs,
  });
  if (decisionRef === null) {
    return await deriveGeneratedDraftSeed();
  }

  const decision = await loadHitlDecision({
    artifactRef: decisionRef,
    artifacts: config.artifacts,
  });
  if (decision.status === "blocked") {
    const generatedDraft = await deriveGeneratedDraftSeed();
    return generatedDraft.status === "blocked" ? decision : generatedDraft;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: hitlDecisionWorkflowSeedDocumentFor({
      decision: decision.document,
      decisionRef,
      decisionSource: "human-review",
    }),
    step: input.step,
  });
};

const executeHitlFollowUpRunRequestNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  const nodeConfig = MemoryHitlFollowUpRunRequestNodeConfigSchema.parse(
    input.step.config
  );
  const seedRefs = hitlDecisionWorkflowSeedRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    inputRefs: input.step.inputRefs,
    plan: input.plan,
  });
  if (seedRefs.length === 0) {
    return blocker(
      "stale_package",
      "Memory HITL follow-up run request node requires a memory.hitl-decision-workflow-seed.v1 artifact ref."
    );
  }

  const seed = await loadFirstArtifactCandidate({
    artifactRefs: seedRefs,
    load: (artifactRef) =>
      loadHitlDecisionWorkflowSeed({
        artifactRef,
        artifacts: config.artifacts,
      }),
    missingBlockerMessage:
      "Memory HITL follow-up run request node requires a memory.hitl-decision-workflow-seed.v1 artifact ref.",
  });
  if (seed.status === "blocked") {
    return seed;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: hitlFollowUpRunRequestDocumentFor({
      actor: input.actor,
      config: nodeConfig,
      seed: seed.document,
      seedRef: seed.artifactRef,
    }),
    step: input.step,
  });
};

const executeCaptureRunNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryCapture === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory capture run node requires a memory capture adapter."
    );
  }

  const nodeConfig = MemoryCaptureRunNodeConfigSchema.parse(input.step.config);
  const result = await config.memoryCapture.captureRun(
    MemoryRelayCaptureRunPayloadSchema.parse({
      actor: input.actor,
      ...(nodeConfig.capturedRef === undefined
        ? {}
        : { capturedRef: nodeConfig.capturedRef }),
      readability: nodeConfig.readability,
      runId: input.plan.runId,
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      sourceSystem: nodeConfig.sourceSystem,
      targetRunId: nodeConfig.targetRunId ?? input.plan.runId,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: MemoryCaptureReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

const executeCaptureArtifactNode = async (
  config: MemoryFabricWorkflowNodeAdapterConfig,
  input: MemoryWorkflowNodeExecutionInput
): Promise<WorkflowNodeExecutionResult> => {
  if (config.memoryCapture === undefined) {
    return blocker(
      "adapter_unavailable",
      "Memory capture artifact node requires a memory capture adapter."
    );
  }

  const nodeConfig = MemoryCaptureArtifactNodeConfigSchema.parse(
    input.step.config
  );
  const artifactRefs = captureArtifactRefCandidatesFor({
    completedStepArtifactRefs: input.completedStepArtifactRefs,
    config: nodeConfig,
    dependencyArtifactRefs: input.dependencyArtifactRefs,
    plan: input.plan,
  });
  if (artifactRefs.length === 0) {
    return blocker(
      "stale_package",
      "Memory capture artifact node requires a generated artifact ref."
    );
  }

  const capturedRef = await captureArtifactPinFor({
    artifactRefs,
    artifacts: config.artifacts,
    mediaType: nodeConfig.mediaType,
  });
  if (capturedRef.status === "blocked") {
    return capturedRef;
  }

  const result = await config.memoryCapture.captureArtifact(
    MemoryRelayCaptureArtifactPayloadSchema.parse({
      actor: input.actor,
      capturedRef: capturedRef.pin,
      readability: nodeConfig.readability,
      runId: input.plan.runId,
      ...(nodeConfig.sourceFamilies === undefined
        ? {}
        : { sourceFamilies: nodeConfig.sourceFamilies }),
      sourceSystem: nodeConfig.sourceSystem,
      workItemId: input.plan.workItemId,
    })
  );
  if (result.status === "blocked") {
    return result;
  }

  return await writeDocument({
    artifacts: config.artifacts,
    document: MemoryCaptureReceiptDocumentSchema.parse(result.document),
    relayLeaseReceipt: result.relayLeaseReceipt,
    step: input.step,
  });
};

export const createMemoryFabricWorkflowNodeAdapter = (
  config: MemoryFabricWorkflowNodeAdapterConfig
): WorkflowNodeAdapterPort => ({
  async execute(input) {
    const { nodeType } = input.step;

    if (nodeType === "joelclaw.memory.search") {
      return await executeMemorySearchNode(config, input);
    }

    if (nodeType === "joelclaw.memory.signals") {
      return await executeSignalsNode(config, input);
    }

    if (nodeType === "joelclaw.memory.capture-run") {
      return await executeCaptureRunNode(config, input);
    }

    if (nodeType === "joelclaw.memory.capture-artifact") {
      return await executeCaptureArtifactNode(config, input);
    }

    if (nodeType === "joelclaw.memory.correlate") {
      return await executeCorrelationNode(config, input);
    }

    if (nodeType === "joelclaw.memory.refinement-proposals") {
      return await executeRefinementProposalsNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hitl-decision-seed") {
      return await executeHitlDecisionWorkflowSeedNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hitl-follow-up-run-request") {
      return await executeHitlFollowUpRunRequestNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hitl-report") {
      return await executeHitlReportNode(config, input);
    }

    if (nodeType === "joelclaw.memory.hydrate") {
      return await executeHydrationNode(config, input);
    }

    return blocker(
      "adapter_unavailable",
      `Memory fabric workflow node adapter does not support nodeType ${input.step.nodeType}.`
    );
  },
  validatePlanNodeConfig(input) {
    return validateMemoryFabricNodeConfig(input.step);
  },
});
