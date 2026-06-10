import { hashJson } from "../../app/domain/hash.ts";
import { ArtifactPinSchema } from "../../app/domain/schemas.ts";
import type {
  MemoryPrivacyTier,
  MemoryRuntime,
  MemorySourceFamily,
  MemorySourceScope,
} from "../../app/domain/source-profile.ts";
import { MemoryCaptureReceiptDocumentSchema } from "./schemas.ts";
import type {
  MemoryCaptureReceiptDocument,
  MemoryRelayCaptureArtifactPayload,
  MemoryRelayCaptureRunPayload,
} from "./schemas.ts";
import type { TrustedJoelClawSessionBridgeCommand } from "./trusted-joelclaw-session-source.ts";
import type { MemoryCapturePort } from "./workflow-node-adapter.ts";

export interface TrustedLocalMemorySourceRoot {
  readonly authorityRoot: string;
  readonly family: MemorySourceFamily;
  readonly includeExtensions?: readonly string[];
  readonly label: string;
  readonly privacyTier: MemoryPrivacyTier;
  readonly runtime?: MemoryRuntime;
  readonly scope?: MemorySourceScope;
  readonly sourceId: string;
  readonly sourceSystem: string;
}

export interface TrustedLocalMemoryFabricConfig {
  readonly maxFilesPerSource?: number;
  readonly now?: () => string;
  readonly sessionBridgeCommand?: TrustedJoelClawSessionBridgeCommand;
  readonly sourceRoots: readonly TrustedLocalMemorySourceRoot[];
}

const captureArtifactRefSegment = (value: string): string =>
  encodeURIComponent(value);

const capturedRunPinFor = (input: {
  readonly capturedAt: string;
  readonly payload: MemoryRelayCaptureRunPayload;
}) =>
  ArtifactPinSchema.parse({
    artifactRef: `artifact://trusted-memory-relay/captures/${captureArtifactRefSegment(
      input.payload.sourceSystem
    )}/runs/${captureArtifactRefSegment(
      input.payload.targetRunId ?? input.payload.runId
    )}.json`,
    hash: hashJson({
      capturedAt: input.capturedAt,
      redacted: true,
      runId: input.payload.runId,
      schemaVersion: "memory.capture-target.run.v1",
      sourceSystem: input.payload.sourceSystem,
      targetRunId: input.payload.targetRunId ?? input.payload.runId,
      workItemId: input.payload.workItemId,
    }),
    mediaType: "application/json",
  });

const captureReceiptFor = (input: {
  readonly captureKind: MemoryCaptureReceiptDocument["captureKind"];
  readonly capturedAt: string;
  readonly capturedRef: MemoryCaptureReceiptDocument["capturedRef"];
  readonly payload:
    | MemoryRelayCaptureArtifactPayload
    | MemoryRelayCaptureRunPayload;
}): MemoryCaptureReceiptDocument => {
  const baseReceipt = {
    capturedAt: input.capturedAt,
    capturedRef: input.capturedRef,
    readability: input.payload.readability,
    redacted: true,
    runId: input.payload.runId,
    schemaVersion: "memory.capture-receipt.v1",
    sourceSystem: input.payload.sourceSystem,
    workItemId: input.payload.workItemId,
  } as const;

  if (input.captureKind === "run") {
    const capturedRunId =
      "targetRunId" in input.payload && input.payload.targetRunId !== undefined
        ? input.payload.targetRunId
        : input.payload.runId;

    return MemoryCaptureReceiptDocumentSchema.parse({
      ...baseReceipt,
      captureKind: "run",
      capturedRunId,
    });
  }

  return MemoryCaptureReceiptDocumentSchema.parse({
    ...baseReceipt,
    captureKind: input.captureKind,
  });
};

export const createTrustedLocalMemoryFabricAdapter = (
  config: TrustedLocalMemoryFabricConfig
): MemoryCapturePort => ({
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
