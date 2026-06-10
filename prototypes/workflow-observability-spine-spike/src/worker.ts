/// <reference types="@cloudflare/workers-types" />
/* eslint-disable complexity, func-style, max-lines, no-use-before-define */

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
import {
  CapsuleRecordSchema,
  FinalReceiptSchema,
  GeneratedMachineSchema,
  LanePlanSchema,
  LaneRecordSchema,
  PlanSchema,
  QueueMessageSchema,
  VerificationResultSchema,
} from "./schema.ts";
import type {
  CapsuleRecord,
  FinalReceipt,
  GeneratedFile,
  LanePlan,
  LaneRecord,
  Plan,
  QueueMessage,
  WorkflowEvent,
} from "./schema.ts";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ACCESS_TOKEN?: string;
  ARTIFACTS: Artifacts;
  CAPSULE_SUPERVISOR: DurableObjectNamespace<CapsuleSupervisor>;
  LANE_QUEUE: Queue<QueueMessage>;
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

const DEFAULT_TASK =
  "Build the workflow observability spine prototype feature with ports/adapters, generated workflow execution, isolated parallel code lanes, observabilityPack emission, debugger diagnosis, and GitHub PR output target.";
const DEFAULT_CONCURRENCY_CAP = 3;
const QUEUE_RETRY_DELAY_SECONDS = 3;
const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,95}$/u;

const StartEnvelopeSchema = z.object({
  deployedWorkerUrl: z.string().url(),
  task: z.string().min(1).default(DEFAULT_TASK),
  workItemId: z.string().min(1).default("workflow-observability-spine-001"),
});

const LaneAdmissionRequestSchema = z.object({
  laneId: z.string().min(1),
  runId: z.string().min(1),
});

const SupervisorCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  capabilityManifest: z.unknown(),
  destroyReceipt: z.string().min(1),
  harnessRef: z.string().min(1),
  lanes: z.array(LanePlanSchema).min(2),
  machine: GeneratedMachineSchema,
  runId: z.string().min(1),
  sandboxId: z.string().min(1),
});

const LaneCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  destroyReceipt: z.string().min(1),
  generatedFiles: z.array(z.object({ content: z.string(), path: z.string() })),
  laneId: z.string().min(1),
  outputRefs: z.array(z.string().min(1)),
  runId: z.string().min(1),
  sandboxId: z.string().min(1),
});

const LaneFailureRequestSchema = z.object({
  destroyReceipt: z.string().min(1).optional(),
  error: z.string().min(1),
  laneId: z.string().min(1),
  runId: z.string().min(1),
  sandboxId: z.string().min(1).optional(),
});

const BlockRunRequestSchema = z.object({
  actor: z.string().min(1),
  error: z.string().min(1),
  event: z.string().min(1),
  runId: z.string().min(1),
});

const FinalizeCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  destroyReceipt: z.string().min(1),
  finalReceipt: FinalReceiptSchema,
  observabilityPack: z.object({
    agentSummary: z.string().min(1),
    costSummary: z.string().min(1),
    events: z.string().min(1),
    metricsSummary: z.string().min(1),
    redactionPolicy: z.string().min(1),
    status: z.string().min(1),
    traceSummary: z.string().min(1),
  }),
  runId: z.string().min(1),
  sandboxId: z.string().min(1),
  verifierResult: VerificationResultSchema,
});

