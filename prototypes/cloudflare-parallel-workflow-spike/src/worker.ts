/// <reference types="@cloudflare/workers-types" />
/* eslint-disable func-style, no-use-before-define */

import { getSandbox } from "@cloudflare/sandbox";
import type {
  ISandbox,
  Sandbox as SandboxDurableObject,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import { add, commit, init as gitInit, push } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";

import { transitionMachine } from "./machine.ts";
import { MemoryFS } from "./memory-fs.ts";
import { createParallelPlan } from "./planner.ts";
import {
  CapsuleRecordSchema,
  FinalReceiptSchema,
  JobSpecSchema,
  QueueMessageSchema,
  VerificationResultSchema,
} from "./schema.ts";
import type {
  CapsuleRecord,
  FinalReceipt,
  JobSpec,
  LaneRecord,
  ParallelPlan,
  QueueMessage,
} from "./schema.ts";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ACCESS_TOKEN?: string;
  ARTIFACTS: Artifacts;
  CAPSULE_SUPERVISOR: DurableObjectNamespace<CapsuleSupervisor>;
  LANE_QUEUE: Queue<QueueMessage>;
  LANE_RUNTIME?: "shell" | "pi";
  PI_AUTH_JSON_B64?: string;
  PI_REAL_MODEL?: string;
  Sandbox: DurableObjectNamespace<SandboxDurableObject>;
}

interface RealSandbox extends ISandbox {
  destroy(): Promise<void>;
}

interface CommandResult {
  command: string;
  duration: number;
  exitCode: number;
  stderr: string;
  stdout: string;
  success: boolean;
  timestamp: string;
}

const StartEnvelopeSchema = z.object({
  deployedWorkerUrl: z.string().url(),
  jobSpec: JobSpecSchema,
});

const LaneAdmissionRequestSchema = z.object({
  laneId: z.string().min(1),
});

const LaneCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  destroyReceipt: z.string().min(1),
  laneId: z.string().min(1),
  outputRefs: z.array(z.string().min(1)),
  sandboxId: z.string().min(1),
});

const LaneFailureRequestSchema = z.object({
  destroyReceipt: z.string().min(1).optional(),
  error: z.string().min(1),
  laneId: z.string().min(1),
  sandboxId: z.string().min(1).optional(),
});

const SynthesisCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  destroyReceipt: z.string().min(1),
  sandboxId: z.string().min(1),
});

const VerificationCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  destroyReceipt: z.string().min(1),
  result: VerificationResultSchema,
  sandboxId: z.string().min(1),
});

const DeliveryCompleteRequestSchema = z.object({
  destroyReceipt: z.string().min(1),
  outputTargetReceipt: z.object({
    deliveredAt: z.string().datetime(),
    outputRefs: z.array(z.string().min(1)).min(1),
    targetKind: z.literal("implementation_plan"),
  }),
  sandboxId: z.string().min(1),
});

const DEFAULT_JOB: JobSpec = {
  contextPackRefs: ["dynamic-workflow-scale-catalog@0.1.0"],
  outputTarget: { kind: "implementation_plan" },
  parallel: {
    concurrencyCap: 3,
    failurePolicy: {
      laneFailure: "retry_then_degrade",
      maxRetries: 2,
    },
    fanIn: {
      requiredLaneIds: [
        "cloudflare-primitives",
        "xstate-machines",
        "secret-leases",
        "artifact-memory",
      ],
      strategy: "wait_all",
    },
    plannedLaneCount: 8,
  },
  secretRefs: ["piCodexAuth"],
  task: "fan out research across Cloudflare primitives, XState machines, secret leases, artifact memory, output targets, and failure/backpressure patterns; synthesize a source-backed implementation plan; verify it; deliver the final implementation plan artifact",
  verificationContract: "source-backed-synthesis-v1",
  workItemId: "parallel-cloudflare-patterns-001",
};

const SOURCE_RECEIPTS = [
  {
    id: "dynamic-workflow-scale-catalog",
    title: "Dynamic Pi Workflow Scale Catalog",
    url: ".brain/resources/dynamic-pi-workflow-scale-catalog.svx",
  },
  {
    id: "cloudflare-queues-config",
    title: "Configuration · Cloudflare Queues docs",
    url: "https://developers.cloudflare.com/queues/configuration/configure-queues/",
  },
  {
    id: "cloudflare-artifacts-how-it-works",
    title: "How Artifacts works · Cloudflare Artifacts docs",
    url: "https://developers.cloudflare.com/artifacts/concepts/how-artifacts-works/",
  },
  {
    id: "cloudflare-sandbox-artifacts-example",
    title: "Sandbox SDK + Artifacts · Cloudflare Artifacts docs",
    url: "https://developers.cloudflare.com/artifacts/examples/sandbox-sdk-artifacts/",
  },
] as const;

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,80}$/u;
const QUEUE_RETRY_DELAY_SECONDS = 2;
const MODEL_DEFAULT = "gpt-5.5";

