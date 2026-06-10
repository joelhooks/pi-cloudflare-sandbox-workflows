import { assign, setup } from "xstate";

import type {
  CapabilityBlocker,
  SafetyEnvelopeCommand,
} from "../domain/schemas.ts";
import {
  SafetyEnvelopeCommandSchema,
  SafetyEnvelopeStateSchema,
} from "../domain/schemas.ts";

export const APP_SAFETY_ENVELOPE_NAME = "dynamic-workflow-safety-envelope";

export const APP_SAFETY_ENVELOPE_STATES = SafetyEnvelopeStateSchema.options;

interface DynamicWorkflowSafetyEnvelopeContext {
  blocker: CapabilityBlocker | null;
}

export const dynamicWorkflowSafetyEnvelopeMachine = setup({
  actions: {
    assignBlocker: assign({
      blocker: ({ event }) => {
        const parsed = SafetyEnvelopeCommandSchema.parse(event);
        return parsed.type === "BLOCK" ? parsed.blocker : null;
      },
    }),
  },
  types: {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- XState setup uses phantom values to bind generic machine types.
    context: {} as DynamicWorkflowSafetyEnvelopeContext,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- XState setup uses phantom values to bind generic machine events.
    events: {} as SafetyEnvelopeCommand,
  },
}).createMachine({
  context: {
    blocker: null,
  },
  id: APP_SAFETY_ENVELOPE_NAME,
  initial: "received",
  states: {
    blocked: {
      type: "final",
    },
    captured: {
      type: "final",
    },
    checkingEntitlements: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        ENTITLEMENTS_ACCEPTED: {
          target: "pinningPackages",
        },
      },
    },
    discoveringPackageMetadata: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        PACKAGE_METADATA_DISCOVERED: {
          target: "checkingEntitlements",
        },
      },
    },
    executingCapability: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        CAPABILITY_EXECUTED: {
          target: "executingDynamicWorkflow",
        },
      },
    },
    executingDynamicWorkflow: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        CAPABILITY_LEASE_REQUESTED: {
          target: "requestingCapabilityLease",
        },
        DYNAMIC_STEP_EXECUTED: {},
        DYNAMIC_WORKFLOW_COMPLETED: {
          target: "verifyingDynamicWorkflow",
        },
      },
    },
    executingReviewSurfaceDelivery: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        CAPABILITY_EXECUTED: {
          target: "summarizingReview",
        },
      },
    },
    loadingPinnedDynamicWorkflow: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        PINNED_DYNAMIC_WORKFLOW_LOADED: {
          target: "executingDynamicWorkflow",
        },
      },
    },
    pinningPackages: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        PACKAGES_PINNED: {
          target: "planningDynamicWorkflow",
        },
      },
    },
    pinningPlanArtifact: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        PLAN_PINNED: {
          target: "loadingPinnedDynamicWorkflow",
        },
      },
    },
    planningDynamicWorkflow: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        DYNAMIC_WORKFLOW_PLANNED: {
          target: "pinningPlanArtifact",
        },
      },
    },
    received: {
      on: {
        START: {
          target: "resolvingCapsule",
        },
      },
    },
    recordingReceipts: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        RECEIPTS_RECORDED: {
          target: "summarizingReview",
        },
      },
    },
    requestingCapabilityLease: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        LEASE_ISSUED: {
          target: "executingCapability",
        },
      },
    },
    requestingReviewSurfaceDeliveryLease: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        LEASE_ISSUED: {
          target: "executingReviewSurfaceDelivery",
        },
      },
    },
    resolvingCapsule: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        CAPSULE_RESOLVED: {
          target: "discoveringPackageMetadata",
        },
      },
    },
    summarizingReview: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        CAPABILITY_LEASE_REQUESTED: {
          target: "requestingReviewSurfaceDeliveryLease",
        },
        REVIEW_SUMMARIZED: {
          target: "captured",
        },
      },
    },
    verifyingDynamicWorkflow: {
      on: {
        BLOCK: {
          actions: "assignBlocker",
          target: "blocked",
        },
        DYNAMIC_WORKFLOW_VERIFIED: {
          target: "recordingReceipts",
        },
        VERIFICATION_BYPASSED: {
          target: "recordingReceipts",
        },
      },
    },
  },
});
