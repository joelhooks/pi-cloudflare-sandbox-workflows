import { describe, expect, it } from "vitest";

import { AgentLaneAlreadyCompletedError } from "../../src/app/application/admitted-agent-lane-runtime.ts";
import { PlannerBlueprintContractError } from "../../src/app/application/ports.ts";
import type {
  AgentLaneRuntimePort,
  AgentLaneRuntimeRequest,
  ArtifactStoreContract,
} from "../../src/app/application/ports.ts";
import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  AgentLaneReceiptSchema,
  DiscordMessagePayloadSchema,
  DynamicWorkflowPlanDocumentSchema,
  PlannerLaneBlueprintDocumentSchema,
  VerificationResultDocumentSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  PlannerLaneBlueprintDocument,
  VerificationResultDocument,
} from "../../src/app/domain/schemas.ts";
import { workflowTraceContextForLane } from "../../src/app/domain/trace-context.ts";
import {
  createCloudflarePiAnalysisReasoningLaneAdapter,
  createCloudflarePiPlannerLaneAdapter,
  createCloudflarePiVerifierLaneAdapter,
  createCloudflarePiWorkerLaneAdapter,
  plannerBlueprintContractError,
} from "../../src/app/infrastructure/cloudflare-agent-lane-adapters.ts";
import {
  createIntegrationTestDynamicWorkflowPlanner,
  createMemoryArtifactStore,
  createMemoryPackageRegistryActor,
} from "../../src/app/infrastructure/memory-adapters.ts";
import { MemoryAgenticRefinementOutputSchema } from "../../src/cartridges/memory-fabric/schemas.ts";
import {
  buildIntegrationTestRunRequest,
  integrationTestActor,
  integrationTestPackageMetadata,
} from "./workflow-app-fixtures.ts";

const buildPlannerLaneFixture = async () => {
  const artifacts = createMemoryArtifactStore("planner-lane-adapter");
  const request = buildIntegrationTestRunRequest();
  const registry = createMemoryPackageRegistryActor(
    integrationTestPackageMetadata
  );
  const pinResult = await registry.pinPackages({
    actor: request.actor,
    packageIds: request.planProposal.requestedPackageIds,
  });
  if (pinResult.status !== "pinned") {
    throw new Error(pinResult.blocker.message);
  }

  const message = request.planProposal.discordMessage;
  if (message === undefined) {
    throw new Error("Planner lane fixture requires a Discord message.");
  }

  const payload = DiscordMessagePayloadSchema.parse({
    body: message.body,
    bodyHash: sha256Hex(message.body),
    channelRef: message.channelRef,
    serverRef: message.serverRef,
  });
  const payloadWrite = await artifacts.writeJson({
    path: "payloads/discord-message.json",
    redacted: true,
    runId: request.runId,
    value: payload,
  });
  const planner = createIntegrationTestDynamicWorkflowPlanner();
  const blueprint = await planner.proposePlan({
    actor: request.actor,
    availablePackages: integrationTestPackageMetadata,
    notification: {
      dryRun: message.dryRun ?? true,
      payloadHash: payload.bodyHash,
      payloadRef: payloadWrite.artifactRef,
      resource: {
        channelRef: message.channelRef,
        kind: "discord.channel",
        serverRef: message.serverRef,
      },
      reviewGate: {
        mode: "dry-run-exempt",
        reason: "Planner adapter fixture dry-run lease.",
      },
      secretRef: "secretref:discord-dry-run",
    },
    pinnedPackages: pinResult.pinnedPackages,
    proposal: request.planProposal,
    runId: request.runId,
    workItemId: request.workItemId,
  });

  return {
    artifacts,
    plannerInput: {
      actor: request.actor,
      availablePackages: integrationTestPackageMetadata,
      pinnedPackages: pinResult.pinnedPackages,
      proposal: request.planProposal,
      runId: request.runId,
      workItemId: request.workItemId,
    },
    plannerOutput: PlannerLaneBlueprintDocumentSchema.parse({
      harness: blueprint.harness,
      machine: blueprint.machine,
      plan: blueprint.plan,
      verificationContract: blueprint.verificationContract,
    }),
  };
};

const agentAuthLeaseFor = (input: {
  readonly runId: string;
  readonly workItemId: string;
}) =>
  ({
    expiresAt: "2026-06-08T20:15:00.000Z",
    issuedAt: "2026-06-08T20:00:00.000Z",
    leaseId: `lease:pi-agent-auth:${input.runId}:test`,
    redacted: true,
    runId: input.runId,
    scope: "pi-agent-auth-json",
    secretRef: "secretref:pi-agent-auth-json",
    workItemId: input.workItemId,
  }) as const;

const createPlannerRuntimeHarness = (input: {
  readonly artifacts: ReturnType<typeof createMemoryArtifactStore>;
  // Widened to a plain JSON object so a faithful hostile double can pin a
  // wrong-shape (non-blueprint) lane output without an unsafe cast — the harness
  // only ever JSON-serializes/hashes this value, never reads blueprint fields.
  readonly plannerOutput:
    | PlannerLaneBlueprintDocument
    | Record<string, unknown>;
  readonly realAgent?: boolean;
}) => {
  const capturedRequests: AgentLaneRuntimeRequest[] = [];
  const runtime: AgentLaneRuntimePort = {
    runLane(request) {
      capturedRequests.push(request);
      const outputRef = request.artifactRef({
        path: request.outputPath,
        runId: request.runId,
      });
      const promptRef = request.artifactRef({
        path: request.promptPath,
        runId: request.runId,
      });
      const transcriptRef = request.artifactRef({
        path: request.transcriptPath,
        runId: request.runId,
      });
      const receiptRef = request.artifactRef({
        path: request.receiptPath,
        runId: request.runId,
      });
      const transcript = "real planner transcript from Cloudflare Sandbox";
      input.artifacts.setJson(outputRef, input.plannerOutput);
      input.artifacts.setText(promptRef, request.prompt, "text/markdown");
      input.artifacts.setText(transcriptRef, transcript, "text/markdown");

      return Promise.resolve(
        AgentLaneReceiptSchema.parse({
          artifactCommitSha:
            "plannercommit000000000000000000000000000000000000",
          authLease: request.authLease,
          completedAt: "2026-06-08T20:00:01.000Z",
          kind: "planner",
          laneId: request.laneId,
          outputPins: [
            {
              artifactRef: outputRef,
              hash: hashJson(input.plannerOutput),
              mediaType: "application/json",
            },
          ],
          outputRefs: [outputRef],
          prompt: {
            artifactRef: promptRef,
            hash: sha256Hex(request.prompt),
            mediaType: "text/markdown",
          },
          realAgent: input.realAgent ?? true,
          receiptRef,
          redacted: true,
          runtime: "pi-agent-cli",
          sandboxAccounting: {
            cleanup: {
              receipt: "destroy:planner-lane-test:ok",
              status: "destroyed",
            },
            commandDurationMs: 1234,
          },
          sandboxRef: "cloudflare-sandbox:planner-lane-test",
          startedAt: "2026-06-08T20:00:00.000Z",
          status: "completed",
          traceContext: request.traceContext,
          transcript: {
            artifactRef: transcriptRef,
            hash: sha256Hex(transcript),
            mediaType: "text/markdown",
          },
        })
      );
    },
    runtime: "pi-agent-cli",
  };

  return { capturedRequests, runtime };
};