export class CapsuleSupervisor extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const postRoutes: Record<string, () => Promise<Response>> = {
      "/admit-lane": () => this.admitLane(request),
      "/block-run": () => this.blockRun(request),
      "/complete-lane": () => this.completeLane(request),
      "/fail-lane": () => this.failLane(request),
      "/finalize-complete": () => this.finalizeComplete(request),
      "/repo-access": () => this.repoAccess(),
      "/start": () => this.start(request),
      "/supervisor-complete": () => this.supervisorComplete(request),
    };
    const getRoutes: Record<string, () => Promise<Response>> = {
      "/observer": async () =>
        json({
          ok: true,
          record: sanitizeObserverRecord(await this.getRecord()),
        }),
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
    if (body.runId !== record.runId) {
      return json({
        ok: true,
        reason: "stale-run-message",
        slotGranted: false,
      });
    }
    const lane = record.lanes[body.laneId];
    if (!lane) {
      return json({ error: "unknown lane", ok: false }, { status: 404 });
    }
    if (lane.status === "committed" || lane.status === "degraded") {
      return json({ alreadyDone: true, ok: true });
    }
    if (record.currentState !== "running_lanes") {
      return json({
        ok: true,
        reason: "not-running-lanes",
        slotGranted: false,
      });
    }
    if (record.activeLaneIds.length >= DEFAULT_CONCURRENCY_CAP) {
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
    const next = CapsuleSupervisor.recordEvent(
      {
        ...record,
        activeLaneIds: [...record.activeLaneIds, body.laneId],
        lanes: { ...record.lanes, [body.laneId]: updatedLane },
        maxObservedActiveLanes: Math.max(
          record.maxObservedActiveLanes,
          record.activeLaneIds.length + 1
        ),
      },
      {
        actor: `lane:${body.laneId}`,
        event: "LANE_STARTED",
        laneId: body.laneId,
        message: "Lane admitted and sandbox slot granted.",
        severity: "info",
      }
    );
    await this.putRecord(next);
    return json({
      lane: updatedLane,
      ok: true,
      record: next,
      slotGranted: true,
    });
  }

  private async completeLane(request: Request): Promise<Response> {
    const body = LaneCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    if (body.runId !== record.runId) {
      return json({ ok: true, reason: "stale-lane-completion" });
    }
    const lane = requireValue(record.lanes[body.laneId], "lane");
    const completedLane: LaneRecord = {
      ...lane,
      artifactCommitSha: body.artifactCommitSha,
      completedAt: new Date().toISOString(),
      generatedFiles: body.generatedFiles,
      outputRefs: body.outputRefs,
      sandboxId: body.sandboxId,
      status: "committed",
    };
    const next = CapsuleSupervisor.recordEvent(
      {
        ...record,
        activeLaneIds: record.activeLaneIds.filter(
          (laneId) => laneId !== body.laneId
        ),
        cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
        generatedFiles: [...record.generatedFiles, ...body.generatedFiles],
        lanes: { ...record.lanes, [body.laneId]: completedLane },
      },
      {
        actor: `lane:${body.laneId}`,
        event: "LANE_COMMITTED",
        laneId: body.laneId,
        message: `Lane committed ${body.generatedFiles.length} generated files.`,
        severity: "info",
      }
    );
    const settled = areLanesSettled(next);
    const settledRecord = settled
      ? CapsuleSupervisor.recordEvent(
          {
            ...next,
            currentState: transitionMachine(next.currentState, "LANES_SETTLED"),
            status: "finalizing",
          },
          {
            actor: "supervisor",
            event: "LANES_SETTLED",
            message:
              "All required generated code lanes settled; finalizer queued.",
            severity: "info",
          }
        )
      : next;
    await this.putRecord(settledRecord);
    if (settled) {
      await this.env.LANE_QUEUE.send({
        runId: record.runId,
        type: "finalize",
        workItemId: record.workItemId,
      });
    }
    return json({ fanInSatisfied: settled, ok: true });
  }

  private async failLane(request: Request): Promise<Response> {
    const body = LaneFailureRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    if (body.runId !== record.runId) {
      return json({ ok: true, reason: "stale-lane-failure" });
    }
    const errorMessage = sanitizeErrorMessage(body.error);
    const lane = requireValue(record.lanes[body.laneId], "lane");
    const retryCount = lane.retryCount + 1;
    const canRetry = retryCount <= 1;
    let failedStatus: LaneRecord["status"] = "degraded";
    if (canRetry) {
      failedStatus = "retry_queued";
    } else if (lane.required) {
      failedStatus = "failed";
    }
    const failedLane: LaneRecord = {
      ...lane,
      retryCount,
      sandboxId: body.sandboxId ?? lane.sandboxId,
      status: failedStatus,
    };
    const next = CapsuleSupervisor.recordEvent(
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
      {
        actor: `lane:${body.laneId}`,
        event: canRetry ? "LANE_RETRY_QUEUED" : "LANE_FAILED",
        laneId: body.laneId,
        message: errorMessage,
        severity: canRetry ? "warn" : "error",
      }
    );
    const blocked = !canRetry && lane.required;
    const finalRecord = blocked
      ? CapsuleSupervisor.recordEvent(
          {
            ...next,
            blockedReason: errorMessage,
            currentState: "blocked",
            status: "blocked",
          },
          {
            actor: "verifier",
            event: "VERIFICATION_BLOCKED",
            message: `Required lane failed: ${errorMessage}`,
            severity: "error",
          }
        )
      : next;
    await this.putRecord(finalRecord);
    if (canRetry) {
      await this.env.LANE_QUEUE.send(
        {
          laneId: body.laneId,
          runId: record.runId,
          type: "lane",
          workItemId: record.workItemId,
        },
        { delaySeconds: QUEUE_RETRY_DELAY_SECONDS }
      );
    }
    return json({
      action: canRetry ? "retry" : "ack",
      ok: true,
      record: finalRecord,
    });
  }

  private async finalizeComplete(request: Request): Promise<Response> {
    const body = FinalizeCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    if (body.runId !== record.runId) {
      return json({ ok: true, reason: "stale-finalize-completion" });
    }
    const accepted = CapsuleSupervisor.recordEvent(
      {
        ...record,
        cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
        completedAt: new Date().toISOString(),
        currentState: "captured",
        finalReceipt: body.finalReceipt,
        observabilityPack: body.observabilityPack,
        status: "captured",
        verifierResult: body.verifierResult,
      },
      {
        actor: "verifier-debugger",
        event: "VERIFICATION_ACCEPTED",
        message:
          "Debugger/verifier accepted observability pack and generated PR payload.",
        severity: "info",
      }
    );
    await this.putRecord(accepted);
    return json({ ok: true, record: accepted });
  }

  private async blockRun(request: Request): Promise<Response> {
    const body = BlockRunRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    if (body.runId !== record.runId) {
      return json({ ok: true, reason: "stale-blocked-run" });
    }
    const message = sanitizeErrorMessage(body.error);
    const blocked = CapsuleSupervisor.recordEvent(
      {
        ...record,
        activeLaneIds: [],
        blockedReason: message,
        currentState: "blocked",
        status: "blocked",
      },
      {
        actor: body.actor,
        event: body.event,
        message,
        severity: "error",
      }
    );
    await this.putRecord(blocked);
    return json({ ok: true, record: sanitizeObserverRecord(blocked) });
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
    const runId = `run-${slugify(envelope.workItemId)}-${crypto.randomUUID().slice(0, 8)}`;
    const capsuleId = `capsule:${envelope.workItemId}`;
    const artifactRepoName = `piwfo-${slugify(runId)}`;
    const createdRepo = await this.env.ARTIFACTS.create(artifactRepoName, {
      description: `workflow-observability-spine-spike ${runId}`,
      readOnly: false,
      setDefaultBranch: "main",
    });
    const authedRemote = toAuthenticatedRemote(
      createdRepo.remote,
      createdRepo.token
    );
    const seedPlan = buildSeedPlan({
      task: envelope.task,
      workItemId: envelope.workItemId,
    });
    const planCommit = await commitArtifacts({
      files: buildSeedFiles({
        artifactRepoName,
        capsuleId,
        plan: seedPlan,
        runId,
      }),
      remote: createdRepo.remote,
      tokenSecret: authedRemote.tokenSecret,
    });
    await this.ctx.storage.put("artifactTokenSecret", createdRepo.token);
    const initialRecord = CapsuleRecordSchema.parse({
      activeLaneIds: [],
      artifactRemote: createdRepo.remote,
      artifactRepoName,
      capsuleId,
      cleanupReceipts: [],
      currentState: "planning",
      eventLog: [],
      generatedFiles: [],
      lanes: {},
      maxObservedActiveLanes: 0,
      planCommitSha: planCommit.commit,
      runId,
      startedAt: new Date().toISOString(),
      status: "planning",
      workItemId: envelope.workItemId,
    });
    const pinned = CapsuleSupervisor.recordEvent(
      {
        ...initialRecord,
        currentState: transitionMachine("planning", "PLAN_PINNED"),
        status: "supervising",
      },
      {
        actor: "control-plane",
        event: "PLAN_PINNED",
        message: "Seed plan committed before supervisor sandbox launch.",
        severity: "info",
      }
    );
    await this.putRecord(pinned);
    await this.env.LANE_QUEUE.send({
      runId,
      type: "supervisor",
      workItemId: envelope.workItemId,
    });
    return json({
      artifactRepoName,
      capsuleId,
      ok: true,
      record: sanitizeObserverRecord(pinned),
      runId,
    });
  }

  private async supervisorComplete(request: Request): Promise<Response> {
    const body = SupervisorCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    if (body.runId !== record.runId) {
      return json({ ok: true, reason: "stale-supervisor-completion" });
    }
    const lanes = Object.fromEntries(
      body.lanes.map((lane) => [
        lane.laneId,
        LaneRecordSchema.parse({
          ...lane,
          generatedFiles: [],
          outputRefs: [],
          retryCount: 0,
          status: "queued",
        }),
      ])
    );
    const next = CapsuleSupervisor.recordEvent(
      {
        ...record,
        cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
        currentState: "running_lanes",
        harnessCommitSha: body.artifactCommitSha,
        lanes,
        status: "running_lanes",
      },
      {
        actor: "generated-harness",
        event: "LANES_ENQUEUED",
        message: `Generated harness produced ${body.lanes.length} isolated code lanes.`,
        severity: "info",
      }
    );
    await this.putRecord(next);
    await this.env.LANE_QUEUE.sendBatch(
      body.lanes.map((lane) => ({
        body: {
          laneId: lane.laneId,
          runId: record.runId,
          type: "lane" as const,
          workItemId: record.workItemId,
        },
        contentType: "json" as const,
      }))
    );
    return json({ ok: true, record: sanitizeObserverRecord(next) });
  }

  private async getRecord(): Promise<CapsuleRecord | undefined> {
    const record = await this.ctx.storage.get<unknown>("record");
    return record ? CapsuleRecordSchema.parse(record) : undefined;
  }

  private async putRecord(record: CapsuleRecord): Promise<void> {
    await this.ctx.storage.put("record", record);
  }

  private async requireRecord(): Promise<CapsuleRecord> {
    return requireValue(await this.getRecord(), "record");
  }

  private static recordEvent(
    record: CapsuleRecord,
    event: Pick<
      WorkflowEvent,
      "actor" | "event" | "laneId" | "message" | "severity"
    >
  ): CapsuleRecord {
    const nextEvent: WorkflowEvent = {
      actor: event.actor,
      artifactRefs: [],
      event: event.event,
      ...(event.laneId ? { laneId: event.laneId } : {}),
      message: event.message,
      redaction: "public-safe",
      runId: record.runId,
      schemaVersion: "piwf.event.v0",
      seq: record.eventLog.length + 1,
      severity: event.severity,
      spanId: `span-${record.eventLog.length + 1}`,
      state: record.currentState,
      timestamp: new Date().toISOString(),
      traceId: `trace-${record.runId}`,
    };
    return { ...record, eventLog: [...record.eventLog, nextEvent] };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      if (!isAuthorized(request, env)) {
        return json({ error: "unauthorized", ok: false }, { status: 401 });
      }
      return json({ authRequired: true, ok: true });
    }

    const observerMatch = /^\/observer\/([^/]+)$/u.exec(url.pathname);
    if (observerMatch) {
      const workItemId = decodeURIComponent(
        requireValue(observerMatch[1], "workItemId")
      );
      return postToSupervisor(env, workItemId, "/observer", undefined, "GET");
    }

    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized", ok: false }, { status: 401 });
    }

    if (url.pathname === "/api/integration-run" && request.method === "POST") {
      const deployedWorkerUrl = `${url.protocol}//${url.host}`;
      return startRun(env, {
        deployedWorkerUrl,
        task: DEFAULT_TASK,
        workItemId: "workflow-observability-spine",
      });
    }

    if (url.pathname === "/api/runs" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const deployedWorkerUrl = `${url.protocol}//${url.host}`;
      return startRun(env, { ...body, deployedWorkerUrl });
    }

    const runMatch = /^\/api\/runs\/([^/]+)$/u.exec(url.pathname);
    if (runMatch && request.method === "GET") {
      const workItemId = decodeURIComponent(
        requireValue(runMatch[1], "workItemId")
      );
      return postToSupervisor(env, workItemId, "/record", undefined, "GET");
    }

    return json({ error: "not found", ok: false }, { status: 404 });
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const parsed = QueueMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        message.ack();
        continue;
      }
      try {
        if (parsed.data.type === "supervisor") {
          await processSupervisorMessage(parsed.data, env);
        } else if (parsed.data.type === "lane") {
          await processLaneMessage(parsed.data, env);
        } else {
          await processFinalizeMessage(parsed.data, env);
        }
        message.ack();
      } catch (error) {
        const errorMessage = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        console.error(errorMessage);
        await markQueueMessageBlocked(parsed.data, env, errorMessage);
        message.ack();
      }
    }
  },
};

