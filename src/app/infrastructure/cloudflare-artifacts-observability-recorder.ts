import type {
  ArtifactStoreContract,
  WorkflowTelemetrySinkPort,
  WorkflowObservabilityRecorderPort,
} from "../application/ports.ts";
import {
  workflowObservabilityHighCardinalityFields,
  workflowObservabilityRequiredSignals,
} from "../domain/observability.ts";
import {
  WorkflowObservabilityPackSchema,
  WorkflowStatusProjectionSchema,
} from "../domain/schemas.ts";
import type {
  AgentLaneReceipt,
  ArtifactRef,
  CapabilityLeaseReceipt,
  CapabilityResource,
  WorkflowStructuredLogRecord,
} from "../domain/schemas.ts";
import { workflowTraceIdForRun } from "../domain/trace-context.ts";
import { createCloudflareArtifactsStructuredLogSink } from "./cloudflare-workflow-telemetry-sinks.ts";

export interface CloudflareArtifactsObservabilityRecorderConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly now?: () => string;
  readonly telemetrySink?: WorkflowTelemetrySinkPort;
}

const uniqueArtifactRefs = (
  artifactRefs: readonly ArtifactRef[]
): ArtifactRef[] => [...new Set(artifactRefs)];

const artifactRepoFrom = (
  artifactRefs: readonly ArtifactRef[]
): string | null =>
  artifactRefs.at(0)?.replace(/^artifact:\/\/([^/]+).*/u, "$1") ?? null;

const laneDurationMs = (receipt: AgentLaneReceipt): number | null => {
  if (receipt.sandboxAccounting !== undefined) {
    return receipt.sandboxAccounting.commandDurationMs;
  }

  return receipt.completedAt === undefined
    ? null
    : Math.max(
        0,
        Date.parse(receipt.completedAt) - Date.parse(receipt.startedAt)
      );
};

const tokenAccountedLaneReceipts = (
  receipts: readonly AgentLaneReceipt[]
): AgentLaneReceipt[] =>
  receipts.filter((receipt) => receipt.tokenCostAccounting !== undefined);

const tokenCostAccountingStatus = (
  receipts: readonly AgentLaneReceipt[]
): "captured" | "not-yet-instrumented" | "partial" => {
  const accountedReceipts = tokenAccountedLaneReceipts(receipts);
  if (accountedReceipts.length === 0) {
    return "not-yet-instrumented";
  }

  const fullyCostedReceipts = accountedReceipts.filter(
    (receipt) => receipt.tokenCostAccounting?.costEstimate !== null
  );
  return accountedReceipts.length === receipts.length &&
    fullyCostedReceipts.length === receipts.length
    ? "captured"
    : "partial";
};

const tokenCountTotal = (
  receipts: readonly AgentLaneReceipt[]
): null | number => {
  let total = 0;
  let accounted = 0;
  for (const receipt of receipts) {
    const tokenCount = receipt.tokenCostAccounting?.tokenCount;
    if (tokenCount === undefined) {
      continue;
    }

    total += tokenCount;
    accounted += 1;
  }

  return accounted === 0 ? null : total;
};

const tokenCostEstimateTotal = (
  receipts: readonly AgentLaneReceipt[]
): null | number => {
  let total = 0;
  let accounted = 0;
  for (const receipt of receipts) {
    const costEstimate = receipt.tokenCostAccounting?.costEstimate;
    if (costEstimate === undefined || costEstimate === null) {
      continue;
    }

    total += costEstimate;
    accounted += 1;
  }

  return accounted === 0 ? null : total;
};

const tracePropagatedReceipts = (
  receipts: readonly {
    readonly traceContext?:
      | { readonly spanId: string; readonly traceId: string }
      | undefined;
  }[],
  traceId: string
): typeof receipts =>
  receipts.filter(
    (receipt) =>
      receipt.traceContext?.traceId === traceId &&
      receipt.traceContext.spanId.length > 0
  );

const tracePropagationStatus = (
  input: {
    readonly capabilityReceipts: readonly CapabilityLeaseReceipt[];
    readonly laneReceipts: readonly AgentLaneReceipt[];
  },
  traceId: string
): "captured" | "not-yet-instrumented" | "partial" => {
  const receipts = [...input.laneReceipts, ...input.capabilityReceipts];
  const propagatedReceipts = tracePropagatedReceipts(receipts, traceId);
  if (propagatedReceipts.length === 0) {
    return "not-yet-instrumented";
  }

  return propagatedReceipts.length === receipts.length ? "captured" : "partial";
};

const structuredLogSpanCount = (
  logs: readonly WorkflowStructuredLogRecord[]
): number =>
  new Set(
    logs
      .map((log) => log.fields["spanId"])
      .filter((spanId): spanId is string => typeof spanId === "string")
  ).size;