const buildVerifierLaneFixture = async () => {
  const plannerFixture = await buildPlannerLaneFixture();
  const { artifacts, plannerInput, plannerOutput } = plannerFixture;
  const machineSource = "export const machine = {} as const;\n";
  const plannerLaneReceipt = AgentLaneReceiptSchema.parse({
    artifactCommitSha: "plannercommit000000000000000000000000000000000000",
    authLease: agentAuthLeaseFor(plannerInput),
    completedAt: "2026-06-08T20:00:01.000Z",
    kind: "planner",
    laneId: `lane:planner:${plannerInput.runId}`,
    outputPins: [],
    outputRefs: [],
    prompt: {
      artifactRef: artifacts.artifactRef({
        path: "lanes/planner/prompt.md",
        runId: plannerInput.runId,
      }),
      hash: sha256Hex("planner prompt"),
      mediaType: "text/markdown",
    },
    realAgent: true,
    receiptRef: artifacts.artifactRef({
      path: "receipts/planner-lane.json",
      runId: plannerInput.runId,
    }),
    redacted: true,
    runtime: "pi-agent-cli",
    sandboxRef: "cloudflare-sandbox:planner-lane-test",
    startedAt: "2026-06-08T20:00:00.000Z",
    status: "completed",
    traceContext: workflowTraceContextForLane({
      laneId: `lane:planner:${plannerInput.runId}`,
      runId: plannerInput.runId,
    }),
    transcript: {
      artifactRef: artifacts.artifactRef({
        path: "lanes/planner/transcript.md",
        runId: plannerInput.runId,
      }),
      hash: sha256Hex("planner transcript"),
      mediaType: "text/markdown",
    },
  });
  const plan = DynamicWorkflowPlanDocumentSchema.parse({
    ...plannerOutput.plan,
    harness: {
      artifactRef: artifacts.artifactRef({
        path: plannerOutput.harness.entrypoint,
        runId: plannerInput.runId,
      }),
      entrypoint: plannerOutput.harness.entrypoint,
      harnessId: plannerOutput.harness.harnessId,
      hash: sha256Hex(plannerOutput.harness.source),
      language: plannerOutput.harness.language,
    },
    machine: {
      artifactRef: artifacts.artifactRef({
        path: "workflows/machine.config.json",
        runId: plannerInput.runId,
      }),
      hash: hashJson(plannerOutput.machine),
      machineId: plannerOutput.machine.machineId,
      sourceArtifactRef: artifacts.artifactRef({
        path: "workflows/machine.ts",
        runId: plannerInput.runId,
      }),
      sourceHash: sha256Hex(machineSource),
    },
    plannerLane: plannerLaneReceipt,
    verificationContract: {
      artifactRef: artifacts.artifactRef({
        path: "run/verification-contract.json",
        runId: plannerInput.runId,
      }),
      contractId: plannerOutput.verificationContract.contractId,
      hash: hashJson(plannerOutput.verificationContract),
      mediaType: "application/json",
    },
  });
  const verificationResult = VerificationResultDocumentSchema.parse({
    checkedAt: "2026-06-08T20:05:00.000Z",
    contractId: plannerOutput.verificationContract.contractId,
    failures: [],
    resultId: `verification-result:${plannerInput.runId}`,
    runId: plannerInput.runId,
    schemaVersion: "workflow.verification-result.v1",
    status: "accepted",
    verifierLaneId: `lane:verifier:${plannerInput.runId}`,
  });

  return {
    artifacts,
    contract: plannerOutput.verificationContract,
    machine: plannerOutput.machine,
    plan,
    verificationResult,
  };
};

const createVerifierRuntimeHarness = (input: {
  readonly artifacts: ReturnType<typeof createMemoryArtifactStore>;
  readonly verificationResult: VerificationResultDocument;
}) => {
  const capturedRequests: AgentLaneRuntimeRequest[] = [];
  const runtime: AgentLaneRuntimePort = {
    runLane(request) {
      capturedRequests.push(request);
      const outputRef = request.artifactRef({
        path: request.outputPath,
        runId: request.runId,
      });
      const promptRef = request.artifactRef({
        path: request.promptPath,
        runId: request.runId,
      });
      const transcriptRef = request.artifactRef({
        path: request.transcriptPath,
        runId: request.runId,
      });
      const receiptRef = request.artifactRef({
        path: request.receiptPath,
        runId: request.runId,
      });
      const transcript = "real verifier transcript from Cloudflare Sandbox";
      input.artifacts.setJson(outputRef, input.verificationResult);
      input.artifacts.setText(promptRef, request.prompt, "text/markdown");
      input.artifacts.setText(transcriptRef, transcript, "text/markdown");

      return Promise.resolve(
        AgentLaneReceiptSchema.parse({
          artifactCommitSha: "verifiercommit0000000000000000000000000000000000",
          authLease: request.authLease,
          completedAt: "2026-06-08T20:05:01.000Z",
          kind: "verifier",
          laneId: request.laneId,
          outputPins: [
            {
              artifactRef: outputRef,
              hash: hashJson(input.verificationResult),
              mediaType: "application/json",
            },
          ],
          outputRefs: [outputRef],
          prompt: {
            artifactRef: promptRef,
            hash: sha256Hex(request.prompt),
            mediaType: "text/markdown",
          },
          realAgent: true,
          receiptRef,
          redacted: true,
          runtime: "pi-agent-cli",
          sandboxRef: "cloudflare-sandbox:verifier-lane-test",
          startedAt: "2026-06-08T20:05:00.000Z",
          status: "completed",
          traceContext: request.traceContext,
          transcript: {
            artifactRef: transcriptRef,
            hash: sha256Hex(transcript),
            mediaType: "text/markdown",
          },
        })
      );
    },
    runtime: "pi-agent-cli",
  };

  return { capturedRequests, runtime };
};

