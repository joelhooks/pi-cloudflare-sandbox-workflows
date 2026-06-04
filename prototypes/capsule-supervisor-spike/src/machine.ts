import { assign, setup } from "xstate";

import type {
  ArtifactRepoHandle,
  SandboxRunHandle,
  SecretLeaseRecord,
  WzrrdReviewRef,
} from "./schema.ts";

export interface CapsuleContext {
  activeRunId?: string;
  artifactRepo?: ArtifactRepoHandle;
  capsuleId?: string;
  contextPackRefs: string[];
  latestRunId?: string;
  sandbox?: SandboxRunHandle;
  secretLeases: SecretLeaseRecord[];
  task?: string;
  verificationContract?: string;
  workItemId?: string;
  wzrrd?: WzrrdReviewRef;
}

export type CapsuleEvent =
  | {
      type: "START_REQUEST";
      contextPackRefs: string[];
      runId: string;
      task: string;
      verificationContract: string;
      workItemId: string;
    }
  | {
      type: "ARTIFACT_REPO_READY";
      artifactRepo: ArtifactRepoHandle;
    }
  | {
      type: "SECRET_LEASE_RECORDED";
      leases: SecretLeaseRecord[];
    }
  | { type: "SANDBOX_ATTACHED"; sandbox: SandboxRunHandle }
  | { type: "SANDBOX_OUTPUTS_COMMITTED"; commitSha: string }
  | { type: "VERIFICATION_ACCEPTED" }
  | { type: "WZRRD_PUBLISHED"; wzrrd: WzrrdReviewRef }
  | { type: "SANDBOX_DESTROYED"; sandbox: SandboxRunHandle }
  | { type: "CAPTURED" }
  | { type: "CANCEL_REQUESTED" };

export const capsuleSupervisorMachine = setup({
  actions: {
    clearActiveRun: assign({
      activeRunId: () => void 0,
    }),
    setArtifactRepo: assign({
      artifactRepo: ({ event }) =>
        event.type === "ARTIFACT_REPO_READY" ? event.artifactRepo : undefined,
    }),
    setSandbox: assign({
      sandbox: ({ event }) =>
        event.type === "SANDBOX_ATTACHED" || event.type === "SANDBOX_DESTROYED"
          ? event.sandbox
          : undefined,
    }),
    setSecretLeases: assign({
      secretLeases: ({ context, event }) =>
        event.type === "SECRET_LEASE_RECORDED"
          ? [...context.secretLeases, ...event.leases]
          : context.secretLeases,
    }),
    setStart: assign({
      activeRunId: ({ event }) =>
        event.type === "START_REQUEST" ? event.runId : undefined,
      capsuleId: ({ event }) =>
        event.type === "START_REQUEST"
          ? `capsule:${event.workItemId}`
          : undefined,
      contextPackRefs: ({ event }) =>
        event.type === "START_REQUEST" ? event.contextPackRefs : [],
      latestRunId: ({ event }) =>
        event.type === "START_REQUEST" ? event.runId : undefined,
      task: ({ event }) =>
        event.type === "START_REQUEST" ? event.task : undefined,
      verificationContract: ({ event }) =>
        event.type === "START_REQUEST" ? event.verificationContract : undefined,
      workItemId: ({ event }) =>
        event.type === "START_REQUEST" ? event.workItemId : undefined,
    }),
    setWzrrd: assign({
      wzrrd: ({ event }) =>
        event.type === "WZRRD_PUBLISHED" ? event.wzrrd : undefined,
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
  id: "capsuleSupervisorPrototype",
  initial: "idle",
  on: {
    CANCEL_REQUESTED: {
      target: ".cancelling",
    },
  },
  states: {
    attachingSandbox: {
      on: {
        SANDBOX_ATTACHED: {
          actions: "setSandbox",
          target: "runningSandbox",
        },
      },
    },
    cancelled: {
      type: "final",
    },
    cancelling: {
      on: {
        SANDBOX_DESTROYED: {
          actions: ["setSandbox", "clearActiveRun"],
          target: "cancelled",
        },
      },
    },
    captured: {
      type: "final",
    },
    capturing: {
      on: {
        CAPTURED: {
          actions: "clearActiveRun",
          target: "captured",
        },
      },
    },
    committingOutputs: {
      on: {
        SANDBOX_OUTPUTS_COMMITTED: "verifying",
      },
    },
    destroyingSandbox: {
      on: {
        SANDBOX_DESTROYED: {
          actions: "setSandbox",
          target: "capturing",
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
    materializingSecrets: {
      on: {
        SECRET_LEASE_RECORDED: {
          actions: "setSecretLeases",
          target: "attachingSandbox",
        },
      },
    },
    publishingWzrrd: {
      on: {
        WZRRD_PUBLISHED: {
          actions: "setWzrrd",
          target: "destroyingSandbox",
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
    runningSandbox: {
      on: {
        SANDBOX_OUTPUTS_COMMITTED: "verifying",
      },
    },
    verifying: {
      on: {
        VERIFICATION_ACCEPTED: "publishingWzrrd",
      },
    },
  },
});