const capabilityResourceRef = (resource: CapabilityResource): string => {
  if (resource.kind === "discord.channel") {
    return `discord.channel:${resource.serverRef}:${resource.channelRef}`;
  }

  if (resource.kind === "github.repository") {
    return `github.repository:${resource.repositoryRef}:${resource.headBranch}->${resource.baseBranch}`;
  }

  if (resource.kind === "linear.issue") {
    return `linear.issue:${resource.issueRef}`;
  }

  return `wzrrd.site:${resource.siteRef}:${resource.slug}`;
};

export const createCloudflareArtifactsObservabilityRecorder = (
  config: CloudflareArtifactsObservabilityRecorderConfig
): WorkflowObservabilityRecorderPort => ({
  async capturePack(input) {
    const initialArtifactRefs = uniqueArtifactRefs([
      input.planArtifact.artifactRef,
      input.plannerLaneReceipt.prompt.artifactRef,
      input.plannerLaneReceipt.transcript.artifactRef,
      input.plannerLaneReceipt.receiptRef,
      ...(input.plannerLaneReceipt.packageMounts === undefined
        ? []
        : [input.plannerLaneReceipt.packageMounts.artifactRef]),
      input.plan.machine.artifactRef,
      input.plan.machine.sourceArtifactRef,
      input.plan.harness.artifactRef,
      input.plan.verificationContract.artifactRef,
      ...input.executionArtifactRefs,
      ...input.workerLaneReceipts.flatMap((receipt) => [
        receipt.prompt.artifactRef,
        receipt.transcript.artifactRef,
        receipt.receiptRef,
        ...(receipt.packageMounts === undefined
          ? []
          : [receipt.packageMounts.artifactRef]),
      ]),
      ...input.capabilityReceipts.map((receipt) => receipt.receiptRef),
    ]);
    const traceId = workflowTraceIdForRun(input.plan.runId);
    const packageIds = input.plan.pinnedPackages
      .map((packageRef) => packageRef.metadata.packageId)
      .join(",");
    const packageVersions = input.plan.pinnedPackages
      .map((packageRef) => packageRef.version)
      .join(",");
    const laneReceipts = [
      input.plannerLaneReceipt,
      ...input.workerLaneReceipts,
    ];
    const laneTokenCostAccountingStatus =
      tokenCostAccountingStatus(laneReceipts);
    const laneTokenCountTotal = tokenCountTotal(laneReceipts);
    const laneTokenCostEstimateTotal = tokenCostEstimateTotal(laneReceipts);
    const receiptTracePropagationStatus = tracePropagationStatus(
      {
        capabilityReceipts: input.capabilityReceipts,
        laneReceipts,
      },
      traceId
    );
    const baseFields = {
      actorId: input.plan.actor.id,
      artifactRepo: artifactRepoFrom(initialArtifactRefs),
      costEstimate: null,
      packageId: packageIds,
      packageVersion: packageVersions,
      runId: input.plan.runId,
      tokenCount: null,
      traceId,
      workItemId: input.plan.workItemId,
    };
    const eventLogs = input.eventLog.map((event, index) => {
      const previous = input.eventLog.at(index - 1);
      const durationMs =
        previous === undefined
          ? 0
          : Math.max(0, Date.parse(event.at) - Date.parse(previous.at));

      return {
        at: event.at,
        eventName: `workflow.state.${event.state}`,
        fields: {
          ...baseFields,
          admissionId: null,
          artifactCommitSha: null,
          artifactRef:
            event.refs["planRef"] ??
            event.refs["machineRef"] ??
            event.refs["harnessRef"] ??
            event.refs["verificationContractRef"] ??
            event.refs["workerLaneReceiptRef"] ??
            event.refs["receiptRef"] ??
            event.refs["reviewSurfaceRef"] ??
            event.refs["outputRefs"] ??
            null,
          blockerCode: event.state === "blocked" ? "unknown" : null,
          capability: event.refs["capability"] ?? null,
          capsuleId: event.refs["capsuleId"] ?? null,
          durationMs,
          laneId: null,
          laneKind: null,
          laneRuntime: null,
          leaseId: event.refs["leaseId"] ?? null,
          payloadHash: null,
          resourceRef: null,
          reviewSurfaceId: null,
          sandboxRef: null,
          spanId: `span:${input.plan.runId}:event:${index + 1}`,
          stepId: event.refs["stepId"] ?? null,
          stepKind: null,
          verifierResultId: null,
        },
        schemaVersion: "workflow.structured-log.v1",
        severity: event.state === "blocked" ? "error" : "info",
      } satisfies WorkflowStructuredLogRecord;
    });
    const capsuleId =
      input.eventLog.find((event) => event.refs["capsuleId"] !== undefined)
        ?.refs["capsuleId"] ?? `capsule:${input.plan.workItemId}`;
    const planAvailableIndex = input.eventLog.findIndex(
      (event) => event.refs["planRef"] === input.planArtifact.artifactRef
    );
    const statusProjectionHistory = input.eventLog.map((event, index) =>
      WorkflowStatusProjectionSchema.parse({
        actorId: input.plan.actor.id,
        capsuleId,
        currentState: event.state,
        eventCount: index + 1,
        lastEvent: event,
        ...(planAvailableIndex !== -1 && index >= planAvailableIndex
          ? { planArtifact: input.planArtifact }
          : {}),
        redacted: true,
        runId: input.plan.runId,
        schemaVersion: "workflow.status-projection.v1",
        updatedAt: event.at,
        workItemId: input.plan.workItemId,
      })
    );
    const latestStatusProjection = statusProjectionHistory.at(-1);
    if (latestStatusProjection === undefined) {
      throw new Error(
        "Observability pack requires at least one workflow event."
      );
    }
    const statusProjectionLogs = statusProjectionHistory.map(
      (projection, index) =>
        ({
          at: projection.updatedAt,
          eventName: "workflow.status_projection.recorded",
          fields: {
            ...baseFields,
            admissionId: null,
            artifactCommitSha: null,
            artifactRef: projection.planArtifact?.artifactRef ?? null,
            blockerCode:
              projection.currentState === "blocked" ? "unknown" : null,
            capability: null,
            capsuleId: projection.capsuleId,
            durationMs: null,
            laneId: null,
            laneKind: null,
            laneRuntime: null,
            leaseId: null,
            payloadHash: null,
            projectionSink: "cloudflare-d1-runs:runs",
            projectionStatus: projection.currentState,
            resourceRef: null,
            reviewSurfaceId: null,
            sandboxRef: null,
            spanId: `span:${input.plan.runId}:status-projection:${index + 1}`,
            stepId: projection.lastEvent.refs["stepId"] ?? null,
            stepKind: null,
            verifierResultId: null,
          },
          schemaVersion: "workflow.structured-log.v1",
          severity: projection.currentState === "blocked" ? "error" : "info",
        }) satisfies WorkflowStructuredLogRecord
    );
    const laneLogs = laneReceipts.map(
      (receipt, index) =>
        ({
          at: receipt.completedAt ?? receipt.startedAt,
          eventName: "workflow.lane.receipt",
          fields: {
            ...baseFields,
            admissionId: null,
            artifactCommitSha: receipt.artifactCommitSha ?? null,
            artifactRef: receipt.receiptRef,
            blockerCode: receipt.status === "blocked" ? "lane_blocked" : null,
            capability: null,
            capsuleId: null,
            costEstimate: receipt.tokenCostAccounting?.costEstimate ?? null,
            durationMs: laneDurationMs(receipt),
            laneId: receipt.laneId,
            laneKind: receipt.kind,
            laneRuntime: receipt.runtime,
            leaseId: receipt.authLease?.leaseId ?? null,
            payloadHash: null,
            resourceRef: null,
            reviewSurfaceId: null,
            sandboxRef: receipt.sandboxRef ?? null,
            spanId:
              receipt.traceContext?.spanId ??
              `span:${input.plan.runId}:lane:${index + 1}`,
            stepId: null,
            stepKind: null,
            tokenCount: receipt.tokenCostAccounting?.tokenCount ?? null,
            traceId: receipt.traceContext?.traceId ?? baseFields.traceId,
            verifierResultId: null,
          },
          schemaVersion: "workflow.structured-log.v1",
          severity: receipt.status === "failed" ? "error" : "info",
        }) satisfies WorkflowStructuredLogRecord
    );
    const sandboxAccountedLaneReceipts = [
      input.plannerLaneReceipt,
      ...input.workerLaneReceipts,
    ].filter(
      (receipt) => receipt.sandboxAccounting?.cleanup?.status === "destroyed"
    );
    let sandboxCommandDurationMs: null | number = null;
    for (const receipt of [
      input.plannerLaneReceipt,
      ...input.workerLaneReceipts,
    ]) {
      const durationMs = receipt.sandboxAccounting?.commandDurationMs;
      if (durationMs === undefined) {
        continue;
      }

      sandboxCommandDurationMs = (sandboxCommandDurationMs ?? 0) + durationMs;
    }
    const capabilityLogs = input.capabilityReceipts.map(
      (receipt) =>
        ({
          at:
            input.eventLog.at(-1)?.at ??
            config.now?.() ??
            new Date().toISOString(),
          eventName: "workflow.capability.receipt",
          fields: {
            ...baseFields,
            admissionId: null,
            artifactCommitSha: null,
            artifactRef: receipt.receiptRef,
            blockerCode:
              receipt.delivery.status === "blocked"
                ? receipt.delivery.blocker.code
                : null,
            capability: receipt.capability,
            capsuleId: null,
            durationMs: null,
            laneId: null,
            laneKind: null,
            laneRuntime: null,
            leaseId: receipt.leaseId,
            payloadHash: receipt.payloadHash,
            resourceRef: capabilityResourceRef(receipt.resource),
            reviewSurfaceId: null,
            sandboxRef: null,
            spanId: receipt.traceContext.spanId,
            stepId: null,
            stepKind: null,
            traceId: receipt.traceContext.traceId,
            verifierResultId: null,
          },
          schemaVersion: "workflow.structured-log.v1",
          severity: receipt.delivery.status === "blocked" ? "error" : "info",
        }) satisfies WorkflowStructuredLogRecord
    );
    const logs = [
      ...eventLogs,
      ...statusProjectionLogs,
      ...laneLogs,
      ...capabilityLogs,
    ];
    const telemetrySink =
      config.telemetrySink ??
      createCloudflareArtifactsStructuredLogSink({
        artifacts: config.artifacts,
        ...(config.now === undefined ? {} : { now: config.now }),
      });
    const telemetrySinks = await telemetrySink.recordLogs({
      logs,
      runId: input.plan.runId,
      workItemId: input.plan.workItemId,
    });
    const artifactRefs = uniqueArtifactRefs([
      ...initialArtifactRefs,
      ...telemetrySinks.flatMap((receipt) =>
        receipt.artifactRef === undefined ? [] : [receipt.artifactRef]
      ),
    ]);
    const document = WorkflowObservabilityPackSchema.parse({
      artifactRefs,
      generatedAt: config.now?.() ?? new Date().toISOString(),
      highCardinalityFields: workflowObservabilityHighCardinalityFields,
      laneReceipts: {
        planner: input.plannerLaneReceipt,
        workers: input.workerLaneReceipts,
      },
      logs,
      metrics: {
        artifactRefCount: artifactRefs.length,
        capabilityReceiptCount: input.capabilityReceipts.length,
        eventCount: input.eventLog.length,
        sandboxAccountingStatus:
          sandboxAccountedLaneReceipts.length ===
          1 + input.workerLaneReceipts.length
            ? "captured"
            : "not-yet-instrumented",
        sandboxCommandDurationMs,
        sandboxDestroyedLaneCount: sandboxAccountedLaneReceipts.length,
        structuredLogSinkStatus:
          telemetrySinks.length > 0 &&
          telemetrySinks.every((receipt) => receipt.status === "captured")
            ? "captured"
            : "not-configured",
        tokenCostAccountingStatus: laneTokenCostAccountingStatus,
        tokenCostEstimate: laneTokenCostEstimateTotal,
        tokenCount: laneTokenCountTotal,
        tracePropagationStatus: receiptTracePropagationStatus,
        traceSpanCount: structuredLogSpanCount(logs),
        workerLaneCount: input.workerLaneReceipts.length,
      },
      redacted: true,
      requiredSignals: workflowObservabilityRequiredSignals,
      runId: input.plan.runId,
      schemaVersion: "workflow.observability-pack.v1",
      statusProjection: {
        history: statusProjectionHistory,
        latest: latestStatusProjection,
        sink: {
          description:
            "WorkflowStatusProjectionPort records are mirrored into the Cloudflare D1 runs table by run_id while the deployed control plane advances the run.",
          kind: "cloudflare-d1-runs",
          runId: input.plan.runId,
          table: "runs",
        },
      },
      summary:
        laneTokenCostAccountingStatus === "captured"
          ? "Structured runtime observability pack captured from workflow events, status projection records mirrored to the Cloudflare D1 runs table, lane receipts, sandbox accounting receipts, token/cost accounting receipts, capability receipts, artifact refs, high-cardinality log fields, and structured telemetry sink receipts."
          : "Structured runtime observability pack captured from workflow events, status projection records mirrored to the Cloudflare D1 runs table, lane receipts, sandbox accounting receipts, capability receipts, artifact refs, high-cardinality log fields, and structured telemetry sink receipts. Token/cost accounting remains partial or not-yet-instrumented unless lane receipts carry explicit usage and cost data.",
      telemetrySinks,
      workItemId: input.plan.workItemId,
    });
    const artifact = await config.artifacts.writeJson({
      path: "run/observability-pack.json",
      redacted: true,
      runId: input.plan.runId,
      value: document,
    });

    return { artifact, document };
  },
});