const createWorkerRuntimeHarness = () => {
  const capturedRequests: AgentLaneRuntimeRequest[] = [];
  const runtime: AgentLaneRuntimePort = {
    runLane(request) {
      capturedRequests.push(request);
      const outputRef = request.artifactRef({
        path: request.outputPath,
        runId: request.runId,
      });
      const promptRef = request.artifactRef({
        path: request.promptPath,
        runId: request.runId,
      });
      const transcriptRef = request.artifactRef({
        path: request.transcriptPath,
        runId: request.runId,
      });
      const receiptRef = request.artifactRef({
        path: request.receiptPath,
        runId: request.runId,
      });
      const transcript = "real worker transcript from Cloudflare Sandbox";

      return Promise.resolve(
        AgentLaneReceiptSchema.parse({
          artifactCommitSha: "workercommit00000000000000000000000000000000000",
          authLease: request.authLease,
          completedAt: "2026-06-08T20:04:01.000Z",
          kind: "worker",
          laneId: request.laneId,
          outputPins: [
            {
              artifactRef: outputRef,
              hash: sha256Hex("worker output"),
              mediaType: request.outputMediaType,
            },
          ],
          outputRefs: [outputRef],
          prompt: {
            artifactRef: promptRef,
            hash: sha256Hex(request.prompt),
            mediaType: "text/markdown",
          },
          realAgent: true,
          receiptRef,
          redacted: true,
          runtime: "pi-agent-cli",
          sandboxRef: "cloudflare-sandbox:worker-lane-test",
          startedAt: "2026-06-08T20:04:00.000Z",
          status: "completed",
          traceContext: request.traceContext,
          transcript: {
            artifactRef: transcriptRef,
            hash: sha256Hex(transcript),
            mediaType: "text/markdown",
          },
        })
      );
    },
    runtime: "pi-agent-cli",
  };

  return { capturedRequests, runtime };
};

const observeArtifactReads = (store: ArtifactStoreContract) => {
  const reads: {
    readonly artifactCommitSha?: string;
    readonly artifactRef: string;
    readonly kind: "json" | "text";
  }[] = [];
  const observedStore: ArtifactStoreContract = {
    artifactRef: store.artifactRef.bind(store),
    readJson(input) {
      reads.push({ ...input, kind: "json" });
      return store.readJson(input);
    },
    readText(input) {
      reads.push({ ...input, kind: "text" });
      return store.readText(input);
    },
    writeJson: store.writeJson.bind(store),
    writeText: store.writeText.bind(store),
  };

  return { observedStore, reads };
};

describe("memory artifact store", () => {
  it("enforces JSON and text media-type boundaries", async () => {
    const artifacts = createMemoryArtifactStore("memory-artifact-boundary");
    const runId = "run:memory-artifact-boundary";
    const jsonWrite = await artifacts.writeJson({
      path: "outputs/data.json",
      redacted: true,
      runId,
      value: { ok: true },
    });
    const textWrite = await artifacts.writeText({
      mediaType: "text/markdown",
      path: "outputs/report.md",
      redacted: true,
      runId,
      value: "# Report",
    });

    await expect(
      artifacts.readText({ artifactRef: jsonWrite.artifactRef })
    ).rejects.toThrow("Text artifact not found");
    await expect(
      artifacts.readJson({ artifactRef: textWrite.artifactRef })
    ).rejects.toThrow("JSON artifact not found");
  });
});

