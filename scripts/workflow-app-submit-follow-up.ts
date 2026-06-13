#!/usr/bin/env tsx

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  WorkflowRunAcceptedSchema,
  WorkflowRunRequestSchema,
} from "../src/app/domain/schemas.ts";
import type { WorkflowRunRequest } from "../src/app/domain/schemas.ts";
import { MemoryHitlFollowUpRunRequestDocumentSchema } from "../src/cartridges/memory-fabric/schemas.ts";
import type { MemoryHitlFollowUpRunRequestDocument } from "../src/cartridges/memory-fabric/schemas.ts";

const defaultWorkerUrl =
  "https://pi-cloudflare-sandbox-workflows.joelhooks.workers.dev";
const defaultPollIntervalMs = 5000;
const defaultPollTimeoutMs = 15 * 60 * 1000;
const terminalRunStates = new Set(["blocked", "captured"]);

const FollowUpSubmissionReceiptSchema = z.object({
  checkedAt: z.string().datetime(),
  decisionSource: z.enum(["generated-draft", "human-review"]).optional(),
  existingRunObserved: z.boolean(),
  followUpPath: z.string().min(1),
  redacted: z.literal(true),
  request: WorkflowRunRequestSchema,
  runId: z.string().min(1),
  schemaVersion: z.literal("workflow.hitl-follow-up-submission.v1"),
  status: z.enum(["submitted", "captured", "blocked", "failed", "timed-out"]),
  submit: z.object({
    attempted: z.boolean(),
    statusCode: z.number().int().optional(),
    url: z.string().url().optional(),
  }),
  terminalStatus: z.unknown().optional(),
  timedOut: z.string().min(1).optional(),
  workerUrl: z.string().url(),
});

export type FollowUpSubmissionReceipt = z.infer<
  typeof FollowUpSubmissionReceiptSchema
>;

interface SubmitFollowUpArgs {
  readonly followUpPath: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly receiptPath?: string;
  readonly workerUrl?: string;
}

export interface SubmitFollowUpCliInput {
  readonly argv: readonly string[];
  readonly fetch?: typeof fetch;
  readonly log?: (message: string) => void;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

export interface SubmitFollowUpRunInput {
  readonly checkedAt?: string;
  readonly fetch?: typeof fetch;
  readonly followUpPath: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly receiptPath?: string;
  readonly workerUrl: string;
}

const isMain = (): boolean =>
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

const argValue = (
  argv: readonly string[],
  name: string
): string | undefined => {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }

  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
};

const positiveIntArg = (
  argv: readonly string[],
  name: string
): number | undefined => {
  const raw = argValue(argv, name);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
};

const parseArgs = (argv: readonly string[]): SubmitFollowUpArgs => {
  const followUpPath = argValue(argv, "--follow-up-path");
  if (followUpPath === undefined || followUpPath.trim().length === 0) {
    throw new Error("Missing required --follow-up-path <path>.");
  }
  const pollIntervalMs = positiveIntArg(argv, "--poll-interval-ms");
  const pollTimeoutMs = positiveIntArg(argv, "--poll-timeout-ms");
  const receiptPath = argValue(argv, "--receipt-path");

  return {
    followUpPath,
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(pollTimeoutMs === undefined ? {} : { pollTimeoutMs }),
    ...(receiptPath === undefined ? {} : { receiptPath }),
    workerUrl: argValue(argv, "--worker-url") ?? defaultWorkerUrl,
  };
};

const normalizeWorkerUrl = (value: string): string =>
  value.replaceAll(/\/+$/gu, "");

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf-8"));

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
};

const responseBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {
      redacted: true,
      status: response.status,
    };
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      redacted: true,
      status: response.status,
      text,
    };
  }
};

const sleep = (durationMs: number): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- Polling the run status needs a bounded timer delay.
  new Promise<void>((_resolve) => {
    setTimeout(_resolve, durationMs);
  });

const runsAuthHeaders = (
  processEnv: Readonly<Record<string, string | undefined>>
): Record<string, string> => {
  const runsToken = processEnv["WORKFLOW_APP_RUNS_TOKEN"];
  return runsToken === undefined || runsToken === ""
    ? {}
    : { authorization: `Bearer ${runsToken}` };
};

