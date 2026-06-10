import { describe, expect, it } from "vitest";

import type { Actor } from "../../src/app/domain/schemas.ts";
import { createTrustedLocalDreamMemoryFabricAdapter } from "../../src/cartridges/dream-memory-fabric/trusted-local-memory-fabric.ts";
import type { DreamMemoryFabricResult } from "../../src/cartridges/dream-memory-fabric/workflow-node-adapter.ts";

const timestamp = "2026-06-09T19:45:00.000Z";

const actor: Actor = {
  id: "actor:trusted-local-dream",
  organizationId: "org:joelhooks",
  roleIds: ["dream.operator"],
  sessionId: "session:trusted-local-dream-test",
  trustTier: "reviewed",
  type: "agent",
};

const readyDocument = <TDocument>(
  result: DreamMemoryFabricResult<TDocument>
): TDocument => {
  if (result.status === "blocked") {
    throw new Error(result.blocker.message);
  }

  return result.document;
};

describe("trusted local Dream memory fabric", () => {
  it("captures run and artifact receipts with redacted refs and no raw local paths", async () => {
    const rawLocalPath = "/Users/joel/.pi/agent/sessions";
    const adapter = createTrustedLocalDreamMemoryFabricAdapter({
      now: () => timestamp,
      sourceRoots: [
        {
          authorityRoot: rawLocalPath,
          family: "agent-transcripts",
          includeExtensions: [".jsonl"],
          label: "Pi transcripts",
          privacyTier: "private",
          runtime: "pi",
          sourceId: "source:pi-transcripts",
          sourceSystem: "local:pi-transcripts",
        },
      ],
    });

    const captureRun = readyDocument(
      await adapter.captureRun({
        actor,
        readability: "actor-private",
        runId: "run:trusted-local-dream",
        sourceSystem: "cloudflare-workflow-run",
        targetRunId: "run:trusted-local-dream",
        workItemId: "work:trusted-local-dream",
      })
    );
    const captureArtifact = readyDocument(
      await adapter.captureArtifact({
        actor,
        capturedRef: {
          artifactRef: "artifact://trusted-local-dream/run/hitl-report.json",
          hash: "f".repeat(64),
          mediaType: "application/json",
        },
        readability: "actor-private",
        runId: "run:trusted-local-dream",
        sourceSystem: "cloudflare-artifacts",
        workItemId: "work:trusted-local-dream",
      })
    );
    const serialized = JSON.stringify({ captureArtifact, captureRun });

    expect({
      artifactCaptureKind: captureArtifact.captureKind,
      artifactCapturedRef: captureArtifact.capturedRef.artifactRef,
      capturedRunId:
        captureRun.captureKind === "run" ? captureRun.capturedRunId : null,
      rawPathLeaked: serialized.includes(rawLocalPath),
      runCaptureKind: captureRun.captureKind,
      runCapturedAt: captureRun.capturedAt,
      runCapturedRef: captureRun.capturedRef.artifactRef,
      runRedacted: captureRun.redacted,
      schemaVersions: [captureArtifact.schemaVersion, captureRun.schemaVersion],
    }).toStrictEqual({
      artifactCaptureKind: "artifact",
      artifactCapturedRef:
        "artifact://trusted-local-dream/run/hitl-report.json",
      capturedRunId: "run:trusted-local-dream",
      rawPathLeaked: false,
      runCaptureKind: "run",
      runCapturedAt: timestamp,
      runCapturedRef:
        "artifact://trusted-dream-memory-relay/captures/cloudflare-workflow-run/runs/run%3Atrusted-local-dream.json",
      runRedacted: true,
      schemaVersions: ["dream.capture-receipt.v1", "dream.capture-receipt.v1"],
    });
  });
});
