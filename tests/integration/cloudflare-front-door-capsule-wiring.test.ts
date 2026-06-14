import { describe, expect, it, vi } from "vitest";

import type { WorkerFrontDoorContract } from "../../src/app/application/ports.ts";
import type { CreateFrontDoorFromEnvOptions } from "../../src/app/infrastructure/cloudflare-worker-route.ts";
import type * as FrontDoorModule from "../../src/app/infrastructure/cloudflare-workflow-front-door.ts";

/**
 * Carrier-wound regression lock (smells #3 + production side of #4).
 *
 * The subrequest-depth melt at node 3 came from the in-DO front door self-fetching
 * its own Durable Object for all 13 capsule-supervisor ports. The fix injects an
 * in-process `contextCapsules` client and — crucially — DROPS the namespace binding
 * from the config whenever that override is present, so the depth limit is no longer
 * load-bearing for correctness. If a future edit ever drops the override, the front
 * door has no namespace to fall back to and `resolveCapsuleSupervisor` throws a clear
 * construction error instead of recursing to a depth-32 melt in production.
 *
 * Every other suite injects a polite test double for the supervisor, so the exact
 * production hazard (override present ⇒ no namespace fallback) is the one path no
 * other test walks. This test captures the literal config shape the REAL
 * `createFrontDoorFromEnv` hands to `createCloudflareWorkflowFrontDoor`.
 */

const { createFrontDoorMock } = vi.hoisted(() => ({
  createFrontDoorMock: vi.fn<(config: unknown) => WorkerFrontDoorContract>(),
}));

vi.mock(
  import("../../src/app/infrastructure/cloudflare-workflow-front-door.ts"),
  async (importOriginal) => {
    const actual = await importOriginal<typeof FrontDoorModule>();

    return {
      ...actual,
      createCloudflareWorkflowFrontDoor: createFrontDoorMock,
    };
  }
);

const { createFrontDoorFromEnv } =
  await import("../../src/app/infrastructure/cloudflare-worker-route.ts");

interface CapturedConfig {
  readonly capsuleSupervisor?: unknown;
  readonly contextCapsules?: unknown;
}

const capsuleNamespaceSentinel = { __sentinel: "capsule-supervisor-namespace" };

const createWorkerEnv = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  ARTIFACTS: {},
  DISCORD_BOT_SECRET_REF: "secretref:discord-bot",
  DISCORD_DRY_RUN_SECRET_REF: "secretref:discord-dry-run",
  DISCORD_USER_AGENT: "pi-cloudflare-sandbox-workflows/0.0.0",
  PI_AUTH_JSON_B64: "eyJvcGVuYWktY29kZXgiOnt9fQ==",
  PI_AUTH_SECRET_REF: "secretref:pi-agent-auth-json",
  Sandbox: {},
  WORKFLOW_APP_ARTIFACTS_ACCOUNT_ID: "baac0d692a7fb14f11b159b48b13055e",
  WORKFLOW_APP_ARTIFACTS_NAMESPACE: "default",
  WORKFLOW_APP_D1: {},
  WORKFLOW_APP_DISCORD_POLICY_ID: "discord-message-policy.v1",
  WORKFLOW_APP_MAX_ACTIVE_LANES: "3",
  WORKFLOW_APP_MODEL: "test-model",
  WORKFLOW_APP_REPO_PREFIX: "piwf",
  WORKFLOW_APP_TIMEOUT_MS: "600000",
  WORKFLOW_CAPSULE_SUPERVISOR: capsuleNamespaceSentinel,
  ...overrides,
});

const lastCapturedConfig = (): CapturedConfig => {
  const call = createFrontDoorMock.mock.calls.at(-1);

  if (call === undefined) {
    throw new Error("createCloudflareWorkflowFrontDoor was never called");
  }

  // Deliberate narrowing of the captured config arg for shape assertions.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return call[0] as CapturedConfig;
};

describe("createFrontDoorFromEnv capsule-supervisor wiring", () => {
  it("forwards the supervisor namespace when no in-process override is supplied (public worker route)", () => {
    createFrontDoorMock.mockReset();
    createFrontDoorMock.mockReturnValue({
      route: "POST /runs",
      startRun: () => Promise.reject(new Error("unused")),
    });

    createFrontDoorFromEnv(createWorkerEnv());

    const config = lastCapturedConfig();

    expect(config.capsuleSupervisor).toBe(capsuleNamespaceSentinel);
    expect(config.contextCapsules).toBeUndefined();
  });

  it("drops the supervisor namespace and injects the in-process client when an override is supplied (in-DO drive path)", () => {
    createFrontDoorMock.mockReset();
    createFrontDoorMock.mockReturnValue({
      route: "POST /runs",
      startRun: () => Promise.reject(new Error("unused")),
    });

    // Identity sentinel standing in for the in-process CapsuleSupervisorPorts the
    // DO builds from `this`. The contract is structural; this test only asserts the
    // config plumbing, so a cast is sufficient.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const inProcessOverride = {
      __sentinel: "in-process-capsule-client",
    } as unknown as NonNullable<
      CreateFrontDoorFromEnvOptions["contextCapsulesOverride"]
    >;

    createFrontDoorFromEnv(createWorkerEnv(), {
      contextCapsulesOverride: inProcessOverride,
    });

    const config = lastCapturedConfig();

    expect(config.contextCapsules).toBe(inProcessOverride);
    // The loaded gun is unloaded: production literally cannot self-fetch its own DO.
    expect(config.capsuleSupervisor).toBeUndefined();
  });
});