const isTerminalRunStatusBody = (body: unknown): boolean => {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  if ("terminal" in body && typeof body.terminal === "boolean") {
    return body.terminal;
  }

  return (
    "status" in body &&
    typeof body.status === "string" &&
    terminalRunStates.has(body.status)
  );
};

const statusFromBody = (body: unknown): FollowUpSubmissionReceipt["status"] => {
  const terminalStatus = ["blocked", "captured"] as const;
  if (
    typeof body === "object" &&
    body !== null &&
    "status" in body &&
    typeof body.status === "string" &&
    terminalStatus.includes(body.status as (typeof terminalStatus)[number])
  ) {
    return body.status as (typeof terminalStatus)[number];
  }

  return "submitted";
};

const pollRunStatusUntilTerminal = async (input: {
  readonly fetch: typeof fetch;
  readonly intervalMs: number;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly runId: string;
  readonly timeoutMs: number;
  readonly workerUrl: string;
}): Promise<{
  readonly body: unknown;
  readonly statusCode?: number;
  readonly terminal: boolean;
  readonly timedOut?: string;
}> => {
  const statusUrl = `${input.workerUrl}/runs/${encodeURIComponent(
    input.runId
  )}/status`;
  const deadline = Date.now() + input.timeoutMs;
  let lastBody: unknown = null;
  let lastStatusCode: number | undefined;

  for (;;) {
    const response = await input.fetch(statusUrl, {
      headers: runsAuthHeaders(input.processEnv),
      method: "GET",
    });
    lastBody = await responseBody(response);
    lastStatusCode = response.status;
    if (response.ok && isTerminalRunStatusBody(lastBody)) {
      return {
        body: lastBody,
        statusCode: lastStatusCode,
        terminal: true,
      };
    }

    if (Date.now() + input.intervalMs >= deadline) {
      return {
        body: lastBody,
        statusCode: lastStatusCode,
        terminal: false,
        timedOut: `Run ${input.runId} did not reach a terminal state within ${input.timeoutMs}ms; poll ${statusUrl} to keep watching.`,
      };
    }

    await sleep(input.intervalMs);
  }
};

const existingRunStatus = async (input: {
  readonly fetch: typeof fetch;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly runId: string;
  readonly workerUrl: string;
}): Promise<unknown | null> => {
  const response = await input.fetch(
    `${input.workerUrl}/runs/${encodeURIComponent(input.runId)}/status`,
    {
      headers: runsAuthHeaders(input.processEnv),
      method: "GET",
    }
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Existing run status probe failed with HTTP ${response.status}.`
    );
  }

  return await responseBody(response);
};

const parseDraftFollowUp = (
  value: unknown
): MemoryHitlFollowUpRunRequestDocument => {
  if (
    typeof value === "object" &&
    value !== null &&
    "submitted" in value &&
    value.submitted === true
  ) {
    throw new Error(
      "Refusing to submit HITL follow-up artifact because submitted is already true."
    );
  }

  const followUp = MemoryHitlFollowUpRunRequestDocumentSchema.parse(value);
  if (followUp.status !== "drafted") {
    throw new Error(
      `Refusing to submit HITL follow-up artifact with status ${followUp.status}; expected drafted.`
    );
  }
  if (followUp.request === undefined) {
    throw new Error("Drafted HITL follow-up artifact is missing request.");
  }

  return followUp;
};

const decisionSourceFromDraft = (
  followUp: MemoryHitlFollowUpRunRequestDocument
): "generated-draft" | "human-review" | undefined => {
  const note = followUp.request?.planProposal.stochasticNotes.find(
    (candidate) =>
      candidate ===
        "Decision source: generated draft from the Dream report/refinement proposals; this is planner input only and not human approval." ||
      candidate === "Decision source: human HITL review artifact."
  );
  if (note === undefined) {
    return undefined;
  }

  return note.includes("generated draft") ? "generated-draft" : "human-review";
};

const submitRequest = async (input: {
  readonly fetch: typeof fetch;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly request: WorkflowRunRequest;
  readonly workerUrl: string;
}): Promise<number> => {
  const response = await input.fetch(`${input.workerUrl}/runs`, {
    body: JSON.stringify(input.request),
    headers: {
      ...runsAuthHeaders(input.processEnv),
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Follow-up run submit failed with HTTP ${response.status}.`
    );
  }
  WorkflowRunAcceptedSchema.parse(await responseBody(response));

  return response.status;
};

