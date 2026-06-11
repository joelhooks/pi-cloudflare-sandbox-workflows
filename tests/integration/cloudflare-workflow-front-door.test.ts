import { describe, expect, it } from "vitest";
import { z } from "zod";

import type {
  AgentLaneAdmissionControllerContract,
  AgentLaneRuntimePort,
  AgentLaneRuntimeRequest,
  ContextCapsuleActorContract,
} from "../../src/app/application/ports.ts";
import { D1PackageRowSchema } from "../../src/app/control-plane/d1-schema.ts";
import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  ActorSchema,
  AgentLaneAdmissionDecisionSchema,
  AgentLaneReceiptSchema,
  AgentLaneReleaseReceiptSchema,
  ArtifactRefSchema,
  DiscordResourceSchema,
  DynamicWorkflowStepSchema,
  PlannerLaneBlueprintDocumentSchema,
  PlanProposalSchema,
  PackageMetadataSchema,
  PinnedPackageSchema,
  ReviewSurfaceDocumentSchema,
  ReviewGateSchema,
  VerificationContractDocumentSchema,
  VerificationResultDocumentSchema,
  WorkflowExecutionProofDocumentSchema,
  WorkflowExternalTelemetryBatchSchema,
  WorkflowObservabilityPackSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  AgentLaneAdmissionRequest,
  AgentLaneReceipt,
  AgentLaneReleaseRequest,
  ArtifactRef,
  PackageMetadata,
  ReviewSurfaceDocument,
  WorkflowObservabilityPack,
  WorkflowExecutionProofDocument,
  WorkflowRunReceipt,
  WorkflowRunRequest,
  WorkflowRunResult,
} from "../../src/app/domain/schemas.ts";
import { buildAgentLanePackageMountIndex } from "../../src/app/infrastructure/agent-lane-package-mounts.ts";
import type { CloudflareArtifactsRunStore } from "../../src/app/infrastructure/cloudflare-artifacts-store.ts";
import { createCloudflareWorkflowFrontDoor } from "../../src/app/infrastructure/cloudflare-workflow-front-door.ts";
import {
  createDryRunDiscordMessageAdapter,
  createIntegrationTestDynamicWorkflowPlanner,
  createMemoryArtifactStore,
  createMemoryContextCapsuleActor,
  createPolicyCapabilityLeaseBroker,
} from "../../src/app/infrastructure/memory-adapters.ts";
import {
  buildIntegrationTestRunRequest,
  integrationTestActor,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

type D1QueryValue = null | number | string;
type D1PackageRow = ReturnType<typeof D1PackageRowSchema.parse>;

const subjectTypes = new Set(["actor", "organization", "role", "service"]);

interface EntitlementRow {
  readonly can_discover: 0 | 1;
  readonly can_mount: 0 | 1;
  readonly package_id: string;
  readonly subject_id: string;
  readonly subject_type: "actor" | "organization" | "role" | "service";
}

interface D1Operation {
  readonly query: string;
  readonly values: readonly D1QueryValue[];
}

const PlannerPromptBindingSchema = z.object({
  actor: ActorSchema,
  notification: z
    .object({
      dryRun: z.boolean(),
      payloadHash: z.string().min(1),
      payloadRef: ArtifactRefSchema,
      resource: DiscordResourceSchema,
      reviewGate: ReviewGateSchema,
      secretRef: z.string().min(1),
    })
    .nullable(),
  proposal: PlanProposalSchema,
  runId: z.string().min(1),
  workItemId: z.string().min(1),
});

const packageRowFor = (metadata: PackageMetadata): D1PackageRow =>
  D1PackageRowSchema.parse({
    artifact_ref: metadata.latestArtifactRef,
    kind: metadata.kind,
    latest_version: metadata.latestVersion,
    manifest_hash: hashJson(metadata),
    manifest_path: metadata.manifestPath,
    owner_ref: metadata.ownerRef,
    package_id: metadata.packageId,
    title: metadata.title,
    trust_tier: metadata.trustTier,
  });

const createFakePackageD1 = (input: {
  readonly entitlements: readonly EntitlementRow[];
  readonly rows: readonly D1PackageRow[];
}) => {
  const operations: D1Operation[] = [];

  return {
    d1: {
      prepare(query: string) {
        const statementFor = (values: readonly D1QueryValue[] = []) => ({
          all() {
            const firstSubjectIndex = values.findIndex(
              (value) => typeof value === "string" && subjectTypes.has(value)
            );
            const packageIds = new Set(
              (firstSubjectIndex === -1
                ? []
                : values.slice(0, firstSubjectIndex)
              )
                .filter((value): value is string => typeof value === "string")
                .filter((value) =>
                  input.rows.some((row) => row.package_id === value)
                )
            );
            const subjectKeys = new Set<string>();
            const subjectStartIndex =
              firstSubjectIndex === -1 ? values.length : firstSubjectIndex;
            for (
              let index = subjectStartIndex;
              index < values.length;
              index += 2
            ) {
              const subjectType = values[index];
              const subjectId = values[index + 1];
              if (
                typeof subjectType === "string" &&
                typeof subjectId === "string"
              ) {
                subjectKeys.add(`${subjectType}:${subjectId}`);
              }
            }
            const entitlementFlag = query.includes("e.can_mount")
              ? "can_mount"
              : "can_discover";
            const entitledPackageIds = new Set(
              input.entitlements
                .filter((entitlement) => entitlement[entitlementFlag] === 1)
                .filter(
                  (entitlement) =>
                    packageIds.size === 0 ||
                    packageIds.has(entitlement.package_id)
                )
                .filter((entitlement) =>
                  subjectKeys.has(
                    `${entitlement.subject_type}:${entitlement.subject_id}`
                  )
                )
                .map((entitlement) => entitlement.package_id)
            );

            return Promise.resolve({
              results: input.rows.filter((row) =>
                entitledPackageIds.has(row.package_id)
              ),
            });
          },
          bind(...boundValues: D1QueryValue[]) {
            return statementFor(boundValues);
          },
          run() {
            operations.push({ query, values });

            return Promise.resolve({ success: true });
          },
        });

        return statementFor();
      },
    },
    operations,
  };
};

const createAdmissionCapsuleController = (): ContextCapsuleActorContract &
  AgentLaneAdmissionControllerContract & {
    readonly admissions: AgentLaneAdmissionRequest[];
    readonly releases: AgentLaneReleaseRequest[];
  } => {
  const capsules = createMemoryContextCapsuleActor();
  const activeLaneIds = new Set<string>();
  const admissions: AgentLaneAdmissionRequest[] = [];
  const releases: AgentLaneReleaseRequest[] = [];

  return {
    admissions,
    admitLane(input) {
      admissions.push(input);
      if (activeLaneIds.size >= input.maxActiveLanes) {
        return Promise.resolve(
          AgentLaneAdmissionDecisionSchema.parse({
            activeLaneIds: [...activeLaneIds],
            kind: input.kind,
            laneId: input.laneId,
            maxActiveLanes: input.maxActiveLanes,
            reason: "concurrency-cap-full",
            retryAfterSeconds: 1,
            runId: input.runId,
            status: "deferred",
            workItemId: input.workItemId,
          })
        );
      }

      activeLaneIds.add(input.laneId);
      return Promise.resolve(
        AgentLaneAdmissionDecisionSchema.parse({
          activeLaneIds: [...activeLaneIds],
          admissionId: `admission:${input.runId}:${input.laneId}`,
          admittedAt: input.requestedAt,
          kind: input.kind,
          laneId: input.laneId,
          maxActiveLanes: input.maxActiveLanes,
          runId: input.runId,
          status: "admitted",
          workItemId: input.workItemId,
        })
      );
    },
    appendEvent(input) {
      return capsules.appendEvent(input);
    },
    loadLatestCheckpoint(input) {
      return capsules.loadLatestCheckpoint(input);
    },
    persistCheckpoint(input) {
      return capsules.persistCheckpoint(input);
    },
    releaseLane(input) {
      releases.push(input);
      activeLaneIds.delete(input.laneId);

      return Promise.resolve(
        AgentLaneReleaseReceiptSchema.parse({
          ...input,
          activeLaneIds: [...activeLaneIds],
        })
      );
    },
    releases,
    resolve(input) {
      return capsules.resolve(input);
    },
  };
};

const artifactRefFor = (
  request: AgentLaneRuntimeRequest,
  path: string
): ArtifactRef =>
  request.artifactRef({
    path,
    runId: request.runId,
  });

const extractJsonSection = (input: {
  readonly heading: string;
  readonly prompt: string;
}): unknown => {
  const marker = `## ${input.heading}\n\n`;
  const start = input.prompt.indexOf(marker);
  if (start === -1) {
    throw new Error(`Missing prompt section: ${input.heading}`);
  }

  const afterMarker = input.prompt.slice(start + marker.length);
  const nextHeadingIndex = afterMarker.search(/\n## /u);
  const jsonText =
    nextHeadingIndex === -1
      ? afterMarker.trim()
      : afterMarker.slice(0, nextHeadingIndex).trim();

  return JSON.parse(jsonText);
};

const buildReceipt = (input: {
  readonly outputHash: string;
  readonly outputRef: ArtifactRef;
  readonly request: AgentLaneRuntimeRequest;
  readonly transcript: string;
}): AgentLaneReceipt =>
  AgentLaneReceiptSchema.parse({
    artifactCommitSha: `commit-${input.request.kind}-${input.request.runId}`,
    authLease: input.request.authLease,
    completedAt: "2026-06-08T23:00:01.000Z",
    kind: input.request.kind,
    laneId: input.request.laneId,
    outputPins: [
      {
        artifactRef: input.outputRef,
        hash: input.outputHash,
        mediaType: input.request.outputMediaType,
      },
    ],
    outputRefs: [input.outputRef],
    ...(input.request.packageMounts === undefined
      ? {}
      : {
          packageMounts: {
            artifactRef: artifactRefFor(
              input.request,
              "packages/pinned-packages.json"
            ),
            hash: hashJson(
              buildAgentLanePackageMountIndex(input.request.packageMounts)
            ),
            mediaType: "application/json",
            mountCount: input.request.packageMounts.length,
          },
        }),
    prompt: {
      artifactRef: artifactRefFor(input.request, input.request.promptPath),
      hash: sha256Hex(input.request.prompt),
      mediaType: "text/markdown",
    },
    realAgent: true,
    receiptRef: artifactRefFor(input.request, input.request.receiptPath),
    redacted: true,
    runtime: "pi-agent-cli",
    sandboxAccounting: {
      cleanup: {
        receipt: `destroy:${input.request.laneId}:ok`,
        status: "destroyed",
      },
      commandDurationMs: 1000 + input.request.kind.length,
    },
    sandboxRef: `cloudflare-sandbox:${input.request.laneId}`,
    startedAt: "2026-06-08T23:00:00.000Z",
    status: "completed",
    traceContext: input.request.traceContext,
    transcript: {
      artifactRef: artifactRefFor(input.request, input.request.transcriptPath),
      hash: sha256Hex(input.transcript),
      mediaType: "text/markdown",
    },
  });

const createFakeRealLaneRuntime = (input: {
  readonly artifacts: ReturnType<typeof createMemoryArtifactStore>;
  readonly requests: AgentLaneRuntimeRequest[];
}): AgentLaneRuntimePort => ({
  async runLane(request) {
    input.requests.push(request);
    input.artifacts.setText(
      artifactRefFor(request, request.promptPath),
      request.prompt,
      "text/markdown"
    );
    const transcript = `real ${request.kind} transcript`;
    input.artifacts.setText(
      artifactRefFor(request, request.transcriptPath),
      transcript,
      "text/markdown"
    );
    const outputRef = artifactRefFor(request, request.outputPath);

    let output: unknown;
    if (request.kind === "planner") {
      const binding = PlannerPromptBindingSchema.parse(
        extractJsonSection({ heading: "Run Binding", prompt: request.prompt })
      );
      const planner = createIntegrationTestDynamicWorkflowPlanner();
      const blueprint = await planner.proposePlan({
        actor: binding.actor,
        availablePackages: z.array(PackageMetadataSchema).parse(
          extractJsonSection({
            heading: "Available Package Metadata",
            prompt: request.prompt,
          })
        ),
        ...(binding.notification === null
          ? {}
          : { notification: binding.notification }),
        pinnedPackages: z.array(PinnedPackageSchema).parse(
          extractJsonSection({
            heading: "Pinned Packages",
            prompt: request.prompt,
          })
        ),
        proposal: binding.proposal,
        runId: binding.runId,
        workItemId: binding.workItemId,
      });
      output = PlannerLaneBlueprintDocumentSchema.parse({
        harness: blueprint.harness,
        machine: blueprint.machine,
        plan: blueprint.plan,
        verificationContract: {
          ...blueprint.verificationContract,
          verifier: {
            kind: "agent-lane",
            runtime: "pi-agent-cli",
          },
        },
      });
    } else if (request.kind === "verifier") {
      const contract = VerificationContractDocumentSchema.parse(
        extractJsonSection({
          heading: "Verification Contract",
          prompt: request.prompt,
        })
      );
      output = VerificationResultDocumentSchema.parse({
        checkedAt: "2026-06-08T23:00:02.000Z",
        contractId: contract.contractId,
        failures: [],
        resultId: `verification-result:${request.runId}`,
        runId: request.runId,
        schemaVersion: "workflow.verification-result.v1",
        status: "accepted",
        verifierLaneId: request.laneId,
      });
    } else {
      const step = DynamicWorkflowStepSchema.parse(
        extractJsonSection({ heading: "Step JSON", prompt: request.prompt })
      );
      output =
        request.outputMediaType === "application/json"
          ? { redacted: true, stepId: step.stepId }
          : `Completed ${step.stepId}`;
    }

    const outputHash =
      typeof output === "string" ? sha256Hex(output) : hashJson(output);
    if (typeof output === "string") {
      input.artifacts.setText(
        outputRef,
        output,
        request.outputMediaType.startsWith("text/")
          ? request.outputMediaType
          : "text/plain"
      );
    } else {
      input.artifacts.setJson(outputRef, output);
    }
    const receipt = buildReceipt({
      outputHash,
      outputRef,
      request,
      transcript,
    });
    input.artifacts.setJson(receipt.receiptRef, receipt);

    return receipt;
  },
  runtime: "pi-agent-cli",
});

const seedPackageArtifacts = (
  artifacts: ReturnType<typeof createMemoryArtifactStore>
): void => {
  for (const packageRecord of integrationTestPackageMetadata) {
    artifacts.setJson(packageRecord.latestArtifactRef, packageRecord);
  }
};

const requireCapturedResult = (
  result: WorkflowRunResult
): WorkflowRunReceipt => {
  if (result.status !== "captured") {
    throw new Error(result.blocker.message);
  }

  return result;
};

const firstWorkerReceipt = (
  receipts: readonly AgentLaneReceipt[]
): AgentLaneReceipt => {
  const receipt = receipts.at(0);
  if (receipt === undefined) {
    throw new Error("Expected at least one worker lane receipt.");
  }

  return receipt;
};

const requireVerifierReceipt = (
  receipt: AgentLaneReceipt | undefined
): AgentLaneReceipt => {
  if (receipt === undefined) {
    throw new Error("Expected verifier lane receipt.");
  }

  return receipt;
};

const readFrontDoorEvidence = async (input: {
  readonly result: WorkflowRunReceipt;
  readonly runArtifacts: ReturnType<typeof createMemoryArtifactStore>;
}): Promise<{
  readonly executionProof: WorkflowExecutionProofDocument;
  readonly observabilityPack: WorkflowObservabilityPack;
  readonly reviewSurface: ReviewSurfaceDocument;
}> => {
  const reviewSurface = ReviewSurfaceDocumentSchema.parse(
    await input.runArtifacts.readJson({
      artifactRef: input.result.reviewSurfaceArtifact.artifactRef,
    })
  );
  const observabilityPackRef = input.result.artifactRefs.find((artifactRef) =>
    artifactRef.endsWith("/run/observability-pack.json")
  );
  if (observabilityPackRef === undefined) {
    throw new Error("Expected observability pack artifact ref.");
  }

  return {
    executionProof: WorkflowExecutionProofDocumentSchema.parse(
      await input.runArtifacts.readJson({
        artifactRef: input.result.executionProofArtifact.artifactRef,
      })
    ),
    observabilityPack: WorkflowObservabilityPackSchema.parse(
      await input.runArtifacts.readJson({ artifactRef: observabilityPackRef })
    ),
    reviewSurface,
  };
};

const reviewWriteKindsFor = (
  operations: ReturnType<typeof createFakePackageD1>["operations"]
): string[] =>
  operations.flatMap((operation) => {
    if (operation.query.includes("review_gates")) {
      return ["review-gate"];
    }

    return operation.values[2] === "review-summary" ? ["review-summary"] : [];
  });

const expectFrontDoorLaneRuntime = (input: {
  readonly capsuleController: ReturnType<
    typeof createAdmissionCapsuleController
  >;
  readonly laneRequests: readonly AgentLaneRuntimeRequest[];
  readonly result: WorkflowRunReceipt;
}): void => {
  const workerReceipt = firstWorkerReceipt(input.result.workerLaneReceipts);
  const verifierReceipt = requireVerifierReceipt(
    input.result.verifierLaneReceipt
  );

  expect({
    admittedKinds: input.capsuleController.admissions.map(
      (admission) => admission.kind
    ),
    laneKinds: input.laneRequests.map((laneRequest) => laneRequest.kind),
    lanePackageMountIds: input.laneRequests.map((laneRequest) =>
      laneRequest.packageMounts?.map(
        (packageMount) => packageMount.metadata.packageId
      )
    ),
    laneTraceIds: input.laneRequests.map(
      (laneRequest) => laneRequest.traceContext.traceId
    ),
    plannerRuntime: input.result.plannerLaneReceipt.runtime,
    receiptSpanIds: [
      input.result.plannerLaneReceipt,
      workerReceipt,
      verifierReceipt,
    ].map((receipt) => receipt.traceContext?.spanId),
    requestSpanIds: input.laneRequests.map(
      (laneRequest) => laneRequest.traceContext.spanId
    ),
    verifierRuntime: verifierReceipt.runtime,
    workerRuntime: workerReceipt.runtime,
  }).toStrictEqual({
    admittedKinds: ["planner", "worker", "verifier"],
    laneKinds: ["planner", "worker", "verifier"],
    lanePackageMountIds: ["planner", "worker", "verifier"].map(() =>
      integrationTestPackageMetadata.map(
        (packageRecord) => packageRecord.packageId
      )
    ),
    laneTraceIds: ["planner", "worker", "verifier"].map(
      () => `trace:${input.result.runId}`
    ),
    plannerRuntime: "pi-agent-cli",
    receiptSpanIds: input.laneRequests.map(
      (laneRequest) => laneRequest.traceContext.spanId
    ),
    requestSpanIds: input.laneRequests.map(
      (laneRequest) => laneRequest.traceContext.spanId
    ),
    verifierRuntime: "pi-agent-cli",
    workerRuntime: "pi-agent-cli",
  });

  expect({
    pinnedPackages: input.result.capsule.pinnedPackageRefs,
    realPlanner: input.result.plannerLaneReceipt.realAgent,
    realVerifier: verifierReceipt.realAgent,
    realWorkers: input.result.workerLaneReceipts.map(
      (receipt) => receipt.realAgent
    ),
    releases: input.capsuleController.releases.map((release) => release.status),
    secretRefs: [
      input.result.plannerLaneReceipt.authLease?.secretRef,
      workerReceipt.authLease?.secretRef,
      verifierReceipt.authLease?.secretRef,
    ],
  }).toStrictEqual({
    pinnedPackages: integrationTestPackageMetadata.map(
      (packageRecord) => packageRecord.latestArtifactRef
    ),
    realPlanner: true,
    realVerifier: true,
    realWorkers: [true],
    releases: ["completed", "completed", "completed"],
    secretRefs: [
      "secretref:pi-agent-auth-json",
      "secretref:pi-agent-auth-json",
      "secretref:pi-agent-auth-json",
    ],
  });
};

const expectFrontDoorReviewEvidence = (input: {
  readonly analyticsDataPoints: readonly unknown[];
  readonly externalTelemetryRequests: readonly {
    readonly body: unknown;
    readonly headers: Headers;
    readonly method: string | undefined;
    readonly url: string;
  }[];
  readonly executionProof: WorkflowExecutionProofDocument;
  readonly fakeD1: ReturnType<typeof createFakePackageD1>;
  readonly observabilityPack: WorkflowObservabilityPack;
  readonly request: WorkflowRunRequest;
  readonly result: WorkflowRunReceipt;
  readonly reviewSurface: ReviewSurfaceDocument;
}): void => {
  const workerReceipt = firstWorkerReceipt(
    input.reviewSurface.laneReceipts.workers
  );
  const verifierReceipt = requireVerifierReceipt(
    input.reviewSurface.laneReceipts.verifier
  );
  const statusProjectionOperations = input.fakeD1.operations.filter(
    (operation) => operation.query.includes("insert into runs")
  );
  const telemetryOperations = input.fakeD1.operations.filter((operation) =>
    operation.query.includes("insert into workflow_telemetry_logs")
  );
  const lastStatusProjectionOperation = statusProjectionOperations.at(-1);
  if (lastStatusProjectionOperation === undefined) {
    throw new Error("Expected status projection D1 operation.");
  }
  const externalTelemetryRequest = input.externalTelemetryRequests.at(0);
  if (externalTelemetryRequest === undefined) {
    throw new Error("Expected external telemetry request.");
  }
  const externalTelemetryBatch = WorkflowExternalTelemetryBatchSchema.parse(
    externalTelemetryRequest.body
  );

  expect({
    acceptanceRefUrls: input.reviewSurface.definitionOfDone.acceptanceRefs.map(
      (ref) => ref.url
    ),
    analyticsDataPointCount: input.analyticsDataPoints.length,
    definitionOfDoneStatus:
      input.reviewSurface.definitionOfDone.reconciliation.status,
    executionProofRef:
      input.reviewSurface.generatedArtifacts.executionProof.artifactRef,
    executionProofStatus: input.executionProof.status,
    externalTelemetryAuthorization:
      externalTelemetryRequest.headers.get("authorization"),
    externalTelemetryLogCount: externalTelemetryBatch.logCount,
    externalTelemetryMethod: externalTelemetryRequest.method,
    externalTelemetryRawSecretExported:
      JSON.stringify(externalTelemetryBatch).includes(
        "artifact-token-secret"
      ) ||
      JSON.stringify(externalTelemetryBatch).includes("leased-pi-auth-json"),
    externalTelemetryRequestCount: input.externalTelemetryRequests.length,
    externalTelemetrySchemaVersion: externalTelemetryBatch.schemaVersion,
    externalTelemetryUrl: externalTelemetryRequest.url,
    observabilityRedaction:
      input.reviewSurface.definitionOfDone.observability.redactionPolicy,
    observabilitySandboxAccountingStatus:
      input.observabilityPack.metrics.sandboxAccountingStatus,
    observabilitySandboxDestroyedLaneCount:
      input.observabilityPack.metrics.sandboxDestroyedLaneCount,
    observabilityStatus:
      input.reviewSurface.definitionOfDone.observability.status,
    observabilityStructuredLogSinkStatus:
      input.observabilityPack.metrics.structuredLogSinkStatus,
    observabilityTelemetrySinkKinds: input.observabilityPack.telemetrySinks.map(
      (receipt) => receipt.sink.kind
    ),
    observabilityTracePropagationStatus:
      input.observabilityPack.metrics.tracePropagationStatus,
    observabilityTraceSpanCountPositive:
      input.observabilityPack.metrics.traceSpanCount > 0,
    packageMountRefs: [
      input.reviewSurface.laneReceipts.planner.packageMounts?.artifactRef,
      workerReceipt.packageMounts?.artifactRef,
      verifierReceipt.packageMounts?.artifactRef,
    ],
    proposalReconciliationMissingIds:
      input.reviewSurface.definitionOfDone.reconciliation.requirements
        .filter((requirement) => requirement.status === "missing")
        .map((requirement) => requirement.requirementId),
    proposalReconciliationRequirementCount:
      input.reviewSurface.definitionOfDone.reconciliation.requirements.length,
    proposalReconciliationStatus:
      input.reviewSurface.definitionOfDone.reconciliation.status,
    reviewSurfaceKind: input.result.reviewSurfaceArtifact.kind,
    reviewSurfacePlanRef: input.reviewSurface.plan.artifactRef,
    reviewSurfaceSandboxCleanup: [
      input.reviewSurface.laneReceipts.planner.sandboxAccounting?.cleanup
        ?.status,
      workerReceipt.sandboxAccounting?.cleanup?.status,
      verifierReceipt.sandboxAccounting?.cleanup?.status,
    ],
    reviewSurfaceVerifierRuntime: verifierReceipt.runtime,
    reviewWriteKinds: reviewWriteKindsFor(input.fakeD1.operations),
    statusProjectionCount: statusProjectionOperations.length,
    statusProjectionLast: lastStatusProjectionOperation.values.slice(0, 7),
    surfaceInRunArtifacts: input.result.artifactRefs.includes(
      input.result.reviewSurfaceArtifact.artifactRef
    ),
    telemetryD1FirstValues: telemetryOperations.at(0)?.values.slice(1, 7),
    telemetryD1OperationCount: telemetryOperations.length,
    telemetryJsonlInRunArtifacts: input.observabilityPack.telemetrySinks.some(
      (receipt) =>
        receipt.sink.kind === "artifact-jsonl" &&
        receipt.artifactRef !== undefined &&
        input.result.artifactRefs.includes(receipt.artifactRef)
    ),
    workflowChainMissingIds:
      input.reviewSurface.definitionOfDone.workflowChain.requirements
        .filter((requirement) => requirement.status === "missing")
        .map((requirement) => requirement.requirementId),
    workflowChainRequirementCount:
      input.reviewSurface.definitionOfDone.workflowChain.requirements.length,
    workflowChainStatus:
      input.reviewSurface.definitionOfDone.workflowChain.status,
  }).toStrictEqual({
    acceptanceRefUrls: ["https://shitrat-brain-proposal.wzrrd.sh/"],
    analyticsDataPointCount: input.observabilityPack.logs.length,
    definitionOfDoneStatus: "reconciled",
    executionProofRef: input.result.executionProofArtifact.artifactRef,
    executionProofStatus: "cloudflare-generated-machine-executed",
    externalTelemetryAuthorization: "Bearer external-test-token",
    externalTelemetryLogCount: input.observabilityPack.logs.length,
    externalTelemetryMethod: "POST",
    externalTelemetryRawSecretExported: false,
    externalTelemetryRequestCount: 1,
    externalTelemetrySchemaVersion: "workflow.external-telemetry-batch.v1",
    externalTelemetryUrl: "https://telemetry.example.test/workflow/logs",
    observabilityRedaction: "no-secrets-no-raw-auth-no-token-bearing-refs",
    observabilitySandboxAccountingStatus: "captured",
    observabilitySandboxDestroyedLaneCount: 2,
    observabilityStatus: "required",
    observabilityStructuredLogSinkStatus: "captured",
    observabilityTelemetrySinkKinds: [
      "artifact-jsonl",
      "cloudflare-d1-structured-logs",
      "cloudflare-analytics-engine",
      "external-http-structured-logs",
    ],
    observabilityTracePropagationStatus: "captured",
    observabilityTraceSpanCountPositive: true,
    packageMountRefs: [
      `artifact://cloudflare-front-door-run/runs/${input.request.runId}/packages/pinned-packages.json`,
      `artifact://cloudflare-front-door-run/runs/${input.request.runId}/packages/pinned-packages.json`,
      `artifact://cloudflare-front-door-run/runs/${input.request.runId}/packages/pinned-packages.json`,
    ],
    proposalReconciliationMissingIds: [],
    proposalReconciliationRequirementCount: 9,
    proposalReconciliationStatus: "reconciled",
    reviewSurfaceKind: "artifact-review",
    reviewSurfacePlanRef: input.result.planArtifact.artifactRef,
    reviewSurfaceSandboxCleanup: ["destroyed", "destroyed", "destroyed"],
    reviewSurfaceVerifierRuntime: "pi-agent-cli",
    reviewWriteKinds: ["review-gate", "review-summary"],
    statusProjectionCount: input.result.eventLog.length,
    statusProjectionLast: [
      input.result.runId,
      input.request.workItemId,
      input.result.capsule.capsuleId,
      input.request.actor.id,
      "captured",
      input.result.planArtifact.artifactRef,
      input.result.planArtifact.hash,
    ],
    surfaceInRunArtifacts: true,
    telemetryD1FirstValues: [
      input.result.runId,
      input.request.workItemId,
      `trace:${input.result.runId}`,
      `span:${input.result.runId}:event:1`,
      "workflow.state.resolvingCapsule",
      "info",
    ],
    telemetryD1OperationCount: input.observabilityPack.logs.length,
    telemetryJsonlInRunArtifacts: true,
    workflowChainMissingIds: [],
    workflowChainRequirementCount: 10,
    workflowChainStatus: "captured",
  });

  const requiredLogFields =
    input.reviewSurface.definitionOfDone.observability
      .requiredStructuredLogFields;
  for (const field of [
    "runId",
    "workItemId",
    "laneId",
    "leaseId",
    "traceId",
    "costEstimate",
  ] as const) {
    expect(requiredLogFields).toContain(field);
  }
};

describe("Cloudflare workflow front door composition", () => {
  it("runs the production composition through admitted real lane adapters", async () => {
    const request = buildIntegrationTestRunRequest();
    const runArtifacts = createMemoryArtifactStore("cloudflare-front-door-run");
    const packageArtifacts = createMemoryArtifactStore(
      "cloudflare-front-door-packages"
    );
    seedPackageArtifacts(packageArtifacts);
    const laneRequests: AgentLaneRuntimeRequest[] = [];
    const analyticsDataPoints: unknown[] = [];
    const externalTelemetryRequests: {
      readonly body: unknown;
      readonly headers: Headers;
      readonly method: string | undefined;
      readonly url: string;
    }[] = [];
    const capsuleController = createAdmissionCapsuleController();
    const fakeD1 = createFakePackageD1({
      entitlements: integrationTestPackageMetadata.map((packageRecord) => ({
        can_discover: 1,
        can_mount: 1,
        package_id: packageRecord.packageId,
        subject_id: integrationTestActor.id,
        subject_type: "actor",
      })),
      rows: integrationTestPackageMetadata.map((packageRecord) =>
        packageRowFor(packageRecord)
      ),
    });
    const frontDoor = createCloudflareWorkflowFrontDoor({
      analyticsEngine: {
        writeDataPoint(event) {
          analyticsDataPoints.push(event);
        },
      },
      analyticsEngineDataset: "pi_cloudflare_sandbox_workflows_telemetry",
      capabilityLeases: createPolicyCapabilityLeaseBroker(runArtifacts, {
        discordSecretRef: "secretref:discord-bot",
        policyId: "discord-message-policy",
      }),
      contextCapsules: capsuleController,
      d1: fakeD1.d1,
      discordMessages: createDryRunDiscordMessageAdapter(),
      discordSecretRefs: {
        dryRun: "secretref:discord-dry-run",
        send: "secretref:discord-bot",
      },
      externalTelemetry: {
        authorizationBearerToken: "external-test-token",
        endpointUrl: "https://telemetry.example.test/workflow/logs",
        fetch(url, init) {
          if (typeof init.body !== "string") {
            throw new TypeError("Expected external telemetry JSON body.");
          }
          externalTelemetryRequests.push({
            body: JSON.parse(init.body) as unknown,
            headers: new Headers(init.headers),
            method: init.method,
            url,
          });

          return Promise.resolve(new Response(null, { status: 202 }));
        },
        sinkId: "operator-external-collector",
      },
      laneRuntime: createFakeRealLaneRuntime({
        artifacts: runArtifacts,
        requests: laneRequests,
      }),
      maxActiveLanes: 2,
      model: "integration-test-pi-model",
      packageArtifacts,
      piAuthJsonBase64: "leased-pi-auth-json",
      piAuthSecretRef: "secretref:pi-agent-auth-json",
      provisionRunStore: () =>
        Promise.resolve({
          artifactRemote: "https://artifacts.example.invalid/run.git",
          artifactRepoName: "cloudflare-front-door-run",
          artifactTokenExpiresAt: "2026-06-08T23:30:00.000Z",
          artifactTokenSecret: "artifact-token-secret",
          store: runArtifacts,
        } satisfies CloudflareArtifactsRunStore),
      timeoutMs: 30_000,
    });

    const result = requireCapturedResult(await frontDoor.startRun(request));
    const evidence = await readFrontDoorEvidence({ result, runArtifacts });

    expect(result.status).toBe("captured");
    expectFrontDoorLaneRuntime({ capsuleController, laneRequests, result });
    expectFrontDoorReviewEvidence({
      analyticsDataPoints,
      externalTelemetryRequests,
      fakeD1,
      request,
      result,
      ...evidence,
    });
  });
});
