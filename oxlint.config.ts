import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";

export default defineConfig({
  extends: [core],
  ignorePatterns: [
    ...core.ignorePatterns,
    "node_modules/**",
    "dist/**",
    ".wrangler/**",
    "prototypes/**/out/**",
    "prototypes/**/.tmp/**",
  ],
});
