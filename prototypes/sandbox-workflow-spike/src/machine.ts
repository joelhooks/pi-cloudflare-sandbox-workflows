import { assign, setup } from "xstate";

import type { VerificationResult } from "./schema.ts";

export type SandboxRole = "supervisor" | "worker" | "reader" | "verifier";
export type CaptureStatus = "verified" | "captured_with_warnings";

export interface LaneReceipt {
  artifactRefs: string[];
  commitSha?: string;
  role: SandboxRole;
}

export interface RunContext {
  runId: string;
  capsuleId?: string;
  contextPackRef?: string;
  authLeaseRef?: string;
  sandboxId?: string;
  sandboxRole?: SandboxRole;
  planRef?: string;
  machineRef?: string;
  harnessRef?: string;
  verificationContractRef?: string;
  verificationResult?: VerificationResult;
  captureStatus?: CaptureStatus;
  warnings: string[];
  laneReceipts: {
    reader?: LaneReceipt;
    verifier?: LaneReceipt;
  };
  artifactRefs: string[];
  wzrrdPageRef?: string;
  destroyReceipt?: string;
  error?: string;
}

export type RunEvent =
  | { type: "START"; runId: string }
  | { type: "CAPSULE_RESOLVED"; capsuleId: string }
  | { type: "CONTEXT_PACK_PINNED"; ref: string }
  | {
      type: "PLAN_COMMITTED";
      artifactRefs: string[];
      harnessRef: string;
      machineRef: string;
      planRef: string;
      verificationContractRef: string;
    }
  | { type: "AUTH_LEASE_MINTED"; ref: string }
  | { type: "SANDBOX_READY"; sandboxId: string; role: SandboxRole }
  | { type: "READER_RUN_COMPLETE"; artifactRefs: string[] }
  | {
      type: "READER_OUTPUTS_COMMITTED";
      artifactRefs: string[];
      commitSha: string;
    }
  | {
      type: "VERIFIER_RUN_COMPLETE";
      artifactRefs: string[];
      result: VerificationResult;
    }
  | {
      type: "VERIFIER_OUTPUTS_COMMITTED";
      artifactRefs: string[];
      commitSha: string;
    }
  | {
      type: "VERIFICATION_ACCEPTED";
      status: CaptureStatus;
      warnings?: string[];
    }
  | { type: "VERIFICATION_BLOCKED"; reason: string }
  | { type: "WZRRD_PUBLISHED"; ref: string }
  | { type: "SANDBOX_DESTROYED"; receipt: string }
  | { type: "CAPTURED" }
  | { type: "FAIL"; error: string }
  | { type: "CANCEL" };