describe("Cloudflare Pi planner lane adapter", () => {
  it("runs a planner lane and attaches real lane evidence", async () => {
    const fixture = await buildPlannerLaneFixture();
    const harness = createPlannerRuntimeHarness(fixture);
    const adapter = createCloudflarePiPlannerLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plannerInput),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    const blueprint = await adapter.proposePlan(fixture.plannerInput);

    expect({
      artifactCommitSha: blueprint.plannerLane.artifactCommitSha,
      authSecretRef: blueprint.plannerLane.authLease?.secretRef,
      promptIncludesContract: blueprint.plannerLane.prompt.value.includes(
        "Do not include plannerLane"
      ),
      realAgent: blueprint.plannerLane.realAgent,
      runtime: blueprint.plannerLane.runtime,
      sandboxCleanup: blueprint.plannerLane.sandboxAccounting?.cleanup?.status,
      sandboxDurationMs:
        blueprint.plannerLane.sandboxAccounting?.commandDurationMs,
      traceContext: blueprint.plannerLane.traceContext,
      transcript: blueprint.plannerLane.transcript.value,
    }).toStrictEqual({
      artifactCommitSha: "plannercommit000000000000000000000000000000000000",
      authSecretRef: "secretref:pi-agent-auth-json",
      promptIncludesContract: true,
      realAgent: true,
      runtime: "pi-agent-cli",
      sandboxCleanup: "destroyed",
      sandboxDurationMs: 1234,
      traceContext: workflowTraceContextForLane({
        laneId: `lane:planner:${fixture.plannerInput.runId}`,
        runId: fixture.plannerInput.runId,
      }),
      transcript: "real planner transcript from Cloudflare Sandbox",
    });
  });

  it("passes the structured-output prompt and blueprint output path to Pi", async () => {
    const fixture = await buildPlannerLaneFixture();
    const harness = createPlannerRuntimeHarness(fixture);
    const adapter = createCloudflarePiPlannerLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plannerInput),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    await adapter.proposePlan(fixture.plannerInput);
    const request = harness.capturedRequests.at(0);
    if (request === undefined) {
      throw new Error("Expected planner runtime request to be captured.");
    }
    const packageMountIds =
      request.packageMounts?.map(
        (packageMount) => packageMount.metadata.packageId
      ) ?? [];

    expect({
      authSecretRef: request.authLease.secretRef,
      kind: request.kind,
      outputMediaType: request.outputMediaType,
      outputPath: request.outputPath,
      packageMountIds,
      promptHasContract: request.prompt.includes(
        "Strict Structured Output Contract"
      ),
      promptHasDeterministicVerifierOption: request.prompt.includes(
        'use verificationContract.verifier {"kind":"deterministic","source":"builtin:artifact-evidence-integrity.v1"} instead'
      ),
      promptHasGitHubPrDoD: request.prompt.includes(
        'Use outputTarget {"kind":"github-pr","repositoryRef":"<owner/repo>","branchName":"<branch>","baseBranch":"main"}'
      ),
      promptHasJsonSchema: request.prompt.includes(
        "PlannerLaneBlueprintDocument JSON Schema"
      ),
      promptHasLinearDoD: request.prompt.includes(
        'Use outputTarget {"kind":"linear","issueRef":"<issue-id-or-key>"}'
      ),
      promptHasPinnedPackagesBinding: request.prompt.includes(
        "Copy plan.pinnedPackages exactly from Pinned Packages"
      ),
      promptHasSideEffects: request.prompt.includes(
        "Every side effect must be represented"
      ),
      promptHasStateProtocol: request.prompt.includes(
        "Do not use NEXT to move between executable step states."
      ),
      promptHasSupportedDeterministicChecks: request.prompt.includes(
        "deterministic-output-evidence-present, deterministic-output-evidence-hashes-match, deterministic-side-effect-receipts-cover-plan, deterministic-observability-pack-present"
      ),
      promptHasVerifierOutputPath: request.prompt.includes(
        'Use verificationContract.outputPath exactly "artifacts/verification/result.json"'
      ),
      promptHasWzrrdDoD: request.prompt.includes(
        'Use outputTarget {"kind":"wzrrd","reviewPath":"review/summary.json"}'
      ),
      promptKeepsOutputDeliveryPostVerifier: request.prompt.includes(
        "Do not model outputTarget delivery as pre-verifier plan.sideEffects or capability steps."
      ),
      promptKeepsVerifierSeparateFromReview: request.prompt.includes(
        "verificationContract.outputPath must not equal any plan.steps[*].outputPath"
      ),
      promptMarksReviewSummaryReserved: request.prompt.includes(
        "Treat plan.steps with kind review.summary as a reserved post-verifier review-gate marker"
      ),
      promptNamesSourceSchema: request.prompt.includes(
        "PlannerLaneBlueprintDocumentSchema"
      ),
      promptSampleReviewSummaryIsPostVerifier: request.prompt.includes(
        "Reserve post-verifier review summary capture; no pre-verifier artifact is produced by this step."
      ),
      traceContext: request.traceContext,
    }).toStrictEqual({
      authSecretRef: "secretref:pi-agent-auth-json",
      kind: "planner",
      outputMediaType: "application/json",
      outputPath: "run/planner-blueprint.json",
      packageMountIds: integrationTestPackageMetadata.map(
        (packageRecord) => packageRecord.packageId
      ),
      promptHasContract: true,
      promptHasDeterministicVerifierOption: true,
      promptHasGitHubPrDoD: true,
      promptHasJsonSchema: true,
      promptHasLinearDoD: true,
      promptHasPinnedPackagesBinding: true,
      promptHasSideEffects: true,
      promptHasStateProtocol: true,
      promptHasSupportedDeterministicChecks: true,
      promptHasVerifierOutputPath: true,
      promptHasWzrrdDoD: true,
      promptKeepsOutputDeliveryPostVerifier: true,
      promptKeepsVerifierSeparateFromReview: true,
      promptMarksReviewSummaryReserved: true,
      promptNamesSourceSchema: true,
      promptSampleReviewSummaryIsPostVerifier: true,
      traceContext: workflowTraceContextForLane({
        laneId: `lane:planner:${fixture.plannerInput.runId}`,
        runId: fixture.plannerInput.runId,
      }),
    });
  });

  it("reads planner output artifacts at the lane commit", async () => {
    const fixture = await buildPlannerLaneFixture();
    const harness = createPlannerRuntimeHarness(fixture);
    const { observedStore, reads } = observeArtifactReads(fixture.artifacts);
    const adapter = createCloudflarePiPlannerLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: observedStore,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plannerInput),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    await adapter.proposePlan(fixture.plannerInput);

    expect(reads.map((read) => read.kind)).toStrictEqual(["json", "text"]);
    expect(reads.map((read) => read.artifactCommitSha)).toStrictEqual([
      "plannercommit000000000000000000000000000000000000",
      "plannercommit000000000000000000000000000000000000",
    ]);
  });

  it("rejects planner receipts that do not prove real agent execution", async () => {
    const fixture = await buildPlannerLaneFixture();
    const harness = createPlannerRuntimeHarness({
      ...fixture,
      realAgent: false,
    });
    const adapter = createCloudflarePiPlannerLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plannerInput),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    await expect(adapter.proposePlan(fixture.plannerInput)).rejects.toThrow(
      "Agent runtime lane receipts must be marked realAgent"
    );
  });

  // Wound #27, faithful end-to-end hostile double: the lane RAN and pinned an
  // output, but pi emitted a non-blueprint object (here the `{ result: ... }`
  // shape observed live, where all four required top-level keys were undefined).
  // The adapter reads the REAL pinned artifact through the REAL schema's
  // safeParse and must throw a typed PlannerBlueprintContractError naming what pi
  // emitted vs what the contract required — never a bare ZodError that upstream
  // flattens into a transient adapter_unavailable and blind-re-drives.
  it("throws a diagnostic PlannerBlueprintContractError when the pinned planner output is not a blueprint", async () => {
    const fixture = await buildPlannerLaneFixture();
    const wrongShapeOutput: Record<string, unknown> = {
      result: {
        summary: "pi emitted a result envelope instead of the flat blueprint",
      },
    };
    const harness = createPlannerRuntimeHarness({
      ...fixture,
      plannerOutput: wrongShapeOutput,
    });
    const adapter = createCloudflarePiPlannerLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plannerInput),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    const rejection = await adapter.proposePlan(fixture.plannerInput).then(
      () => {
        throw new Error("expected proposePlan to reject");
      },
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(PlannerBlueprintContractError);
    if (!(rejection instanceof PlannerBlueprintContractError)) {
      throw new Error("expected a PlannerBlueprintContractError");
    }
    const contractError = rejection;
    expect({
      deterministic: contractError.message.includes("deterministic"),
      missingKeys: [...contractError.missingKeys].toSorted(),
      namesPresentKeys: contractError.message.includes(
        "present top-level keys [result]"
      ),
      presentKeys: contractError.presentKeys,
      runId: contractError.runId,
      stage: contractError.stage,
      workItemId: contractError.workItemId,
    }).toStrictEqual({
      deterministic: true,
      missingKeys: ["harness", "machine", "plan", "verificationContract"],
      namesPresentKeys: true,
      presentKeys: ["result"],
      runId: fixture.plannerInput.runId,
      stage: "planner-output",
      workItemId: fixture.plannerInput.workItemId,
    });
  });

  // Unit-level faithful double for the factory: feed the REAL schema's parse
  // error from the REAL wrong-shape object. A polite double would hand-craft a
  // ZodError; this runs the production schema so the diagnostic stays bound to
  // what the schema actually rejects.
  it("plannerBlueprintContractError derives present/missing keys from the real schema error", () => {
    const raw = { notes: ["x"], result: { summary: "not a blueprint" } };
    const parsed = PlannerLaneBlueprintDocumentSchema.safeParse(raw);
    expect(parsed.success).toBeFalsy();
    if (parsed.success) {
      return;
    }

    const error = plannerBlueprintContractError({
      raw,
      requiredKeys: Object.keys(PlannerLaneBlueprintDocumentSchema.shape),
      runId: "run-x",
      stage: "planner-output",
      workItemId: "work-x",
      zodError: parsed.error,
    });

    expect({
      hasIssuePaths: error.issuePaths.length > 0,
      missingKeys: [...error.missingKeys].toSorted(),
      presentKeys: [...error.presentKeys].toSorted(),
    }).toStrictEqual({
      hasIssuePaths: true,
      missingKeys: ["harness", "machine", "plan", "verificationContract"],
      presentKeys: ["notes", "result"],
    });
  });
});

