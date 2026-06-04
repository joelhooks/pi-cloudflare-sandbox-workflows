/// <reference types="@cloudflare/workers-types" />
/* eslint-disable func-style, no-use-before-define, no-void, require-await, sort-keys */

import { DurableObject } from "cloudflare:workers";
import { assign, createActor, setup } from "xstate";
import { z } from "zod";

interface Env {
  ACCESS_TOKEN?: string;
  CAPSULES: DurableObjectNamespace<IntegratedCapsule>;
  REAL_RUN_URL: string;
}

const IntegratedRunRequestSchema = z.object({
  contextPackRefs: z.array(z.string().min(1)).min(1),
  secretRefs: z.array(z.string().min(1)).min(1),
  task: z.string().min(1),
  verificationContract: z.string().min(1),
  workItemId: z.string().min(1),
});

type IntegratedRunRequest = z.infer<typeof IntegratedRunRequestSchema>;

const RealRunResponseSchema = z.object({
  artifacts: z.object({
    planCommitSha: z.string().min(1),
    readerCommitSha: z.string().min(1),
    remote: z.string().url(),
    repoName: z.string().min(1),
    verifierCommitSha: z.string().min(1),
  }),
  ok: z.literal(true),
  run: z.object({
    captureStatus: z.string().min(1),
    destroyReceipt: z.string().min(1),
    model: z.string().min(1),
    runId: z.string().min(1),
    sandboxId: z.string().min(1),
  }),
  state: z.literal("captured"),
  verification: z.object({
    blockingFailures: z.array(z.string()),
    status: z.string().min(1),
    warnings: z.array(z.string()),
  }),
  workflowEvents: z.array(z.unknown()).min(1),
  wzrrd: z.object({
    source: z.string().min(1),
    url: z.string().url(),
  }),
});

type RealRunResponse = z.infer<typeof RealRunResponseSchema>;

const EventRecordSchema = z.object({
  at: z.string().datetime(),
  event: z.string().min(1),
  state: z.unknown(),
  status: z.string().min(1),
});

type EventRecord = z.infer<typeof EventRecordSchema>;

const CapsuleRecordSchema = z.object({
  artifactRepo: z
    .object({
      planCommitSha: z.string().min(1),
      readerCommitSha: z.string().min(1),
      remote: z.string().url(),
      repoName: z.string().min(1),
      verifierCommitSha: z.string().min(1),
    })
    .optional(),
  capsuleId: z.string().min(1),
  eventLog: z.array(EventRecordSchema),
  realRun: RealRunResponseSchema.optional(),
  request: IntegratedRunRequestSchema,
  sandbox: z
    .object({
      destroyReceipt: z.string().min(1),
      runId: z.string().min(1),
      sandboxId: z.string().min(1),
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
  verification: z
    .object({
      blockingFailures: z.array(z.string()),
      status: z.string().min(1),
      warnings: z.array(z.string()),
    })
    .optional(),
  workItemId: z.string().min(1),
  wzrrd: z
    .object({
      source: z.string().min(1),
      url: z.string().url(),
    })
    .optional(),
});

type CapsuleRecord = z.infer<typeof CapsuleRecordSchema>;

const IntegratedReceiptSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        status: z.literal("passed"),
        summary: z.string().min(1),
      })
    )
    .min(1),
  prototype: z.literal("integrated-capsule-run-spike"),
  schemaVersion: z.literal("integrated-capsule-run-receipt.v1"),
  success: z.object({
    artifactRemote: z.string().url(),
    capsuleId: z.string().min(1),
    eventLogLength: z.number().int().min(1),
    finalState: z.literal("captured"),
    leaseRef: z.string().min(1),
    planCommitSha: z.string().min(1),
    readerCommitSha: z.string().min(1),
    realRunState: z.literal("captured"),
    repoName: z.string().min(1),
    sandboxDestroyReceipt: z.string().min(1),
    sandboxId: z.string().min(1),
    verificationStatus: z.string().min(1),
    verifierCommitSha: z.string().min(1),
    workItemId: z.string().min(1),
    wzrrdUrl: z.string().url(),
  }),
});