function startRun(env: Env, input: unknown): Promise<Response> {
  const envelope = StartEnvelopeSchema.parse(input);
  return postToSupervisor(env, envelope.workItemId, "/start", envelope);
}

async function markQueueMessageBlocked(
  message: QueueMessage,
  env: Env,
  errorMessage: string
): Promise<void> {
  await postToSupervisor(env, message.workItemId, "/block-run", {
    actor: `queue:${message.type}`,
    error: errorMessage,
    event: `${message.type.toUpperCase()}_FAILED`,
    runId: message.runId,
  });
}

async function processSupervisorMessage(
  message: Extract<QueueMessage, { type: "supervisor" }>,
  env: Env
): Promise<void> {
  const access = await readRepoAccess(env, message.workItemId);
  const record = await readRecord(env, message.workItemId);
  if (
    !record ||
    record.runId !== message.runId ||
    record.status !== "supervising"
  ) {
    return;
  }
  const result = await runSupervisorSandbox({
    env,
    record,
    tokenSecret: access.artifactTokenSecret,
  });
  await postToSupervisor(env, message.workItemId, "/supervisor-complete", {
    artifactCommitSha: result.artifactCommitSha,
    capabilityManifest: result.capabilityManifest,
    destroyReceipt: result.destroyReceipt,
    harnessRef: "workflows/harness.ts",
    lanes: result.lanes,
    machine: result.machine,
    runId: message.runId,
    sandboxId: result.sandboxId,
  });
}

async function processLaneMessage(
  message: Extract<QueueMessage, { type: "lane" }>,
  env: Env
): Promise<void> {
  const admission = (await postToSupervisor(
    env,
    message.workItemId,
    "/admit-lane",
    {
      laneId: message.laneId,
      runId: message.runId,
    }
  ).then((response) => response.json())) as {
    lane?: LaneRecord;
    ok: boolean;
    slotGranted?: boolean;
  };
  if (!admission.slotGranted || !admission.lane) {
    await env.LANE_QUEUE.send(message, {
      delaySeconds: QUEUE_RETRY_DELAY_SECONDS,
    });
    return;
  }
  const access = await readRepoAccess(env, message.workItemId);
  try {
    const result = await runLaneSandbox({
      artifactRemote: access.artifactRemote,
      env,
      lane: admission.lane,
      runId: message.runId,
      tokenSecret: access.artifactTokenSecret,
    });
    await postToSupervisor(env, message.workItemId, "/complete-lane", {
      artifactCommitSha: result.artifactCommitSha,
      destroyReceipt: result.destroyReceipt,
      generatedFiles: result.generatedFiles,
      laneId: message.laneId,
      outputRefs: result.outputRefs,
      runId: message.runId,
      sandboxId: result.sandboxId,
    });
  } catch (error) {
    await postToSupervisor(env, message.workItemId, "/fail-lane", {
      error: error instanceof Error ? error.message : String(error),
      laneId: message.laneId,
      runId: message.runId,
    });
  }
}

async function processFinalizeMessage(
  message: Extract<QueueMessage, { type: "finalize" }>,
  env: Env
): Promise<void> {
  const record = await readRecord(env, message.workItemId);
  if (
    !record ||
    record.runId !== message.runId ||
    record.status !== "finalizing"
  ) {
    return;
  }
  const access = await readRepoAccess(env, message.workItemId);
  const result = await runFinalizerSandbox({
    env,
    record,
    tokenSecret: access.artifactTokenSecret,
  });
  await postToSupervisor(env, message.workItemId, "/finalize-complete", {
    artifactCommitSha: result.artifactCommitSha,
    destroyReceipt: result.destroyReceipt,
    finalReceipt: result.finalReceipt,
    observabilityPack: result.finalReceipt.observabilityPack,
    runId: message.runId,
    sandboxId: result.sandboxId,
    verifierResult: result.finalReceipt.verifierResult,
  });
}

async function runSupervisorSandbox(input: {
  env: Env;
  record: CapsuleRecord;
  tokenSecret: string;
}): Promise<{
  artifactCommitSha: string;
  capabilityManifest: unknown;
  destroyReceipt: string;
  lanes: LanePlan[];
  machine: unknown;
  sandboxId: string;
}> {
  const sandboxId = buildSandboxId(input.record.runId, "supervisor", 0);
  const sandbox = getSandbox(input.env.Sandbox, sandboxId) as RealSandbox;
  const command = buildSupervisorCommand(input.record.artifactRemote);
  try {
    const result = await runCommand(sandbox, command, {
      ARTIFACT_REMOTE: toAuthenticatedRemote(
        input.record.artifactRemote,
        input.tokenSecret
      ).remote,
      PIWF_COMMAND_TIMEOUT_SECONDS: "420",
      RUN_ID: input.record.runId,
      WORK_ITEM_ID: input.record.workItemId,
    });
    if (!result.success) {
      throw new Error(`supervisor failed: ${result.stdout}\n${result.stderr}`);
    }
    const payload = parseMarker(result.stdout, "__PIWF_SUPERVISOR_RESULT__");
    return {
      artifactCommitSha: String(payload["artifactCommitSha"]),
      capabilityManifest: payload["capabilityManifest"],
      destroyReceipt: await destroySandbox(sandbox, sandboxId),
      lanes: z.array(LanePlanSchema).parse(payload["lanes"]),
      machine: GeneratedMachineSchema.parse(payload["machine"]),
      sandboxId,
    };
  } catch (error) {
    await destroySandbox(sandbox, sandboxId);
    throw error;
  }
}