describe("Cloudflare Pi worker lane adapter", () => {
  it("passes a schema-backed research-review JSON contract to Pi", async () => {
    const fixture = await buildVerifierLaneFixture();
    const harness = createWorkerRuntimeHarness();
    const adapter = createCloudflarePiWorkerLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plan),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });
    const step = fixture.plan.steps.find(
      (planStep) => planStep.kind === "research.review"
    );
    if (step === undefined) {
      throw new Error("Fixture is missing a research.review step.");
    }

    await adapter.runStep({
      machine: fixture.machine,
      plan: fixture.plan,
      step,
    });
    const request = harness.capturedRequests.at(0);

    expect({
      outputMediaType: request?.outputMediaType,
      outputPath: request?.outputPath,
      packageMountIds: request?.packageMounts?.map(
        (packageMount) => packageMount.metadata.packageId
      ),
      promptHasJsonOnlyRule: request?.prompt.includes("Emit only JSON"),
      promptHasResearchSchema: request?.prompt.includes(
        "ResearchReviewOutputDocumentSchema"
      ),
      promptHasRunBinding: request?.prompt.includes(
        `Use runId exactly ${JSON.stringify(fixture.plan.runId)}.`
      ),
      promptHasStepBinding: request?.prompt.includes(
        `Use stepId exactly ${JSON.stringify(step.stepId)}.`
      ),
      traceContext: request?.traceContext,
    }).toStrictEqual({
      outputMediaType: "application/json",
      outputPath: "outputs/research-review.json",
      packageMountIds: integrationTestPackageMetadata.map(
        (packageRecord) => packageRecord.packageId
      ),
      promptHasJsonOnlyRule: true,
      promptHasResearchSchema: true,
      promptHasRunBinding: true,
      promptHasStepBinding: true,
      traceContext: workflowTraceContextForLane({
        laneId: `lane:worker:${fixture.plan.runId}:${step.stepId}`,
        runId: fixture.plan.runId,
      }),
    });
  });
});