export const sandboxWorkflowMachine = setup({
  actions: {
    addPlanArtifacts: assign({
      artifactRefs: ({ context, event }) =>
        event.type === "PLAN_COMMITTED"
          ? [...new Set([...context.artifactRefs, ...event.artifactRefs])]
          : context.artifactRefs,
      harnessRef: ({ event }) =>
        event.type === "PLAN_COMMITTED" ? event.harnessRef : undefined,
      machineRef: ({ event }) =>
        event.type === "PLAN_COMMITTED" ? event.machineRef : undefined,
      planRef: ({ event }) =>
        event.type === "PLAN_COMMITTED" ? event.planRef : undefined,
      verificationContractRef: ({ event }) =>
        event.type === "PLAN_COMMITTED"
          ? event.verificationContractRef
          : undefined,
    }),
    addReaderArtifacts: assign({
      artifactRefs: ({ context, event }) =>
        event.type === "READER_RUN_COMPLETE"
          ? [...new Set([...context.artifactRefs, ...event.artifactRefs])]
          : context.artifactRefs,
    }),
    addReaderCommit: assign({
      artifactRefs: ({ context, event }) =>
        event.type === "READER_OUTPUTS_COMMITTED"
          ? [...new Set([...context.artifactRefs, ...event.artifactRefs])]
          : context.artifactRefs,
      laneReceipts: ({ context, event }) =>
        event.type === "READER_OUTPUTS_COMMITTED"
          ? {
              ...context.laneReceipts,
              reader: {
                artifactRefs: event.artifactRefs,
                commitSha: event.commitSha,
                role: "reader",
              },
            }
          : context.laneReceipts,
    }),
    addVerifierArtifacts: assign({
      artifactRefs: ({ context, event }) =>
        event.type === "VERIFIER_RUN_COMPLETE"
          ? [...new Set([...context.artifactRefs, ...event.artifactRefs])]
          : context.artifactRefs,
      verificationResult: ({ event }) =>
        event.type === "VERIFIER_RUN_COMPLETE" ? event.result : undefined,
    }),
    addVerifierCommit: assign({
      artifactRefs: ({ context, event }) =>
        event.type === "VERIFIER_OUTPUTS_COMMITTED"
          ? [...new Set([...context.artifactRefs, ...event.artifactRefs])]
          : context.artifactRefs,
      laneReceipts: ({ context, event }) =>
        event.type === "VERIFIER_OUTPUTS_COMMITTED"
          ? {
              ...context.laneReceipts,
              verifier: {
                artifactRefs: event.artifactRefs,
                commitSha: event.commitSha,
                role: "verifier",
              },
            }
          : context.laneReceipts,
    }),
    setAuthLease: assign({
      authLeaseRef: ({ event }) =>
        event.type === "AUTH_LEASE_MINTED" ? event.ref : undefined,
    }),
    setCapsule: assign({
      capsuleId: ({ event }) =>
        event.type === "CAPSULE_RESOLVED" ? event.capsuleId : undefined,
    }),
    setCaptureStatus: assign({
      captureStatus: ({ event }) =>
        event.type === "VERIFICATION_ACCEPTED" ? event.status : undefined,
      warnings: ({ context, event }) =>
        event.type === "VERIFICATION_ACCEPTED"
          ? [...new Set([...context.warnings, ...(event.warnings ?? [])])]
          : context.warnings,
    }),
    setContextPack: assign({
      contextPackRef: ({ event }) =>
        event.type === "CONTEXT_PACK_PINNED" ? event.ref : undefined,
    }),
    setDestroyReceipt: assign({
      destroyReceipt: ({ event }) =>
        event.type === "SANDBOX_DESTROYED" ? event.receipt : undefined,
    }),
    setError: assign({
      error: ({ event }) => {
        if (event.type === "FAIL") {
          return event.error;
        }
        if (event.type === "VERIFICATION_BLOCKED") {
          return event.reason;
        }

        return event.type === "CANCEL" ? "cancelled" : undefined;
      },
    }),
    setRunId: assign({
      runId: ({ event }) => (event.type === "START" ? event.runId : "unknown"),
    }),
    setSandbox: assign({
      sandboxId: ({ event }) =>
        event.type === "SANDBOX_READY" ? event.sandboxId : undefined,
      sandboxRole: ({ event }) =>
        event.type === "SANDBOX_READY" ? event.role : undefined,
    }),
    setWzrrdPage: assign({
      wzrrdPageRef: ({ event }) =>
        event.type === "WZRRD_PUBLISHED" ? event.ref : undefined,
    }),
  },
  types: {} as {
    context: RunContext;
    events: RunEvent;
  },
}).createMachine({
  context: {
    artifactRefs: [],
    laneReceipts: {},
    runId: "not-started",
    warnings: [],
  },
  id: "sandboxWorkflowPrototype",
  initial: "idle",
  on: {
    CANCEL: { actions: "setError", target: ".destroyingSandbox" },
    FAIL: { actions: "setError", target: ".failed" },
    VERIFICATION_BLOCKED: { actions: "setError", target: ".failed" },
  },
  states: {
    captured: {
      type: "final",
    },
    capturingLearning: {
      on: {
        CAPTURED: "captured",
      },
    },
    committingPlan: {
      on: {
        PLAN_COMMITTED: {
          actions: "addPlanArtifacts",
          target: "mintingAuthLease",
        },
      },
    },
    committingReaderOutputs: {
      on: {
        READER_OUTPUTS_COMMITTED: {
          actions: "addReaderCommit",
          target: "runningVerifier",
        },
      },
    },
    committingVerifierOutputs: {
      on: {
        VERIFIER_OUTPUTS_COMMITTED: {
          actions: "addVerifierCommit",
          target: "evaluatingVerification",
        },
      },
    },
    destroyingSandbox: {
      on: {
        SANDBOX_DESTROYED: {
          actions: "setDestroyReceipt",
          target: "capturingLearning",
        },
      },
    },
    evaluatingVerification: {
      on: {
        VERIFICATION_ACCEPTED: {
          actions: "setCaptureStatus",
          target: "publishingWzrrd",
        },
        VERIFICATION_BLOCKED: {
          actions: "setError",
          target: "failed",
        },
      },
    },
    failed: {
      type: "final",
    },
    hydratingSandbox: {
      on: {
        SANDBOX_READY: { actions: "setSandbox", target: "runningReader" },
      },
    },
    idle: {
      on: {
        START: { actions: "setRunId", target: "resolvingCapsule" },
      },
    },
    mintingAuthLease: {
      on: {
        AUTH_LEASE_MINTED: {
          actions: "setAuthLease",
          target: "hydratingSandbox",
        },
      },
    },
    pinningContextPack: {
      on: {
        CONTEXT_PACK_PINNED: {
          actions: "setContextPack",
          target: "committingPlan",
        },
      },
    },
    publishingWzrrd: {
      on: {
        WZRRD_PUBLISHED: {
          actions: "setWzrrdPage",
          target: "destroyingSandbox",
        },
      },
    },
    resolvingCapsule: {
      on: {
        CAPSULE_RESOLVED: {
          actions: "setCapsule",
          target: "pinningContextPack",
        },
      },
    },
    runningReader: {
      on: {
        READER_RUN_COMPLETE: {
          actions: "addReaderArtifacts",
          target: "committingReaderOutputs",
        },
      },
    },
    runningVerifier: {
      on: {
        VERIFIER_RUN_COMPLETE: {
          actions: "addVerifierArtifacts",
          target: "committingVerifierOutputs",
        },
      },
    },
  },
});