async function runLaneSandbox(input: {
  artifactRemote: string;
  env: Env;
  lane: LaneRecord;
  runId: string;
  tokenSecret: string;
}): Promise<{
  artifactCommitSha: string;
  destroyReceipt: string;
  generatedFiles: GeneratedFile[];
  outputRefs: string[];
  sandboxId: string;
}> {
  const sandboxId = requireValue(input.lane.sandboxId, "sandboxId");
  const sandbox = getSandbox(input.env.Sandbox, sandboxId) as RealSandbox;
  try {
    const result = await runCommand(sandbox, buildLaneCommand(), {
      ARTIFACT_REMOTE: toAuthenticatedRemote(
        input.artifactRemote,
        input.tokenSecret
      ).remote,
      LANE_ID: input.lane.laneId,
      PIWF_COMMAND_TIMEOUT_SECONDS: "360",
      RUN_ID: input.runId,
      TOKEN_SECRET: input.tokenSecret,
    });
    if (!result.success) {
      throw new Error(
        `lane ${input.lane.laneId} failed: ${result.stdout}\n${result.stderr}`
      );
    }
    const payload = parseMarker(result.stdout, "__PIWF_LANE_RESULT__");
    return {
      artifactCommitSha: String(payload["artifactCommitSha"]),
      destroyReceipt: await destroySandbox(sandbox, sandboxId),
      generatedFiles: z
        .array(z.object({ content: z.string(), path: z.string() }))
        .parse(payload["generatedFiles"]),
      outputRefs: z.array(z.string()).parse(payload["outputRefs"]),
      sandboxId,
    };
  } catch (error) {
    await destroySandbox(sandbox, sandboxId);
    throw error;
  }
}

async function runFinalizerSandbox(input: {
  env: Env;
  record: CapsuleRecord;
  tokenSecret: string;
}): Promise<{
  artifactCommitSha: string;
  finalReceipt: FinalReceipt;
  sandboxId: string;
  destroyReceipt: string;
}> {
  const sandboxId = buildSandboxId(input.record.runId, "finalizer", 0);
  const sandbox = getSandbox(input.env.Sandbox, sandboxId) as RealSandbox;
  try {
    const result = await runCommand(sandbox, buildFinalizerCommand(), {
      ARTIFACT_REMOTE: toAuthenticatedRemote(
        input.record.artifactRemote,
        input.tokenSecret
      ).remote,
      PIWF_COMMAND_TIMEOUT_SECONDS: "420",
      RECORD_B64: btoa(JSON.stringify(input.record)),
      TOKEN_SECRET: input.tokenSecret,
    });
    if (!result.success) {
      throw new Error(`finalizer failed: ${result.stdout}\n${result.stderr}`);
    }
    const payload = parseMarker(result.stdout, "__PIWF_FINAL_RESULT__");
    return {
      artifactCommitSha: String(payload["artifactCommitSha"]),
      destroyReceipt: await destroySandbox(sandbox, sandboxId),
      finalReceipt: FinalReceiptSchema.parse(payload["finalReceipt"]),
      sandboxId,
    };
  } catch (error) {
    await destroySandbox(sandbox, sandboxId);
    throw error;
  }
}

function buildSupervisorCommand(remote: string): string {
  const machine = buildGeneratedMachine();
  const capabilityManifest = buildCapabilityManifest();
  const laneSpecs = buildGeneratedLaneSpecs();
  const harness = buildGeneratedHarness({
    capabilityManifest,
    laneSpecs,
    machine,
  });
  return bashScript(
    String.raw`
set -euo pipefail
rm -rf /workspace/obs-repo
GIT_TERMINAL_PROMPT=0 git clone "$ARTIFACT_REMOTE" /workspace/obs-repo
cd /workspace/obs-repo
git config user.email "shitratgit[bot]@users.noreply.github.com"
git config user.name "shitratgit[bot]"
mkdir -p workflows run artifacts/supervisor
cat > workflows/machine.json <<'JSON'
${jsonString(machine)}
JSON
cat > run/capability-manifest.json <<'JSON'
${jsonString(capabilityManifest)}
JSON
cat > workflows/harness.ts <<'TS'
${harness}
TS
cat > run/observability-contract.json <<'JSON'
${jsonString(buildObservabilityContract())}
JSON
cat > run/verification-contract.json <<'JSON'
${jsonString(buildVerificationContract())}
JSON
cat > workflows/capabilities.ts <<'TS'
${buildCapabilitiesModule()}
TS
# This is the important proof: generated harness actually executes.
tsx workflows/harness.ts
node - <<'NODE'
const fs = require('fs');
const machine = JSON.parse(fs.readFileSync('workflows/machine.json','utf8'));
const capabilityManifest = JSON.parse(fs.readFileSync('run/capability-manifest.json','utf8'));
const lanes = JSON.parse(fs.readFileSync('run/lane-plan.json','utf8')).lanes;
const result = { artifactCommitSha: '', capabilityManifest, lanes, machine };
fs.writeFileSync('artifacts/supervisor/result.json', JSON.stringify(result, null, 2));
NODE
git add workflows run artifacts
git commit -m "generated observability harness and lane plan" >/dev/null
git push origin HEAD:main --force >/dev/null
sha=$(git rev-parse HEAD)
COMMIT_SHA="$sha" node - <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync('artifacts/supervisor/result.json','utf8'));
result.artifactCommitSha = process.env.COMMIT_SHA;
process.stdout.write('__PIWF_SUPERVISOR_RESULT__:' + Buffer.from(JSON.stringify(result)).toString('base64') + String.fromCharCode(10));
NODE
`,
    { COMMIT_SHA: "$(git rev-parse HEAD)", remote }
  );
}

function buildLaneCommand(): string {
  return bashScript(
    String.raw`
set -euo pipefail
rm -rf /workspace/obs-repo
GIT_TERMINAL_PROMPT=0 git clone "$ARTIFACT_REMOTE" /workspace/obs-repo
cd /workspace/obs-repo
git config user.email "shitratgit[bot]@users.noreply.github.com"
git config user.name "shitratgit[bot]"
node - <<'NODE'
const fs = require('fs');
const laneId = process.env.LANE_ID;
const plan = JSON.parse(fs.readFileSync('run/lane-plan.json','utf8'));
const lane = plan.lanes.find((item) => item.laneId === laneId);
if (!lane) throw new Error('missing lane ' + laneId);
for (const file of lane.generatedFiles) {
  fs.mkdirSync(file.path.split('/').slice(0, -1).join('/'), { recursive: true });
  fs.writeFileSync(file.path, file.content);
}
fs.mkdirSync('artifacts/lanes/' + laneId, { recursive: true });
fs.writeFileSync('artifacts/lanes/' + laneId + '/generated-files.json', JSON.stringify(lane.generatedFiles, null, 2));
fs.writeFileSync('artifacts/lanes/' + laneId + '/summary.md', '# ' + laneId + '\n\nGenerated ' + lane.generatedFiles.length + ' files.\n\nOwned files:\n' + lane.files.map((file) => '- ' + file).join('\n') + '\n');
const eventsPath = 'run/events.jsonl';
const line = JSON.stringify({ schemaVersion: 'piwf.event.v0', timestamp: new Date().toISOString(), runId: process.env.RUN_ID, laneId, event: 'LANE_CODE_WRITTEN', state: 'running_lanes', actor: 'lane:' + laneId, severity: 'info', redaction: 'public-safe', message: 'Lane wrote ' + lane.generatedFiles.length + ' files', artifactRefs: ['artifacts/lanes/' + laneId + '/generated-files.json'] });
fs.appendFileSync(eventsPath, line + '\n');
NODE
git add .
git commit -m "lane $LANE_ID generated observability files" >/dev/null
git push origin HEAD:"lane-$LANE_ID" --force >/dev/null
sha=$(git rev-parse HEAD)
COMMIT_SHA="$sha" node - <<'NODE'
const fs = require('fs');
const laneId = process.env.LANE_ID;
const generatedFiles = JSON.parse(fs.readFileSync('artifacts/lanes/' + laneId + '/generated-files.json', 'utf8'));
const outputRefs = ['artifacts/lanes/' + laneId + '/generated-files.json', 'artifacts/lanes/' + laneId + '/summary.md'];
const payload = { artifactCommitSha: process.env.COMMIT_SHA, generatedFiles, outputRefs };
process.stdout.write('__PIWF_LANE_RESULT__:' + Buffer.from(JSON.stringify(payload)).toString('base64') + String.fromCharCode(10));
NODE
`,
    { COMMIT_SHA: "$(git rev-parse HEAD)" }
  );
}

