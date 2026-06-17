import { fileURLToPath, URL } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: fileURLToPath(new URL("wrangler.jsonc", import.meta.url)),
      },
    }),
  ],
  test: {
    include: ["tests/cloudflare-msw/**/*.cf.ts"],
  },
});
