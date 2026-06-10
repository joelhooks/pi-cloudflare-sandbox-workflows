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