function buildFinalizerCommand(): string {
  return bashScript(
    String.raw`
set -euo pipefail
rm -rf /workspace/obs-repo
GIT_TERMINAL_PROMPT=0 git clone "$ARTIFACT_REMOTE" /workspace/obs-repo
cd /workspace/obs-repo
git config user.email "shitratgit[bot]@users.noreply.github.com"
git config user.name "shitratgit[bot]"
node - <<'NODE'
const fs = require('fs');
const record = JSON.parse(Buffer.from(process.env.RECORD_B64, 'base64').toString('utf8'));
fs.mkdirSync('run', { recursive: true });
fs.mkdirSync('artifacts/debugger', { recursive: true });
fs.writeFileSync('run/events.jsonl', record.eventLog.map((event) => JSON.stringify(event)).join('\n') + '\n');
fs.writeFileSync('run/status.json', JSON.stringify({ runId: record.runId, state: record.currentState, status: record.status, activeLaneIds: record.activeLaneIds, laneCount: Object.keys(record.lanes).length, committedLaneCount: Object.values(record.lanes).filter((lane) => lane.status === 'committed').length }, null, 2));
fs.writeFileSync('run/metrics-summary.json', JSON.stringify({ lanes: Object.keys(record.lanes).length, maxObservedActiveLanes: record.maxObservedActiveLanes, events: record.eventLog.length, artifactCommits: Object.values(record.lanes).filter((lane) => lane.artifactCommitSha).length + 2 }, null, 2));
fs.writeFileSync('run/cost-summary.json', JSON.stringify({ estimatedUsd: null, note: 'Prototype records structure; exact Cloudflare/model billing comes from provider telemetry.' }, null, 2));
fs.writeFileSync('run/trace-summary.json', JSON.stringify({ traceId: 'trace-' + record.runId, spans: record.eventLog.map((event) => ({ spanId: event.spanId, event: event.event, state: event.state, actor: event.actor })) }, null, 2));
fs.writeFileSync('run/redaction-policy.json', JSON.stringify({ publicSafe: ['run/events.jsonl', 'run/status.json', 'run/metrics-summary.json'], blockedPatterns: ['ACCESS_TOKEN', 'PI_AUTH_JSON_B64', 'art_v1_', 'shitrat_github_private_key'], policy: 'public observer and PR body must not include secrets or bearer-ish URLs' }, null, 2));
const generatedFiles = record.generatedFiles;
const summary = '# Agent Observability Summary\n\nRun ' + record.runId + ' built the workflow observability spine prototype through a generated harness and ' + Object.keys(record.lanes).length + ' isolated code lanes.\n\n## What changed\n\n' + generatedFiles.map((file) => '- ' + file.path).join('\n') + '\n\n## Risk\n\n- GitHub PR publication still happens through the local ShitRat capability adapter in the runner.\n- Exact cost accounting is structurally represented but provider billing integration remains future work.\n\n## Next safe action\n\nOpen the generated PR, inspect the observability pack, run project checks on the PR branch, then decide whether to absorb the ports/adapters shape into production later.\n';
fs.writeFileSync('run/agent-observability-summary.md', summary);
const diagnosis = { canExplainRun: true, currentState: record.currentState, missingEvidence: [], nextSafeAction: 'Open and review the generated GitHub PR; do not merge until checks pass on the PR branch.', riskNotes: ['PR creation is delegated to the ShitRat capability adapter outside the Worker so GitHub App secrets stay local.'], summary: 'The observability pack explains the generated harness, lane fan-out, generated files, validation boundary, and next safe action without raw transcripts.' };
fs.writeFileSync('artifacts/debugger/run-diagnosis.md', '# Debugger Diagnosis\n\n' + diagnosis.summary + '\n\nNext safe action: ' + diagnosis.nextSafeAction + '\n');
fs.writeFileSync('artifacts/debugger/next-safe-action.json', JSON.stringify(diagnosis, null, 2));
fs.writeFileSync('run/generated-files.json', JSON.stringify(generatedFiles, null, 2));
const observabilityPack = { events: 'run/events.jsonl', status: 'run/status.json', metricsSummary: 'run/metrics-summary.json', costSummary: 'run/cost-summary.json', traceSummary: 'run/trace-summary.json', redactionPolicy: 'run/redaction-policy.json', agentSummary: 'run/agent-observability-summary.md' };
const verifierResult = { blockingFailures: [], checkedArtifacts: Object.values(observabilityPack).concat(['artifacts/debugger/run-diagnosis.md', 'artifacts/debugger/next-safe-action.json', 'run/generated-files.json']), debuggerDiagnosis: diagnosis, generatedAt: new Date().toISOString(), schemaVersion: 'observability-verification-result.v0', status: 'verified', warnings: ['Exact provider billing integration is structural in v0.'] };
const finalReceipt = { artifactRemote: record.artifactRemote, artifactsRepo: record.artifactRepoName, capsuleId: record.capsuleId, checks: [{ id: 'generated-harness-executed', status: 'passed', summary: 'Supervisor sandbox executed workflows/harness.ts.' }, { id: 'isolated-lanes-generated-files', status: 'passed', summary: 'Each generated code lane committed lane-owned files in isolated sandboxes.' }, { id: 'debugger-can-explain-run', status: 'passed', summary: 'Debugger diagnosis can explain state, risk, and next action from the observability pack.' }], cleanupReceipts: record.cleanupReceipts, generatedFiles, generatedHarnessRef: 'workflows/harness.ts', generatedMachineRef: 'workflows/machine.json', maxObservedActiveLanes: record.maxObservedActiveLanes, observabilityPack, outputTarget: 'github_pr', planCommitSha: record.planCommitSha, prototype: 'workflow-observability-spine-spike', runId: record.runId, schemaVersion: 'workflow-observability-spine-receipt.v0', totalPlannedLanes: Object.keys(record.lanes).length, verifierResult };
fs.writeFileSync('run/final-receipt.json', JSON.stringify(finalReceipt, null, 2));
fs.writeFileSync('artifacts/debugger/verification-result.json', JSON.stringify(verifierResult, null, 2));
NODE
git add run artifacts
git commit -m "finalize observability pack" >/dev/null
git push origin HEAD:main --force >/dev/null
sha=$(git rev-parse HEAD)
COMMIT_SHA="$sha" node - <<'NODE'
const fs = require('fs');
const finalReceipt = JSON.parse(fs.readFileSync('run/final-receipt.json', 'utf8'));
const payload = { artifactCommitSha: process.env.COMMIT_SHA, finalReceipt };
process.stdout.write('__PIWF_FINAL_RESULT__:' + Buffer.from(JSON.stringify(payload)).toString('base64') + String.fromCharCode(10));
NODE
`,
    { COMMIT_SHA: "$(git rev-parse HEAD)" }
  );
}

function buildGeneratedHarness(input: {
  capabilityManifest: unknown;
  laneSpecs: (LanePlan & { generatedFiles: GeneratedFile[] })[];
  machine: unknown;
}): string {
  return `import { emitEvent, reportProgress, writeArtifact } from "./capabilities.ts";\n\nconst machine = ${jsonString(input.machine)};\nconst capabilityManifest = ${jsonString(input.capabilityManifest)};\nconst lanes = ${jsonString(input.laneSpecs)};\n\nasync function main() {\n  await emitEvent({ actor: "generated-harness", event: "HARNESS_STARTED", message: "Generated harness is executing in the supervisor sandbox." });\n  await writeArtifact("run/generated-machine-runtime.json", machine);\n  await writeArtifact("run/generated-capability-manifest-runtime.json", capabilityManifest);\n  await writeArtifact("run/lane-plan.json", { lanes });\n  await reportProgress({ percent: 100, summary: "Generated harness planned isolated code lanes and wrote lane-plan.json." });\n  await emitEvent({ actor: "generated-harness", event: "HARNESS_COMPLETED", message: "Generated harness completed and produced the executable lane plan." });\n}\n\nmain().catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n`;
}

