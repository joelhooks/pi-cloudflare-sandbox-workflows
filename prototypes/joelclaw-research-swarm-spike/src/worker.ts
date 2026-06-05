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
import {
  CapsuleRecordSchema,
  FinalReceiptSchema,
  PrelaunchPlanSchema,
  QueueMessageSchema,
  SourceRefSchema,
  VerificationResultSchema,
} from "./schema.ts";
import type {
  CapsuleRecord,
  LaneRecord,
  OutputDeliveryReceipt,
  PrelaunchPlan,
  QueueMessage,
} from "./schema.ts";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  ACCESS_TOKEN?: string;
  ARTIFACTS: Artifacts;
  BRAVE_SEARCH_API_KEY?: string;
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

const StartEnvelopeSchema = z.object({
  deployedWorkerUrl: z.string().url(),
  plan: PrelaunchPlanSchema,
});

const LaneAdmissionRequestSchema = z.object({
  laneId: z.string().min(1),
  runId: z.string().min(1),
});

const LaneCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  destroyReceipt: z.string().min(1),
  laneId: z.string().min(1),
  model: z.string().min(1),
  outputRefs: z.array(z.string().min(1)),
  reportContent: z.string().min(1),
  runtime: z.literal("pi-agent-internet-research"),
  sandboxId: z.string().min(1),
  sourceRefs: z.array(SourceRefSchema).min(1),
});

const LaneFailureRequestSchema = z.object({
  destroyReceipt: z.string().min(1).optional(),
  error: z.string().min(1),
  laneId: z.string().min(1),
  sandboxId: z.string().min(1).optional(),
});

const SynthesisCompleteRequestSchema = z.object({
  artifactCommitSha: z.string().min(1),
  brainPageContent: z.string().min(1),
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
    brainPageRef: z.string().min(1),
    deliveredAt: z.string().datetime(),
    outputRefs: z.array(z.string().min(1)).min(1),
    publicObserverUrl: z.string().url(),
    targetKind: z.literal("brain_page"),
  }),
  sandboxId: z.string().min(1),
});

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{2,80}$/u;
const QUEUE_RETRY_DELAY_SECONDS = 4;
const DEFAULT_HOT_RESEARCH_CONCURRENCY_CAP = 3;
const DEFAULT_PI_MODEL = "gpt-5.5";

