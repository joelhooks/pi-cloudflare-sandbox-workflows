#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const authPath =
  process.env.PI_AUTH_JSON_PATH ?? join(homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf-8"));
const openaiCodex = auth["openai-codex"];

if (!openaiCodex) {
  console.error(`Missing openai-codex auth entry in ${authPath}`);
  process.exit(1);
}

process.stdout.write(
  Buffer.from(JSON.stringify({ "openai-codex": openaiCodex })).toString(
    "base64"
  )
);