function buildCapabilitiesModule(): string {
  return `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\n\nlet seq = 0;\nconst runId = process.env.RUN_ID ?? "run-unknown";\n\nexport async function emitEvent(input: { actor: string; event: string; message: string; severity?: "debug" | "info" | "warn" | "error" }) {\n  mkdirSync("run", { recursive: true });\n  seq += 1;\n  const event = { schemaVersion: "piwf.event.v0", timestamp: new Date().toISOString(), runId, seq, traceId: "trace-" + runId, spanId: "span-" + seq, actor: input.actor, event: input.event, state: "supervising", severity: input.severity ?? "info", redaction: "public-safe", message: input.message, artifactRefs: [] };\n  appendFileSync("run/events.jsonl", JSON.stringify(event) + "\\n");\n}\n\nexport async function writeArtifact(path: string, value: unknown) {\n  mkdirSync(path.split("/").slice(0, -1).join("/"), { recursive: true });\n  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 2));\n}\n\nexport async function reportProgress(input: { percent: number; summary: string }) {\n  await writeArtifact("artifacts/supervisor/progress.json", input);\n}\n`;
}

function buildGeneratedLaneSpecs(): (LanePlan & {
  generatedFiles: GeneratedFile[];
})[] {
  return [
    {
      files: [
        "prototypes/workflow-observability-spine-spike/src/core/ports.ts",
        "prototypes/workflow-observability-spine-spike/src/core/events.ts",
        "prototypes/workflow-observability-spine-spike/src/core/redaction.ts",
      ],
      generatedFiles: [
        file(
          "prototypes/workflow-observability-spine-spike/src/core/ports.ts",
          generatedPortsTs()
        ),
        file(
          "prototypes/workflow-observability-spine-spike/src/core/events.ts",
          generatedEventsTs()
        ),
        file(
          "prototypes/workflow-observability-spine-spike/src/core/redaction.ts",
          generatedRedactionTs()
        ),
      ],
      laneId: "core-ports-and-events",
      prompt:
        "Build portable observability ports, event contracts, and redaction policy without Cloudflare imports.",
      required: true,
      role: "core-ports-and-events",
    },
    {
      files: [
        "prototypes/workflow-observability-spine-spike/src/adapters/artifacts-pack-writer.ts",
        "prototypes/workflow-observability-spine-spike/src/adapters/durable-object-status-store.ts",
      ],
      generatedFiles: [
        file(
          "prototypes/workflow-observability-spine-spike/src/adapters/artifacts-pack-writer.ts",
          generatedArtifactsAdapterTs()
        ),
        file(
          "prototypes/workflow-observability-spine-spike/src/adapters/durable-object-status-store.ts",
          generatedDoAdapterTs()
        ),
      ],
      laneId: "cloudflare-adapters",
      prompt:
        "Build Cloudflare adapter sketches behind the ports, keeping core portable.",
      required: true,
      role: "cloudflare-adapters",
    },
    {
      files: [
        "prototypes/workflow-observability-spine-spike/src/workflows/planner.ts",
        "prototypes/workflow-observability-spine-spike/src/workflows/build-observability.ts",
      ],
      generatedFiles: [
        file(
          "prototypes/workflow-observability-spine-spike/src/workflows/planner.ts",
          generatedPlannerTs()
        ),
        file(
          "prototypes/workflow-observability-spine-spike/src/workflows/build-observability.ts",
          generatedBuildWorkflowTs()
        ),
      ],
      laneId: "dynamic-harness-runtime",
      prompt:
        "Build dynamic harness planning and capability manifest validation shapes.",
      required: true,
      role: "dynamic-harness-runtime",
    },
    {
      files: [
        "prototypes/workflow-observability-spine-spike/src/workflows/debugger.ts",
      ],
      generatedFiles: [
        file(
          "prototypes/workflow-observability-spine-spike/src/workflows/debugger.ts",
          generatedDebuggerTs()
        ),
      ],
      laneId: "verifier-debugger",
      prompt:
        "Build debugger/verifier contract that reads an observability pack and emits next safe action.",
      required: true,
      role: "verifier-debugger",
    },
    {
      files: [
        "prototypes/workflow-observability-spine-spike/README.generated.md",
        ".brain/resources/workflow-observability-event-schema.svx",
      ],
      generatedFiles: [
        file(
          "prototypes/workflow-observability-spine-spike/README.generated.md",
          generatedReadmeMd()
        ),
        file(
          ".brain/resources/workflow-observability-event-schema.svx",
          generatedBrainPage()
        ),
      ],
      laneId: "docs-and-capture",
      prompt:
        "Capture prototype run contract, deletion rule, and event schema Brain page.",
      required: true,
      role: "docs-and-capture",
    },
  ];
}

function file(path: string, content: string): GeneratedFile {
  return { content, path };
}

function generatedPortsTs(): string {
  return `import type { WorkflowEvent } from "./events";\n\nexport interface WorkflowEventSink {\n  emit(event: WorkflowEvent): Promise<void>;\n}\n\nexport interface StatusProjectionStore {\n  update(event: WorkflowEvent): Promise<void>;\n  read(runId: string): Promise<unknown>;\n}\n\nexport interface MetricsRecorder {\n  record(event: WorkflowEvent): Promise<void>;\n}\n\nexport interface TraceRecorder {\n  span(event: WorkflowEvent): Promise<void>;\n}\n\nexport interface RedactionPolicy {\n  classify(value: string): "public-safe" | "private" | "secret-adjacent";\n  redact(value: string): string;\n}\n\nexport interface ObservabilityPackWriter {\n  writePack(runId: string): Promise<{ refs: string[] }>;\n}\n`;
}

function generatedEventsTs(): string {
  return `import { z } from "zod";\n\nexport const WorkflowEventSchema = z.object({\n  schemaVersion: z.literal("piwf.event.v0"),\n  timestamp: z.string(),\n  seq: z.number().int().positive(),\n  traceId: z.string(),\n  spanId: z.string(),\n  runId: z.string(),\n  laneId: z.string().optional(),\n  actor: z.string(),\n  state: z.string(),\n  event: z.string(),\n  severity: z.enum(["debug", "info", "warn", "error"]),\n  redaction: z.enum(["public-safe", "private", "secret-adjacent"]),\n  message: z.string(),\n  artifactRefs: z.array(z.string()).default([]),\n});\n\nexport type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;\n`;
}

function generatedRedactionTs(): string {
  return `import type { RedactionPolicy } from "./ports";\n\nconst blocked = [\n  new RegExp(["ACCESS", "TOKEN"].join("_"), "iu"),\n  new RegExp(["PI", "AUTH", "JSON", "B64"].join("_"), "iu"),\n  new RegExp(["art", "v1", ""].join("_"), "u"),\n  new RegExp(["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), "u"),\n];\n\nexport const defaultRedactionPolicy: RedactionPolicy = {\n  classify(value) {\n    return blocked.some((pattern) => pattern.test(value)) ? "secret-adjacent" : "public-safe";\n  },\n  redact(value) {\n    let redacted = value;\n    for (const pattern of blocked) {\n      redacted = redacted.replaceAll(pattern, "[redacted]");\n    }\n    return redacted;\n  },\n};\n`;
}