type IntegratedReceipt = z.infer<typeof IntegratedReceiptSchema>;

interface IntegratedContext {
  record?: CapsuleRecord;
  request?: IntegratedRunRequest;
}

type IntegratedEvent =
  | { type: "REQUEST_RECEIVED"; request: IntegratedRunRequest }
  | { type: "REAL_RUN_STARTED" }
  | { type: "REAL_RUN_CAPTURED"; realRun: RealRunResponse }
  | { type: "CAPTURED" };

const integratedMachine = setup({
  actions: {
    setCaptured: assign({
      record: ({ context }) => {
        const record = requireValue(context.record, "record");
        return { ...record, status: "captured" };
      },
    }),
    setRealRun: assign({
      record: ({ context, event }) => {
        if (event.type !== "REAL_RUN_CAPTURED") {
          return context.record;
        }
        const request = requireValue(context.request, "request");
        const capsuleId = `capsule:${request.workItemId}`;
        const leaseRef = `lease:${request.secretRefs[0]}:${event.realRun.run.runId}:task-scoped-auth-json`;
        return CapsuleRecordSchema.parse({
          artifactRepo: event.realRun.artifacts,
          capsuleId,
          eventLog: [],
          realRun: event.realRun,
          request,
          sandbox: {
            destroyReceipt: event.realRun.run.destroyReceipt,
            runId: event.realRun.run.runId,
            sandboxId: event.realRun.run.sandboxId,
          },
          secretLeases: [
            {
              leaseRef,
              materializedPath: "/workspace/.pi/agent/auth.json",
              secretRef: request.secretRefs[0],
            },
          ],
          status: "real_run_captured",
          verification: event.realRun.verification,
          workItemId: request.workItemId,
          wzrrd: event.realRun.wzrrd,
        });
      },
    }),
    setRequest: assign({
      record: ({ event }) => {
        if (event.type !== "REQUEST_RECEIVED") {
          return;
        }
        return CapsuleRecordSchema.parse({
          capsuleId: `capsule:${event.request.workItemId}`,
          eventLog: [],
          request: event.request,
          secretLeases: [],
          status: "requested",
          workItemId: event.request.workItemId,
        });
      },
      request: ({ event }) =>
        event.type === "REQUEST_RECEIVED" ? event.request : undefined,
    }),
  },
  types: {} as { context: IntegratedContext; events: IntegratedEvent },
}).createMachine({
  context: {},
  id: "integratedCapsuleRun",
  initial: "idle",
  states: {
    captured: { type: "final" },
    capturing: {
      on: { CAPTURED: { actions: "setCaptured", target: "captured" } },
    },
    idle: {
      on: {
        REQUEST_RECEIVED: { actions: "setRequest", target: "callingRealRun" },
      },
    },
    callingRealRun: {
      on: { REAL_RUN_CAPTURED: { actions: "setRealRun", target: "capturing" } },
    },
  },
});

