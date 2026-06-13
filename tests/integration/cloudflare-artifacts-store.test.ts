import { describe, expect, it } from "vitest";

import {
  createCloudflareArtifactsGitStore,
  provisionCloudflareArtifactsRunStore,
} from "../../src/app/infrastructure/cloudflare-artifacts-store.ts";

describe(provisionCloudflareArtifactsRunStore, () => {
  it("uses the requested repo name as the run artifact namespace", async () => {
    const runStore = await provisionCloudflareArtifactsRunStore({
      artifacts: {
        create: () =>
          Promise.resolve({
            remote:
              "https://example.invalid/git/default/piwf-run-live-test.git",
            token: "artifact-token?expires=1780960000",
            tokenExpiresAt: "2026-06-09T00:00:00.000Z",
          }),
        get: () => Promise.reject(new Error("get should not be called")),
      },
      description: "live run store",
      repoName: "piwf-run-live-test",
    });

    expect({
      artifactRef: runStore.store.artifactRef({
        path: "run/planner-blueprint.json",
        runId: "run-live-test",
      }),
      repoName: runStore.artifactRepoName,
      tokenSecret: runStore.artifactTokenSecret,
    }).toStrictEqual({
      artifactRef:
        "artifact://piwf-run-live-test/runs/run-live-test/run/planner-blueprint.json",
      repoName: "piwf-run-live-test",
      tokenSecret: "artifact-token",
    });
  });

  it("ignores the Artifacts create result name for run artifact namespaces", async () => {
    const runStore = await provisionCloudflareArtifactsRunStore({
      artifacts: {
        create: () =>
          Promise.resolve({
            name: "undefined",
            remote:
              "https://example.invalid/git/default/piwf-run-string-undefined.git",
            token: "artifact-token?expires=1780960000",
            tokenExpiresAt: "2026-06-09T00:00:00.000Z",
          }),
        get: () => Promise.reject(new Error("get should not be called")),
      },
      description: "live run store",
      repoName: "piwf-run-string-undefined",
    });

    expect(
      runStore.store.artifactRef({
        path: "run/planner-blueprint.json",
        runId: "run-live-test",
      })
    ).toBe(
      "artifact://piwf-run-string-undefined/runs/run-live-test/run/planner-blueprint.json"
    );
  });

  it("re-attaches to the existing run repo when the repo already exists", async () => {
    let createCalls = 0;
    let mintedTokenScope: string | undefined;
    let mintedTokenTtl: number | undefined;

    const runStore = await provisionCloudflareArtifactsRunStore({
      artifacts: {
        create: () => {
          createCalls += 1;
          return Promise.reject(
            Object.assign(new Error("repo already exists"), {
              code: "ALREADY_EXISTS",
            })
          );
        },
        get: () =>
          Promise.resolve({
            createToken: (scope: "write" | "read", ttl?: number) => {
              mintedTokenScope = scope;
              mintedTokenTtl = ttl;
              return Promise.resolve({
                expiresAt: "2026-06-13T00:00:00.000Z",
                plaintext: "rotated-token?expires=1781040000",
              });
            },
            remote: "https://example.invalid/git/default/piwf-run-redrive.git",
          }),
      },
      description: "live run store",
      repoName: "piwf-run-redrive",
    });

    expect({
      artifactRef: runStore.store.artifactRef({
        path: "run/planner-blueprint.json",
        runId: "run-redrive",
      }),
      artifactRemote: runStore.artifactRemote,
      createCalls,
      mintedTokenScope,
      mintedTokenTtl,
      repoName: runStore.artifactRepoName,
      tokenExpiresAt: runStore.artifactTokenExpiresAt,
      tokenSecret: runStore.artifactTokenSecret,
    }).toStrictEqual({
      artifactRef:
        "artifact://piwf-run-redrive/runs/run-redrive/run/planner-blueprint.json",
      artifactRemote:
        "https://example.invalid/git/default/piwf-run-redrive.git",
      createCalls: 1,
      mintedTokenScope: "write",
      mintedTokenTtl: 86_400,
      repoName: "piwf-run-redrive",
      tokenExpiresAt: "2026-06-13T00:00:00.000Z",
      tokenSecret: "rotated-token",
    });
  });

  it("constructs the re-attach remote when Artifacts get returns an RPC property proxy", async () => {
    const rpcPropertyProxy = {
      toString: () => "[object JsRpcProperty]",
    };

    const runStore = await provisionCloudflareArtifactsRunStore({
      artifacts: {
        create: () =>
          Promise.reject(
            Object.assign(new Error("repo already exists"), {
              code: "ALREADY_EXISTS",
            })
          ),
        get: () =>
          Promise.resolve({
            createToken: () =>
              Promise.resolve({
                expiresAt: "2026-06-13T00:00:00.000Z",
                plaintext: "rotated-token?expires=1781040000",
              }),
            defaultBranch: rpcPropertyProxy,
            name: rpcPropertyProxy,
            remote: rpcPropertyProxy,
          }),
      },
      artifactsAccountId: "baac0d692a7fb14f11b159b48b13055e",
      artifactsNamespace: "default",
      description: "live run store",
      repoName: "piwf-run-redrive-proxy",
    });

    expect({
      artifactRef: runStore.store.artifactRef({
        path: "run/plan.json",
        runId: "run-redrive-proxy",
      }),
      artifactRemote: runStore.artifactRemote,
      repoName: runStore.artifactRepoName,
    }).toStrictEqual({
      artifactRef:
        "artifact://piwf-run-redrive-proxy/runs/run-redrive-proxy/run/plan.json",
      artifactRemote:
        "https://baac0d692a7fb14f11b159b48b13055e.artifacts.cloudflare.net/git/default/piwf-run-redrive-proxy.git",
      repoName: "piwf-run-redrive-proxy",
    });
  });

  it("rethrows Artifacts errors that are not ALREADY_EXISTS", async () => {
    await expect(
      provisionCloudflareArtifactsRunStore({
        artifacts: {
          create: () =>
            Promise.reject(
              Object.assign(new Error("invalid repo name"), {
                code: "INVALID_REPO_NAME",
              })
            ),
          get: () => Promise.reject(new Error("get should not be called")),
        },
        description: "live run store",
        repoName: "piwf-run-invalid",
      })
    ).rejects.toThrow("invalid repo name");
  });

  it("derives the store namespace from the Artifacts remote when namespace is invalid", () => {
    const store = createCloudflareArtifactsGitStore({
      artifactRemote:
        "https://example-account.artifacts.cloudflare.net/git/default/piwf-run-derived.git",
      artifactTokenSecret: "artifact-token",
      namespace: "undefined",
    });

    expect(
      store.artifactRef({
        path: "run/planner-blueprint.json",
        runId: "run-live-test",
      })
    ).toBe(
      "artifact://piwf-run-derived/runs/run-live-test/run/planner-blueprint.json"
    );
  });
});