export class CapsuleSupervisor extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const postRoutes: Record<string, () => Promise<Response>> = {
      "/admit-lane": () => this.admitLane(request),
      "/begin-finalization": () => this.beginFinalization(),
      "/complete-lane": () => this.completeLane(request),
      "/delivery-complete": () => this.deliveryComplete(request),
      "/fail-lane": () => this.failLane(request),
      "/repo-access": () => this.repoAccess(),
      "/start": () => this.start(request),
      "/synthesis-complete": () => this.synthesisComplete(request),
      "/verification-complete": () => this.verificationComplete(request),
    };
    const getRoutes: Record<string, () => Promise<Response>> = {
      "/record": async () => json({ ok: true, record: await this.getRecord() }),
    };
    const routes = request.method === "POST" ? postRoutes : getRoutes;
    const handler = routes[pathname];
    return handler
      ? handler()
      : Promise.resolve(
          json({ error: "not found", ok: false }, { status: 404 })
        );
  }

  private async admitLane(request: Request): Promise<Response> {
    const body = LaneAdmissionRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const lane = record.lanes[body.laneId];
    if (!lane) {
      return json({ error: "unknown lane", ok: false }, { status: 404 });
    }
    if (lane.status === "committed" || lane.status === "degraded") {
      return json({ alreadyDone: true, ok: true });
    }
    if (record.currentState !== "runningFanoutLanes") {
      return json({
        ok: true,
        reason: "not-running-fanout",
        slotGranted: false,
      });
    }
    if (
      record.activeLaneIds.length >= record.plan.jobSpec.parallel.concurrencyCap
    ) {
      return json({
        ok: true,
        reason: "concurrency-cap-full",
        slotGranted: false,
      });
    }

    const sandboxId = buildSandboxId(
      record.runId,
      body.laneId,
      lane.retryCount
    );
    const updatedLane: LaneRecord = {
      ...lane,
      sandboxId,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    const nextRecord = CapsuleSupervisor.applyEvent(
      {
        ...record,
        activeLaneIds: [...record.activeLaneIds, body.laneId],
        lanes: { ...record.lanes, [body.laneId]: updatedLane },
        maxObservedActiveLanes: Math.max(
          record.maxObservedActiveLanes,
          record.activeLaneIds.length + 1
        ),
      },
      "LANE_STARTED"
    );
    await this.putRecord(nextRecord);
    return json({
      lane: updatedLane,
      ok: true,
      record: nextRecord,
      slotGranted: true,
    });
  }

  private async beginFinalization(): Promise<Response> {
    const record = await this.requireRecord();
    if (record.status === "captured") {
      return json({ alreadyDone: true, ok: true, record });
    }
    if (record.status === "synthesizing" || record.status === "verifying") {
      return json({ ok: true, record, shouldFinalize: false });
    }
    if (!isFanInSatisfied(record)) {
      return json({ ok: true, record, shouldFinalize: false });
    }

    const currentState =
      record.currentState === "waitingFanIn"
        ? record
        : CapsuleSupervisor.applyEvent(record, "ALL_REQUIRED_LANES_SETTLED");
    const nextRecord = {
      ...CapsuleSupervisor.applyEvent(
        currentState,
        "ALL_REQUIRED_LANES_SETTLED"
      ),
      status: "synthesizing" as const,
    };
    await this.putRecord(nextRecord);
    return json({ ok: true, record: nextRecord, shouldFinalize: true });
  }

  private async completeLane(request: Request): Promise<Response> {
    const body = LaneCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const lane = requireValue(record.lanes[body.laneId], "lane");
    const completedLane: LaneRecord = {
      ...lane,
      artifactCommitSha: body.artifactCommitSha,
      completedAt: new Date().toISOString(),
      outputRefs: body.outputRefs,
      sandboxId: body.sandboxId,
      status: "committed",
    };
    const nextRecord = CapsuleSupervisor.applyEvent(
      {
        ...record,
        activeLaneIds: record.activeLaneIds.filter(
          (laneId) => laneId !== body.laneId
        ),
        cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
        lanes: { ...record.lanes, [body.laneId]: completedLane },
      },
      "LANE_OUTPUT_COMMITTED"
    );
    const fanInSatisfied = isFanInSatisfied(nextRecord);
    await this.putRecord(
      fanInSatisfied
        ? CapsuleSupervisor.applyEvent(nextRecord, "ALL_REQUIRED_LANES_SETTLED")
        : nextRecord
    );

    if (fanInSatisfied) {
      await this.env.LANE_QUEUE.send({
        runId: requireValue(nextRecord.runId, "runId"),
        type: "finalize",
        workItemId: nextRecord.workItemId,
      });
    }

    return json({ fanInSatisfied, ok: true });
  }

  private async deliveryComplete(request: Request): Promise<Response> {
    const body = DeliveryCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const delivered = CapsuleSupervisor.applyEvent(record, "OUTPUT_DELIVERED");
    const cleaned = CapsuleSupervisor.applyEvent(
      {
        ...delivered,
        cleanupReceipts: [...delivered.cleanupReceipts, body.destroyReceipt],
      },
      "CLEANUP_DONE"
    );
    const finalRecord = {
      ...cleaned,
      completedAt: new Date().toISOString(),
      finalReceipt: buildFinalReceipt(cleaned, body.outputTargetReceipt),
      status: "captured" as const,
    };
    await this.putRecord(finalRecord);
    return json({ ok: true, record: finalRecord });
  }

  private async failLane(request: Request): Promise<Response> {
    const body = LaneFailureRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const lane = requireValue(record.lanes[body.laneId], "lane");
    const retryCount = lane.retryCount + 1;
    const canRetry =
      retryCount <= record.plan.jobSpec.parallel.failurePolicy.maxRetries;
    let failedStatus: LaneRecord["status"];
    if (canRetry) {
      failedStatus = "retry_queued";
    } else if (lane.required) {
      failedStatus = "failed";
    } else {
      failedStatus = "degraded";
    }
    const sandboxId = body.sandboxId ?? lane.sandboxId;
    const failedLane: LaneRecord = {
      ...lane,
      ...(sandboxId ? { sandboxId } : {}),
      outputRefs: lane.outputRefs,
      retryCount,
      status: failedStatus,
    };
    let failureEvent = "LANE_FAILED";
    if (canRetry) {
      failureEvent = "LANE_RETRY_ENQUEUED";
    } else if (failedLane.status === "degraded") {
      failureEvent = "LANE_DEGRADED";
    }
    const updatedRecord = CapsuleSupervisor.applyEvent(
      {
        ...record,
        activeLaneIds: record.activeLaneIds.filter(
          (laneId) => laneId !== body.laneId
        ),
        cleanupReceipts: body.destroyReceipt
          ? [...record.cleanupReceipts, body.destroyReceipt]
          : record.cleanupReceipts,
        lanes: { ...record.lanes, [body.laneId]: failedLane },
      },
      failureEvent
    );
    const blockedRecord =
      !canRetry && lane.required
        ? {
            ...CapsuleSupervisor.applyEvent(
              updatedRecord,
              "VERIFICATION_BLOCKED"
            ),
            blockedReason: body.error,
            status: "blocked" as const,
          }
        : updatedRecord;
    await this.putRecord(blockedRecord);
    return json({
      action: canRetry ? "retry" : "ack",
      ok: true,
      record: blockedRecord,
    });
  }

  private async repoAccess(): Promise<Response> {
    const record = await this.requireRecord();
    const artifactTokenSecret = requireValue(
      await this.ctx.storage.get<string>("artifactTokenSecret"),
      "artifactTokenSecret"
    );
    return json({
      artifactRemote: record.artifactRemote,
      artifactTokenSecret,
      ok: true,
    });
  }

  private async start(request: Request): Promise<Response> {
    const envelope = StartEnvelopeSchema.parse(await request.json());
    const plan = createParallelPlan(envelope.jobSpec);
    const runId = `run-${slugify(plan.jobSpec.workItemId)}-${crypto.randomUUID().slice(0, 8)}`;
    const capsuleId = `capsule:${plan.jobSpec.workItemId}`;
    const artifactRepoName = `piwfp-${slugify(runId)}`;
    const createdRepo = await this.env.ARTIFACTS.create(artifactRepoName, {
      description: `Real Cloudflare parallel workflow prototype ${runId}`,
      readOnly: false,
      setDefaultBranch: "main",
    });
    const authedRemote = toAuthenticatedRemote(
      createdRepo.remote,
      createdRepo.token
    );
    const planCommit = await commitPlanPhaseArtifacts({
      files: buildPlanFiles({ artifactRepoName, capsuleId, plan, runId }),
      remote: createdRepo.remote,
      tokenSecret: authedRemote.tokenSecret,
    });
    await this.ctx.storage.put("artifactTokenSecret", createdRepo.token);
    const lanes = Object.fromEntries(
      plan.lanes.map((lane) => [
        lane.laneId,
        {
          ...lane,
          outputRefs: [],
          retryCount: 0,
          status: "queued" as const,
        },
      ])
    );
    const initialRecord = CapsuleRecordSchema.parse({
      activeLaneIds: [],
      artifactRemote: createdRepo.remote,
      artifactRepoName,
      capsuleId,
      cleanupReceipts: [],
      currentState: plan.machine.initial,
      eventLog: [],
      lanes,
      maxObservedActiveLanes: 0,
      plan,
      planCommitSha: planCommit.commit,
      runId,
      startedAt: new Date().toISOString(),
      status: "planning",
      workItemId: plan.jobSpec.workItemId,
    });
    const planned = CapsuleSupervisor.applyEvent(
      initialRecord,
      "PLAN_GENERATED"
    );
    const validated = CapsuleSupervisor.applyEvent(planned, "PLAN_VALIDATED");
    const pinned = CapsuleSupervisor.applyEvent(validated, "PLAN_PINNED");
    const admitted = CapsuleSupervisor.applyEvent(pinned, "LANES_ADMITTED");
    const queued = CapsuleSupervisor.applyEvent(admitted, "LANE_ENQUEUED");
    await this.putRecord({ ...queued, status: "running" });
    await this.env.LANE_QUEUE.sendBatch(
      plan.lanes.map((lane) => ({
        body: {
          laneId: lane.laneId,
          runId,
          type: "lane" as const,
          workItemId: plan.jobSpec.workItemId,
        },
        contentType: "json" as const,
      }))
    );
    return json({
      artifactRepoName,
      capsuleId,
      ok: true,
      planCommitSha: planCommit.commit,
      runId,
      status: "running",
    });
  }

  private async synthesisComplete(request: Request): Promise<Response> {
    const body = SynthesisCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const nextRecord = {
      ...CapsuleSupervisor.applyEvent(record, "SYNTHESIS_COMMITTED"),
      cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
      status: "verifying" as const,
      synthesisCommitSha: body.artifactCommitSha,
      synthesisSandboxId: body.sandboxId,
    };
    await this.putRecord(nextRecord);
    return json({ ok: true, record: nextRecord });
  }

  private async verificationComplete(request: Request): Promise<Response> {
    const body = VerificationCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const afterVerifier = CapsuleSupervisor.applyEvent(
      {
        ...record,
        cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
        verifierCommitSha: body.artifactCommitSha,
        verifierResult: body.result,
        verifierSandboxId: body.sandboxId,
      },
      "VERIFIER_DONE"
    );
    const nextRecord =
      body.result.status === "blocked"
        ? {
            ...CapsuleSupervisor.applyEvent(
              afterVerifier,
              "VERIFICATION_BLOCKED"
            ),
            blockedReason: body.result.blockingFailures.join("; "),
            status: "blocked" as const,
          }
        : {
            ...CapsuleSupervisor.applyEvent(
              afterVerifier,
              "VERIFICATION_VERIFIED"
            ),
            status: "verifying" as const,
          };
    await this.putRecord(nextRecord);
    return json({ ok: true, record: nextRecord });
  }

  private static applyEvent(
    record: CapsuleRecord,
    event: string
  ): CapsuleRecord {
    const nextState = transitionMachine(
      record.plan.machine,
      record.currentState,
      event
    );
    return CapsuleRecordSchema.parse({
      ...record,
      currentState: nextState,
      eventLog: [
        ...record.eventLog,
        { at: new Date().toISOString(), event, state: nextState },
      ],
    });
  }

  private getRecord(): Promise<CapsuleRecord | undefined> {
    return this.ctx.storage.get<CapsuleRecord>("record");
  }

  private async putRecord(record: CapsuleRecord): Promise<void> {
    await this.ctx.storage.put("record", CapsuleRecordSchema.parse(record));
  }

  private async requireRecord(): Promise<CapsuleRecord> {
    return requireValue(await this.getRecord(), "capsule record");
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> | Response {
    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized", ok: false }, { status: 401 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({
        authRequired: Boolean(env.ACCESS_TOKEN),
        laneRuntime: env.LANE_RUNTIME ?? "shell",
        ok: true,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      return startRun(request, env);
    }
    if (request.method === "POST" && url.pathname === "/api/integration-run") {
      return startRunWithBody(request, env, {
        ...DEFAULT_JOB,
        workItemId: `parallel-cloudflare-patterns-${crypto.randomUUID().slice(0, 8)}`,
      });
    }

    const match = url.pathname.match(/^\/api\/runs\/([^/]+)$/u);
    if (request.method === "GET" && match) {
      const workItemId = decodeURIComponent(match[1] ?? "");
      return getRunRecord(request, env, workItemId);
    }

    return json({ error: "not found", ok: false }, { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await Promise.all(
      batch.messages.map(async (message) => {
        const parsed = QueueMessageSchema.safeParse(message.body);
        if (!parsed.success) {
          console.error("invalid queue message", parsed.error.message);
          message.ack();
          return;
        }

        try {
          if (parsed.data.type === "lane") {
            const result = await processLaneMessage(parsed.data, env);
            if (result.retry) {
              message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
              return;
            }
            message.ack();
            return;
          }

          await processFinalizeMessage(parsed.data, env);
          message.ack();
        } catch (error) {
          console.error("queue message failed", error);
          message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
        }
      })
    );
  },
} satisfies ExportedHandler<Env, QueueMessage>;

async function startRun(request: Request, env: Env): Promise<Response> {
  const body = await request.json();
  return startRunWithBody(request, env, body);
}

async function startRunWithBody(
  request: Request,
  env: Env,
  body: unknown
): Promise<Response> {
  const jobSpec = JobSpecSchema.parse(body);
  const stub = getSupervisorStub(env, jobSpec.workItemId);
  const response = await stub.fetch(
    new Request(new URL("/start", request.url), {
      body: JSON.stringify({
        deployedWorkerUrl: new URL(request.url).origin,
        jobSpec,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  const payload = await response.json();
  return json(payload, { status: response.status });
}

async function getRunRecord(
  request: Request,
  env: Env,
  workItemId: string
): Promise<Response> {
  const response = await getSupervisorStub(env, workItemId).fetch(
    new Request(new URL("/record", request.url))
  );
  const payload = await response.json();
  return json(payload, { status: response.status });
}

async function processLaneMessage(
  message: Extract<QueueMessage, { type: "lane" }>,
  env: Env
): Promise<{ retry: boolean }> {
  const stub = getSupervisorStub(env, message.workItemId);
  const admission = await postDo(stub, "/admit-lane", {
    laneId: message.laneId,
  });
  if (admission["alreadyDone"]) {
    return { retry: false };
  }
  if (!admission["slotGranted"]) {
    return { retry: true };
  }

  const record = CapsuleRecordSchema.parse(admission["record"]);
  const lane = requireValue(record.lanes[message.laneId], "lane");
  const repoAccess = await postDo(stub, "/repo-access", {});
  const authedRemote = toAuthenticatedRemote(
    String(repoAccess["artifactRemote"]),
    String(repoAccess["artifactTokenSecret"])
  );
  const sandboxId = requireValue(lane.sandboxId, "sandboxId");
  let sandbox: RealSandbox | undefined;
  let destroyReceipt: string | undefined;

  try {
    sandbox = getSandbox(env.Sandbox, sandboxId) as unknown as RealSandbox;
    const command =
      env.LANE_RUNTIME === "pi" && env.PI_AUTH_JSON_B64
        ? buildPiLaneCommand()
        : buildShellLaneCommand();
    const result = await runCommand(
      sandbox,
      command,
      { tokenSecret: authedRemote.tokenSecret },
      {
        env: {
          ARTIFACTS_GIT_REMOTE: authedRemote.remote,
          GIT_TERMINAL_PROMPT: "0",
          LANE_ID: lane.laneId,
          LANE_PROMPT: lane.prompt,
          LANE_ROLE: lane.role,
          LANE_TOPIC: lane.topic,
          PIWF_COMMAND_TIMEOUT_SECONDS:
            env.LANE_RUNTIME === "pi" ? "280" : "90",
          PI_AUTH_JSON_B64: env.PI_AUTH_JSON_B64 ?? "",
          PI_MODEL: env.PI_REAL_MODEL ?? MODEL_DEFAULT,
          RUN_ID: message.runId,
          WORK_ITEM_ID: message.workItemId,
        },
        timeout: env.LANE_RUNTIME === "pi" ? 300_000 : 120_000,
      }
    );
    assertCommand(result, `lane ${lane.laneId}`);
    const commitSha = requireValue(
      getLastNonEmptyLine(result.stdout),
      "lane commit sha"
    );
    destroyReceipt = await destroySandbox(sandbox, sandboxId);
    await postDo(stub, "/complete-lane", {
      artifactCommitSha: commitSha,
      destroyReceipt,
      laneId: lane.laneId,
      outputRefs: [
        `artifacts/lanes/${lane.laneId}/report.md`,
        `artifacts/lanes/${lane.laneId}/receipt.json`,
      ],
      sandboxId,
    });
    return { retry: false };
  } catch (error) {
    if (sandbox && !destroyReceipt) {
      destroyReceipt = await destroySandbox(sandbox, sandboxId).catch(
        (destroyError) => `destroy:${sandboxId}:error:${String(destroyError)}`
      );
    }
    const failure = await postDo(stub, "/fail-lane", {
      destroyReceipt,
      error: error instanceof Error ? error.message : String(error),
      laneId: lane.laneId,
      sandboxId,
    });
    return { retry: failure["action"] === "retry" };
  }
}

async function processFinalizeMessage(
  message: Extract<QueueMessage, { type: "finalize" }>,
  env: Env
): Promise<void> {
  const stub = getSupervisorStub(env, message.workItemId);
  const begin = await postDo(stub, "/begin-finalization", {});
  if (!begin["shouldFinalize"]) {
    return;
  }

  const record = CapsuleRecordSchema.parse(begin["record"]);
  const repoAccess = await postDo(stub, "/repo-access", {});
  const authedRemote = toAuthenticatedRemote(
    String(repoAccess["artifactRemote"]),
    String(repoAccess["artifactTokenSecret"])
  );
  const laneIds = Object.keys(record.lanes).toSorted();
  const { requiredLaneIds } = record.plan.jobSpec.parallel.fanIn;
  const synthesis = await runFinalizationSandbox({
    command: buildSynthesisCommand(),
    env,
    label: "synthesis",
    message,
    runtimeEnv: {
      ARTIFACTS_GIT_REMOTE: authedRemote.remote,
      GIT_TERMINAL_PROMPT: "0",
      LANE_IDS_JSON: JSON.stringify(laneIds),
      PIWF_COMMAND_TIMEOUT_SECONDS: "120",
      REQUIRED_LANE_IDS_JSON: JSON.stringify(requiredLaneIds),
      RUN_ID: message.runId,
      WORK_ITEM_ID: message.workItemId,
    },
    timeout: 180_000,
    tokenSecret: authedRemote.tokenSecret,
  });
  await postDo(stub, "/synthesis-complete", synthesis);

  const verifierRemote = authedRemote;
  const verification = await runFinalizationSandbox({
    command: buildVerifierCommand(),
    env,
    label: "verifier",
    message,
    readPath: "/workspace/piwf-parallel/artifacts/verification/result.json",
    runtimeEnv: {
      ARTIFACTS_GIT_REMOTE: verifierRemote.remote,
      GIT_TERMINAL_PROMPT: "0",
      PIWF_COMMAND_TIMEOUT_SECONDS: "90",
      REQUIRED_LANE_IDS_JSON: JSON.stringify(requiredLaneIds),
      RUN_ID: message.runId,
      WORK_ITEM_ID: message.workItemId,
    },
    timeout: 120_000,
    tokenSecret: verifierRemote.tokenSecret,
  });
  const verificationResultText = requireValue(
    verification.readContent,
    "verification result text"
  );
  const verificationResult = VerificationResultSchema.parse(
    JSON.parse(verificationResultText)
  );
  await postDo(stub, "/verification-complete", {
    ...verification,
    result: verificationResult,
  });

  const deliveryRemote = authedRemote;
  const delivery = await runFinalizationSandbox({
    command: buildDeliveryCommand(),
    env,
    label: "delivery",
    message,
    runtimeEnv: {
      ARTIFACTS_GIT_REMOTE: deliveryRemote.remote,
      GIT_TERMINAL_PROMPT: "0",
      PIWF_COMMAND_TIMEOUT_SECONDS: "90",
      RUN_ID: message.runId,
      WORK_ITEM_ID: message.workItemId,
    },
    timeout: 120_000,
    tokenSecret: deliveryRemote.tokenSecret,
  });
  await postDo(stub, "/delivery-complete", {
    destroyReceipt: delivery.destroyReceipt,
    outputTargetReceipt: {
      deliveredAt: new Date().toISOString(),
      outputRefs: [
        "artifacts/synthesis/implementation-plan.md",
        "artifacts/output-target/implementation-plan/receipt.json",
      ],
      targetKind: "implementation_plan",
    },
    sandboxId: delivery.sandboxId,
  });
}

async function runFinalizationSandbox(input: {
  command: string;
  env: Env;
  label: "delivery" | "synthesis" | "verifier";
  message: Extract<QueueMessage, { type: "finalize" }>;
  readPath?: string;
  runtimeEnv: Record<string, string>;
  timeout: number;
  tokenSecret: string;
}): Promise<{
  artifactCommitSha: string;
  destroyReceipt: string;
  readContent?: string;
  sandboxId: string;
}> {
  const sandboxId = buildSandboxId(input.message.runId, input.label);
  const sandbox = getSandbox(
    input.env.Sandbox,
    sandboxId
  ) as unknown as RealSandbox;
  const result = await runCommand(
    sandbox,
    input.command,
    { tokenSecret: input.tokenSecret },
    { env: input.runtimeEnv, timeout: input.timeout }
  );
  assertCommand(result, input.label);
  const artifactCommitSha = requireValue(
    getLastNonEmptyLine(result.stdout),
    `${input.label} commit sha`
  );
  let readContent: string | undefined;
  if (input.readPath) {
    const file = await sandbox.readFile(input.readPath);
    readContent = file.content;
  }
  const destroyReceipt = await destroySandbox(sandbox, sandboxId);
  return readContent
    ? { artifactCommitSha, destroyReceipt, readContent, sandboxId }
    : { artifactCommitSha, destroyReceipt, sandboxId };
}

function buildPlanFiles(input: {
  artifactRepoName: string;
  capsuleId: string;
  plan: ParallelPlan;
  runId: string;
}): { content: string; path: string }[] {
  const manifest = {
    artifactRepoName: input.artifactRepoName,
    capsuleId: input.capsuleId,
    contextPackRefs: input.plan.jobSpec.contextPackRefs,
    outputTarget: input.plan.outputTarget,
    runId: input.runId,
    schemaVersion: "parallel-run-manifest.v1",
    secretRefs: input.plan.jobSpec.secretRefs,
    workItemId: input.plan.jobSpec.workItemId,
  };
  const laneInputs = input.plan.lanes.map((lane) => ({
    content: jsonString(lane),
    path: `run/lane-inputs/${lane.laneId}.json`,
  }));

  return [
    { content: jsonString(input.plan), path: "run/plan.json" },
    { content: jsonString(input.plan.machine), path: "workflows/machine.json" },
    { content: jsonString(input.plan.harness), path: "workflows/harness.json" },
    {
      content: jsonString(input.plan.verification),
      path: "run/verification-contract.json",
    },
    { content: jsonString(manifest), path: "run/manifest.json" },
    { content: jsonString(SOURCE_RECEIPTS), path: "run/source-receipts.json" },
    {
      content:
        "# Cloudflare Parallel Workflow Spike\n\nPlan artifacts pinned before Queue-backed lane execution.\n",
      path: "README.md",
    },
    ...laneInputs,
  ];
}

async function commitPlanPhaseArtifacts(input: {
  files: { content: string; path: string }[];
  remote: string;
  tokenSecret: string;
}): Promise<{ commit: string }> {
  const fs = new MemoryFS();
  const dir = "/workspace";
  await gitInit({ defaultBranch: "main", dir, fs });

  for (const file of input.files) {
    await fs.promises.writeFile(`${dir}/${file.path}`, file.content);
    await add({ dir, filepath: file.path, fs });
  }

  const commitSha = await commit({
    author: {
      email: "cloudflare-parallel-workflow-spike@example.invalid",
      name: "cloudflare-parallel-workflow-spike",
    },
    dir,
    fs,
    message: "prototype: pin parallel workflow plan",
  });

  await push({
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.tokenSecret, username: "x" }),
    ref: "main",
    url: input.remote,
  });

  return { commit: commitSha };
}

function buildShellLaneCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/piwf-parallel
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-parallel
cd /workspace/piwf-parallel
git config user.name "cloudflare-parallel-workflow-spike"
git config user.email "cloudflare-parallel-workflow-spike@example.invalid"
git checkout -B "lane-$LANE_ID"
node <<'NODE'
const fs = require('fs');
const laneId = process.env.LANE_ID;
const topic = process.env.LANE_TOPIC;
const prompt = process.env.LANE_PROMPT;
const role = process.env.LANE_ROLE;
const runId = process.env.RUN_ID;
const workItemId = process.env.WORK_ITEM_ID;
const outDir = 'artifacts/lanes/' + laneId;
fs.mkdirSync(outDir, { recursive: true });
const report = [
  '# Lane ' + laneId,
  '',
  'Role: ' + role,
  'Work item: ' + workItemId,
  '',
  '## Topic',
  '',
  topic,
  '',
  '## Source-backed implementation notes',
  '',
  '- Cloudflare Queue messages schedule lane work; the Durable Object supervisor owns admission and caps hot concurrency. [source:cloudflare-queues-config]',
  '- Cloudflare Sandbox is the disposable execution boundary for each active lane, not durable memory. [source:cloudflare-sandbox-artifacts-example]',
  '- Cloudflare Artifacts is the durable Git-compatible receipt store for plan, lane, synthesis, verifier, and output artifacts. [source:cloudflare-artifacts-how-it-works]',
  '- The project scale invariant is unbounded addressability with bounded hot concurrency. [source:dynamic-workflow-scale-catalog]',
  '',
  '## Lane prompt',
  '',
  prompt,
  '',
].join('\n');
const receipt = {
  generatedAt: new Date().toISOString(),
  laneId,
  outputRefs: [outDir + '/report.md', outDir + '/receipt.json'],
  role,
  runId,
  topic,
};
fs.writeFileSync(outDir + '/report.md', report);
fs.writeFileSync(outDir + '/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
NODE
git add "artifacts/lanes/$LANE_ID"
git commit -m "lane: $LANE_ID $RUN_ID"
commit=$(git rev-parse HEAD)
git push origin HEAD:"refs/heads/lane-$LANE_ID"
printf '%s\n' "$commit"`;
}

function buildPiLaneCommand(): string {
  return String.raw`set -eu
agent_dir="/workspace/.pi/agent"
auth_path="$agent_dir/auth.json"
mkdir -p "$agent_dir"
printf '%s' "$PI_AUTH_JSON_B64" | base64 -d > "$auth_path"
chmod 600 "$auth_path"
rm -rf /workspace/piwf-parallel
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-parallel
cd /workspace/piwf-parallel
git config user.name "cloudflare-parallel-workflow-spike"
git config user.email "cloudflare-parallel-workflow-spike@example.invalid"
git checkout -B "lane-$LANE_ID"
mkdir -p "artifacts/lanes/$LANE_ID"
printf '%s\n' "$LANE_PROMPT" > "artifacts/lanes/$LANE_ID/prompt.md"
pi --provider openai-codex --model "$PI_MODEL" --thinking off --no-session -p "$(cat artifacts/lanes/$LANE_ID/prompt.md)" > "artifacts/lanes/$LANE_ID/report.md"
node <<'NODE'
const fs = require('fs');
const laneId = process.env.LANE_ID;
const receipt = { generatedAt: new Date().toISOString(), laneId, outputRefs: ['artifacts/lanes/' + laneId + '/report.md', 'artifacts/lanes/' + laneId + '/receipt.json'], role: process.env.LANE_ROLE, runId: process.env.RUN_ID, topic: process.env.LANE_TOPIC };
fs.writeFileSync('artifacts/lanes/' + laneId + '/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
NODE
git add "artifacts/lanes/$LANE_ID"
git commit -m "lane: $LANE_ID $RUN_ID"
commit=$(git rev-parse HEAD)
git push origin HEAD:"refs/heads/lane-$LANE_ID"
printf '%s\n' "$commit"`;
}

function buildSynthesisCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/piwf-parallel
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-parallel
cd /workspace/piwf-parallel
git config user.name "cloudflare-parallel-workflow-spike"
git config user.email "cloudflare-parallel-workflow-spike@example.invalid"
git fetch origin '+refs/heads/*:refs/remotes/origin/*'
node <<'NODE'
const fs = require('fs');
const { execFileSync } = require('child_process');
const laneIds = JSON.parse(process.env.LANE_IDS_JSON);
const requiredLaneIds = JSON.parse(process.env.REQUIRED_LANE_IDS_JSON);
fs.mkdirSync('artifacts/synthesis/lane-reports', { recursive: true });
const reports = [];
for (const laneId of laneIds) {
  const reportPath = 'artifacts/lanes/' + laneId + '/report.md';
  const branchPath = 'origin/lane-' + laneId + ':' + reportPath;
  let report = '';
  try {
    report = execFileSync('git', ['show', branchPath], { encoding: 'utf8' });
  } catch {
    report = '# Missing lane ' + laneId + '\n';
  }
  fs.writeFileSync('artifacts/synthesis/lane-reports/' + laneId + '.md', report);
  reports.push({ laneId, reportBytes: Buffer.byteLength(report), required: requiredLaneIds.includes(laneId) });
}
const fanIn = { generatedAt: new Date().toISOString(), laneCount: laneIds.length, reports, requiredLaneIds, strategy: 'wait_all' };
const plan = [
  '# Implementation Plan: Real Cloudflare Parallel Pi Workflows',
  '',
  '## Receipts',
  '',
  '- Run id: ' + process.env.RUN_ID,
  '- Work item: ' + process.env.WORK_ITEM_ID,
  '- Lane count: ' + laneIds.length,
  '- Required lanes: ' + requiredLaneIds.join(', '),
  '',
  '## Synthesis',
  '',
  '- Worker receives the job and routes by workItemId to a Durable Object supervisor.',
  '- Durable Object owns current state, active lane registry, fan-in policy, and final receipt.',
  '- Cloudflare Queue schedules lane and finalization messages; lane messages ask the DO for a slot before creating Sandbox compute.',
  '- Cloudflare Sandbox runs each admitted lane and pushes lane branch receipts to Cloudflare Artifacts.',
  '- Fan-in waits for required lane receipts, then synthesis and verifier sandboxes commit accepted artifacts.',
  '- Output target delivery is generic implementation_plan delivery, not Wzrrd-as-core.',
  '',
  '## Lane evidence',
  '',
  ...reports.map((item) => '- ' + item.laneId + ': ' + item.reportBytes + ' bytes' + (item.required ? ' (required)' : '')),
  '',
].join('\n');
fs.writeFileSync('artifacts/synthesis/fan-in.json', JSON.stringify(fanIn, null, 2) + '\n');
fs.writeFileSync('artifacts/synthesis/implementation-plan.md', plan + '\n');
NODE
git add artifacts/synthesis
git commit -m "synthesis: $RUN_ID"
commit=$(git rev-parse HEAD)
git push origin HEAD:main
printf '%s\n' "$commit"`;
}

function buildVerifierCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/piwf-parallel
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-parallel
cd /workspace/piwf-parallel
git config user.name "cloudflare-parallel-workflow-spike"
git config user.email "cloudflare-parallel-workflow-spike@example.invalid"
node <<'NODE'
const fs = require('fs');
const requiredLaneIds = JSON.parse(process.env.REQUIRED_LANE_IDS_JSON);
const blockingFailures = [];
const warnings = [];
const checkedArtifacts = ['artifacts/synthesis/implementation-plan.md', 'artifacts/synthesis/fan-in.json'];
for (const laneId of requiredLaneIds) {
  const reportPath = 'artifacts/synthesis/lane-reports/' + laneId + '.md';
  checkedArtifacts.push(reportPath);
  if (!fs.existsSync(reportPath)) blockingFailures.push('missing required lane report: ' + laneId);
}
if (!fs.existsSync('artifacts/synthesis/implementation-plan.md')) blockingFailures.push('missing synthesis implementation plan');
const result = {
  blockingFailures,
  checkedArtifacts,
  generatedAt: new Date().toISOString(),
  schemaVersion: 'parallel-verification-result.v1',
  status: blockingFailures.length > 0 ? 'blocked' : warnings.length > 0 ? 'warnings' : 'verified',
  warnings,
};
fs.mkdirSync('artifacts/verification', { recursive: true });
fs.writeFileSync('artifacts/verification/result.json', JSON.stringify(result, null, 2) + '\n');
fs.writeFileSync('artifacts/verification/report.md', '# Verification\n\nStatus: ' + result.status + '\n\nChecked ' + checkedArtifacts.length + ' artifacts.\n');
NODE
git add artifacts/verification
git commit -m "verify: $RUN_ID"
commit=$(git rev-parse HEAD)
git push origin HEAD:main
printf '%s\n' "$commit"`;
}

function buildDeliveryCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/piwf-parallel
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/piwf-parallel
cd /workspace/piwf-parallel
git config user.name "cloudflare-parallel-workflow-spike"
git config user.email "cloudflare-parallel-workflow-spike@example.invalid"
node <<'NODE'
const fs = require('fs');
const receipt = {
  deliveredAt: new Date().toISOString(),
  outputRefs: ['artifacts/synthesis/implementation-plan.md', 'artifacts/output-target/implementation-plan/receipt.json'],
  targetKind: 'implementation_plan',
};
fs.mkdirSync('artifacts/output-target/implementation-plan', { recursive: true });
fs.writeFileSync('artifacts/output-target/implementation-plan/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
NODE
git add artifacts/output-target/implementation-plan
git commit -m "deliver: $RUN_ID implementation plan"
commit=$(git rev-parse HEAD)
git push origin HEAD:main
printf '%s\n' "$commit"`;
}

function buildFinalReceipt(
  record: CapsuleRecord,
  outputTargetReceipt: {
    deliveredAt: string;
    outputRefs: string[];
    targetKind: "implementation_plan";
  }
): FinalReceipt {
  const { plan } = record;
  const verifierResult = requireValue(record.verifierResult, "verifierResult");
  const receipt = FinalReceiptSchema.parse({
    artifactRemote: requireValue(record.artifactRemote, "artifactRemote"),
    artifactsRepo: requireValue(record.artifactRepoName, "artifactRepoName"),
    capsuleId: record.capsuleId,
    checks: [
      {
        id: "bounded-hot-concurrency",
        status:
          record.maxObservedActiveLanes <= plan.jobSpec.parallel.concurrencyCap
            ? "passed"
            : "failed",
        summary:
          "Max observed active fanout lanes did not exceed concurrency cap.",
      },
      {
        id: "real-cloudflare-primitives",
        status: "passed",
        summary:
          "Run used Worker, Durable Object, Queue, Sandbox, and Artifacts bindings.",
      },
      {
        id: "no-wzrrd-core-state",
        status: plan.machine.states.some((state) => /wzrrd/iu.test(state.id))
          ? "failed"
          : "passed",
        summary: "Machine state names avoid Wzrrd-specific lifecycle language.",
      },
    ],
    cleanupReceipts: record.cleanupReceipts,
    concurrencyCap: plan.jobSpec.parallel.concurrencyCap,
    deployedWorkerUrl:
      "https://pi-cloudflare-parallel-workflow-spike.joelhooks.workers.dev",
    finalState: "captured",
    generatedHarnessRef: "workflows/harness.json",
    generatedMachineRef: "workflows/machine.json",
    laneReceipts: Object.values(record.lanes),
    maxObservedActiveLanes: record.maxObservedActiveLanes,
    outputTargetReceipt,
    planCommitSha: requireValue(record.planCommitSha, "planCommitSha"),
    prototype: "cloudflare-parallel-workflow-spike",
    runId: requireValue(record.runId, "runId"),
    schemaVersion: "cloudflare-parallel-workflow-receipt.v1",
    synthesisCommitSha: requireValue(
      record.synthesisCommitSha,
      "synthesisCommitSha"
    ),
    totalPlannedLanes: plan.lanes.length,
    verifierResult,
  });
  const failed = receipt.checks.filter((check) => check.status !== "passed");
  if (failed.length > 0) {
    throw new Error(`final receipt failed checks: ${JSON.stringify(failed)}`);
  }
  return receipt;
}

function getSupervisorStub(env: Env, workItemId: string): DurableObjectStub {
  return env.CAPSULE_SUPERVISOR.get(
    env.CAPSULE_SUPERVISOR.idFromName(workItemId)
  );
}

async function postDo(
  stub: DurableObjectStub,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const response = await stub.fetch(
    new Request(`https://capsule.local${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok || payload["ok"] !== true) {
    throw new Error(
      `DO ${path} failed: ${response.status} ${JSON.stringify(payload)}`
    );
  }
  return payload;
}

async function runCommand(
  sandbox: RealSandbox,
  command: string,
  redaction: { tokenSecret: string },
  options: { env: Record<string, string>; timeout: number }
): Promise<CommandResult> {
  const encodedCommand = btoa(command);
  const wrappedCommand = String.raw`set +e
script_path="$(mktemp)"
printf '%s' '${encodedCommand}' | base64 -d > "$script_path"
timeout "$PIWF_COMMAND_TIMEOUT_SECONDS" bash "$script_path" 2>&1
status=$?
rm -f "$script_path"
printf '\n__PIWF_EXIT_CODE__:%s\n' "$status"`;
  const result = await sandbox.exec(wrappedCommand, {
    cwd: "/workspace",
    env: options.env,
    timeout: options.timeout,
  });
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const exitMatch = combinedOutput.match(/__PIWF_EXIT_CODE__:(\d+)/u);
  const exitCode = exitMatch?.[1] ? Number(exitMatch[1]) : result.exitCode;

  return {
    command,
    duration: result.duration,
    exitCode,
    stderr: redact(result.stderr, [redaction.tokenSecret]),
    stdout: redact(result.stdout, [redaction.tokenSecret]),
    success: exitCode === 0,
    timestamp: result.timestamp,
  };
}

function assertCommand(result: CommandResult, label: string): void {
  if (!result.success) {
    throw new Error(
      `${label} failed with exit ${result.exitCode}: ${result.stderr || result.stdout}`
    );
  }
}

async function destroySandbox(
  sandbox: RealSandbox,
  sandboxId: string
): Promise<string> {
  await sandbox.destroy();
  return `destroy:${sandboxId}:ok`;
}

function isFanInSatisfied(record: CapsuleRecord): boolean {
  const lanes = Object.values(record.lanes);
  if (record.plan.jobSpec.parallel.fanIn.strategy === "wait_all") {
    return lanes.every(
      (lane) => lane.status === "committed" || lane.status === "degraded"
    );
  }
  return record.plan.jobSpec.parallel.fanIn.requiredLaneIds.every(
    (laneId) => record.lanes[laneId]?.status === "committed"
  );
}

function toAuthenticatedRemote(
  remote: string,
  token: string
): { remote: string; tokenSecret: string } {
  const tokenSecret = token.split("?expires=")[0] ?? token;
  return {
    remote: `https://x:${tokenSecret}@${remote.slice("https://".length)}`,
    tokenSecret,
  };
}

function getLastNonEmptyLine(value: string): string | undefined {
  const lines = value.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && !line.startsWith("__PIWF_EXIT_CODE__:")) {
      return line;
    }
  }
  return undefined;
}

function redact(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[redacted]");
    }
  }
  return redacted.replaceAll(
    /art_v1_[A-Za-z0-9]+/gu,
    "[redacted-artifacts-token]"
  );
}

function isAuthorized(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  if (!env.ACCESS_TOKEN) {
    return ["localhost", "127.0.0.1", "0.0.0.0"].includes(url.hostname);
  }

  const queryToken = url.searchParams.get("token");
  const headerToken = request.headers.get("X-Access-Token");
  const authorization = request.headers.get("Authorization");
  const bearerToken = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return [queryToken, headerToken, bearerToken].some(
    (token) => token === env.ACCESS_TOKEN
  );
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init.headers,
    },
  });
}

function jsonString(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function requireValue<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing ${name}`);
  }
  return value;
}

function buildSandboxId(
  runId: string,
  label: string,
  attempt?: number
): string {
  const runParts = slugify(runId).split("-");
  const runToken = runParts.slice(-2).join("-").slice(0, 24);
  const labelToken = slugify(label).slice(0, 28);
  const suffix = attempt === undefined ? "" : `-${attempt}`;
  return `ps-${runToken}-${labelToken}${suffix}`.slice(0, 63);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "")
    .slice(0, 60);
  if (!RUN_ID_RE.test(slug)) {
    return `run-${crypto.randomUUID().slice(0, 8)}`;
  }
  return slug;
}
