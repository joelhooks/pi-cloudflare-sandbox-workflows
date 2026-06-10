import { init as gitInit } from "isomorphic-git";
import { describe, expect, it } from "vitest";

import { GitMemoryFS } from "../../src/app/infrastructure/git-memory-fs.ts";

describe(GitMemoryFS, () => {
  it("behaves like a promise filesystem for isomorphic-git", async () => {
    const fs = new GitMemoryFS();
    const probe = fs.promises.readFile("/missing");

    expect(probe).toBeInstanceOf(Promise);
    await expect(probe).rejects.toThrow("ENOENT: /missing");
  });

  it("supports isomorphic-git directory initialization", async () => {
    const fs = new GitMemoryFS();
    await fs.promises.mkdir("/repo", { recursive: true });

    await gitInit({
      defaultBranch: "main",
      dir: "/repo",
      fs,
    });

    await expect(
      fs.promises.readFile("/repo/.git/HEAD", { encoding: "utf-8" })
    ).resolves.toBe("ref: refs/heads/main\n");
  });
});