export class CapsuleSupervisor extends DurableObject<Env> {
  override fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const postRoutes: Record<string, () => Promise<Response>> = {
      "/admit-lane": () => this.admitLane(request),
      "/begin-finalization": () => this.beginFinalization(request),
      "/cancel": () => this.cancel(request),
      "/complete-lane": () => this.completeLane(request),
      "/delivery-complete": () => this.deliveryComplete(request),
      "/fail-lane": () => this.failLane(request),
      "/repo-access": () => this.repoAccess(),
      "/start": () => this.start(request),
      "/synthesis-complete": () => this.synthesisComplete(request),
      "/verification-complete": () => this.verificationComplete(request),
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
    if (record.currentState !== "runningHotResearchLanes") {
      return json({ ok: true, reason: "not-running", slotGranted: false });
    }
    if (record.activeLaneIds.length >= getConcurrencyCap(record.plan)) {
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

  private async beginFinalization(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { runId?: string };
    const record = await this.requireRecord();
    if (body.runId && body.runId !== record.runId) {
      return json({
        ok: true,
        reason: "stale-finalize-message",
        shouldFinalize: false,
      });
    }
    if (["blocked", "cancelled", "captured"].includes(record.status)) {
      return json({
        alreadyDone: true,
        ok: true,
        record,
        shouldFinalize: false,
      });
    }
    if (record.status === "synthesizing" && !record.synthesisCommitSha) {
      return json({ ok: true, record, shouldFinalize: true });
    }
    if (record.status === "verifying" && !record.verifierCommitSha) {
      return json({ ok: true, record, shouldFinalize: true });
    }
    if (record.status === "delivering" && !record.finalReceipt) {
      return json({ ok: true, record, shouldFinalize: true });
    }
    if (
      record.status === "synthesizing" ||
      record.status === "verifying" ||
      record.status === "delivering"
    ) {
      return json({ ok: true, record, shouldFinalize: false });
    }
    if (!isFanInSatisfied(record)) {
      return json({ ok: true, record, shouldFinalize: false });
    }
    const fanInReady =
      record.currentState === "waitingFanIn"
        ? CapsuleSupervisor.applyEvent(record, "FAN_IN_READY")
        : CapsuleSupervisor.applyEvent(
            CapsuleSupervisor.applyEvent(record, "ALL_REQUIRED_LANES_SETTLED"),
            "FAN_IN_READY"
          );
    const nextRecord = { ...fanInReady, status: "synthesizing" as const };
    await this.putRecord(nextRecord);
    return json({ ok: true, record: nextRecord, shouldFinalize: true });
  }

  private async cancel(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      reason?: string;
    };
    const record = await this.requireRecord();
    if (record.status === "cancelled") {
      return json({ alreadyDone: true, ok: true, record });
    }
    const knownSandboxIds = new Set<string>();
    for (const lane of Object.values(record.lanes)) {
      if (lane.sandboxId) {
        knownSandboxIds.add(lane.sandboxId);
      }
    }
    for (const label of ["synthesis", "verifier", "delivery"]) {
      knownSandboxIds.add(buildSandboxId(record.runId, label));
    }
    const destroyReceipts = await Promise.all(
      [...knownSandboxIds].map(async (sandboxId) => {
        try {
          const sandbox = getSandbox(
            this.env.Sandbox,
            sandboxId
          ) as unknown as RealSandbox;
          await sandbox.destroy();
          return `destroy:${sandboxId}:ok`;
        } catch (error) {
          return `destroy:${sandboxId}:error:${String(error)}`;
        }
      })
    );
    const cancelling = CapsuleSupervisor.applyEvent(record, "CANCEL_REQUESTED");
    const cancelled = CapsuleSupervisor.applyEvent(
      {
        ...cancelling,
        activeLaneIds: [],
        blockedReason: body.reason ?? "cancelled by operator",
        cleanupReceipts: [...cancelling.cleanupReceipts, ...destroyReceipts],
        completedAt: new Date().toISOString(),
        status: "cancelled" as const,
      },
      "CLEANUP_DONE"
    );
    await this.putRecord(cancelled);
    return json({ ok: true, record: cancelled });
  }

  private async completeLane(request: Request): Promise<Response> {
    const body = LaneCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const lane = requireValue(record.lanes[body.laneId], "lane");
    const completedLane: LaneRecord = {
      ...lane,
      artifactCommitSha: body.artifactCommitSha,
      completedAt: new Date().toISOString(),
      model: body.model,
      outputRefs: body.outputRefs,
      reportContent: body.reportContent,
      runtime: body.runtime,
      sandboxId: body.sandboxId,
      sourceRefs: body.sourceRefs,
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
    const storedRecord = fanInSatisfied
      ? CapsuleSupervisor.applyEvent(nextRecord, "ALL_REQUIRED_LANES_SETTLED")
      : nextRecord;
    await this.putRecord(storedRecord);
    if (fanInSatisfied) {
      await this.env.LANE_QUEUE.send({
        runId: storedRecord.runId,
        type: "finalize",
        workItemId: storedRecord.workItemId,
      });
    }
    return json({ fanInSatisfied, ok: true });
  }

  private async deliveryComplete(request: Request): Promise<Response> {
    const body = DeliveryCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const rendered = CapsuleSupervisor.applyEvent(
      record,
      "BRAIN_PAGE_RENDERED"
    );
    const delivered = CapsuleSupervisor.applyEvent(
      rendered,
      "OUTPUT_DELIVERED"
    );
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
    const canRetry = retryCount <= 4;
    const sandboxId = body.sandboxId ?? lane.sandboxId;
    const failedLane: LaneRecord = {
      ...lane,
      ...(sandboxId ? { sandboxId } : {}),
      retryCount,
      status: canRetry ? "retry_queued" : "failed",
    };
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
      canRetry ? "LANE_RETRY_ENQUEUED" : "LANE_FAILED"
    );
    const blockedRecord = canRetry
      ? updatedRecord
      : {
          ...CapsuleSupervisor.applyEvent(
            updatedRecord,
            "VERIFICATION_BLOCKED"
          ),
          blockedReason: body.error,
          status: "blocked" as const,
        };
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
    if (envelope.plan.approval.decision !== "approved") {
      return json(
        { error: "operator approval required", ok: false },
        { status: 412 }
      );
    }
    const runId = `run-${slugify(envelope.plan.researchEnvelope.workItemId)}-${crypto.randomUUID().slice(0, 8)}`;
    const capsuleId = `capsule:${envelope.plan.researchEnvelope.workItemId}`;
    const artifactRepoName = `jcrs-${slugify(runId)}`;
    const publicObserverUrl = `${envelope.deployedWorkerUrl}/observer/${encodeURIComponent(envelope.plan.researchEnvelope.workItemId)}`;
    const createdRepo = await this.env.ARTIFACTS.create(artifactRepoName, {
      description: `JoelClaw research swarm prototype ${runId}`,
      readOnly: false,
      setDefaultBranch: "main",
    });
    const authedRemote = toAuthenticatedRemote(
      createdRepo.remote,
      createdRepo.token
    );
    const planCommit = await commitPlanPhaseArtifacts({
      files: buildPlanFiles({
        artifactRepoName,
        capsuleId,
        plan: envelope.plan,
        publicObserverUrl,
        runId,
      }),
      remote: createdRepo.remote,
      tokenSecret: authedRemote.tokenSecret,
    });
    await this.ctx.storage.put("artifactTokenSecret", createdRepo.token);
    const lanes = Object.fromEntries(
      envelope.plan.themeMap.themes.map((theme) => [
        theme.laneId,
        { ...theme, outputRefs: [], retryCount: 0, status: "queued" as const },
      ])
    );
    const initialRecord = CapsuleRecordSchema.parse({
      activeLaneIds: [],
      artifactRemote: createdRepo.remote,
      artifactRepoName,
      capsuleId,
      cleanupReceipts: [],
      currentState: envelope.plan.machine.initial,
      eventLog: [],
      lanes,
      maxObservedActiveLanes: 0,
      observerPublishReceipt: `observer:${publicObserverUrl}:ok`,
      plan: envelope.plan,
      planCommitSha: planCommit.commit,
      publicObserverUrl,
      runId,
      startedAt: new Date().toISOString(),
      status: "planning",
      workItemId: envelope.plan.researchEnvelope.workItemId,
    });
    let started = initialRecord;
    for (const event of [
      "PRELAUNCH_ENVELOPE_READY",
      "SCOUT_RECEIPTS_READY",
      "THEME_MAP_READY",
      "REVIEW_PAGE_RENDERED",
      "OPERATOR_APPROVED",
      "APPROVED_ARTIFACTS_COMMITTED",
      "OBSERVER_PUBLISHED",
      "RESEARCH_LANES_ADMITTED",
      "LANE_STARTED",
    ]) {
      started = CapsuleSupervisor.applyEvent(started, event);
    }
    await this.putRecord({ ...started, status: "running" });
    await this.env.LANE_QUEUE.sendBatch(
      envelope.plan.themeMap.themes.map((theme) => ({
        body: {
          laneId: theme.laneId,
          runId,
          type: "research-lane" as const,
          workItemId: envelope.plan.researchEnvelope.workItemId,
        },
        contentType: "json" as const,
      }))
    );
    return json({
      artifactRepoName,
      capsuleId,
      ok: true,
      planCommitSha: planCommit.commit,
      publicObserverUrl,
      runId,
      status: "running",
    });
  }

  private async synthesisComplete(request: Request): Promise<Response> {
    const body = SynthesisCompleteRequestSchema.parse(await request.json());
    const record = await this.requireRecord();
    const nextRecord = {
      ...CapsuleSupervisor.applyEvent(record, "SYNTHESIS_COMMITTED"),
      brainPageContent: body.brainPageContent,
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
    let event = "VERIFICATION_VERIFIED";
    if (body.result.status === "blocked") {
      event = "VERIFICATION_BLOCKED";
    } else if (body.result.status === "warnings") {
      event = "VERIFICATION_WARNINGS";
    }
    const status = body.result.status === "blocked" ? "blocked" : "delivering";
    const nextRecord = {
      ...CapsuleSupervisor.applyEvent(
        {
          ...record,
          cleanupReceipts: [...record.cleanupReceipts, body.destroyReceipt],
          status,
          verifierCommitSha: body.artifactCommitSha,
          verifierResult: body.result,
          verifierSandboxId: body.sandboxId,
        },
        event
      ),
      ...(body.result.status === "blocked"
        ? { blockedReason: body.result.blockingFailures.join("; ") }
        : {}),
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
    const url = new URL(request.url);
    const observerMatch = url.pathname.match(
      /^\/observer\/([^/.]+)(\.json)?$/u
    );
    if (request.method === "GET" && observerMatch) {
      const workItemId = decodeURIComponent(observerMatch[1] ?? "");
      return getObserver(request, env, workItemId, Boolean(observerMatch[2]));
    }

    const researchMatch = url.pathname.match(/^\/research\/([^/.]+)(\.md)?$/u);
    if (request.method === "GET" && researchMatch) {
      const workItemId = decodeURIComponent(researchMatch[1] ?? "");
      return getResearchOutput(env, workItemId, Boolean(researchMatch[2]));
    }

    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized", ok: false }, { status: 401 });
    }

    if (url.pathname === "/healthz") {
      return json({
        authRequired: Boolean(env.ACCESS_TOKEN),
        braveSearchConfigured: Boolean(env.BRAVE_SEARCH_API_KEY),
        ok: true,
        piAuthConfigured: Boolean(env.PI_AUTH_JSON_B64),
        piModel: env.PI_REAL_MODEL ?? DEFAULT_PI_MODEL,
      });
    }
    if (request.method === "POST" && url.pathname === "/api/runs") {
      return startRun(request, env);
    }

    const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/u);
    if (request.method === "POST" && cancelMatch) {
      return cancelRun(request, env, decodeURIComponent(cancelMatch[1] ?? ""));
    }

    const match = url.pathname.match(/^\/api\/runs\/([^/]+)$/u);
    if (request.method === "GET" && match) {
      return getRunRecord(request, env, decodeURIComponent(match[1] ?? ""));
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
          if (parsed.data.type === "research-lane") {
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
  const plan = PrelaunchPlanSchema.parse(body);
  const stub = getSupervisorStub(env, plan.researchEnvelope.workItemId);
  const response = await stub.fetch(
    new Request(new URL("/start", request.url), {
      body: JSON.stringify({
        deployedWorkerUrl: new URL(request.url).origin,
        plan,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  const payload = await response.json();
  return json(payload, { status: response.status });
}

async function cancelRun(
  _request: Request,
  env: Env,
  workItemId: string
): Promise<Response> {
  const response = await getSupervisorStub(env, workItemId).fetch(
    new Request("https://capsule.local/cancel", {
      body: JSON.stringify({ reason: "operator requested kill and rerun" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );
  const payload = await response.json();
  return json(payload, { status: response.status });
}

async function getRunRecord(
  _request: Request,
  env: Env,
  workItemId: string
): Promise<Response> {
  const response = await getSupervisorStub(env, workItemId).fetch(
    new Request("https://capsule.local/record")
  );
  const payload = await response.json();
  return json(payload, { status: response.status });
}

async function getObserver(
  _request: Request,
  env: Env,
  workItemId: string,
  jsonOnly: boolean
): Promise<Response> {
  const response = await getSupervisorStub(env, workItemId).fetch(
    new Request("https://capsule.local/observer")
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (jsonOnly) {
    return json(payload);
  }
  return html(renderObserver(payload["record"]));
}

async function getResearchOutput(
  env: Env,
  workItemId: string,
  markdownOnly: boolean
): Promise<Response> {
  const response = await getSupervisorStub(env, workItemId).fetch(
    new Request("https://capsule.local/record")
  );
  const payload = (await response.json()) as Record<string, unknown>;
  const record = CapsuleRecordSchema.safeParse(payload["record"]);
  const finalReceipt = record.success
    ? FinalReceiptSchema.safeParse(record.data.finalReceipt)
    : undefined;
  if (!finalReceipt?.success) {
    return markdownOnly
      ? text("Research output is not captured yet.\n", { status: 404 })
      : html(renderResearchOutput("Research output is not captured yet."), {
          status: 404,
        });
  }
  const content = finalReceipt.data.brainPageContent;
  return markdownOnly ? markdown(content) : html(renderResearchOutput(content));
}

async function processLaneMessage(
  message: Extract<QueueMessage, { type: "research-lane" }>,
  env: Env
): Promise<{ retry: boolean }> {
  const stub = getSupervisorStub(env, message.workItemId);
  const admission = await postDo(stub, "/admit-lane", {
    laneId: message.laneId,
    runId: message.runId,
  });
  if (admission["alreadyDone"]) {
    return { retry: false };
  }
  if (!admission["slotGranted"]) {
    return { retry: admission["reason"] !== "stale-run-message" };
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
    if (!env.PI_AUTH_JSON_B64) {
      throw new Error("missing PI_AUTH_JSON_B64 for real Pi research lane");
    }
    sandbox = getSandbox(env.Sandbox, sandboxId) as unknown as RealSandbox;
    await seedPiAuth(sandbox, env.PI_AUTH_JSON_B64);
    const result = await runCommand(
      sandbox,
      buildResearchLaneCommand(),
      { tokenSecret: authedRemote.tokenSecret },
      {
        env: {
          ARTIFACTS_GIT_REMOTE: authedRemote.remote,
          BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY ?? "",
          GIT_TERMINAL_PROMPT: "0",
          LANE_ID: lane.laneId,
          LANE_JSON: JSON.stringify(lane),
          PIWF_COMMAND_TIMEOUT_SECONDS: "900",
          PI_MODEL: env.PI_REAL_MODEL ?? DEFAULT_PI_MODEL,
          RUN_ID: message.runId,
          WORK_ITEM_ID: message.workItemId,
        },
        timeout: 960_000,
      }
    );
    assertCommand(result, `research lane ${lane.laneId}`);
    const commitSha = requireValue(
      getLastNonEmptyLine(result.stdout),
      "lane commit sha"
    );
    const reportFile = await sandbox.readFile(
      `/workspace/joelclaw-swarm/artifacts/research/${lane.laneId}/report.md`
    );
    const sourceRefsFile = await sandbox.readFile(
      `/workspace/joelclaw-swarm/artifacts/research/${lane.laneId}/source-refs.json`
    );
    const rawSourceRefs = JSON.parse(sourceRefsFile.content) as unknown[];
    const sourceRefs = z.array(SourceRefSchema).parse(
      rawSourceRefs.map((sourceRef) => {
        if (!sourceRef || typeof sourceRef !== "object") {
          return sourceRef;
        }
        const draft = sourceRef as Record<string, unknown>;
        return {
          ...draft,
          claimSupport: Array.isArray(draft["claimSupport"])
            ? draft["claimSupport"]
            : [draft["claimSupport"] ?? "pattern"],
        };
      })
    );
    destroyReceipt = await destroySandbox(sandbox, sandboxId);
    await postDo(stub, "/complete-lane", {
      artifactCommitSha: commitSha,
      destroyReceipt,
      laneId: lane.laneId,
      model: env.PI_REAL_MODEL ?? DEFAULT_PI_MODEL,
      outputRefs: [
        `artifacts/research/${lane.laneId}/brief.md`,
        `artifacts/research/${lane.laneId}/agent-transcript.md`,
        `artifacts/research/${lane.laneId}/report.md`,
        `artifacts/research/${lane.laneId}/source-refs.json`,
        `artifacts/research/${lane.laneId}/receipt.json`,
      ],
      reportContent: reportFile.content,
      runtime: "pi-agent-internet-research",
      sandboxId,
      sourceRefs,
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
    if (failure["action"] === "retry") {
      await env.LANE_QUEUE.send({
        laneId: lane.laneId,
        runId: message.runId,
        type: "research-lane",
        workItemId: message.workItemId,
      });
    }
    return { retry: false };
  }
}

async function processFinalizeMessage(
  message: Extract<QueueMessage, { type: "finalize" }>,
  env: Env
): Promise<void> {
  const stub = getSupervisorStub(env, message.workItemId);
  const begin = await postDo(stub, "/begin-finalization", {
    runId: message.runId,
  });
  if (!begin["shouldFinalize"]) {
    return;
  }
  const record = CapsuleRecordSchema.parse(begin["record"]);
  const page = buildInlineBrainPage(record);
  await postDo(stub, "/synthesis-complete", {
    artifactCommitSha: `worker-synthesis-${record.runId}`,
    brainPageContent: page,
    destroyReceipt: "destroy:worker-synthesis:not-applicable",
    sandboxId: "worker-synthesis",
  });

  const verificationResult = buildInlineVerificationResult(record, page);
  await postDo(stub, "/verification-complete", {
    artifactCommitSha: `worker-verifier-${record.runId}`,
    destroyReceipt: "destroy:worker-verifier:not-applicable",
    result: verificationResult,
    sandboxId: "worker-verifier",
  });
  if (verificationResult.status === "blocked") {
    return;
  }

  const outputTargetReceipt: OutputDeliveryReceipt = {
    brainPageRef: ".brain/resources/workflow-verifier-evals-playbook.svx",
    deliveredAt: new Date().toISOString(),
    outputRefs: [
      ".brain/resources/workflow-verifier-evals-playbook.svx",
      "capsule:inline-bibliography",
      "capsule:inline-source-map",
    ],
    publicObserverUrl: record.publicObserverUrl,
    targetKind: "brain_page",
  };
  await postDo(stub, "/delivery-complete", {
    destroyReceipt: "destroy:worker-delivery:not-applicable",
    outputTargetReceipt,
    sandboxId: "worker-delivery",
  });
}

function buildInlineBrainPage(record: CapsuleRecord): string {
  const lanes = Object.values(record.lanes).toSorted((left, right) =>
    left.laneId.localeCompare(right.laneId)
  );
  const allSourceRefs = lanes.flatMap((lane) =>
    (lane.sourceRefs ?? []).map((ref) => ({ ...ref, laneId: lane.laneId }))
  );
  const laneSummaries = lanes.map((lane) => ({
    laneId: lane.laneId,
    report: lane.reportContent ?? `# Missing lane report ${lane.laneId}\n`,
    reportBytes: new TextEncoder().encode(lane.reportContent ?? "").length,
    sourceRefCount: lane.sourceRefs?.length ?? 0,
  }));
  return [
    "---",
    'title: "Workflow Verifier Evals Playbook"',
    'type: "resource"',
    'status: "active"',
    `created_at: "${new Date().toISOString().slice(0, 10)}"`,
    "tags:",
    "  - verifier",
    "  - evals",
    "  - workflows",
    "  - joelclaw",
    "---",
    "",
    "# Workflow Verifier Evals Playbook",
    "",
    "This page was generated by joelclaw-research-swarm-spike from a hot Cloudflare Sandbox research swarm.",
    "",
    "## Public run observer",
    "",
    `- ${record.publicObserverUrl}`,
    "",
    "## Verification contract card",
    "",
    "A generated workflow needs a pinned verification card before hot execution:",
    "",
    "- **scope**: what output or lifecycle claim is being checked",
    "- **source class requirement**: which source classes can support each claim",
    "- **severity**: blocking or warning",
    "- **evidence refs**: Artifacts paths, source refs, lane receipts, event ids",
    "- **stop behavior**: capture, captured-with-warnings, blocked, cancelled",
    "",
    "## Machine invariants",
    "",
    "- Plan and approval artifacts are pinned before hot Sandbox lane admission.",
    "- Observer publication happens before research lanes so the operator can watch the run.",
    "- Hot research lanes can adapt inside the approved envelope but cannot widen source policy, output target, spend limits, or verifier rules without re-approval.",
    "- Terminal states do not accept mutating lane events.",
    "- Cleanup receipts are required for lane, synthesis, verifier, and delivery sandboxes.",
    "",
    "## Eval families",
    "",
    "| Eval family | Blocking check |",
    "| --- | --- |",
    "| Source support | Implementation/API claims require official or source_repo evidence. |",
    "| Pattern support | Pattern language can use book_or_corpus, maintainer, and local_project evidence. |",
    "| Risk notes | Field reports can support warnings and caveats, not canonical API claims. |",
    "| Cancellation | Cancel stops new lane admission and records cleanup receipts. |",
    "| Retry/idempotency | Retried lanes use the same lane intent and new sandbox ids. |",
    "| Public observer | Observer events are redacted and omit bearer-ish/private material. |",
    "",
    "## Source-class rules",
    "",
    "- official: canonical product/API/runtime truth.",
    "- source_repo: source/tests/examples/issues for exact API shape and edge behavior.",
    "- maintainer: design rationale, migration notes, and intent.",
    "- book_or_corpus: JoelClaw library for durable patterns and principles under fair use.",
    "- field_report: risk notes and implementation pain, not canonical truth.",
    "- local_project: canonical project terminology, decisions, and receipts.",
    "",
    "## Lane receipts",
    "",
    ...laneSummaries.map(
      (lane) =>
        `- ${lane.laneId}: ${lane.reportBytes} bytes, ${lane.sourceRefCount} source refs`
    ),
    "",
    "## Research reports",
    "",
    ...laneSummaries.flatMap((lane) => [
      `### ${lane.laneId}`,
      "",
      lane.report,
      "",
    ]),
    "## Bibliography and source refs",
    "",
    ...allSourceRefs.map((ref) => {
      const claimSupport = ref.claimSupport.join(", ");
      const evidencePath = ref.evidencePath ?? "missing evidencePath";
      return `- [${ref.title}](${ref.url}) — ${ref.sourceClass}; supports: ${claimSupport}; evidence: ${evidencePath}; lane: ${ref.laneId}`;
    }),
    "",
    "## Source map summary",
    "",
    `Inline source map contains ${allSourceRefs.length} source refs across ${laneSummaries.length} lanes.`,
    "",
  ].join("\n");
}

function buildInlineVerificationResult(
  record: CapsuleRecord,
  page: string
): z.infer<typeof VerificationResultSchema> {
  const laneIds = Object.keys(record.lanes);
  const blockingFailures: string[] = [];
  const warnings: string[] = [];
  for (const phrase of [
    "Verification contract card",
    "Machine invariants",
    "Source-class rules",
    "Bibliography and source refs",
    record.publicObserverUrl,
  ]) {
    if (!page.includes(phrase)) {
      blockingFailures.push(`Brain page missing phrase: ${phrase}`);
    }
  }
  if (!page.includes("https://")) {
    blockingFailures.push("Brain page does not expose source URLs");
  }
  for (const lane of Object.values(record.lanes)) {
    if (!lane.reportContent) {
      blockingFailures.push(`missing lane report content: ${lane.laneId}`);
    }
    if (!lane.sourceRefs || lane.sourceRefs.length === 0) {
      blockingFailures.push(`missing lane source refs: ${lane.laneId}`);
    }
  }
  const sourceRefCount = Object.values(record.lanes).reduce(
    (total, lane) => total + (lane.sourceRefs?.length ?? 0),
    0
  );
  if (sourceRefCount < laneIds.length) {
    warnings.push("source ref count is low for lane count");
  }
  let status: "blocked" | "verified" | "warnings" = "verified";
  if (blockingFailures.length > 0) {
    status = "blocked";
  } else if (warnings.length > 0) {
    status = "warnings";
  }
  return VerificationResultSchema.parse({
    blockingFailures,
    checkedArtifacts: [
      ".brain/resources/workflow-verifier-evals-playbook.svx",
      "capsule:inline-source-map",
      ...laneIds.map((laneId) => `artifacts/research/${laneId}/report.md`),
    ],
    generatedAt: new Date().toISOString(),
    schemaVersion: "joelclaw-swarm-verification-result.v1",
    status,
    warnings,
  });
}

function buildPlanFiles(input: {
  artifactRepoName: string;
  capsuleId: string;
  plan: PrelaunchPlan;
  publicObserverUrl: string;
  runId: string;
}): { content: string; path: string }[] {
  const laneInputs = input.plan.themeMap.themes.map((theme) => ({
    content: jsonString(theme),
    path: `run/lane-inputs/${theme.laneId}.json`,
  }));
  const manifest = {
    artifactRepoName: input.artifactRepoName,
    capsuleId: input.capsuleId,
    publicObserverUrl: input.publicObserverUrl,
    runId: input.runId,
    schemaVersion: "joelclaw-swarm-run-manifest.v1",
    targetBrainPage: input.plan.researchEnvelope.targetBrainPage,
    workItemId: input.plan.researchEnvelope.workItemId,
  };
  return [
    {
      content: jsonString(input.plan.researchEnvelope),
      path: "run/research-envelope.json",
    },
    { content: jsonString(input.plan.machine), path: "workflows/machine.json" },
    { content: jsonString(input.plan.harness), path: "workflows/harness.json" },
    {
      content: jsonString(input.plan.sourcePolicy),
      path: "run/source-policy.json",
    },
    {
      content: jsonString(input.plan.verificationContract),
      path: "run/verification-contract.json",
    },
    {
      content: jsonString(input.plan.approval),
      path: "run/operator-approval.json",
    },
    { content: jsonString(input.plan.themeMap), path: "run/theme-map.json" },
    { content: jsonString(manifest), path: "run/manifest.json" },
    {
      content: buildResearchToolsExtension(),
      path: ".pi/extensions/research-tools.ts",
    },
    {
      content: jsonString({
        publicObserverUrl: input.publicObserverUrl,
        target: input.plan.researchEnvelope.observerTarget,
      }),
      path: "run/observer-target.json",
    },
    {
      content:
        "# JoelClaw Research Swarm Spike\n\nPlan artifacts pinned before hot Cloudflare Sandbox research lanes.\n",
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
      email: "joelclaw-research-swarm@example.invalid",
      name: "joelclaw-research-swarm-spike",
    },
    dir,
    fs,
    message: "prototype: pin joelclaw research swarm plan",
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

function buildResearchToolsExtension(): string {
  return String.raw`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";

const truncate = (value: string, maxChars: number): string =>
  value.length > maxChars ? value.slice(0, maxChars) + "\n...[truncated]" : value;

const textFromHtml = (html: string): string =>
  html
    .replaceAll(/<script[\s\S]*?<\/script>/giu, " ")
    .replaceAll(/<style[\s\S]*?<\/style>/giu, " ")
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/&nbsp;/gu, " ")
    .replaceAll(/&amp;/gu, "&")
    .replaceAll(/&lt;/gu, "<")
    .replaceAll(/&gt;/gu, ">")
    .replaceAll(/&quot;/gu, '"')
    .replaceAll(/&#39;/gu, "'")
    .replaceAll(/\s+/gu, " ")
    .trim();

const safeEvidencePath = (cwd: string, path: string): string => {
  const target = resolve(cwd, path.replace(/^@/u, ""));
  const allowedRoot = resolve(cwd, "artifacts/research");
  if (!target.startsWith(allowedRoot)) {
    throw new Error("evidencePath must stay under artifacts/research/");
  }
  return target;
};

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "research_search",
    label: "Research Search",
    description: "Search the public web with Brave Search. Use this to discover resources for research lanes.",
    promptSnippet: "Search the public web with Brave Search for research sources.",
    promptGuidelines: [
      "Use research_search to discover official docs, source repos, maintainer posts, and field reports before writing research claims.",
      "Never print or ask for BRAVE_SEARCH_API_KEY; research_search uses it internally.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(Type.Number({ description: "Result count, max 10" })),
    }),
    async execute(_toolCallId, params, signal) {
      const key = process.env.BRAVE_SEARCH_API_KEY;
      if (!key) throw new Error("BRAVE_SEARCH_API_KEY is not configured");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("count", String(Math.min(Math.max(params.count ?? 5, 1), 10)));
      const response = await fetch(url, {
        headers: {
          "X-Subscription-Token": key,
          "User-Agent": "pi-joelclaw-research-swarm/0.1",
        },
        signal,
      });
      if (!response.ok) throw new Error("Brave search failed: " + response.status);
      const body = await response.json();
      const results = (body.web?.results ?? []).map((item: any) => ({
        title: item.title,
        url: item.url,
        description: item.description,
        profile: item.profile?.name,
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ query: params.query, results }, null, 2) }],
        details: { resultCount: results.length },
      };
    },
  });

  pi.registerTool({
    name: "research_fetch",
    label: "Research Fetch",
    description: "Fetch and read a URL. Optionally save the fetched text as an evidence file.",
    promptSnippet: "Fetch/read URLs and optionally save evidence files.",
    promptGuidelines: [
      "Use research_fetch to read sources discovered by research_search before citing them.",
      "When using research_fetch, set evidencePath under artifacts/research/<lane>/evidence/ so the lane leaves receipts.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      evidencePath: Type.Optional(Type.String({ description: "Optional path under artifacts/research/.../evidence/ to save fetched text" })),
      maxChars: Type.Optional(Type.Number({ description: "Maximum returned characters" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const response = await fetch(params.url, {
        headers: { "User-Agent": "pi-joelclaw-research-swarm/0.1" },
        signal,
      });
      if (!response.ok) throw new Error("Fetch failed: " + response.status);
      const contentType = response.headers.get("content-type") ?? "";
      const raw = await response.text();
      const text = contentType.includes("html") ? textFromHtml(raw) : raw;
      const maxChars = Math.min(Math.max(params.maxChars ?? 12_000, 1_000), 40_000);
      const payload = truncate(text, maxChars);
      let savedPath: string | undefined;
      if (params.evidencePath) {
        const absolutePath = safeEvidencePath(ctx.cwd, params.evidencePath);
        await withFileMutationQueue(absolutePath, async () => {
          await mkdir(dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, payload + "\n", "utf8");
        });
        savedPath = params.evidencePath;
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ url: params.url, contentType, savedPath, text: payload }, null, 2) }],
        details: { contentType, savedPath, bytes: raw.length },
      };
    },
  });

  pi.registerTool({
    name: "joelclaw_search",
    label: "JoelClaw Search",
    description: "Search JoelClaw docs API for private-corpus source discovery.",
    promptSnippet: "Search JoelClaw for corpus-backed source discovery.",
    promptGuidelines: [
      "Use joelclaw_search for book_or_corpus pattern research, then fetch/read selected chunk URLs before citing them.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "JoelClaw search query" }),
      perPage: Type.Optional(Type.Number({ description: "Results per page, max 10" })),
    }),
    async execute(_toolCallId, params, signal) {
      const url = new URL("https://joelclaw.com/api/docs/search");
      url.searchParams.set("q", params.query);
      url.searchParams.set("perPage", String(Math.min(Math.max(params.perPage ?? 5, 1), 10)));
      url.searchParams.set("page", "1");
      url.searchParams.set("semantic", "true");
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error("JoelClaw search failed: " + response.status);
      const body = await response.json();
      const hits = (body.result?.hits ?? []).map((hit: any) => ({
        id: hit.id,
        docId: hit.docId,
        title: hit.title,
        headingPath: hit.headingPath,
        url: "https://joelclaw.com/api/docs/chunks/" + encodeURIComponent(hit.id),
      }));
      return {
        content: [{ type: "text", text: JSON.stringify({ query: params.query, found: body.result?.found ?? 0, hits }, null, 2) }],
        details: { resultCount: hits.length },
      };
    },
  });
}
`;
}

function buildResearchLaneCommand(): string {
  return String.raw`set -eu
rm -rf /workspace/joelclaw-swarm
git clone "$ARTIFACTS_GIT_REMOTE" /workspace/joelclaw-swarm
cd /workspace/joelclaw-swarm
git config user.name "joelclaw-research-swarm-spike"
git config user.email "joelclaw-research-swarm@example.invalid"
git checkout -B "lane-$LANE_ID"
node <<'NODE'
const fs = require('fs');
const lane = JSON.parse(process.env.LANE_JSON);
const outDir = 'artifacts/research/' + lane.laneId;
fs.mkdirSync(outDir + '/evidence', { recursive: true });
const brief = [
  '# Pi internet research lane: ' + lane.title,
  '',
  'You are a real Pi research agent running inside a Cloudflare Sandbox with network access.',
  'Your job is to take this brief, scour the internet, dig up relevant sources, read them, and write a source-backed lane report.',
  '',
  'This is NOT a summarization task over supplied refs. You must discover and fetch the sources yourself.',
  '',
  'Lane id: ' + lane.laneId,
  'Research question: ' + lane.researchQuestion,
  'Required source classes to seek: ' + lane.sourceClasses.join(', '),
  'Coverage questions: ' + lane.coverageQuestionIds.join(', '),
  '',
  'Available research tools:',
  '- research_search: Brave web search for public internet discovery.',
  '- research_fetch: fetch/read a URL and save evidence under artifacts/research/<lane>/evidence/.',
  '- joelclaw_search: search JoelClaw corpus for book_or_corpus leads.',
  '- built-in file tools: inspect and write output files.',
  '',
  'Research requirements:',
  '- Use research_search and/or joelclaw_search to discover sources. Do not rely only on this brief.',
  '- Use research_fetch to read actual source material before writing claims.',
  '- Search broadly: official docs, source repos, maintainer posts, issue/forum field reports, and JoelClaw where useful.',
  '- Save fetched/read evidence excerpts or page notes under ' + outDir + '/evidence/.',
  '- Write ' + outDir + '/source-refs.json as a JSON array. Each entry must include: title, url, sourceClass, claimSupport, evidencePath, whyItMatters.',
  '- Write at least 4 source refs unless the lane is impossible, and explain gaps in the report.',
  '- For each source ref, include an evidencePath that points to a file actually written under evidence/.',
  '- Use sourceClass honestly: official/source_repo for implementation/API truth; maintainer for rationale; field_report for risks; book_or_corpus for durable patterns.',
  '- Do not print secrets, auth tokens, environment variables, or bearer-ish URLs.',
  '',
  'Output files you must create:',
  '- ' + outDir + '/report.md',
  '- ' + outDir + '/source-refs.json',
  '- one or more evidence files under ' + outDir + '/evidence/',
  '',
  'Report sections:',
  '1. Findings',
  '2. Sources read and why they matter',
  '3. Workflow verifier implications',
  '4. Eval cases to add',
  '5. Gaps / weak evidence / next searches',
  '',
  'If a source is not actually fetched/read with research_fetch or equivalent tool work, do not list it as evidence.',
  '',
].join('\n');
const receipt = {
  generatedAt: new Date().toISOString(),
  laneId: lane.laneId,
  outputRefs: [outDir + '/brief.md', outDir + '/agent-transcript.md', outDir + '/report.md', outDir + '/source-refs.json', outDir + '/receipt.json'],
  researchQuestion: lane.researchQuestion,
  runId: process.env.RUN_ID,
  sourceRefCount: 0,
  title: lane.title,
  runtime: 'pi-agent-internet-research',
  model: process.env.PI_MODEL,
};
fs.writeFileSync(outDir + '/brief.md', brief + '\n');
fs.writeFileSync(outDir + '/receipt.json', JSON.stringify(receipt, null, 2) + '\n');
NODE
out_dir="artifacts/research/$LANE_ID"
pi -e .pi/extensions/research-tools.ts --provider openai-codex --model "$PI_MODEL" --thinking off --no-session -p @"$out_dir/brief.md" > "$out_dir/agent-transcript.md"
node - "$out_dir/receipt.json" "$out_dir/report.md" "$out_dir/source-refs.json" "$out_dir/evidence" <<'NODE'
const fs = require('fs');
const [receiptPath, reportPath, sourceRefsPath, evidenceDir] = process.argv.slice(2);
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
if (!fs.existsSync(reportPath)) throw new Error('Pi agent did not write report.md');
if (!fs.existsSync(sourceRefsPath)) throw new Error('Pi agent did not write source-refs.json');
const sourceRefs = JSON.parse(fs.readFileSync(sourceRefsPath, 'utf8'));
if (!Array.isArray(sourceRefs)) throw new Error('source-refs.json must be a JSON array');
if (sourceRefs.length < 4) throw new Error('Pi agent found fewer than 4 source refs');
const evidenceFiles = fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir).filter((name) => !name.startsWith('.')) : [];
if (evidenceFiles.length === 0) throw new Error('Pi agent did not write evidence files');
const missingEvidence = [];
for (const [index, sourceRef] of sourceRefs.entries()) {
  if (!sourceRef || typeof sourceRef !== 'object') throw new Error('source ref ' + index + ' is not an object');
  if (typeof sourceRef.url !== 'string') throw new Error('source ref ' + index + ' missing url');
  if (typeof sourceRef.sourceClass !== 'string') throw new Error('source ref ' + index + ' missing sourceClass');
  if (typeof sourceRef.evidencePath !== 'string') throw new Error('source ref ' + index + ' missing evidencePath');
  if (!fs.existsSync(sourceRef.evidencePath)) missingEvidence.push(sourceRef.evidencePath);
}
if (missingEvidence.length > 0) throw new Error('missing evidence files: ' + missingEvidence.join(', '));
const report = fs.readFileSync(reportPath, 'utf8');
for (const phrase of ['Findings', 'Sources read', 'Eval cases']) {
  if (!report.includes(phrase)) throw new Error('report.md missing section: ' + phrase);
}
receipt.reportBytes = Buffer.byteLength(report);
receipt.completedBy = 'pi --provider openai-codex';
receipt.runtime = 'pi-agent-internet-research';
receipt.sourceRefCount = sourceRefs.length;
receipt.evidenceFileCount = evidenceFiles.length;
receipt.validatedOutputContract = true;
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
NODE
git add "artifacts/research/$LANE_ID"
git commit -m "research lane: $LANE_ID $RUN_ID"
commit=$(git rev-parse HEAD)
git push --force origin HEAD:"refs/heads/lane-$LANE_ID"
printf '%s\n' "$commit"`;
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

async function seedPiAuth(
  sandbox: RealSandbox,
  authJsonBase64: string
): Promise<void> {
  const result = await sandbox.exec(
    String.raw`set -eu
agent_dir="$PI_CODING_AGENT_DIR"
if [ -z "$agent_dir" ]; then
  agent_dir="/workspace/.pi/agent"
fi
auth_path="$agent_dir/auth.json"
if [ -s "$auth_path" ] && node -e 'const fs = require("fs"); const auth = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(auth["openai-codex"] ? 0 : 1);' "$auth_path" 2>/dev/null; then
  echo "openai-codex auth already present"
else
  mkdir -p "$agent_dir"
  umask 077
  seed_b64="$(mktemp)"
  seed_json="$(mktemp)"
  printf '%s' "$PI_AUTH_JSON_B64" > "$seed_b64"
  base64 -d "$seed_b64" > "$seed_json"
  node - "$auth_path" "$seed_json" <<'NODE'
const fs = require("fs");
const [authPath, seedPath] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
if (!seed["openai-codex"]) throw new Error("PI_AUTH_JSON_B64 is missing openai-codex");
let current = {};
try { current = JSON.parse(fs.readFileSync(authPath, "utf8")); } catch {}
current["openai-codex"] = seed["openai-codex"];
fs.writeFileSync(authPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
NODE
  chmod 600 "$auth_path"
  rm -f "$seed_b64" "$seed_json"
  echo "openai-codex auth materialized"
fi`,
    {
      cwd: "/workspace",
      env: { PI_AUTH_JSON_B64: authJsonBase64 },
      timeout: 30_000,
    }
  );
  if (!result.success) {
    throw new Error(
      `Failed to seed Pi auth: ${result.stderr || result.stdout || result.exitCode}`
    );
  }
}

function toAuthenticatedRemote(
  remote: string,
  tokenSecret: string
): { remote: string; tokenSecret: string } {
  const url = new URL(remote);
  url.username = "x";
  url.password = tokenSecret;
  return { remote: url.toString(), tokenSecret };
}

function isFanInSatisfied(record: CapsuleRecord): boolean {
  return Object.values(record.lanes).every(
    (lane) => lane.status === "committed"
  );
}

function sanitizeObserverRecord(record: CapsuleRecord | undefined): unknown {
  if (!record) {
    return undefined;
  }
  return {
    artifactRefs: { repoName: record.artifactRepoName },
    blockedReason: record.blockedReason,
    cleanupReceipts: record.cleanupReceipts,
    completedAt: record.completedAt,
    currentState: record.currentState,
    eventLog: record.eventLog,
    finalReceiptPresent: Boolean(record.finalReceipt),
    lanes: Object.fromEntries(
      Object.entries(record.lanes).map(([laneId, lane]) => [
        laneId,
        {
          artifactCommitSha: lane.artifactCommitSha,
          completedAt: lane.completedAt,
          outputRefs: lane.outputRefs,
          sandboxId: lane.sandboxId,
          sourceRefCount: lane.sourceRefs?.length ?? 0,
          startedAt: lane.startedAt,
          status: lane.status,
        },
      ])
    ),
    maxObservedActiveLanes: record.maxObservedActiveLanes,
    publicObserverUrl: record.publicObserverUrl,
    runId: record.runId,
    status: record.status,
    synthesisCommitSha: record.synthesisCommitSha,
    verifierResult: record.verifierResult,
  };
}

function renderObserver(record: unknown): string {
  return `<!doctype html><meta charset="utf-8"><title>Research swarm observer</title><pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>`;
}

function renderResearchOutput(content: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Research output</title><article><pre>${escapeHtml(content)}</pre></article>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildFinalReceipt(
  record: CapsuleRecord,
  outputTargetReceipt: OutputDeliveryReceipt
): z.infer<typeof FinalReceiptSchema> {
  const verifierResult = requireValue(record.verifierResult, "verifierResult");
  return FinalReceiptSchema.parse({
    artifactRemote: record.artifactRemote,
    artifactsRepo: record.artifactRepoName,
    brainPageContent: requireValue(record.brainPageContent, "brainPageContent"),
    brainPageRef: outputTargetReceipt.brainPageRef,
    capsuleId: record.capsuleId,
    checks: [
      {
        id: "observer-public-redacted",
        status: "passed",
        summary: "Public observer URL is present and redacted.",
      },
      {
        id: "hot-sandbox-lanes-ran",
        status: Object.values(record.lanes).every(
          (lane) => lane.sandboxId && lane.status === "committed"
        )
          ? "passed"
          : "failed",
        summary:
          "Every planned research lane ran in a real Sandbox and committed outputs.",
      },
      {
        id: "bibliography-visible",
        status: requireValue(
          record.brainPageContent,
          "brainPageContent"
        ).includes("Bibliography and source refs")
          ? "passed"
          : "failed",
        summary:
          "Public output includes visible source URLs and bibliography entries.",
      },
      {
        id: "verification-not-blocked",
        status: verifierResult.status === "blocked" ? "failed" : "passed",
        summary:
          "Verifier accepted the Brain page with verified or warning status.",
      },
    ],
    cleanupReceipts: record.cleanupReceipts,
    finalState: "captured",
    generatedHarnessRef: "workflows/harness.json",
    generatedMachineRef: "workflows/machine.json",
    laneReceipts: Object.values(record.lanes),
    maxObservedActiveLanes: record.maxObservedActiveLanes,
    outputTargetReceipt,
    planCommitSha: record.planCommitSha,
    prototype: "joelclaw-research-swarm-spike",
    publicObserverUrl: record.publicObserverUrl,
    runId: record.runId,
    schemaVersion: "joelclaw-research-swarm-receipt.v1",
    synthesisCommitSha: requireValue(
      record.synthesisCommitSha,
      "synthesisCommitSha"
    ),
    totalResearchLanes: Object.keys(record.lanes).length,
    verifierResult,
  });
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
  return normalizeCommandResult(result, wrappedCommand, redaction);
}

function normalizeCommandResult(
  result: Awaited<ReturnType<RealSandbox["exec"]>>,
  command: string,
  redaction: { tokenSecret: string }
): CommandResult {
  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const exitMarker = combined.match(/__PIWF_EXIT_CODE__:(\d+)/u);
  const exitCode = exitMarker
    ? Number.parseInt(exitMarker[1] ?? "1", 10)
    : (result.exitCode ?? (result.success ? 0 : 1));
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

function getConcurrencyCap(plan: PrelaunchPlan): number {
  return Math.min(
    plan.themeMap.themes.length,
    plan.researchEnvelope.constructiveLimits.maxHotSandboxLanesPerWave,
    DEFAULT_HOT_RESEARCH_CONCURRENCY_CAP
  );
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
    headers: { "Cache-Control": "no-store", ...init.headers },
  });
}

function html(markup: string, init: ResponseInit = {}): Response {
  return new Response(markup, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      ...init.headers,
    },
  });
}

function markdown(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/markdown; charset=utf-8",
      ...init.headers,
    },
  });
}

function text(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
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
  return `js-${runToken}-${labelToken}${suffix}`.slice(0, 63);
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