export class IntegratedCapsule extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/run") {
      return this.run(request);
    }
    if (url.pathname === "/record") {
      return json({ ok: true, record: await this.ctx.storage.get("record") });
    }
    return json({ error: "not found", ok: false }, { status: 404 });
  }

  private async run(request: Request): Promise<Response> {
    if (!this.env.ACCESS_TOKEN) {
      return json(
        { error: "missing ACCESS_TOKEN", ok: false },
        { status: 412 }
      );
    }
    const body = IntegratedRunRequestSchema.parse(await request.json());
    await this.send({ request: body, type: "REQUEST_RECEIVED" });
    await this.send({ type: "REAL_RUN_STARTED" });
    const realRunResponse = await fetch(this.env.REAL_RUN_URL, {
      body: JSON.stringify({
        capsuleId: `capsule:${body.workItemId}`,
        task: body.task,
      }),
      headers: {
        Authorization: `Bearer ${this.env.ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    const rawRealRun = await realRunResponse.json();
    if (!realRunResponse.ok) {
      return json(
        { error: "real_run_failed", ok: false, rawRealRun },
        { status: 502 }
      );
    }
    await this.send({
      realRun: RealRunResponseSchema.parse(rawRealRun),
      type: "REAL_RUN_CAPTURED",
    });
    const record = await this.send({ type: "CAPTURED" });
    const receipt = buildReceipt(record);
    await this.ctx.storage.put("receipt", receipt);
    return json({ ok: true, receipt });
  }

  private async send(event: IntegratedEvent): Promise<CapsuleRecord> {
    const snapshot = await this.ctx.storage.get<unknown>("snapshot");
    const actor = snapshot
      ? createActor(integratedMachine, { snapshot: snapshot as never })
      : createActor(integratedMachine);
    actor.start();
    actor.send(event);
    const actorSnapshot = actor.getSnapshot();
    const persistedSnapshot = actor.getPersistedSnapshot();
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
    const record = CapsuleRecordSchema.parse({
      ...requireValue(actorSnapshot.context.record, "record"),
      eventLog,
      status: String(actorSnapshot.value),
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
    if (request.method === "POST" && url.pathname === "/api/integrated-run") {
      const body = IntegratedRunRequestSchema.parse(
        await request.clone().json()
      );
      const id = env.CAPSULES.idFromName(body.workItemId);
      return env.CAPSULES.get(id).fetch(
        new Request(new URL("/run", request.url), request)
      );
    }
    return json({ error: "not found", ok: false }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function buildReceipt(record: CapsuleRecord): IntegratedReceipt {
  return IntegratedReceiptSchema.parse({
    checks: [
      {
        id: "do-capsule-record",
        status: "passed",
        summary:
          "Durable Object capsule record persisted request, snapshot/event-derived state, and real run receipts.",
      },
      {
        id: "real-substrate-run",
        status: "passed",
        summary:
          "Integrated request called the deployed real sandbox Worker and captured real Sandbox/Artifacts/Wzrrd receipts.",
      },
      {
        id: "secret-lease-ref",
        status: "passed",
        summary:
          "Capsule recorded task-scoped auth materialization as a lease ref without plaintext secret value.",
      },
      {
        id: "verification-captured",
        status: "passed",
        summary: "Real verifier result was captured in the capsule record.",
      },
    ],
    prototype: "integrated-capsule-run-spike",
    schemaVersion: "integrated-capsule-run-receipt.v1",
    success: {
      artifactRemote: requireValue(
        record.artifactRepo?.remote,
        "artifact remote"
      ),
      capsuleId: record.capsuleId,
      eventLogLength: record.eventLog.length,
      finalState: record.status,
      leaseRef: requireValue(record.secretLeases[0]?.leaseRef, "leaseRef"),
      planCommitSha: requireValue(
        record.artifactRepo?.planCommitSha,
        "plan commit"
      ),
      readerCommitSha: requireValue(
        record.artifactRepo?.readerCommitSha,
        "reader commit"
      ),
      realRunState: requireValue(record.realRun?.state, "real run state"),
      repoName: requireValue(record.artifactRepo?.repoName, "repoName"),
      sandboxDestroyReceipt: requireValue(
        record.sandbox?.destroyReceipt,
        "destroyReceipt"
      ),
      sandboxId: requireValue(record.sandbox?.sandboxId, "sandboxId"),
      verificationStatus: requireValue(
        record.verification?.status,
        "verification status"
      ),
      verifierCommitSha: requireValue(
        record.artifactRepo?.verifierCommitSha,
        "verifier commit"
      ),
      workItemId: record.workItemId,
      wzrrdUrl: requireValue(record.wzrrd?.url, "wzrrd url"),
    },
  });
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
    headers: { "Cache-Control": "no-store", ...init.headers },
  });
}

function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}
