import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

const repoRoot = resolve(import.meta.dirname, "../..");
const signoffPhrase = "exposing JoelClaw/Typesense over a new network boundary";

const isReadonlyUnknownArray = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

const DeployReceiptSchema = z.object({
  status: z.string(),
  steps: z.array(
    z.object({
      name: z.string(),
      result: z.object({ message: z.string().optional() }).loose(),
    })
  ),
});

const runDeployScript = async (input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly receiptPath: string;
}): Promise<{ readonly exitCode: number }> => {
  const child = spawn(
    "node",
    [
      "scripts/workflow-app-deploy-and-seed.mjs",
      "--skip-migrations",
      "--skip-secrets",
      "--skip-seed",
      `--receipt-path=${input.receiptPath}`,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...input.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const closeEvent: unknown = await once(child, "close");
  const code = isReadonlyUnknownArray(closeEvent)
    ? closeEvent.at(0)
    : undefined;

  return {
    exitCode: typeof code === "number" ? code : 1,
  };
};

describe("workflow app deploy and seed script", () => {
  it("refuses to deploy the Memory relay against a Cloudflare Quick Tunnel URL", async () => {
    const receiptPath =
      ".wrangler/workflow-app/test-quick-tunnel-deploy-receipt.json";

    try {
      const result = await runDeployScript({
        env: {
          MEMORY_RELAY_APPROVAL_SIGNOFF: signoffPhrase,
          MEMORY_RELAY_BASE_URL:
            "https://relax-offer-oscar-derek.trycloudflare.com",
          NO_COLOR: "1",
        },
        receiptPath,
      });
      const receipt = DeployReceiptSchema.parse(
        JSON.parse(await readFile(resolve(repoRoot, receiptPath), "utf-8"))
      );
      const failure = receipt.steps.find((step) => step.name === "failure");

      expect({
        exitCode: result.exitCode,
        failureMentionsQuickTunnel:
          failure?.result.message?.includes("Cloudflare Quick Tunnel") ?? false,
        status: receipt.status,
      }).toStrictEqual({
        exitCode: 1,
        failureMentionsQuickTunnel: true,
        status: "failed",
      });
    } finally {
      await rm(resolve(repoRoot, receiptPath), { force: true });
    }
  });
});
