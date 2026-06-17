import { describe, expect, it } from "vitest";

import {
  buildWorkflowSeamLadderReceipt,
  workflowSeamLadderCommandSpecs,
  workflowSeamLadderGates,
  workflowSeamLadderIntegrationTestFiles,
} from "../../scripts/workflow-seam-ladder-gate.ts";
import type { WorkflowSeamLadderCommandReceipt } from "../../scripts/workflow-seam-ladder-gate.ts";

const commandReceipt = (
  commandId: string,
  exitCode: number
): WorkflowSeamLadderCommandReceipt => ({
  command: ["pnpm", "exec", "vitest", "run"],
  commandId,
  durationMs: 1,
  exitCode,
  stderrTail: "",
  stdoutTail: "",
});

describe("workflow seam ladder gate", () => {
  it("keeps ladder gates ordered, classified, and attached to concrete test evidence", () => {
    const gateIds = workflowSeamLadderGates.map((gate) => gate.gateId);
    const commandIds = new Set(
      workflowSeamLadderCommandSpecs.map((command) => command.commandId)
    );
    const commandIdsByGate = Object.fromEntries(
      workflowSeamLadderGates.map((gate) => [gate.gateId, gate.commandIds])
    );

    expect({
      bottomRungCommands: {
        artifacts: commandIdsByGate["seam-03-artifacts"],
        d1: commandIdsByGate["seam-01-d1-state"],
        durableObject: commandIdsByGate["seam-02-do-lifecycle"],
      },
      commandRefsKnown: workflowSeamLadderGates.every((gate) =>
        gate.commandIds.every((commandId) => commandIds.has(commandId))
      ),
      concreteEvidence: workflowSeamLadderGates.every(
        (gate) => gate.evidence.length > 0
      ),
      uniqueGateIds: new Set(gateIds).size === gateIds.length,
      validFailureClasses: workflowSeamLadderGates.map(
        (gate) => gate.failureClass
      ),
    }).toStrictEqual({
      bottomRungCommands: {
        artifacts: ["focused-integration"],
        d1: ["carrier"],
        durableObject: ["carrier"],
      },
      commandRefsKnown: true,
      concreteEvidence: true,
      uniqueGateIds: true,
      validFailureClasses: [
        "carrier",
        "carrier",
        "carrier",
        "carrier",
        "carrier",
        "planner-contract",
        "data-source",
        "render-verifier",
        "carrier",
      ],
    });
  });

  it("runs the Cloudflare MSW canary outside the default Node integration command", () => {
    const carrier = workflowSeamLadderCommandSpecs.find(
      (command) => command.commandId === "carrier"
    );
    const focusedIntegration = workflowSeamLadderCommandSpecs.find(
      (command) => command.commandId === "focused-integration"
    );
    const focusedIntegrationArgs = [
      ...(focusedIntegration?.args ?? []),
    ] as readonly string[];
    const cloudflareMsw = workflowSeamLadderCommandSpecs.find(
      (command) => command.commandId === "cloudflare-msw"
    );

    expect({
      carrierScript: carrier?.args,
      focusedCommandMentionsCfFile: focusedIntegrationArgs.includes(
        "tests/cloudflare-msw/external-telemetry-msw.cf.ts"
      ),
      hasTelemetryIntegrationTest:
        workflowSeamLadderIntegrationTestFiles.includes(
          "tests/integration/cloudflare-workflow-telemetry-sinks.test.ts"
        ),
      includesCarrierCompositionCanary:
        workflowSeamLadderIntegrationTestFiles.includes(
          "tests/integration/workflow-carrier-composition.acceptance.test.ts"
        ),
      mswCommand: cloudflareMsw?.args,
    }).toStrictEqual({
      carrierScript: ["test:carrier"],
      focusedCommandMentionsCfFile: false,
      hasTelemetryIntegrationTest: true,
      includesCarrierCompositionCanary: true,
      mswCommand: ["test:cloudflare-msw"],
    });
  });

  it("builds a captured receipt only when every backing command passes", () => {
    const captured = buildWorkflowSeamLadderReceipt({
      commands: [
        commandReceipt("carrier", 0),
        commandReceipt("focused-integration", 0),
        commandReceipt("cloudflare-msw", 0),
      ],
      generatedAt: "2026-06-17T00:00:00.000Z",
      gitCommit: "abc1234",
      runId: "seam-ladder-test",
    });
    const blocked = buildWorkflowSeamLadderReceipt({
      commands: [
        commandReceipt("carrier", 0),
        commandReceipt("focused-integration", 0),
        commandReceipt("cloudflare-msw", 1),
      ],
      generatedAt: "2026-06-17T00:00:00.000Z",
      gitCommit: "abc1234",
      runId: "seam-ladder-test",
    });

    expect({
      blockedCanaryStatus: blocked.gates.find(
        (gate) => gate.gateId === "canary-cloudflare-msw-telemetry"
      )?.status,
      blockedOverall: blocked.status,
      capturedGateCount: captured.gates.length,
      capturedOverall: captured.status,
      schemaVersion: captured.schemaVersion,
    }).toStrictEqual({
      blockedCanaryStatus: "blocked",
      blockedOverall: "blocked",
      capturedGateCount: workflowSeamLadderGates.length,
      capturedOverall: "captured",
      schemaVersion: "workflow.seam-ladder.acceptance.v1",
    });
  });
});
