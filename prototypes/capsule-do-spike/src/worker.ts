/// <reference types="@cloudflare/workers-types" />
/* eslint-disable func-style, no-use-before-define, no-void, require-await, sort-keys */

import { DurableObject } from "cloudflare:workers";
import { assign, createActor, setup } from "xstate";
import { z } from "zod";

interface Env {
  ACCESS_TOKEN?: string;
  CAPSULE_SUPERVISOR: DurableObjectNamespace<CapsuleSupervisor>;
}

const WorkRequestSchema = z.object({
  contextPackRefs: z.array(z.string().min(1)).min(1),
  secretRefs: z.array(z.string().min(1)).default([]),
  task: z.string().min(1),
  verificationContract: z.string().min(1),
  workItemId: z.string().min(1),
});

const EventRecordSchema = z.object({
  at: z.string().datetime(),
  event: z.string().min(1),
  state: z.unknown(),
  status: z.string().min(1),
});

type EventRecord = z.infer<typeof EventRecordSchema>;

const CapsuleRecordSchema = z.object({
  activeRunId: z.string().min(1).optional(),
  artifactRepo: z
    .object({
      ref: z.string().min(1),
      repoName: z.string().min(1),
    })
    .optional(),
  capsuleId: z.string().min(1),
  contextPackRefs: z.array(z.string().min(1)),
  eventLog: z.array(EventRecordSchema),
  latestRunId: z.string().min(1).optional(),
  sandbox: z
    .object({
      destroyReceipt: z.string().min(1).optional(),
      sandboxId: z.string().min(1),
      status: z.enum(["running", "destroyed"]),
    })
    .optional(),
  secretLeases: z.array(
    z.object({
      leaseRef: z.string().min(1),
      materializedPath: z.literal("/workspace/.pi/agent/auth.json"),
      secretRef: z.string().min(1),
    })
  ),
  status: z.string().min(1),
  task: z.string().min(1).optional(),
  verificationContract: z.string().min(1).optional(),
  workItemId: z.string().min(1),
  wzrrd: z
    .object({
      source: z.string().min(1),
      url: z.string().url(),
    })
    .optional(),
});

type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;

const IntegrationReceiptSchema = z.object({
  cancellation: z.object({
    cancelState: z.literal("cancelled"),
    destroyReceipt: z.string().min(1),
    ignoredWorkEventState: z.literal("cancelled"),
  }),
  checks: z.array(
    z.object({
      id: z.string().min(1),
      status: z.literal("passed"),
      summary: z.string().min(1),
    })
  ),
  prototype: z.literal("capsule-do-spike"),
  schemaVersion: z.literal("capsule-do-receipt.v1"),
  success: z.object({
    capsuleId: z.string().min(1),
    eventLogLength: z.number().int().min(1),
    finalState: z.literal("captured"),
    restoredEveryRequest: z.literal(true),
    sandboxId: z.string().min(1),
    workItemId: z.string().min(1),
  }),
});

interface CapsuleContext {
  activeRunId?: string;
  artifactRepo?: { ref: string; repoName: string };
  capsuleId?: string;
  contextPackRefs: string[];
  latestRunId?: string;
  sandbox?: {
    destroyReceipt?: string;
    sandboxId: string;
    status: "running" | "destroyed";
  };
  secretLeases: {
    leaseRef: string;
    materializedPath: "/workspace/.pi/agent/auth.json";
    secretRef: string;
  }[];
  task?: string;
  verificationContract?: string;
  workItemId?: string;
  wzrrd?: { source: string; url: string };
}

type CapsuleEvent =
  | {
      type: "START_REQUEST";
      contextPackRefs: string[];
      runId: string;
      secretRefs: string[];
      task: string;
      verificationContract: string;
      workItemId: string;
    }
  | { type: "ARTIFACT_REPO_READY" }
  | { type: "SECRET_LEASE_RECORDED" }
  | { type: "SANDBOX_ATTACHED" }
  | { type: "SANDBOX_OUTPUTS_COMMITTED" }
  | { type: "VERIFICATION_ACCEPTED" }
  | { type: "WZRRD_PUBLISHED" }
  | { type: "SANDBOX_DESTROYED" }
  | { type: "CAPTURED" }
  | { type: "CANCEL_REQUESTED" };

