#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const authPath =
  process.argv[2] ?? join(homedir(), ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf-8"));
const codex = auth["openai-codex"];

if (!codex) {
  console.error(
    `No openai-codex entry found in ${authPath}. Run pi /login for ChatGPT Plus/Pro (Codex) first.`
  );
  process.exit(1);
}

const payload = JSON.stringify({ "openai-codex": codex });
process.stdout.write(Buffer.from(payload, "utf-8").toString("base64"));