describe("Cloudflare Pi verifier lane adapter", () => {
  it("passes a schema-backed verification-result prompt to Pi", async () => {
    const fixture = await buildVerifierLaneFixture();
    const harness = createVerifierRuntimeHarness(fixture);
    const adapter = createCloudflarePiVerifierLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plan),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    const result = await adapter.verify({
      capabilityReceipts: [],
      contract: fixture.contract,
      outputEvidence: [
        {
          artifactCommitSha: "workercommit000000000000000000000000000000000000",
          artifactRef: fixture.artifacts.artifactRef({
            path: "outputs/research-review.json",
            runId: fixture.plan.runId,
          }),
          hash: sha256Hex("worker output"),
          mediaType: "text/markdown",
          text: "worker output",
        },
      ],
      outputRefs: [
        fixture.artifacts.artifactRef({
          path: "outputs/research-review.json",
          runId: fixture.plan.runId,
        }),
      ],
      plan: fixture.plan,
    });
    const request = harness.capturedRequests.at(0);

    expect({
      outputPath: request?.outputPath,
      packageMountIds: request?.packageMounts?.map(
        (packageMount) => packageMount.metadata.packageId
      ),
      promptHasCapabilityEvidence: request?.prompt.includes(
        "Capability Receipt Evidence"
      ),
      promptHasContractIdBinding: request?.prompt.includes(
        `Use contractId exactly ${JSON.stringify(fixture.contract.contractId)}.`
      ),
      promptHasExtractedObservabilityRule: request?.prompt.includes(
        "inspect extractedObservabilityPack before the truncated text snapshot"
      ),
      promptHasJsonSchema: request?.prompt.includes(
        "VerificationResultDocument JSON Schema"
      ),
      promptHasOutputPathRule: request?.prompt.includes(
        "do not require that file to exist before this verifier lane writes it"
      ),
      promptHasPostVerifierArtifactRule: request?.prompt.includes(
        "Do not require final review surface evidence"
      ),
      promptHasPostVerifierDeliveryLeaseRule: request?.prompt.includes(
        "the app executes those leases only after verifier acceptance"
      ),
      promptHasResultIdBinding: request?.prompt.includes(
        `Use resultId exactly ${JSON.stringify(`verification-result:${fixture.plan.runId}`)}.`
      ),
      promptHasStatusRules: request?.prompt.includes(
        "Use status accepted when all blocking checks pass"
      ),
      promptHasTelemetrySinkRule: request?.prompt.includes(
        "telemetrySinks is the structured log sink evidence"
      ),
      promptIgnoresReviewSummaryAsWorkerOutput: request?.prompt.includes(
        "Ignore review.summary steps when deciding whether worker-lane output evidence is present"
      ),
      promptIncludesOutputEvidence: request?.prompt.includes(
        "Output Evidence Snapshots"
      ),
      promptNamesSourceSchema: request?.prompt.includes(
        "VerificationResultDocumentSchema"
      ),
      promptTreatsEmptyCapabilityReceiptsAsPreVerifierOnly:
        request?.prompt.includes(
          "If Capability Receipt Evidence is empty, treat it as no pre-verifier side effects executed"
        ),
      promptTreatsReviewSummaryAsPostVerifierReservation:
        request?.prompt.includes(
          "When plan.steps includes kind review.summary, treat that step as a post-verifier review-gate reservation"
        ),
      resultDocumentStatus: result.resultDocument.status,
      resultId: result.result.resultId,
      traceContext: request?.traceContext,
    }).toStrictEqual({
      outputPath: fixture.contract.outputPath,
      packageMountIds: integrationTestPackageMetadata.map(
        (packageRecord) => packageRecord.packageId
      ),
      promptHasCapabilityEvidence: true,
      promptHasContractIdBinding: true,
      promptHasExtractedObservabilityRule: true,
      promptHasJsonSchema: true,
      promptHasOutputPathRule: true,
      promptHasPostVerifierArtifactRule: true,
      promptHasPostVerifierDeliveryLeaseRule: true,
      promptHasResultIdBinding: true,
      promptHasStatusRules: true,
      promptHasTelemetrySinkRule: true,
      promptIgnoresReviewSummaryAsWorkerOutput: true,
      promptIncludesOutputEvidence: true,
      promptNamesSourceSchema: true,
      promptTreatsEmptyCapabilityReceiptsAsPreVerifierOnly: true,
      promptTreatsReviewSummaryAsPostVerifierReservation: true,
      resultDocumentStatus: "accepted",
      resultId: `verification-result:${fixture.plan.runId}`,
      traceContext: workflowTraceContextForLane({
        laneId: `lane:verifier:${fixture.plan.runId}`,
        runId: fixture.plan.runId,
      }),
    });
  });

  it("recovers a completed verifier lane from its committed receipt", async () => {
    const fixture = await buildVerifierLaneFixture();
    const laneId = `lane:verifier:${fixture.plan.runId}`;
    const artifactCommitSha =
      "verifiercommit0000000000000000000000000000000000";
    const outputRef = fixture.artifacts.artifactRef({
      path: fixture.contract.outputPath,
      runId: fixture.plan.runId,
    });
    const promptRef = fixture.artifacts.artifactRef({
      path: "lanes/verifier/prompt.md",
      runId: fixture.plan.runId,
    });
    const receiptRef = fixture.artifacts.artifactRef({
      path: "receipts/verifier-lane.json",
      runId: fixture.plan.runId,
    });
    const transcriptRef = fixture.artifacts.artifactRef({
      path: "lanes/verifier/transcript.md",
      runId: fixture.plan.runId,
    });
    const transcript = "recovered verifier transcript";
    fixture.artifacts.setJson(outputRef, fixture.verificationResult);
    fixture.artifacts.setJson(
      receiptRef,
      AgentLaneReceiptSchema.parse({
        authLease: agentAuthLeaseFor(fixture.plan),
        completedAt: "2026-06-08T20:05:01.000Z",
        kind: "verifier",
        laneId,
        outputPins: [
          {
            artifactRef: outputRef,
            hash: hashJson(fixture.verificationResult),
            mediaType: "application/json",
          },
        ],
        outputRefs: [outputRef],
        prompt: {
          artifactRef: promptRef,
          hash: sha256Hex("verifier prompt"),
          mediaType: "text/markdown",
        },
        realAgent: true,
        receiptRef,
        redacted: true,
        runtime: "pi-agent-cli",
        sandboxRef: "cloudflare-sandbox:verifier-lane-test",
        startedAt: "2026-06-08T20:05:00.000Z",
        status: "completed",
        traceContext: workflowTraceContextForLane({
          laneId,
          runId: fixture.plan.runId,
        }),
        transcript: {
          artifactRef: transcriptRef,
          hash: sha256Hex(transcript),
          mediaType: "text/markdown",
        },
      })
    );
    const capturedRequests: AgentLaneRuntimeRequest[] = [];
    const runtime: AgentLaneRuntimePort = {
      runLane(request) {
        capturedRequests.push(request);
        throw new AgentLaneAlreadyCompletedError({
          artifactCommitSha,
          kind: "verifier",
          laneId,
          runId: fixture.plan.runId,
          workItemId: fixture.plan.workItemId,
        });
      },
      runtime: "pi-agent-cli",
    };
    const { observedStore, reads } = observeArtifactReads(fixture.artifacts);
    const adapter = createCloudflarePiVerifierLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: observedStore,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture.plan),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime,
      timeoutMs: 30_000,
    });

    const result = await adapter.verify({
      capabilityReceipts: [],
      contract: fixture.contract,
      outputEvidence: [],
      outputRefs: [],
      plan: fixture.plan,
    });

    expect({
      readCommitShas: reads.map((read) => read.artifactCommitSha),
      readRefs: reads.map((read) => read.artifactRef),
      recoveredCommit: result.verifierLaneReceipt.artifactCommitSha,
      resultArtifactRef: result.result.artifactRef,
      resultStatus: result.resultDocument.status,
      runtimeCalls: capturedRequests.length,
    }).toStrictEqual({
      readCommitShas: [artifactCommitSha, artifactCommitSha],
      readRefs: [receiptRef, outputRef],
      recoveredCommit: artifactCommitSha,
      resultArtifactRef: outputRef,
      resultStatus: "accepted",
      runtimeCalls: 1,
    });
  });

  it("surfaces the raw-output sample from a failed-normalize verifier receipt in the blocker the operator reads (wound #34 dead-letter)", async () => {
    // Wound #33 muzzled the verifier; this is the OBSERVABILITY half its receipt
    // predicted. The verifier fails "complete-with-failed-normalize": it COMMITS a
    // receipt (status:"failed", outputNormalization.normalized=false), so the
    // abort-path lane-diagnostics file (AgentLaneIncompleteError) NEVER fires — the
    // bash `diag` sample dead-letters. Pre-fix, the receipt schema had no field to
    // carry the sample and the adapter's blocker said only "reason:
    // no_parseable_output". The operator reading /runs/:id/status was blind to WHY
    // the channel was empty — prose? a tool turn? a verdict written off-stdout? —
    // and the only recourse was another blind re-drive (the exact thing Joel's
    // standing demand forbids: "observe the run ... instead of staring like dummies").
    //
    // The fix threads a bounded, scrubbed raw head/tail from the normalizer outcome
    // -> receipt.outputNormalization.rawOutputSample (real AgentLaneReceiptSchema) ->
    // the verifier adapter's blocker `cause`. This drives the REAL adapter against a
    // runtime returning a REAL schema-parsed failed receipt; the seam (runLane
    // returning a committed-failed receipt) is the production seam. The A/B control
    // below proves the sample suffix is the load-bearing discriminator: a polite
    // assertion that merely checked a TS field would have stayed green against the
    // dead-letter schema that DROPPED the field on parse.
    const fixture = await buildVerifierLaneFixture();
    const proseSample =
      "Verdict written to the verification output path. Review complete. " +
      "...[2048 bytes omitted]... approve: inlined evidence reviewed.";

    const driveWithSample = async (rawOutputSample: string | null) => {
      const runtime: AgentLaneRuntimePort = {
        runLane(request) {
          // A verifier lane that committed status:"failed" because normalize found
          // no parseable verdict — exactly the fccee972 transport. The receipt is
          // parsed through the REAL schema, so a regression that drops
          // rawOutputSample from outputNormalization makes the field vanish here.
          const promptRef = request.artifactRef({
            path: request.promptPath,
            runId: request.runId,
          });
          const transcriptRef = request.artifactRef({
            path: request.transcriptPath,
            runId: request.runId,
          });
          const receiptRef = request.artifactRef({
            path: request.receiptPath,
            runId: request.runId,
          });
          return Promise.resolve(
            AgentLaneReceiptSchema.parse({
              authLease: request.authLease,
              completedAt: "2026-06-14T20:16:00.000Z",
              kind: "verifier",
              laneId: request.laneId,
              outputNormalization: {
                agentStopReason: null,
                normalized: false,
                rawOutputSample,
                reason: "no_parseable_output",
              },
              outputPins: [],
              outputRefs: [],
              prompt: {
                artifactRef: promptRef,
                hash: sha256Hex(request.prompt),
                mediaType: "text/markdown",
              },
              realAgent: true,
              receiptRef,
              redacted: true,
              runtime: "pi-agent-cli",
              sandboxRef: "cloudflare-sandbox:verifier-dead-letter-test",
              startedAt: "2026-06-14T20:15:00.000Z",
              status: "failed",
              traceContext: request.traceContext,
              transcript: {
                artifactRef: transcriptRef,
                hash: sha256Hex("verifier transcript"),
                mediaType: "text/markdown",
              },
            })
          );
        },
        runtime: "pi-agent-cli",
      };
      const adapter = createCloudflarePiVerifierLaneAdapter({
        artifactRemote: "https://artifacts.example.invalid/repo.git",
        artifactStore: fixture.artifacts,
        artifactTokenSecret: "artifact-token",
        authLease: agentAuthLeaseFor(fixture.plan),
        leasedPiAuthJsonBase64: "auth-json",
        model: "integration-test-pi-model",
        provider: "openai-codex",
        runtime,
        timeoutMs: 30_000,
      });
      try {
        await adapter.verify({
          capabilityReceipts: [],
          contract: fixture.contract,
          outputEvidence: [],
          outputRefs: [],
          plan: fixture.plan,
        });
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };

    const withSample = await driveWithSample(proseSample);
    const withoutSample = await driveWithSample(null);

    expect({
      // post-fix: the blocker the operator reads now NAMES the raw head/tail
      withSampleBlocked: withSample !== null,
      withSampleNamesReason:
        withSample?.includes("no_parseable_output") ?? false,
      withSampleSurfacesRawSample:
        (withSample?.includes("raw output sample:") ?? false) &&
        (withSample?.includes(
          "Verdict written to the verification output path"
        ) ??
          false),
      // control: a null sample (normalize captured nothing) must NOT fabricate the
      // suffix — proves the `raw output sample:` clause is gated on a real sample,
      // and that the assertion above is non-vacuous, not matching ambient prose.
      withoutSampleBlocked: withoutSample !== null,
      withoutSampleOmitsRawSampleClause: !(
        withoutSample?.includes("raw output sample:") ?? true
      ),
    }).toStrictEqual({
      withSampleBlocked: true,
      withSampleNamesReason: true,
      withSampleSurfacesRawSample: true,
      withoutSampleBlocked: true,
      withoutSampleOmitsRawSampleClause: true,
    });
  });
});