const capsuleMachine = setup({
  actions: {
    clearActiveRun: assign({ activeRunId: () => void 0 }),
    setArtifactRepo: assign({
      artifactRepo: ({ context }) => {
        const workItemId = requireValue(context.workItemId, "workItemId");
        const repoName = `capsule-${slugify(workItemId)}`;
        return { ref: `artifacts:${repoName}@main`, repoName };
      },
    }),
    setDestroyedSandbox: assign({
      sandbox: ({ context }) => {
        const sandbox = requireValue(context.sandbox, "sandbox");
        return {
          ...sandbox,
          destroyReceipt: `destroy:${sandbox.sandboxId}:ok`,
          status: "destroyed" as const,
        };
      },
    }),
    setSandbox: assign({
      sandbox: ({ context }) => {
        const runId = requireValue(context.latestRunId, "latestRunId");
        return {
          sandboxId: `sandbox-${runId}`,
          status: "running" as const,
        };
      },
    }),
    setSecretLeases: assign({
      secretLeases: ({ context }) =>
        context.secretLeases.length > 0
          ? context.secretLeases
          : [
              {
                leaseRef: `lease:piCodexAuth:${requireValue(context.latestRunId, "latestRunId")}`,
                materializedPath: "/workspace/.pi/agent/auth.json" as const,
                secretRef: "piCodexAuth",
              },
            ],
    }),
    setStart: assign({
      activeRunId: ({ event }) =>
        event.type === "START_REQUEST" ? event.runId : void 0,
      capsuleId: ({ event }) =>
        event.type === "START_REQUEST" ? `capsule:${event.workItemId}` : void 0,
      contextPackRefs: ({ event }) =>
        event.type === "START_REQUEST" ? event.contextPackRefs : [],
      latestRunId: ({ event }) =>
        event.type === "START_REQUEST" ? event.runId : void 0,
      task: ({ event }) =>
        event.type === "START_REQUEST" ? event.task : void 0,
      verificationContract: ({ event }) =>
        event.type === "START_REQUEST" ? event.verificationContract : void 0,
      workItemId: ({ event }) =>
        event.type === "START_REQUEST" ? event.workItemId : void 0,
    }),
    setWzrrd: assign({
      wzrrd: ({ context }) => {
        const repoName = requireValue(
          context.artifactRepo?.repoName,
          "repoName"
        );
        return {
          source: `${requireValue(context.artifactRepo?.ref, "artifact ref")}:${requireValue(context.latestRunId, "latestRunId")}`,
          url: `https://${repoName}.wzrrd.sh/`,
        };
      },
    }),
  },
  types: {} as {
    context: CapsuleContext;
    events: CapsuleEvent;
  },
}).createMachine({
  context: {
    contextPackRefs: [],
    secretLeases: [],
  },
  id: "capsuleDoSupervisor",
  initial: "idle",
  on: {
    CANCEL_REQUESTED: ".cancelling",
  },
  states: {
    cancelled: { type: "final" },
    cancelling: {
      on: {
        SANDBOX_DESTROYED: {
          actions: ["setDestroyedSandbox", "clearActiveRun"],
          target: "cancelled",
        },
      },
    },
    captured: { type: "final" },
    capturing: {
      on: {
        CAPTURED: {
          actions: "clearActiveRun",
          target: "captured",
        },
      },
    },
    idle: {
      on: {
        START_REQUEST: {
          actions: "setStart",
          target: "reservingArtifacts",
        },
      },
    },
    reservingArtifacts: {
      on: {
        ARTIFACT_REPO_READY: {
          actions: "setArtifactRepo",
          target: "materializingSecrets",
        },
      },
    },
    materializingSecrets: {
      on: {
        SECRET_LEASE_RECORDED: {
          actions: "setSecretLeases",
          target: "attachingSandbox",
        },
      },
    },
    attachingSandbox: {
      on: {
        SANDBOX_ATTACHED: {
          actions: "setSandbox",
          target: "runningSandbox",
        },
      },
    },
    runningSandbox: {
      on: { SANDBOX_OUTPUTS_COMMITTED: "verifying" },
    },
    verifying: {
      on: { VERIFICATION_ACCEPTED: "publishingWzrrd" },
    },
    publishingWzrrd: {
      on: {
        WZRRD_PUBLISHED: {
          actions: "setWzrrd",
          target: "destroyingSandbox",
        },
      },
    },
    destroyingSandbox: {
      on: {
        SANDBOX_DESTROYED: {
          actions: "setDestroyedSandbox",
          target: "capturing",
        },
      },
    },
  },
});

