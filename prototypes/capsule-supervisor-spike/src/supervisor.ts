/* eslint-disable func-style, no-use-before-define, require-await */

import { createActor } from "xstate";
import type { ActorRefFrom } from "xstate";

import { capsuleSupervisorMachine } from "./machine.ts";
import type { CapsuleContext, CapsuleEvent } from "./machine.ts";
import { CapsuleRecordSchema, EventRecordSchema } from "./schema.ts";
import type {
  ArtifactRepoHandle,
  CapsuleRecord,
  EventRecord,
  SandboxRunHandle,
  SecretLeaseRecord,
  WorkRequest,
  WzrrdReviewRef,
} from "./schema.ts";
import type { MemoryCapsuleStorage } from "./storage.ts";

type Actor = ActorRefFrom<typeof capsuleSupervisorMachine>;

export class CapsuleSupervisor {
  private readonly actor: Actor;
  private readonly storage: MemoryCapsuleStorage;

  private constructor(input: { actor: Actor; storage: MemoryCapsuleStorage }) {
    this.actor = input.actor;
    this.storage = input.storage;
  }

  static async create(
    storage: MemoryCapsuleStorage,
    workItemId?: string
  ): Promise<CapsuleSupervisor> {
    const existing = workItemId
      ? await storage.getCapsule(workItemId)
      : undefined;
    const actor = existing?.snapshot
      ? createActor(capsuleSupervisorMachine, {
          snapshot: existing.snapshot as never,
        })
      : createActor(capsuleSupervisorMachine);
    actor.start();
    return new CapsuleSupervisor({ actor, storage });
  }

  async cancel(): Promise<CapsuleRecord> {
    await this.send({ type: "CANCEL_REQUESTED" });
    const { context } = this.actor.getSnapshot();
    const sandbox = context.sandbox
      ? destroySandbox(context.sandbox)
      : buildSandboxHandle(context.latestRunId ?? "unknown-run");
    return this.send({ sandbox, type: "SANDBOX_DESTROYED" });
  }

  get state(): unknown {
    return this.actor.getSnapshot().value;
  }

  get status(): string {
    return String(this.actor.getSnapshot().status);
  }

  async record(): Promise<CapsuleRecord | undefined> {
    const { workItemId } = this.actor.getSnapshot().context;
    return workItemId ? this.storage.getCapsule(workItemId) : undefined;
  }

  async send(event: CapsuleEvent): Promise<CapsuleRecord> {
    this.actor.send(event);
    return this.persist(event);
  }

  async startRun(request: WorkRequest): Promise<CapsuleRecord> {
    const runId = buildRunId(request.workItemId);
    await this.send({
      contextPackRefs: request.contextPackRefs,
      runId,
      task: request.task,
      type: "START_REQUEST",
      verificationContract: request.verificationContract,
      workItemId: request.workItemId,
    });
    await this.send({
      artifactRepo: buildArtifactRepo(request.workItemId),
      type: "ARTIFACT_REPO_READY",
    });
    await this.send({
      leases: request.secretRefs.map((secretRef) =>
        buildSecretLease(secretRef, runId)
      ),
      type: "SECRET_LEASE_RECORDED",
    });
    return this.send({
      sandbox: buildSandboxHandle(runId),
      type: "SANDBOX_ATTACHED",
    });
  }

  async succeed(): Promise<CapsuleRecord> {
    const { context } = this.actor.getSnapshot();
    const runId = requireContextValue(context.latestRunId, "latestRunId");
    const artifactRepo = requireContextValue(
      context.artifactRepo,
      "artifactRepo"
    );
    await this.send({
      commitSha: `commit-${runId}`,
      type: "SANDBOX_OUTPUTS_COMMITTED",
    });
    await this.send({ type: "VERIFICATION_ACCEPTED" });
    await this.send({
      type: "WZRRD_PUBLISHED",
      wzrrd: buildWzrrdRef(artifactRepo, runId),
    });
    const sandbox = requireContextValue(context.sandbox, "sandbox");
    await this.send({
      sandbox: destroySandbox(sandbox),
      type: "SANDBOX_DESTROYED",
    });
    return this.send({ type: "CAPTURED" });
  }

  private async persist(event: CapsuleEvent): Promise<CapsuleRecord> {
    const snapshot = this.actor.getSnapshot();
    const { context } = snapshot;
    const eventRecord = EventRecordSchema.parse({
      at: new Date().toISOString(),
      context,
      event: event.type,
      state: snapshot.value,
      status: String(snapshot.status),
    });
    const existing = context.workItemId
      ? await this.storage.getCapsule(context.workItemId)
      : undefined;
    const eventLog = [...(existing?.eventLog ?? []), eventRecord];
    const record = buildRecord({
      context,
      eventLog,
      snapshot: this.actor.getPersistedSnapshot(),
      status: String(snapshot.value),
    });
    await this.storage.putCapsule(record);
    return record;
  }
}

function buildArtifactRepo(workItemId: string): ArtifactRepoHandle {
  const repoName = `capsule-${slugify(workItemId)}`;
  return {
    defaultBranch: "main",
    ref: `artifacts:${repoName}@main`,
    repoName,
  };
}

function buildRecord(input: {
  context: CapsuleContext;
  eventLog: EventRecord[];
  snapshot: unknown;
  status: string;
}): CapsuleRecord {
  const workItemId = requireContextValue(
    input.context.workItemId,
    "workItemId"
  );
  return CapsuleRecordSchema.parse({
    activeRunId: input.context.activeRunId,
    artifactRepo: input.context.artifactRepo,
    capsuleId: requireContextValue(input.context.capsuleId, "capsuleId"),
    contextPackRefs: input.context.contextPackRefs,
    eventLog: input.eventLog,
    latestRunId: input.context.latestRunId,
    sandbox: input.context.sandbox,
    secretLeases: input.context.secretLeases,
    snapshot: input.snapshot,
    status: input.status,
    task: input.context.task,
    verificationContract: input.context.verificationContract,
    workItemId,
    wzrrd: input.context.wzrrd,
  });
}

function buildRunId(workItemId: string): string {
  return `run-${slugify(workItemId)}-0001`;
}

function buildSandboxHandle(runId: string): SandboxRunHandle {
  return {
    runId,
    sandboxId: `sandbox-${runId}-${crypto.randomUUID().slice(0, 8)}`,
    status: "running",
  };
}

function buildSecretLease(secretRef: string, runId: string): SecretLeaseRecord {
  return {
    leaseRef: `lease:${secretRef}:${runId}`,
    materializedPath: "/workspace/.pi/agent/auth.json",
    secretRef,
  };
}

function buildWzrrdRef(
  artifactRepo: ArtifactRepoHandle,
  runId: string
): WzrrdReviewRef {
  return {
    source: `${artifactRepo.ref}:${runId}`,
    url: `https://${artifactRepo.repoName}.wzrrd.sh/`,
  };
}

function destroySandbox(sandbox: SandboxRunHandle): SandboxRunHandle {
  const destroyedAt = new Date().toISOString();
  return {
    ...sandbox,
    destroyReceipt: `destroy:${sandbox.sandboxId}:ok`,
    destroyedAt,
    status: "destroyed",
  };
}

function requireContextValue<T>(value: T | undefined, label: string): T {
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