export const submitFollowUpRun = async (
  input: SubmitFollowUpRunInput
): Promise<FollowUpSubmissionReceipt> => {
  const submitFetch = input.fetch ?? fetch;
  const workerUrl = normalizeWorkerUrl(input.workerUrl);
  const followUp = parseDraftFollowUp(await readJson(input.followUpPath));
  const request = WorkflowRunRequestSchema.parse(followUp.request);
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const existingStatus = await existingRunStatus({
    fetch: submitFetch,
    processEnv: input.processEnv,
    runId: request.runId,
    workerUrl,
  });

  const submitStatusCode =
    existingStatus === null
      ? await submitRequest({
          fetch: submitFetch,
          processEnv: input.processEnv,
          request,
          workerUrl,
        })
      : undefined;
  const poll =
    existingStatus !== null && isTerminalRunStatusBody(existingStatus)
      ? { body: existingStatus, terminal: true }
      : await pollRunStatusUntilTerminal({
          fetch: submitFetch,
          intervalMs: input.pollIntervalMs ?? defaultPollIntervalMs,
          processEnv: input.processEnv,
          runId: request.runId,
          timeoutMs: input.pollTimeoutMs ?? defaultPollTimeoutMs,
          workerUrl,
        });
  const receipt = FollowUpSubmissionReceiptSchema.parse({
    checkedAt,
    ...(decisionSourceFromDraft(followUp) === undefined
      ? {}
      : { decisionSource: decisionSourceFromDraft(followUp) }),
    existingRunObserved: existingStatus !== null,
    followUpPath: input.followUpPath,
    redacted: true,
    request,
    runId: request.runId,
    schemaVersion: "workflow.hitl-follow-up-submission.v1",
    status:
      "timedOut" in poll && poll.timedOut !== undefined
        ? "timed-out"
        : statusFromBody(poll.body),
    submit: {
      attempted: existingStatus === null,
      ...(submitStatusCode === undefined
        ? {}
        : { statusCode: submitStatusCode }),
      ...(existingStatus === null ? { url: `${workerUrl}/runs` } : {}),
    },
    terminalStatus: poll.body,
    ...("timedOut" in poll && poll.timedOut !== undefined
      ? { timedOut: poll.timedOut }
      : {}),
    workerUrl,
  });

  if (input.receiptPath !== undefined) {
    await writeJson(input.receiptPath, receipt);
  }

  return receipt;
};

export const runSubmitFollowUpCli = async (
  input: SubmitFollowUpCliInput
): Promise<FollowUpSubmissionReceipt> => {
  const args = parseArgs(input.argv);
  const followUpPath = resolve(input.repoRoot, args.followUpPath);
  const receiptPath =
    args.receiptPath === undefined
      ? undefined
      : resolve(input.repoRoot, args.receiptPath);
  const receipt = await submitFollowUpRun({
    followUpPath,
    ...(args.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: args.pollIntervalMs }),
    ...(args.pollTimeoutMs === undefined
      ? {}
      : { pollTimeoutMs: args.pollTimeoutMs }),
    processEnv: input.processEnv,
    ...(receiptPath === undefined ? {} : { receiptPath }),
    workerUrl: args.workerUrl ?? defaultWorkerUrl,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  const log = input.log ?? console.log;
  log(JSON.stringify(receipt, null, 2));

  return receipt;
};

if (isMain()) {
  try {
    await runSubmitFollowUpCli({
      argv: process.argv.slice(2),
      processEnv: process.env,
      repoRoot: resolve(import.meta.dirname, ".."),
    });
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "HITL follow-up submission failed."
    );
    process.exitCode = 1;
  }
}