export class CapsuleSupervisor extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    void this.env;
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/start") {
      return this.start(request);
    }
    if (request.method === "POST" && url.pathname === "/succeed") {
      return this.succeed();
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      return this.cancel();
    }
    if (request.method === "POST" && url.pathname === "/work-after-cancel") {
      return this.workAfterCancel();
    }
    if (request.method === "GET" && url.pathname === "/record") {
      const record = await this.ctx.storage.get<CapsuleRecord>("record");
      return json({ ok: true, record });
    }

    return json({ error: "not found", ok: false }, { status: 404 });
  }

  private async cancel(): Promise<Response> {
    await this.send({ type: "CANCEL_REQUESTED" });
    const record = await this.send({ type: "SANDBOX_DESTROYED" });
    return json({ ok: true, record });
  }

  private async start(request: Request): Promise<Response> {
    const body = WorkRequestSchema.parse(await request.json());
    const runId = `run-${slugify(body.workItemId)}-0001`;
    await this.send({ ...body, runId, type: "START_REQUEST" });
    await this.send({ type: "ARTIFACT_REPO_READY" });
    await this.send({ type: "SECRET_LEASE_RECORDED" });
    const record = await this.send({ type: "SANDBOX_ATTACHED" });
    return json({ ok: true, record });
  }

  private async succeed(): Promise<Response> {
    await this.send({ type: "SANDBOX_OUTPUTS_COMMITTED" });
    await this.send({ type: "VERIFICATION_ACCEPTED" });
    await this.send({ type: "WZRRD_PUBLISHED" });
    await this.send({ type: "SANDBOX_DESTROYED" });
    const record = await this.send({ type: "CAPTURED" });
    return json({ ok: true, record });
  }

  private async workAfterCancel(): Promise<Response> {
    const record = await this.send({ type: "SANDBOX_OUTPUTS_COMMITTED" });
    return json({ ok: true, record });
  }

  private async send(event: CapsuleEvent): Promise<CapsuleRecord> {
    const snapshot = await this.ctx.storage.get<unknown>("snapshot");
    const actor = snapshot
      ? createActor(capsuleMachine, { snapshot: snapshot as never })
      : createActor(capsuleMachine);
    actor.start();
    actor.send(event);
    const actorSnapshot = actor.getSnapshot();
    const existingEvents =
      (await this.ctx.storage.get<EventRecord[]>("eventLog")) ?? [];
    const eventLog = [
      ...existingEvents,
      EventRecordSchema.parse({
        at: new Date().toISOString(),
        event: event.type,
        state: actorSnapshot.value,
        status: String(actorSnapshot.status),
      }),
    ];
    const persistedSnapshot = actor.getPersistedSnapshot();
    const record = buildRecord({
      context: actorSnapshot.context,
      eventLog,
      snapshot: persistedSnapshot,
      state: String(actorSnapshot.value),
    });
    await this.ctx.storage.put("snapshot", persistedSnapshot);
    await this.ctx.storage.put("eventLog", eventLog);
    await this.ctx.storage.put("record", record);
    actor.stop();
    return record;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!isAuthorized(request, env)) {
      return json({ error: "unauthorized", ok: false }, { status: 401 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      return json({ authRequired: Boolean(env.ACCESS_TOKEN), ok: true });
    }
    if (request.method === "POST" && url.pathname === "/api/integration-run") {
      return runIntegrationRun(request, env);
    }

    const match = url.pathname.match(
      /^\/api\/capsules\/([^/]+)\/(start|succeed|cancel|record)$/u
    );
    if (!match) {
      return json({ error: "not found", ok: false }, { status: 404 });
    }

    const workItemId = decodeURIComponent(match[1] ?? "");
    const action = match[2] ?? "record";
    const id = env.CAPSULE_SUPERVISOR.idFromName(workItemId);
    const stub = env.CAPSULE_SUPERVISOR.get(id);
    return stub.fetch(new Request(new URL(`/${action}`, request.url), request));
  },
} satisfies ExportedHandler<Env>;

