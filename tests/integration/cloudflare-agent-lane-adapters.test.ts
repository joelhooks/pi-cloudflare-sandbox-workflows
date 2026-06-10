import { describe, expect, it } from "vitest";

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
  createCloudflarePiPlannerLaneAdapter,
  createCloudflarePiVerifierLaneAdapter,
  createCloudflarePiWorkerLaneAdapter,
} from "../../src/app/infrastructure/cloudflare-agent-lane-adapters.ts";
import {
  createIntegrationTestDynamicWorkflowPlanner,
  createMemoryArtifactStore,
  createMemoryPackageRegistryActor,
} from "../../src/app/infrastructure/memory-adapters.ts";
import {
  buildIntegrationTestRunRequest,
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
  readonly plannerOutput: PlannerLaneBlueprintDocument;
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
});