const analysisReasoningOutput = {
  findings: [
    {
      proposedChange: "Add a data-access kernel skill for the typesense env.",
      rating: 9,
      reasoning: "Recurring friction across sessions.",
      receiptKeys: ["source:joelclaw-sessions:receipt:typesense"],
      recommendation: "turn-into-work",
      summary: "Typesense env re-derived every session.",
      targetKind: "kernel-memory",
      title: "Document the typesense env",
    },
  ],
  schemaVersion: "memory.agentic-refinement-output.v1",
} as const;

const createAnalysisRuntimeHarness = (input: {
  readonly artifacts: ReturnType<typeof createMemoryArtifactStore>;
  readonly realAgent?: boolean;
  readonly receiptRuntime?: "integration-test" | "pi-agent-cli";
}) => {
  const capturedRequests: AgentLaneRuntimeRequest[] = [];
  const runtime: AgentLaneRuntimePort = {
    runLane(request) {
      capturedRequests.push(request);
      const outputRef = request.artifactRef({
        path: request.outputPath,
        runId: request.runId,
      });
      const promptRef = request.artifactRef({
        path: request.promptPath,
        runId: request.runId,
      });
      const transcriptRef = request.artifactRef({
        path: request.transcriptPath,
        runId: request.runId,
      });
      const receiptRef = request.artifactRef({
        path: request.receiptPath,
        runId: request.runId,
      });
      const transcript = "real analysis transcript from Cloudflare Sandbox";
      input.artifacts.setJson(outputRef, analysisReasoningOutput);
      input.artifacts.setText(transcriptRef, transcript, "text/markdown");

      return Promise.resolve(
        AgentLaneReceiptSchema.parse({
          artifactCommitSha: "analysiscommit0000000000000000000000000000000000",
          authLease: request.authLease,
          completedAt: "2026-06-08T20:06:01.000Z",
          kind: "worker",
          laneId: request.laneId,
          outputPins: [
            {
              artifactRef: outputRef,
              hash: hashJson(analysisReasoningOutput),
              mediaType: request.outputMediaType,
            },
          ],
          outputRefs: [outputRef],
          prompt: {
            artifactRef: promptRef,
            hash: sha256Hex(request.prompt),
            mediaType: "text/markdown",
          },
          realAgent: input.realAgent ?? true,
          receiptRef,
          redacted: true,
          runtime: input.receiptRuntime ?? "pi-agent-cli",
          sandboxRef: "cloudflare-sandbox:analysis-lane-test",
          startedAt: "2026-06-08T20:06:00.000Z",
          status: "completed",
          traceContext: request.traceContext,
          transcript: {
            artifactRef: transcriptRef,
            hash: sha256Hex(transcript),
            mediaType: "text/markdown",
          },
        })
      );
    },
    runtime: "pi-agent-cli",
  };

  return { capturedRequests, runtime };
};