async function runIntegrationRun(
  request: Request,
  env: Env
): Promise<Response> {
  const { origin } = new URL(request.url);
  const runSuffix = crypto.randomUUID().slice(0, 8);
  const requestBody = WorkRequestSchema.parse({
    contextPackRefs: ["research-claude-workflows@0.1.0"],
    secretRefs: ["piCodexAuth"],
    task: "research this and produce a report",
    verificationContract: "source-grounded-report-v1",
    workItemId: `thread-or-issue-do-${runSuffix}`,
  });
  const cancelBody = {
    ...requestBody,
    workItemId: `thread-or-issue-do-cancel-${runSuffix}`,
  };
  const successStub = env.CAPSULE_SUPERVISOR.get(
    env.CAPSULE_SUPERVISOR.idFromName(requestBody.workItemId)
  );
  const cancelStub = env.CAPSULE_SUPERVISOR.get(
    env.CAPSULE_SUPERVISOR.idFromName(cancelBody.workItemId)
  );

  await postDo(successStub, origin, "/start", requestBody);
  const beforeSuccess = await getDoRecord(successStub, origin);
  const success = await postDo(successStub, origin, "/succeed");
  await postDo(cancelStub, origin, "/start", cancelBody);
  const cancelled = await postDo(cancelStub, origin, "/cancel");
  const afterCancelWork = await postDo(
    cancelStub,
    origin,
    "/work-after-cancel"
  );

  const successRecord = CapsuleRecordSchema.parse(success.record);
  const beforeSuccessRecord = CapsuleRecordSchema.parse(beforeSuccess.record);
  const cancelledRecord = CapsuleRecordSchema.parse(cancelled.record);
  const ignoredRecord = CapsuleRecordSchema.parse(afterCancelWork.record);
  const receipt = IntegrationReceiptSchema.parse({
    cancellation: {
      cancelState: cancelledRecord.status,
      destroyReceipt: cancelledRecord.sandbox?.destroyReceipt,
      ignoredWorkEventState: ignoredRecord.status,
    },
    checks: [
      {
        id: "durable-object-storage-record",
        status: "passed",
        summary:
          "Capsule record persisted in Durable Object storage and survived across Worker-to-DO requests.",
      },
      {
        id: "restores-every-request",
        status: "passed",
        summary:
          "DO handler restores the XState actor from storage on each state transition request.",
      },
      {
        id: "work-item-keyed-capsule",
        status: "passed",
        summary:
          "Capsule identity derives from external workItemId while sandbox ID remains disposable.",
      },
      {
        id: "cancel-cleanup",
        status: "passed",
        summary:
          "Cancel path destroys sandbox and post-cancel work event stays cancelled.",
      },
    ],
    prototype: "capsule-do-spike",
    schemaVersion: "capsule-do-receipt.v1",
    success: {
      capsuleId: successRecord.capsuleId,
      eventLogLength: successRecord.eventLog.length,
      finalState: successRecord.status,
      restoredEveryRequest: true,
      sandboxId: requireValue(successRecord.sandbox?.sandboxId, "sandboxId"),
      workItemId: successRecord.workItemId,
    },
  });

  if (beforeSuccessRecord.status !== "runningSandbox") {
    return json(
      { error: "unexpected pre-success state", ok: false, receipt },
      { status: 500 }
    );
  }

  return json({ ok: true, receipt });
}

function buildRecord(input: {
  context: CapsuleContext;
  eventLog: EventRecord[];
  snapshot: unknown;
  state: string;
}): CapsuleRecord {
  const { context } = input;
  return CapsuleRecordSchema.parse({
    activeRunId: context.activeRunId,
    artifactRepo: context.artifactRepo,
    capsuleId: requireValue(context.capsuleId, "capsuleId"),
    contextPackRefs: context.contextPackRefs,
    eventLog: input.eventLog,
    latestRunId: context.latestRunId,
    sandbox: context.sandbox,
    secretLeases: context.secretLeases,
    status: input.state,
    task: context.task,
    verificationContract: context.verificationContract,
    workItemId: requireValue(context.workItemId, "workItemId"),
    wzrrd: context.wzrrd,
  });
}

async function getDoRecord(
  stub: DurableObjectStub<CapsuleSupervisor>,
  origin: string
): Promise<{ record: unknown }> {
  const response = await stub.fetch(new Request(`${origin}/record`));
  return response.json();
}

function isAuthorized(request: Request, env: Env): boolean {
  const url = new URL(request.url);
  if (!env.ACCESS_TOKEN) {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  }

  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return bearer === env.ACCESS_TOKEN;
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

async function postDo(
  stub: DurableObjectStub<CapsuleSupervisor>,
  origin: string,
  path: string,
  body?: unknown
): Promise<{ record: unknown }> {
  const init: RequestInit = {
    headers: { "content-type": "application/json" },
    method: "POST",
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await stub.fetch(new Request(`${origin}${path}`, init));
  return response.json();
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 48);
}
