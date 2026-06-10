import { hashJson } from "../../app/domain/hash.ts";
import { ArtifactPinSchema } from "../../app/domain/schemas.ts";
import { DreamCaptureReceiptDocumentSchema } from "./schemas.ts";
import type {
  DreamCaptureReceiptDocument,
  DreamMemoryRelayCaptureArtifactPayload,
  DreamMemoryRelayCaptureRunPayload,
  DreamPrivacyTier,
  DreamRuntime,
  DreamSourceFamily,
  DreamSourceScope,
} from "./schemas.ts";
import type { TrustedJoelClawSessionBridgeCommand } from "./trusted-joelclaw-session-source.ts";
import type { DreamMemoryCapturePort } from "./workflow-node-adapter.ts";

export interface TrustedLocalDreamSourceRoot {
  readonly authorityRoot: string;
  readonly family: DreamSourceFamily;
  readonly includeExtensions?: readonly string[];
  readonly label: string;
  readonly privacyTier: DreamPrivacyTier;
  readonly runtime?: DreamRuntime;
  readonly scope?: DreamSourceScope;
  readonly sourceId: string;
  readonly sourceSystem: string;
}

export interface TrustedLocalDreamMemoryFabricConfig {
  readonly maxFilesPerSource?: number;
  readonly now?: () => string;
  readonly sessionBridgeCommand?: TrustedJoelClawSessionBridgeCommand;
  readonly sourceRoots: readonly TrustedLocalDreamSourceRoot[];
}

const captureArtifactRefSegment = (value: string): string =>
  encodeURIComponent(value);

const capturedRunPinFor = (input: {
  readonly capturedAt: string;
  readonly payload: DreamMemoryRelayCaptureRunPayload;
}) =>
  ArtifactPinSchema.parse({
    artifactRef: `artifact://trusted-dream-memory-relay/captures/${captureArtifactRefSegment(
      input.payload.sourceSystem
    )}/runs/${captureArtifactRefSegment(
      input.payload.targetRunId ?? input.payload.runId
    )}.json`,
    hash: hashJson({
      capturedAt: input.capturedAt,
      redacted: true,
      runId: input.payload.runId,
      schemaVersion: "dream.capture-target.run.v1",
      sourceSystem: input.payload.sourceSystem,
      targetRunId: input.payload.targetRunId ?? input.payload.runId,
      workItemId: input.payload.workItemId,
    }),
    mediaType: "application/json",
  });

const captureReceiptFor = (input: {
  readonly captureKind: DreamCaptureReceiptDocument["captureKind"];
  readonly capturedAt: string;
  readonly capturedRef: DreamCaptureReceiptDocument["capturedRef"];
  readonly payload:
    | DreamMemoryRelayCaptureArtifactPayload
    | DreamMemoryRelayCaptureRunPayload;
}): DreamCaptureReceiptDocument => {
  const baseReceipt = {
    capturedAt: input.capturedAt,
    capturedRef: input.capturedRef,
    readability: input.payload.readability,
    redacted: true,
    runId: input.payload.runId,
    schemaVersion: "dream.capture-receipt.v1",
    sourceSystem: input.payload.sourceSystem,
    workItemId: input.payload.workItemId,
  } as const;

  if (input.captureKind === "run") {
    const capturedRunId =
      "targetRunId" in input.payload && input.payload.targetRunId !== undefined
        ? input.payload.targetRunId
        : input.payload.runId;

    return DreamCaptureReceiptDocumentSchema.parse({
      ...baseReceipt,
      captureKind: "run",
      capturedRunId,
    });
  }

  return DreamCaptureReceiptDocumentSchema.parse({
    ...baseReceipt,
    captureKind: input.captureKind,
  });
};

export const createTrustedLocalDreamMemoryFabricAdapter = (
  config: TrustedLocalDreamMemoryFabricConfig
): DreamMemoryCapturePort => ({
  captureArtifact(input) {
    const capturedAt = config.now?.() ?? new Date().toISOString();

    return Promise.resolve({
      document: captureReceiptFor({
        captureKind: "artifact",
        capturedAt,
        capturedRef: input.capturedRef,
        payload: input,
      }),
      status: "ready",
    });
  },
  captureRun(input) {
    const capturedAt = config.now?.() ?? new Date().toISOString();

    return Promise.resolve({
      document: captureReceiptFor({
        captureKind: "run",
        capturedAt,
        capturedRef:
          input.capturedRef ??
          capturedRunPinFor({ capturedAt, payload: input }),
        payload: input,
      }),
      status: "ready",
    });
  },
});