const buildAnalysisLaneFixture = async () => {
  const plannerFixture = await buildPlannerLaneFixture();

  return {
    artifacts: plannerFixture.artifacts,
    pinnedPackages: plannerFixture.plannerInput.pinnedPackages,
    runId: plannerFixture.plannerInput.runId,
    workItemId: plannerFixture.plannerInput.workItemId,
  };
};

describe("Cloudflare Pi analysis reasoning lane adapter", () => {
  it("runs a worker-kind lane over the node's prompt and returns the schema-validated reasoning", async () => {
    const fixture = await buildAnalysisLaneFixture();
    const harness = createAnalysisRuntimeHarness({
      artifacts: fixture.artifacts,
    });
    const adapter = createCloudflarePiAnalysisReasoningLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    const result = await adapter.reason({
      actor: integrationTestActor,
      laneId: `lane:analysis:${fixture.runId}:propose-refinements`,
      outputPath: "lanes/analysis-propose-refinements/refinement-output.json",
      outputSchema: MemoryAgenticRefinementOutputSchema,
      packageMounts: fixture.pinnedPackages,
      prompt: "# Dream Analysis Lane\n\nReason over the evidence.",
      promptPath: "lanes/analysis-propose-refinements/prompt.md",
      receiptPath: "receipts/analysis-propose-refinements-lane.json",
      runId: fixture.runId,
      transcriptPath: "lanes/analysis-propose-refinements/transcript.md",
      workItemId: fixture.workItemId,
    });
    const request = harness.capturedRequests.at(0);

    expect({
      laneKind: adapter.laneKind,
      outputMediaType: request?.outputMediaType,
      parsedFindingCount: result.parsed.findings.length,
      parsedFirstRating: result.parsed.findings.at(0)?.rating,
      requestKind: request?.kind,
      requestOutputPath: request?.outputPath,
      runtime: adapter.runtime,
      traceContext: request?.traceContext,
    }).toStrictEqual({
      laneKind: "analysis",
      outputMediaType: "application/json",
      parsedFindingCount: 1,
      parsedFirstRating: 9,
      requestKind: "worker",
      requestOutputPath:
        "lanes/analysis-propose-refinements/refinement-output.json",
      runtime: "pi-agent-cli",
      traceContext: workflowTraceContextForLane({
        laneId: `lane:analysis:${fixture.runId}:propose-refinements`,
        runId: fixture.runId,
      }),
    });
  });

  it("rejects a non-real-agent receipt so a fake lane can never masquerade as reasoned", async () => {
    const fixture = await buildAnalysisLaneFixture();
    const harness = createAnalysisRuntimeHarness({
      artifacts: fixture.artifacts,
      realAgent: false,
      receiptRuntime: "integration-test",
    });
    const adapter = createCloudflarePiAnalysisReasoningLaneAdapter({
      artifactRemote: "https://artifacts.example.invalid/repo.git",
      artifactStore: fixture.artifacts,
      artifactTokenSecret: "artifact-token",
      authLease: agentAuthLeaseFor(fixture),
      leasedPiAuthJsonBase64: "auth-json",
      model: "integration-test-pi-model",
      provider: "openai-codex",
      runtime: harness.runtime,
      timeoutMs: 30_000,
    });

    await expect(
      adapter.reason({
        actor: integrationTestActor,
        laneId: `lane:analysis:${fixture.runId}:propose-refinements`,
        outputPath: "lanes/analysis-propose-refinements/refinement-output.json",
        outputSchema: MemoryAgenticRefinementOutputSchema,
        packageMounts: fixture.pinnedPackages,
        prompt: "# Dream Analysis Lane",
        promptPath: "lanes/analysis-propose-refinements/prompt.md",
        receiptPath: "receipts/analysis-propose-refinements-lane.json",
        runId: fixture.runId,
        transcriptPath: "lanes/analysis-propose-refinements/transcript.md",
        workItemId: fixture.workItemId,
      })
    ).rejects.toThrow("completed real-agent receipt");
  });
});