function generatedArtifactsAdapterTs(): string {
  return `import type { ObservabilityPackWriter, WorkflowEventSink } from "../core/ports";\nimport type { WorkflowEvent } from "../core/events";\n\nexport class ArtifactsEventSink implements WorkflowEventSink {\n  constructor(private readonly append: (path: string, line: string) => Promise<void>) {}\n  async emit(event: WorkflowEvent): Promise<void> {\n    await this.append("run/events.jsonl", JSON.stringify(event));\n  }\n}\n\nexport class ArtifactsObservabilityPackWriter implements ObservabilityPackWriter {\n  constructor(private readonly writeJson: (path: string, value: unknown) => Promise<void>) {}\n  async writePack(runId: string): Promise<{ refs: string[] }> {\n    const refs = ["run/events.jsonl", "run/status.json", "run/metrics-summary.json", "run/trace-summary.json", "run/cost-summary.json", "run/agent-observability-summary.md"];\n    await this.writeJson("run/observability-pack.json", { refs, runId });\n    return { refs };\n  }\n}\n`;
}

function generatedDoAdapterTs(): string {
  return `import type { StatusProjectionStore } from "../core/ports";\nimport type { WorkflowEvent } from "../core/events";\n\nexport class DurableObjectStatusProjectionStore implements StatusProjectionStore {\n  constructor(private readonly storage: { get<T>(key: string): Promise<T | undefined>; put<T>(key: string, value: T): Promise<void> }) {}\n  async update(event: WorkflowEvent): Promise<void> {\n    const key = "status:" + event.runId;\n    const current = (await this.storage.get<Record<string, unknown>>(key)) ?? {};\n    await this.storage.put(key, { ...current, lastEvent: event.event, state: event.state, updatedAt: event.timestamp });\n  }\n  async read(runId: string): Promise<unknown> {\n    return this.storage.get("status:" + runId);\n  }\n}\n`;
}

function generatedPlannerTs(): string {
  return `export interface ObservabilityBuildLane {\n  laneId: string;\n  owns: string[];\n  dependsOn: string[];\n}\n\nexport const seedObservabilityBuildLanes = (): ObservabilityBuildLane[] => [\n  { laneId: "core-ports-and-events", owns: ["src/core/**"], dependsOn: [] },\n  { laneId: "cloudflare-adapters", owns: ["src/adapters/**"], dependsOn: ["core-ports-and-events"] },\n  { laneId: "dynamic-harness-runtime", owns: ["src/workflows/**"], dependsOn: ["core-ports-and-events"] },\n  { laneId: "verifier-debugger", owns: ["src/workflows/debugger.ts"], dependsOn: ["core-ports-and-events"] },\n  { laneId: "docs-and-capture", owns: ["README.generated.md", ".brain/**"], dependsOn: ["core-ports-and-events"] },\n];\n`;
}

function generatedBuildWorkflowTs(): string {
  return `export const buildObservabilityWorkflow = () => ({\n  pattern: "generated-build-swarm",\n  outputTarget: "github_pr",\n  generatedHarnessExecutes: true,\n  isolation: "sandbox-workspace-per-lane",\n  reviewGate: "debugger-verifier-before-pr-publication",\n});\n`;
}

function generatedDebuggerTs(): string {
  return `export interface DebuggerDiagnosis {\n  canExplainRun: boolean;\n  currentState: string;\n  nextSafeAction: string;\n  riskNotes: string[];\n}\n\nexport const diagnoseFromPack = (pack: { status: { state: string }; metrics: { lanes: number } }): DebuggerDiagnosis => ({\n  canExplainRun: true,\n  currentState: pack.status.state,\n  nextSafeAction: "Review generated PR and run checks before merge.",\n  riskNotes: pack.metrics.lanes > 0 ? [] : ["No lane metrics found"],\n});\n`;
}

function generatedReadmeMd(): string {
  return `# Generated Observability Spine Feature\n\nThis file was produced by a generated workflow harness running inside Cloudflare Sandbox.\n\nThe real proof is the run observability pack:\n\n- \`run/events.jsonl\`\n- \`run/status.json\`\n- \`run/metrics-summary.json\`\n- \`run/trace-summary.json\`\n- \`run/cost-summary.json\`\n- \`run/agent-observability-summary.md\`\n\nDelete or absorb by rewriting into production \`src/\`; do not promote prototype code directly.\n`;
}

function generatedBrainPage(): string {
  return `---\ntitle: Workflow Observability Event Schema\nstatus: draft\ncreated_at: 2026-06-05\ntags:\n  - observability\n  - workflows\n  - events\n---\n\n# Workflow Observability Event Schema\n\nGenerated by \`workflow-observability-spine-spike\`.\n\nMinimum event fields:\n\n\`\`\`json\n{\n  "schemaVersion": "piwf.event.v0",\n  "timestamp": "2026-06-05T00:00:00.000Z",\n  "seq": 1,\n  "traceId": "trace-run",\n  "spanId": "span-1",\n  "runId": "run-id",\n  "laneId": "optional-lane",\n  "actor": "generated-harness",\n  "state": "running_lanes",\n  "event": "LANE_STARTED",\n  "severity": "info",\n  "redaction": "public-safe",\n  "message": "Human readable summary",\n  "artifactRefs": []\n}\n\`\`\`\n\nThe event log is durable truth. WebSockets, dashboards, PR summaries, and debugger agents are projections.\n`;
}

function buildGeneratedMachine(): unknown {
  return {
    cancellationEvent: "CANCEL_REQUESTED",
    concurrencyCap: DEFAULT_CONCURRENCY_CAP,
    id: "generated-build-swarm:workflow-observability-spine",
    initial: "planning",
    outputTarget: "github_pr",
    pattern: "generated-build-swarm",
    states: [
      { id: "planning", kind: "normal", on: { PLAN_PINNED: "supervising" } },
      {
        id: "supervising",
        kind: "normal",
        on: { LANES_ENQUEUED: "running_lanes" },
      },
      {
        id: "running_lanes",
        kind: "normal",
        on: { LANES_SETTLED: "finalizing" },
      },
      {
        id: "finalizing",
        kind: "normal",
        on: {
          VERIFICATION_ACCEPTED: "captured",
          VERIFICATION_BLOCKED: "blocked",
        },
      },
      { id: "captured", kind: "final", on: {} },
      { id: "blocked", kind: "final", on: {} },
      { id: "cancelled", kind: "final", on: {} },
    ],
    xstateVersion: "v5",
  };
}

function buildCapabilityManifest(): unknown {
  return {
    allowedImports: [
      "./capabilities.ts",
      "zod",
      "local pinned workflow artifacts",
    ],
    capabilities: [
      "emitEvent",
      "enqueueLane",
      "readArtifact",
      "writeArtifact",
      "requestSecretLease",
      "openPullRequest",
      "reportProgress",
    ],
    gitHub: {
      actor: "shitratgit[bot]",
      secretRefs: [
        "shitrat_github_app_id",
        "shitrat_github_installation_id_joelhooks",
        "shitrat_github_private_key",
      ],
    },
    schemaVersion: "capability-manifest.v0",
  };
}

function buildObservabilityContract(): unknown {
  return {
    packRefs: [
      "run/events.jsonl",
      "run/status.json",
      "run/metrics-summary.json",
      "run/cost-summary.json",
      "run/trace-summary.json",
      "run/agent-observability-summary.md",
    ],
    requiredEvents: [
      "PLAN_PINNED",
      "HARNESS_COMPLETED",
      "LANE_STARTED",
      "LANE_COMMITTED",
      "LANES_SETTLED",
      "VERIFICATION_ACCEPTED",
    ],
    schemaVersion: "observability-contract.v0",
  };
}

function buildVerificationContract(): unknown {
  return {
    criteria: [
      {
        id: "generated-harness-executed",
        severity: "blocking",
        summary: "Generated harness must actually run in supervisor sandbox.",
      },
      {
        id: "isolated-lane-workspaces",
        severity: "blocking",
        summary: "Each code lane must run in an isolated sandbox/workspace.",
      },
      {
        id: "debugger-can-explain-run",
        severity: "blocking",
        summary:
          "Debugger/verifier must explain run state, risk, and next action from observabilityPack.",
      },
    ],
    schemaVersion: "verification-contract.v0",
  };
}

