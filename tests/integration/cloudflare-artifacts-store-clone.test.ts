import type * as IsomorphicGit from "isomorphic-git";
import { beforeEach, describe, expect, it, vi } from "vitest";

type GitModule = typeof IsomorphicGit;
type CloneCall = Parameters<GitModule["clone"]>[0];

const gitMocks = vi.hoisted(() => ({
  add: vi.fn<GitModule["add"]>(),
  clone: vi.fn<GitModule["clone"]>(),
  commit: vi.fn<GitModule["commit"]>(),
  init: vi.fn<GitModule["init"]>(),
  push: vi.fn<GitModule["push"]>(),
  readBlob: vi.fn<GitModule["readBlob"]>(),
}));

vi.mock(import("isomorphic-git"), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    add: gitMocks.add,
    clone: gitMocks.clone,
    commit: gitMocks.commit,
    init: gitMocks.init,
    push: gitMocks.push,
    readBlob: gitMocks.readBlob,
  };
});

const firstCloneCall = (): CloneCall => {
  const call = gitMocks.clone.mock.calls.at(0);
  if (call === undefined) {
    throw new Error("Expected clone to be called.");
  }

  return call[0];
};

const createSeededStore = () =>
  import("../../src/app/infrastructure/cloudflare-artifacts-store.ts").then(
    ({ createCloudflareArtifactsGitStore }) =>
      createCloudflareArtifactsGitStore({
        artifactRemote: "https://example.invalid/git/default/piwf-seeded.git",
        artifactTokenSecret: "artifact-token",
        namespace: "piwf-seeded",
        seedFromRemote: true,
      })
  );

describe("CloudflareArtifactsGitStore remote seeding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitMocks.init.mockResolvedValue();
  });

  it("clones an existing run repo with a checked-out default branch", async () => {
    gitMocks.clone.mockResolvedValue();
    const store = await createSeededStore();

    await expect(
      store.readText({
        artifactRef: store.artifactRef({
          path: "run/plan.json",
          runId: "run-seeded",
        }),
      })
    ).rejects.toMatchObject({ code: "ENOENT" });

    const cloneCall = firstCloneCall();
    expect({
      ref: cloneCall.ref,
      singleBranch: cloneCall.singleBranch,
      url: cloneCall.url,
    }).toStrictEqual({
      ref: "main",
      singleBranch: true,
      url: "https://example.invalid/git/default/piwf-seeded.git",
    });
    expect(gitMocks.init).not.toHaveBeenCalled();
  });

  it("does not silently fall back to an empty worktree on clone failures", async () => {
    gitMocks.clone.mockRejectedValue(
      Object.assign(new Error("remote auth failed"), { code: "HttpError" })
    );
    const store = await createSeededStore();

    await expect(
      store.readText({
        artifactRef: store.artifactRef({
          path: "run/plan.json",
          runId: "run-seeded",
        }),
      })
    ).rejects.toThrow("remote auth failed");

    expect(gitMocks.init).not.toHaveBeenCalled();
  });

  it("falls back to empty init only when the remote has no default branch yet", async () => {
    gitMocks.clone.mockRejectedValue(new Error("Could not find main."));
    const store = await createSeededStore();

    await expect(
      store.readText({
        artifactRef: store.artifactRef({
          path: "run/plan.json",
          runId: "run-seeded",
        }),
      })
    ).rejects.toMatchObject({ code: "ENOENT" });

    expect(gitMocks.init).toHaveBeenCalledOnce();
  });
});