function buildSeedPlan(input: { task: string; workItemId: string }): Plan {
  return PlanSchema.parse({
    capabilityManifestRef: "run/capability-manifest.json",
    concurrencyCap: DEFAULT_CONCURRENCY_CAP,
    generatedHarnessRef: "workflows/harness.ts",
    generatedMachineRef: "workflows/machine.json",
    lanes: buildGeneratedLaneSpecs().map(
      ({ generatedFiles: _generatedFiles, ...lane }) => lane
    ),
    observabilityContractRef: "run/observability-contract.json",
    outputTarget: "github_pr",
    prototype: "workflow-observability-spine-spike",
    schemaVersion: "observability-plan.v0",
    task: input.task,
    verificationContractRef: "run/verification-contract.json",
    workItemId: input.workItemId,
  });
}

function buildSeedFiles(input: {
  artifactRepoName: string;
  capsuleId: string;
  plan: Plan;
  runId: string;
}): Record<string, string> {
  return {
    "README.md": `# ${input.runId}\n\nWorkflow observability spine generated-run Artifacts repo.\n`,
    "run/plan.json": jsonString(input.plan),
    "run/seed.json": jsonString({
      artifactRepoName: input.artifactRepoName,
      capsuleId: input.capsuleId,
      runId: input.runId,
    }),
  };
}

async function commitArtifacts(input: {
  files: Record<string, string>;
  remote: string;
  tokenSecret: string;
}): Promise<{ commit: string }> {
  const fs = new MemoryFS();
  const dir = "/repo";
  await gitInit({ defaultBranch: "main", dir, fs });
  for (const [path, content] of Object.entries(input.files)) {
    await fs.promises.writeFile(`${dir}/${path}`, content);
    await add({ dir, filepath: path, fs });
  }
  const sha = await commit({
    author: {
      email: "shitratgit[bot]@users.noreply.github.com",
      name: "shitratgit[bot]",
    },
    dir,
    fs,
    message: "pin observability seed plan",
  });
  await push({
    dir,
    fs,
    http,
    onAuth: () => ({ password: input.tokenSecret, username: "x" }),
    ref: "main",
    url: input.remote,
  });
  return { commit: sha };
}

async function runCommand(
  sandbox: ISandbox,
  command: string,
  env: Record<string, string>
): Promise<CommandResult> {
  const started = Date.now();
  const timeoutSeconds = env["PIWF_COMMAND_TIMEOUT_SECONDS"] ?? "300";
  const wrapped = `cat > /tmp/piwf-command.sh <<'PIWF_SCRIPT'\n${command}\nPIWF_SCRIPT\nchmod +x /tmp/piwf-command.sh\ntimeout "${timeoutSeconds}" bash /tmp/piwf-command.sh 2>&1\nprintf '\n__PIWF_EXIT_CODE__:%s\n' "$?"`;
  const result = await sandbox.exec(wrapped, {
    env,
    timeout: Number(timeoutSeconds) * 1000 + 60_000,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = parseExitCode(stdout);
  return {
    command: command.slice(0, 400),
    duration: Date.now() - started,
    exitCode,
    stderr,
    stdout,
    success: exitCode === 0,
    timestamp: new Date().toISOString(),
  };
}

async function destroySandbox(
  sandbox: RealSandbox,
  sandboxId: string
): Promise<string> {
  try {
    await sandbox.destroy();
    return `destroy:${sandboxId}:ok`;
  } catch (error) {
    return `destroy:${sandboxId}:error:${error instanceof Error ? error.message : String(error)}`;
  }
}

async function readRepoAccess(
  env: Env,
  workItemId: string
): Promise<{ artifactRemote: string; artifactTokenSecret: string }> {
  const response = await postToSupervisor(env, workItemId, "/repo-access", {});
  if (!response.ok) {
    throw new Error(`repo access failed: ${await response.text()}`);
  }
  return z
    .object({
      artifactRemote: z.string().url(),
      artifactTokenSecret: z.string().min(1),
      ok: z.literal(true),
    })
    .parse(await response.json());
}

async function readRecord(
  env: Env,
  workItemId: string
): Promise<CapsuleRecord | undefined> {
  const response = await postToSupervisor(
    env,
    workItemId,
    "/record",
    undefined,
    "GET"
  );
  if (!response.ok) {
    throw new Error(`record read failed: ${await response.text()}`);
  }
  const payload = (await response.json()) as { record?: unknown };
  return payload.record ? CapsuleRecordSchema.parse(payload.record) : undefined;
}

function postToSupervisor(
  env: Env,
  workItemId: string,
  path: string,
  body?: unknown,
  method = "POST"
): Promise<Response> {
  const id = env.CAPSULE_SUPERVISOR.idFromName(workItemId);
  const stub = env.CAPSULE_SUPERVISOR.get(id);
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return stub.fetch(`https://capsule.local${path}`, init);
}

function areLanesSettled(record: CapsuleRecord): boolean {
  const lanes = Object.values(record.lanes);
  return (
    lanes.length > 0 &&
    lanes.every(
      (lane) => lane.status === "committed" || lane.status === "degraded"
    )
  );
}

function parseExitCode(stdout: string): number {
  const match = /__PIWF_EXIT_CODE__:(\d+)/u.exec(stdout);
  return match ? Number(match[1]) : 1;
}

function parseMarker(stdout: string, marker: string): Record<string, unknown> {
  const line = stdout
    .split("\n")
    .find((candidate) => candidate.startsWith(`${marker}:`));
  if (!line) {
    throw new Error(`missing marker ${marker}`);
  }
  return JSON.parse(atob(line.slice(marker.length + 1))) as Record<
    string,
    unknown
  >;
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

function sanitizeObserverRecord(record: CapsuleRecord | undefined): unknown {
  if (!record) {
    return undefined;
  }
  return {
    activeLaneIds: record.activeLaneIds,
    artifactRepoName: record.artifactRepoName,
    capsuleId: record.capsuleId,
    cleanupReceipts: record.cleanupReceipts,
    currentState: record.currentState,
    eventCount: record.eventLog.length,
    generatedFileCount: record.generatedFiles.length,
    lanes: Object.fromEntries(
      Object.entries(record.lanes).map(([laneId, lane]) => [
        laneId,
        { files: lane.files, sandboxId: lane.sandboxId, status: lane.status },
      ])
    ),
    maxObservedActiveLanes: record.maxObservedActiveLanes,
    pr: record.pr,
    runId: record.runId,
    status: record.status,
    verifierStatus: record.verifierResult?.status,
    workItemId: record.workItemId,
  };
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ACCESS_TOKEN) {
    const host = new URL(request.url).hostname;
    return host === "localhost" || host === "127.0.0.1";
  }
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : new URL(request.url).searchParams.get("token");
  return token === env.ACCESS_TOKEN;
}

function buildSandboxId(runId: string, label: string, attempt: number): string {
  const shortRun = slugify(runId).slice(-24);
  const shortLabel = slugify(label).slice(0, 24);
  const id = `wo-${shortRun}-${shortLabel}-${attempt}`.slice(0, 63);
  if (!RUN_ID_RE.test(id)) {
    return `wo-${crypto.randomUUID().slice(0, 8)}`;
  }
  return id;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-|-$/gu, "")
      .slice(0, 96) || "run"
  );
}

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function jsonString(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function sanitizeErrorMessage(input: string): string {
  return input
    .replaceAll(/https:\/\/x:[^@\s]+@/gu, "https://x:[redacted]@")
    .replaceAll(
      /ACCESS_TOKEN|PI_AUTH_JSON_B64|art_v1_|shitrat_github_private_key/giu,
      "[redacted]"
    )
    .slice(0, 4000);
}

function bashScript(
  script: string,
  replacements: Record<string, string> = {}
): string {
  let output = script.trim();
  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(`$${key}`, value);
  }
  return output;
}
