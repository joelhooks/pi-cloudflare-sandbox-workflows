import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentLaneIncompleteError } from "../../src/app/application/ports.ts";
import {
  AgentLanePackageMountIndexSchema,
  PackageMetadataSchema,
  PinnedPackageSchema,
} from "../../src/app/domain/schemas.ts";
import type { PinnedPackage } from "../../src/app/domain/schemas.ts";
import {
  AgentLaneAgentError,
  extractFirstJsonValueText,
  jsonOutputNormalizerNodeScript,
  normalizeAgentLaneJsonOutput,
} from "../../src/app/infrastructure/agent-lane-json-output.ts";
import {
  agentLanePackageMountWriterNodeScript,
  buildAgentLanePackageMountIndex,
  mountedPackagePathFor,
} from "../../src/app/infrastructure/agent-lane-package-mounts.ts";
import {
  buildPiAgentLaneCommand,
  classifyAgentLaneIncompleteFailure,
  lastHeartbeatStep,
  laneStepReachedAgentInvocation,
  selectLaneAbortDiagnostic,
} from "../../src/app/infrastructure/cloudflare-sandbox-agent-lane-command.ts";
import { integrationTestPackageMetadata } from "./workflow-app-fixtures.ts";

const buildPinnedPackageFixture = (
  overrides: {
    readonly artifactRef?: string;
    readonly packageId?: string;
  } = {}
): PinnedPackage => {
  const metadata = integrationTestPackageMetadata.at(0);
  if (metadata === undefined) {
    throw new Error("Missing integration package metadata fixture.");
  }

  return {
    artifactRef: overrides.artifactRef ?? metadata.latestArtifactRef,
    fileHashes: {
      "package.json":
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    manifestHash:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    metadata: {
      ...metadata,
      packageId: overrides.packageId ?? metadata.packageId,
    },
    pinnedAt: "2026-06-08T20:00:00.000Z",
    version: metadata.latestVersion,
  };
};

const PackagePinFileSchema = PinnedPackageSchema.pick({
  artifactRef: true,
  fileHashes: true,
  manifestHash: true,
  pinnedAt: true,
  version: true,
}).extend({
  redacted: z.literal(true),
});

describe(extractFirstJsonValueText, () => {
  it("extracts the first complete JSON value from chatty agent output", () => {
    const jsonText = extractFirstJsonValueText(
      [
        "Here is the verification result:",
        "```json",
        '{ "status": "accepted", "message": "brace in string: }", "items": [1, 2] }',
        "```",
        "done",
      ].join("\n")
    );

    expect(JSON.parse(jsonText)).toStrictEqual({
      items: [1, 2],
      message: "brace in string: }",
      status: "accepted",
    });
  });

  it("skips bracket-like prose before the real JSON document", () => {
    const jsonText = extractFirstJsonValueText(
      'note [not json] before {"ok":true,"nested":{"value":1}} trailing'
    );

    expect(JSON.parse(jsonText)).toStrictEqual({
      nested: { value: 1 },
      ok: true,
    });
  });

  it("throws when the agent output has no complete JSON value", () => {
    expect(() => extractFirstJsonValueText("no structured output")).toThrow(
      "Agent lane output did not contain a complete JSON value."
    );
  });
});

/**
 * Build a faithful pi `--mode json` JSONL event stream. The shape mirrors a real
 * captured stream: a `session` HEADER line (itself a complete JSON object — the
 * hostile bit, because a naive whole-buffer scan would return it instead of the
 * verdict), lifecycle events, then an `agent_end` carrying `messages[]`. The
 * verdict lives ONLY inside the final assistant message's `{type:"text"}` block,
 * alongside a `{type:"thinking"}` block that must be ignored. When `stopReason`
 * is "error"/"aborted" the assistant carries no text block and an `errorMessage`,
 * exactly like pi's failure ending.
 */
const buildPiJsonEventStream = (
  options: {
    readonly assistantText?: string;
    readonly errorMessage?: string;
    readonly includeThinking?: boolean;
    readonly stopReason?: string;
  } = {}
): string => {
  const {
    assistantText = '{"ok":true}',
    errorMessage,
    includeThinking = true,
    stopReason = "stop",
  } = options;
  const failed = stopReason === "error" || stopReason === "aborted";

  const assistantContent: Record<string, unknown>[] = [];
  if (includeThinking) {
    assistantContent.push({
      thinking: "weighing the primary source against the claim",
      type: "thinking",
    });
  }
  if (!failed) {
    assistantContent.push({ text: assistantText, type: "text" });
  }

  const assistantMessage: Record<string, unknown> = {
    content: assistantContent,
    role: "assistant",
    stopReason,
  };
  if (errorMessage !== undefined) {
    assistantMessage["errorMessage"] = errorMessage;
  }

  const lines: Record<string, unknown>[] = [
    {
      cwd: "/workspace/piwf-agent-lane",
      id: "sess_chaos",
      timestamp: "2026-06-14T00:00:00.000Z",
      type: "session",
      version: 3,
    },
    { type: "agent_start" },
    { type: "turn_start" },
    {
      message: { content: [], role: "assistant", stopReason: null },
      type: "message_start",
    },
    {
      messages: [
        {
          content: [{ text: "verify the claim", type: "text" }],
          role: "user",
        },
        assistantMessage,
      ],
      type: "agent_end",
      willRetry: false,
    },
  ];

  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
};

/** Narrow an unknown JSON value to a plain object (non-null, non-array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Assert a caught value is an {@link AgentLaneAgentError}, narrowing without a cast. */
const asAgentError = (value: unknown): AgentLaneAgentError => {
  if (value instanceof AgentLaneAgentError) {
    return value;
  }
  throw new Error(`expected AgentLaneAgentError, received: ${String(value)}`);
};

/** Run the sandbox node normalizer script against a raw fixture, out-of-process. */
const runNormalizerNodeScript = (
  raw: string
): {
  readonly exitCode: number;
  readonly laneOutput: string | null;
  readonly normalization: Record<string, unknown> | null;
} => {
  const dir = mkdtempSync(join(tmpdir(), "piwf-normalize-"));
  const rawPath = join(dir, "raw.txt");
  const outPath = join(dir, "out.json");
  const normPath = join(dir, "normalization.json");

  try {
    writeFileSync(rawPath, raw);
    let exitCode = 0;
    try {
      execFileSync(process.execPath, ["-e", jsonOutputNormalizerNodeScript], {
        env: {
          ...process.env,
          LANE_OUTPUT_NORMALIZATION_PATH: normPath,
          LANE_OUTPUT_PATH: outPath,
          raw_output_path: rawPath,
        },
      });
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? error.status
          : undefined;
      exitCode = typeof status === "number" ? status : 1;
    }

    const normalizationRaw: unknown = existsSync(normPath)
      ? JSON.parse(readFileSync(normPath, "utf-8"))
      : null;

    return {
      exitCode,
      laneOutput: existsSync(outPath) ? readFileSync(outPath, "utf-8") : null,
      normalization: isRecord(normalizationRaw) ? normalizationRaw : null,
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/**
 * Run bash out-of-process and return its stdout regardless of exit status. A handler
 * that exits non-zero (e.g. 143 on a trapped SIGTERM) makes execFileSync throw with
 * the stdout riding on the error; this normalizes both paths to a plain string.
 */
const captureBashStdout = (harness: string, env: NodeJS.ProcessEnv): string => {
  try {
    return execFileSync("bash", ["-c", harness], {
      encoding: "utf-8",
      env,
      timeout: 15_000,
    });
  } catch (error) {
    const captured =
      typeof error === "object" && error !== null && "stdout" in error
        ? error.stdout
        : undefined;
    return typeof captured === "string" ? captured : "";
  }
};

/** Decode the base64 `__PIWF_AGENT_LANE_RESULT__` marker from lane stdout. */
const decodeAgentLaneMarker = (
  stdout: string
): Record<string, unknown> | null => {
  const match = /__PIWF_AGENT_LANE_RESULT__:([A-Za-z0-9+/=]+)/u.exec(stdout);
  if (match?.[1] === undefined) {
    return null;
  }
  const decoded: unknown = JSON.parse(
    Buffer.from(match[1], "base64").toString("utf-8")
  );
  return isRecord(decoded) ? decoded : null;
};

/** Read a marker field as a string, defaulting to "" when absent or non-string. */
const markerString = (
  payload: Record<string, unknown> | null,
  key: string
): string => {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
};

describe(normalizeAgentLaneJsonOutput, () => {
  it("recovers the verdict from the agent_end assistant text of a real json event stream", () => {
    const verdict = normalizeAgentLaneJsonOutput(
      buildPiJsonEventStream({
        assistantText: '{"ok":true,"verdict":"accepted"}',
      })
    );

    expect(JSON.parse(verdict)).toStrictEqual({
      ok: true,
      verdict: "accepted",
    });
  });

  it("recovers a fenced verdict buried in the assistant's prose", () => {
    const verdict = normalizeAgentLaneJsonOutput(
      buildPiJsonEventStream({
        assistantText: [
          "Here is my verification result:",
          "```json",
          '{ "status": "accepted", "confidence": 0.9 }',
          "```",
          "Done.",
        ].join("\n"),
      })
    );

    expect(JSON.parse(verdict)).toStrictEqual({
      confidence: 0.9,
      status: "accepted",
    });
  });

  it("throws AgentLaneAgentError (not a silent empty) when the run ends in error", () => {
    let thrown: unknown;
    try {
      normalizeAgentLaneJsonOutput(
        buildPiJsonEventStream({
          errorMessage: "model provider returned 500",
          stopReason: "error",
        })
      );
    } catch (error) {
      thrown = error;
    }

    const agentError = asAgentError(thrown);
    expect(agentError.agentStopReason).toBe("error");
    expect(agentError.message).toBe("model provider returned 500");
  });

  it("throws AgentLaneAgentError when the run is aborted mid-flight", () => {
    expect(() =>
      normalizeAgentLaneJsonOutput(
        buildPiJsonEventStream({ stopReason: "aborted" })
      )
    ).toThrow(AgentLaneAgentError);
  });

  it("never returns the session header when an event stream carries no verdict", () => {
    // The wound class: a json lane whose agent produced only thinking (no text
    // verdict) must NOT have its `{type:"session"}` header scraped as the result.
    const stream = buildPiJsonEventStream({ includeThinking: true });
    const verdictless = stream
      .split("\n")
      .filter((line) => !line.includes('"type":"text"'))
      .join("\n");

    expect(() => normalizeAgentLaneJsonOutput(verdictless)).toThrow(
      "Agent lane output did not contain a complete JSON value."
    );
  });

  it("falls back to a bare legacy verdict that is not an event stream", () => {
    expect(
      JSON.parse(
        normalizeAgentLaneJsonOutput('{"status":"accepted","score":3}')
      )
    ).toStrictEqual({ score: 3, status: "accepted" });
  });

  it("falls back to extracting a verdict from legacy chatty single-line text", () => {
    expect(
      JSON.parse(
        normalizeAgentLaneJsonOutput('result: {"ok":true} <- the verdict')
      )
    ).toStrictEqual({ ok: true });
  });

  it("normalizes a real stream end-to-end through the sandbox node script", () => {
    const result = runNormalizerNodeScript(
      buildPiJsonEventStream({
        assistantText: '{"ok":true,"verdict":"accepted"}',
      })
    );

    expect({
      exitCode: result.exitCode,
      laneVerdict:
        result.laneOutput === null
          ? null
          : (JSON.parse(result.laneOutput) as unknown),
      normalization: result.normalization,
    }).toStrictEqual({
      exitCode: 0,
      laneVerdict: { ok: true, verdict: "accepted" },
      normalization: { agentStopReason: null, normalized: true, reason: null },
    });
  });

  it("classifies an agent-error stream as a non-zero, honest normalization failure", () => {
    const result = runNormalizerNodeScript(
      buildPiJsonEventStream({
        errorMessage: "model provider returned 500",
        stopReason: "error",
      })
    );

    expect({
      agentStopReason: result.normalization?.["agentStopReason"],
      failedExit: result.exitCode !== 0,
      normalized: result.normalization?.["normalized"],
      reason: result.normalization?.["reason"],
    }).toStrictEqual({
      agentStopReason: "error",
      failedExit: true,
      normalized: false,
      reason: "agent_error",
    });
  });

  it("records a no-parseable-output failure without inventing an agent stop reason", () => {
    const result = runNormalizerNodeScript(
      buildPiJsonEventStream({ includeThinking: true })
        .split("\n")
        .filter((line) => !line.includes('"type":"text"'))
        .join("\n")
    );

    expect({
      agentStopReason: result.normalization?.["agentStopReason"],
      failedExit: result.exitCode !== 0,
      normalized: result.normalization?.["normalized"],
      reason: result.normalization?.["reason"],
    }).toStrictEqual({
      agentStopReason: null,
      failedExit: true,
      normalized: false,
      reason: "no_parseable_output",
    });
  });

  it("bounds a brace-heavy truncated blob instead of grinding O(n^2) to a hang", () => {
    // wound #23-B: extractFirstJsonValueText re-scanned to EOF for every unbalanced
    // opener, so a large truncated brace run cost O(n^2) — 477KB took 9s, 1.2MB took
    // 59s, and the real ~1.5-2MB normalize step rode past the lane timeout into a
    // silent block. A pure run of openers is the worst case: each '{' triggers a full
    // forward scan that never closes. The scan budget must cut it short and classify
    // it as oversized_output, not hang. The test timeout IS the bound assertion: the
    // pre-fix path could not finish a 600KB run inside it.
    const truncatedBraceRun = "{".repeat(600_000);

    const start = process.hrtime.bigint();
    const result = runNormalizerNodeScript(truncatedBraceRun);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    expect({
      completedWellUnderHang: elapsedMs < 5000,
      failedExit: result.exitCode !== 0,
      laneOutput: result.laneOutput,
      normalized: result.normalization?.["normalized"],
      reason: result.normalization?.["reason"],
    }).toStrictEqual({
      completedWellUnderHang: true,
      failedExit: true,
      laneOutput: null,
      normalized: false,
      reason: "oversized_output",
    });
  }, 15_000);
});

describe(jsonOutputNormalizerNodeScript, () => {
  it("embeds the same extraction helper used by the TypeScript tests", () => {
    expect({
      avoidsBundlerHelpers: !jsonOutputNormalizerNodeScript.includes("__name"),
      readsRawOutputPath: jsonOutputNormalizerNodeScript.includes(
        "process.env.raw_output_path"
      ),
      usesExtractor: jsonOutputNormalizerNodeScript.includes(
        "extractFirstJsonValueText"
      ),
      writesPrettyJson: jsonOutputNormalizerNodeScript.includes(
        "JSON.stringify(parsed, null, 2)"
      ),
    }).toStrictEqual({
      avoidsBundlerHelpers: true,
      readsRawOutputPath: true,
      usesExtractor: true,
      writesPrettyJson: true,
    });
  });
});

describe(buildPiAgentLaneCommand, () => {
  const command = buildPiAgentLaneCommand();

  it("guarantees a result marker on any exit via an EXIT trap installed before fallible work", () => {
    const trapIndex = command.indexOf("trap emit_failure_marker EXIT");
    const cloneIndex = command.indexOf('git clone "$ARTIFACTS_GIT_REMOTE"');

    expect({
      emitsErrorStatusOnFailure: command.includes('status: "error"'),
      emitsOkStatusOnSuccess: command.includes('status: "ok"'),
      guardsAgainstDoubleEmit: command.includes(
        'if [ "$marker_emitted" = "1" ]'
      ),
      // Three emit sites share the prefix: success-node, failure-node, and the
      // shell-only failure fallback that fires when node cannot emit. (wound #23-A)
      markerEmittedAtAllThreeSites:
        (command.match(/__PIWF_AGENT_LANE_RESULT__/gu) ?? []).length === 3,
      scrubsCredentialsBeforeTailing: command.includes(
        "s#https://x:[^@]*@#https://x:***@#g"
      ),
      tracksFailingStepThroughPush: command.includes("mark git-push"),
      trapInstalledBeforeClone: trapIndex !== -1 && trapIndex < cloneIndex,
    }).toStrictEqual({
      emitsErrorStatusOnFailure: true,
      emitsOkStatusOnSuccess: true,
      guardsAgainstDoubleEmit: true,
      markerEmittedAtAllThreeSites: true,
      scrubsCredentialsBeforeTailing: true,
      tracksFailingStepThroughPush: true,
      trapInstalledBeforeClone: true,
    });
  });

  it("copies the lane prompt from a sandbox file instead of inheriting a huge env value", () => {
    expect({
      copiesPromptFromSourcePath: command.includes(
        'cp "$LANE_PROMPT_SOURCE_PATH" "$LANE_PROMPT_PATH"'
      ),
      promptEnvRemoved: !command.includes("$LANE_PROMPT "),
      writesPromptPath: command.includes('"$LANE_PROMPT_PATH"'),
    }).toStrictEqual({
      copiesPromptFromSourcePath: true,
      promptEnvRemoved: true,
      writesPromptPath: true,
    });
  });

  it("captures pi's json event stream for json lanes without forging a non-zero exit", () => {
    expect({
      appliesJsonModeForJsonLanes: command.includes(
        'pi_mode_args="--mode json"'
      ),
      doesNotClobberPiStatus: !command.includes("pi_status=65"),
      exitsWithRealPiStatus: command.includes('exit "$pi_status"'),
      gatesJsonModeOnMediaType: command.includes(
        '[ "$LANE_OUTPUT_MEDIA_TYPE" = "application/json" ]'
      ),
      passesModeArgsToPi: command.includes("$pi_mode_args"),
      recordsNormalizationOutcomePath: command.includes(
        'export LANE_OUTPUT_NORMALIZATION_PATH="$normalization_outcome_path"'
      ),
      tracksNormalizationSeparately: command.includes("output_normalized=0"),
    }).toStrictEqual({
      appliesJsonModeForJsonLanes: true,
      doesNotClobberPiStatus: true,
      exitsWithRealPiStatus: true,
      gatesJsonModeOnMediaType: true,
      passesModeArgsToPi: true,
      recordsNormalizationOutcomePath: true,
      tracksNormalizationSeparately: true,
    });
  });

  it("reattaches existing remote lane branches before publishing rerun receipts", () => {
    expect({
      checksOutExistingLaneBranch: command.includes(
        'git checkout -B "$LANE_BRANCH" "origin/$LANE_BRANCH"'
      ),
      checksRemoteLaneBranch: command.includes(
        'git show-ref --verify --quiet "refs/remotes/origin/$LANE_BRANCH"'
      ),
      keepsFastForwardPush: command.includes(
        'git push origin HEAD:"refs/heads/$LANE_BRANCH"'
      ),
      toleratesNoopCommit: command.includes("git diff --cached --quiet"),
    }).toStrictEqual({
      checksOutExistingLaneBranch: true,
      checksRemoteLaneBranch: true,
      keepsFastForwardPush: true,
      toleratesNoopCommit: true,
    });
  });

  it("self-bounds pi-invoke to the remaining whole-script budget so a hung model call cannot ride past the EXIT trap", () => {
    // Wound #22 Layer B was structural: pi-invoke was a bare `pi --provider ...` with
    // no inner bound, so a hung model call rode until the whole-script `timeout`
    // SIGTERM'd it — and SIGTERM skips the EXIT trap, so pi's stderr was never captured
    // and the blocker named a step with no cause. The fix wraps pi in a `timeout`
    // derived from the budget remaining before the whole-script ceiling (so the
    // variable cold-install lead time cannot starve it, and it always fires first).
    // This assertion fails against the pre-fix bare invocation.
    expect({
      attributesTimeoutToPiInvoke:
        command.includes("[pi-invoke self-bound]") &&
        command.includes("the heartbeat names pi-invoke as the wedge step"),
      boundsPiInvokeWithTimeout: command.includes(
        'timeout "$pi_budget_s" pi --provider'
      ),
      capturesScriptStartEpoch: command.includes(
        'script_start_s="$(date +%s)"'
      ),
      clampsBudgetToAtLeastOneSecond: command.includes(
        'if [ "$pi_budget_s" -lt 1 ]; then'
      ),
      derivesBudgetFromElapsed: command.includes(
        "pi_elapsed_s=$(( $(date +%s) - script_start_s ))"
      ),
      subtractsTailMarginFromCeiling: command.includes(
        "pi_budget_s=$(( PIWF_COMMAND_TIMEOUT_SECONDS - pi_elapsed_s - PIWF_PI_INVOKE_TAIL_MARGIN_SECONDS ))"
      ),
    }).toStrictEqual({
      attributesTimeoutToPiInvoke: true,
      boundsPiInvokeWithTimeout: true,
      capturesScriptStartEpoch: true,
      clampsBudgetToAtLeastOneSecond: true,
      derivesBudgetFromElapsed: true,
      subtractsTailMarginFromCeiling: true,
    });
  });

  it("converts a hung pi-invoke into a bounded, attributable failure that reaches the post-pi steps", () => {
    // Hostile double (polite fakes recur because doubles are politer than prod):
    // slice the REAL pi-invoke block out of buildPiAgentLaneCommand() and run it
    // verbatim against a `pi` that hangs. Production transport — the budget
    // arithmetic, the `timeout` wrapper, the exit-124 attribution — is exercised
    // byte-for-byte; only the pi binary is faked. A pre-fix unbounded `pi` would run
    // the fake's full sleep and exit 0 with no attribution line, failing all three
    // signals. That is exactly the regression this guards.
    const blockStart = command.indexOf('pi_mode_args=""');
    const blockEnd = command.indexOf("\nmark normalize-output");
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      throw new Error(
        "Could not locate the pi-invoke block in the lane command."
      );
    }
    const piInvokeBlock = command.slice(blockStart, blockEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-pi-hang-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      // A pi that never returns on its own. 20s dwarfs the 2s budget, so any non-124
      // exit means the self-bound `timeout` was missing or wrong.
      const fakePi = join(binDir, "pi");
      writeFileSync(fakePi, "#!/usr/bin/env bash\nsleep 20\n");
      chmodSync(fakePi, 0o755);

      const promptPath = join(dir, "prompt.txt");
      writeFileSync(promptPath, "verify the primary source");
      const rawOutputPath = join(dir, "raw.txt");
      const stderrPath = join(dir, "stderr.txt");

      const harness = [
        "set -u",
        "script_start_s=$(date +%s)",
        piInvokeBlock,
        "printf 'POST_PI_REACHED pi_status=%s\\n' \"$pi_status\"",
      ].join("\n");

      const stdout = execFileSync("bash", ["-c", harness], {
        encoding: "utf-8",
        env: {
          ...process.env,
          LANE_OUTPUT_MEDIA_TYPE: "text/markdown",
          LANE_PROMPT_PATH: promptPath,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          PIWF_COMMAND_TIMEOUT_SECONDS: "3",
          PIWF_PI_INVOKE_TAIL_MARGIN_SECONDS: "1",
          PI_MODEL: "fake-model",
          PI_PROVIDER: "fake-provider",
          raw_output_path: rawOutputPath,
          stderr_path: stderrPath,
        },
        timeout: 15_000,
      });

      const stderr = existsSync(stderrPath)
        ? readFileSync(stderrPath, "utf-8")
        : "";

      expect({
        attributesWedgeToPiInvoke:
          stderr.includes("[pi-invoke self-bound]") &&
          stderr.includes("pi-invoke as the wedge step"),
        reachedPostPiSteps: stdout.includes("POST_PI_REACHED"),
        timedOutWithExit124: stdout.includes("POST_PI_REACHED pi_status=124"),
      }).toStrictEqual({
        attributesWedgeToPiInvoke: true,
        reachedPostPiSteps: true,
        timedOutWithExit124: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("bounds the raw pi-output capture at the source so a runaway stream cannot ENOSPC the lane (wound #30)", () => {
    // Hostile double for wound #30 ([[polite-fakes-franchise-wound]]): slice the REAL
    // pi-invoke capture block out of buildPiAgentLaneCommand() and run it verbatim
    // against a `pi` that SPEWS far more than the cap — the production transport for
    // the live failure (a8bc84dc/53cc30a4: raw_output_bytes 1084434255 on a 1.81 GB
    // lite disk → build-receipt cp ENOSPC, exit 143). A polite mock that emitted a few
    // bytes would never exercise the bound; this fake emits 512 KiB against a 4096-byte
    // cap so head -c MUST truncate to disk. The pre-fix capture was a bare
    // `pi ... > "$raw_output_path"`: it wrote the FULL 512 KiB (1 GB in prod) with no
    // cap, no truncation notice, and no diagnostic — flipping every signal below, and
    // on the lite disk poisoning every downstream cp/hash/git step with ENOSPC.
    const blockStart = command.indexOf('pi_mode_args=""');
    const blockEnd = command.indexOf("\nmark normalize-output");
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      throw new Error(
        "Could not locate the pi-invoke block in the lane command."
      );
    }
    const piInvokeBlock = command.slice(blockStart, blockEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-pi-runaway-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      // A runaway/looping agent: spew 512 KiB — orders of magnitude over the 4096-byte
      // test cap and over a 64 KiB pipe buffer, so head -c definitively bounds the file
      // regardless of whether pi exits 0 (fully buffered) or takes SIGPIPE mid-stream.
      const fakePi = join(binDir, "pi");
      writeFileSync(
        fakePi,
        "#!/usr/bin/env bash\nhead -c 524288 /dev/zero | tr '\\0' 'x'\n"
      );
      chmodSync(fakePi, 0o755);

      const promptPath = join(dir, "prompt.txt");
      writeFileSync(promptPath, "verify the primary source");
      const rawOutputPath = join(dir, "raw.txt");
      const stderrPath = join(dir, "stderr.txt");
      const diagnosticsPath = join(dir, "diagnostics.txt");

      const harness = [
        "set -u",
        "script_start_s=$(date +%s)",
        `diag() { printf '%s\\n' "$1" >> "${diagnosticsPath}" 2>/dev/null || true; }`,
        piInvokeBlock,
        "printf 'POST_PI_REACHED pi_status=%s\\n' \"$pi_status\"",
      ].join("\n");

      const stdout = execFileSync("bash", ["-c", harness], {
        encoding: "utf-8",
        env: {
          ...process.env,
          LANE_OUTPUT_MEDIA_TYPE: "application/json",
          LANE_PROMPT_PATH: promptPath,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          PIWF_COMMAND_TIMEOUT_SECONDS: "5",
          PIWF_PI_INVOKE_TAIL_MARGIN_SECONDS: "1",
          PIWF_RAW_OUTPUT_CAP_BYTES: "4096",
          PI_MODEL: "fake-model",
          PI_PROVIDER: "fake-provider",
          raw_output_path: rawOutputPath,
          stderr_path: stderrPath,
        },
        timeout: 15_000,
      });

      const rawBytes = existsSync(rawOutputPath)
        ? readFileSync(rawOutputPath).length
        : -1;
      const stderr = existsSync(stderrPath)
        ? readFileSync(stderrPath, "utf-8")
        : "";
      const diagnostics = existsSync(diagnosticsPath)
        ? readFileSync(diagnosticsPath, "utf-8")
        : "";

      expect({
        // The capture is bounded to the cap — a 1 GB spew can never reach disk.
        boundedRawCaptureToCap: rawBytes === 4096,
        // The runaway is named in the diagnostics channel that rides out on the blocker.
        diagnosedRunaway: diagnostics.includes("pi-invoke raw_output_capped"),
        // The runaway is named in pi's stderr tail that the receipt carries.
        namedRunawayInStderr: stderr.includes("[pi-invoke output cap]"),
        // The lane reaches the post-pi steps instead of dying in an ENOSPC cascade.
        reachedPostPiSteps: stdout.includes("POST_PI_REACHED"),
      }).toStrictEqual({
        boundedRawCaptureToCap: true,
        diagnosedRunaway: true,
        namedRunawayInStderr: true,
        reachedPostPiSteps: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("a failed normalize whose recovery copy also fails does NOT abort the lane blind (wound #25)", () => {
    // Hostile double for wound #25: slice the REAL normalize-output recovery block
    // out of buildPiAgentLaneCommand() and run it verbatim under production's
    // `set -eu`, with the JSON normalizer forced to fail (fake `node` exits 1) AND
    // the raw-output source MISSING so the recovery copy cannot succeed — exactly
    // the production conditions (pi exit 0, normalize fails, the verbatim copy of
    // the raw output into LANE_OUTPUT_PATH fails). The pre-fix recovery was a BARE
    // `cp "$raw_output_path" "$LANE_OUTPUT_PATH"`: under `set -eu` that exit-1
    // ABORTED the whole lane at normalize-output, the cp error went to the script's
    // OWN stderr (an uncaptured channel), the blocker fell back to the benign
    // empty-repo clone log, and the planner forged a blind `adapter_unavailable`
    // that was re-driven for 40 minutes. All three signals below flip against that
    // pre-fix code: it never reaches the sentinel, never leaves an output file, and
    // never captures the copy error. The fix must (1) not abort, (2) guarantee
    // LANE_OUTPUT_PATH exists for the downstream hash/add/commit steps, and (3) tee
    // the copy failure into stderr_path so the marker is not blind.
    const blockStart = command.indexOf("mark normalize-output");
    const blockEnd = command.indexOf("\ncompleted_at=");
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      throw new Error(
        "Could not locate the normalize-output recovery block in the lane command."
      );
    }
    const normalizeBlock = command.slice(blockStart, blockEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-normalize-recovery-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      // A `node` that fails so the JSON-lane normalizer takes the recovery branch.
      // Faithful to production: the normalizer RECORDS its outcome, THEN exits
      // non-zero — so wound #26's "no outcome file => normalize_timeout" shim does not
      // fire here. This wound is the recovery COPY failing, not a killed normalize.
      const fakeNode = join(binDir, "node");
      writeFileSync(
        fakeNode,
        [
          "#!/usr/bin/env bash",
          "cat >/dev/null",
          `printf '{"normalized":false,"reason":"no_parseable_output","agentStopReason":null,"detail":"fake parse failure"}\\n' > "$LANE_OUTPUT_NORMALIZATION_PATH"`,
          "exit 1",
          "",
        ].join("\n")
      );
      chmodSync(fakeNode, 0o755);

      const stderrPath = join(dir, "stderr.txt");
      // Dest lives under a not-yet-created subdir to also exercise the recovery's
      // `mkdir -p "$(dirname ...)"`, matching production's relative run/ output path.
      const outputPath = join(dir, "run", "planner-blueprint.json");
      const normalizationOutcomePath = join(dir, "normalization.json");
      // Source is intentionally MISSING so the recovery copy fails like production.
      const missingRawPath = join(dir, "raw-MISSING.txt");

      const harness = [
        "set -eu",
        "mark() { :; }",
        "script_start_s=$(date +%s)",
        normalizeBlock,
        "printf 'POST_RECOVERY_REACHED normalized=%s\\n' \"$output_normalized\"",
      ].join("\n");

      const stdout = execFileSync("bash", ["-c", harness], {
        encoding: "utf-8",
        env: {
          ...process.env,
          LANE_OUTPUT_MEDIA_TYPE: "application/json",
          LANE_OUTPUT_NORMALIZATION_PATH: normalizationOutcomePath,
          LANE_OUTPUT_PATH: outputPath,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          PIWF_COMMAND_TIMEOUT_SECONDS: "600",
          PIWF_NORMALIZE_MAX_SECONDS: "60",
          PIWF_NORMALIZE_TAIL_MARGIN_SECONDS: "20",
          raw_output_path: missingRawPath,
          stderr_path: stderrPath,
        },
        timeout: 15_000,
      });

      const stderr = existsSync(stderrPath)
        ? readFileSync(stderrPath, "utf-8")
        : "";
      const output = existsSync(outputPath)
        ? readFileSync(outputPath, "utf-8")
        : null;

      expect({
        // (3) the copy failure is captured into stderr_path — the marker is not blind
        capturedCopyErrorForTheMarker:
          stderr.length > 0 && /No such file or directory/u.test(stderr),
        // (2) LANE_OUTPUT_PATH exists so downstream hash/add/commit never abort
        leftOutputFile: output !== null,
        // (1) the recovery did not abort the lane under set -eu
        reachedPostRecovery: stdout.includes(
          "POST_RECOVERY_REACHED normalized=0"
        ),
        wroteRecoveryPlaceholder:
          output?.includes("[agent-lane recovery]") ?? false,
      }).toStrictEqual({
        capturedCopyErrorForTheMarker: true,
        leftOutputFile: true,
        reachedPostRecovery: true,
        wroteRecoveryPlaceholder: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("self-bounds the normalize-output node to a small budget so a runaway grind cannot ride to the SIGKILL (wound #26)", () => {
    // Wound #26 was structural and the twin of #22-B: normalize-output was a BARE
    // `node <<NODE` with no inner bound — the ONE heavy post-pi step with no timeout.
    // On a pathological pi output the normalizer grinds for minutes under memory
    // pressure on the lite instance, and because bash cannot service the MIDDLE
    // whole-script SIGTERM while blocked on that busy FOREGROUND node, the grind rode
    // PAST the recoverable SIGTERM into the OUTER sandbox.exec SIGKILL: no trap, no
    // marker, a blind blocker. The fix wraps node in a `timeout -s KILL` derived from
    // the remaining budget but capped small, and stamps a NAMED reason when the killed
    // node leaves no outcome file. These assertions fail against the pre-fix bare node.
    expect({
      attributesTimeoutToNormalize:
        command.includes("[normalize-output self-bound]") &&
        command.includes(
          "the heartbeat names normalize-output as the wedge step"
        ),
      boundsNormalizeWithKillTimeout: command.includes(
        'timeout -s KILL "$normalize_budget_s" node'
      ),
      capsBudgetToTheMax: command.includes(
        'if [ "$normalize_budget_s" -gt "$PIWF_NORMALIZE_MAX_SECONDS" ]; then'
      ),
      clampsBudgetToAtLeastOneSecond: command.includes(
        'if [ "$normalize_budget_s" -lt 1 ]; then'
      ),
      clearsStaleOutcomeBeforeRun: command.includes(
        'rm -f "$LANE_OUTPUT_NORMALIZATION_PATH"'
      ),
      derivesBudgetFromElapsed: command.includes(
        "normalize_elapsed_s=$(( $(date +%s) - script_start_s ))"
      ),
      stampsNamedTimeoutWhenNodeLeftNoOutcome:
        command.includes(
          'if [ ! -s "$LANE_OUTPUT_NORMALIZATION_PATH" ]; then'
        ) && command.includes('"reason":"normalize_timeout"'),
      subtractsTailMarginFromCeiling: command.includes(
        "normalize_budget_s=$(( PIWF_COMMAND_TIMEOUT_SECONDS - normalize_elapsed_s - PIWF_NORMALIZE_TAIL_MARGIN_SECONDS ))"
      ),
    }).toStrictEqual({
      attributesTimeoutToNormalize: true,
      boundsNormalizeWithKillTimeout: true,
      capsBudgetToTheMax: true,
      clampsBudgetToAtLeastOneSecond: true,
      clearsStaleOutcomeBeforeRun: true,
      derivesBudgetFromElapsed: true,
      stampsNamedTimeoutWhenNodeLeftNoOutcome: true,
      subtractsTailMarginFromCeiling: true,
    });
  });

  it("converts a runaway normalize into a bounded, named normalize_timeout failure that reaches the post-pi steps (wound #26)", () => {
    // Hostile double for wound #26: slice the REAL normalize-output block out of
    // buildPiAgentLaneCommand() and run it verbatim under production's `set -eu` with a
    // `node` that NEVER returns (sleep 20 dwarfs the 2s budget). Production transport —
    // the budget arithmetic, the `timeout -s KILL` wrapper, the absent-outcome stamp —
    // is exercised byte-for-byte; only the node binary is faked. A pre-fix unbounded
    // `node` would run the full 20s grind (and in production keep grinding until the
    // OUTER SIGKILL), leaving no outcome and a blind blocker. The fix must (1) bound the
    // grind to ~2s, (2) stamp reason:"normalize_timeout" so the receipt commits
    // status:"failed" honestly, (3) leave LANE_OUTPUT_PATH for the downstream steps, and
    // (4) attribute the wedge to normalize-output in the captured stderr.
    const blockStart = command.indexOf("mark normalize-output");
    const blockEnd = command.indexOf("\ncompleted_at=");
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      throw new Error(
        "Could not locate the normalize-output block in the lane command."
      );
    }
    const normalizeBlock = command.slice(blockStart, blockEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-normalize-timeout-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      // A `node` that never returns on its own — the grind that wedged the lane. It
      // drains stdin (the heredoc normalizer script) then sleeps far past the budget,
      // and it writes NO outcome file, exactly like a real OOM/timeout SIGKILL.
      const fakeNode = join(binDir, "node");
      writeFileSync(
        fakeNode,
        "#!/usr/bin/env bash\ncat >/dev/null\nsleep 20\n"
      );
      chmodSync(fakeNode, 0o755);

      const stderrPath = join(dir, "stderr.txt");
      const outputPath = join(dir, "run", "planner-blueprint.json");
      const normalizationOutcomePath = join(dir, "normalization.json");
      // Raw output EXISTS so the recovery copy succeeds — this test is about the
      // timeout, not the copy failure (#25 covers the failing copy).
      const rawOutputPath = join(dir, "raw.txt");
      writeFileSync(rawOutputPath, '{"unparseable":"event stream"}\n');

      const harness = [
        "set -eu",
        "mark() { :; }",
        "script_start_s=$(date +%s)",
        normalizeBlock,
        "printf 'POST_RECOVERY_REACHED normalized=%s\\n' \"$output_normalized\"",
      ].join("\n");

      const startedAt = Date.now();
      const stdout = execFileSync("bash", ["-c", harness], {
        encoding: "utf-8",
        env: {
          ...process.env,
          LANE_OUTPUT_MEDIA_TYPE: "application/json",
          LANE_OUTPUT_NORMALIZATION_PATH: normalizationOutcomePath,
          LANE_OUTPUT_PATH: outputPath,
          PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
          // Huge remaining budget so the MAX cap (2s), not the ceiling, bounds it.
          PIWF_COMMAND_TIMEOUT_SECONDS: "600",
          PIWF_NORMALIZE_MAX_SECONDS: "2",
          PIWF_NORMALIZE_TAIL_MARGIN_SECONDS: "5",
          raw_output_path: rawOutputPath,
          stderr_path: stderrPath,
        },
        timeout: 18_000,
      });
      const elapsedMs = Date.now() - startedAt;

      const stderr = existsSync(stderrPath)
        ? readFileSync(stderrPath, "utf-8")
        : "";
      const outcomeRaw: unknown = existsSync(normalizationOutcomePath)
        ? JSON.parse(readFileSync(normalizationOutcomePath, "utf-8"))
        : null;
      const outcome = isRecord(outcomeRaw) ? outcomeRaw : null;
      const output = existsSync(outputPath)
        ? readFileSync(outputPath, "utf-8")
        : null;

      expect({
        // (4) the wedge is attributed to normalize-output, not a blind step
        attributedToNormalize: stderr.includes("[normalize-output self-bound]"),
        // (1) the grind is bounded far under the fake's 20s sleep
        boundedWellUnderTheGrind: elapsedMs < 12_000,
        // (3) LANE_OUTPUT_PATH exists so downstream hash/add/commit never abort
        leftOutputFile: output !== null,
        // (2) a NAMED, honest failure the receipt can commit as status:"failed"
        namedNormalizeTimeout:
          outcome?.["normalized"] === false &&
          outcome?.["reason"] === "normalize_timeout",
        reachedPostRecovery: stdout.includes(
          "POST_RECOVERY_REACHED normalized=0"
        ),
      }).toStrictEqual({
        attributedToNormalize: true,
        boundedWellUnderTheGrind: true,
        leftOutputFile: true,
        namedNormalizeTimeout: true,
        reachedPostRecovery: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 25_000);

  it("runs the failure marker on a whole-script SIGTERM, not just a clean exit", () => {
    // Wound #22 Layer C: the self-bound pi-invoke fires, but pi can eat its whole
    // budget and leave the post-pi tail (normalize/transcript/receipt/commit/push) too
    // little time. When the tail overruns, the MIDDLE whole-script shell `timeout`
    // reaps with SIGTERM — and a bare signal kills bash WITHOUT running an EXIT-only
    // trap, so pi's stderr was never captured and the blocker named a step with no
    // cause (observed live: a causeless "Command timeout after 480000ms"). The fix
    // traps INT/TERM to run the SAME failure marker, which carries pi's stderr tail.
    expect({
      backstopsWithExitTrap: command.includes("trap emit_failure_marker EXIT"),
      signalHandlerExitsAfterMarker: command.includes("exit 143"),
      signalHandlerRunsMarker: /on_signal\(\)\s*\{\s*emit_failure_marker/u.test(
        command
      ),
      trapsSignalsNotJustExit: command.includes("trap on_signal INT TERM"),
    }).toStrictEqual({
      backstopsWithExitTrap: true,
      signalHandlerExitsAfterMarker: true,
      signalHandlerRunsMarker: true,
      trapsSignalsNotJustExit: true,
    });
  });

  it("emits a failure marker carrying pi's stderr when the whole script is SIGTERM'd mid-tail", () => {
    // Hostile double for Layer C: slice the REAL marker+trap machinery out of
    // buildPiAgentLaneCommand() and run it verbatim, then deliver the whole-script
    // reaper signal with `kill -TERM $$` while a tail step is in flight. Production
    // transport — the on_signal handler, emit_failure_marker, the credential scrub,
    // the base64 marker contract — is exercised byte-for-byte; only the SIGTERM source
    // is faked. The pre-fix EXIT-only trap would NOT run on this signal, so no marker
    // reaches stdout and pi's stderr is lost. That is exactly the regression this guards.
    const trapSetupStart = command.indexOf("marker_emitted=0");
    const trapSetupEnd = command.indexOf("\nmark install-pi-agent");
    if (
      trapSetupStart === -1 ||
      trapSetupEnd === -1 ||
      trapSetupEnd <= trapSetupStart
    ) {
      throw new Error(
        "Could not locate the marker+trap machinery in the lane command."
      );
    }
    const trapSetup = command.slice(trapSetupStart, trapSetupEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-sigterm-"));
    try {
      // emit_failure_marker shells out to bare `node`; guarantee it resolves to this
      // runtime regardless of the test host's PATH.
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      const nodeShim = join(binDir, "node");
      writeFileSync(
        nodeShim,
        `#!/usr/bin/env bash\nexec ${process.execPath} "$@"\n`
      );
      chmodSync(nodeShim, 0o755);

      const stderrPath = join(dir, "stderr.txt");
      // What pi left behind before the tail starved: a credential-bearing transport
      // line (must be scrubbed) plus the self-bound attribution.
      writeFileSync(
        stderrPath,
        [
          "pi: clone https://x:supersecrettoken@artifacts.example/run.git failed: timeout",
          "[pi-invoke self-bound] pi exceeded its 2s budget; the heartbeat names pi-invoke as the wedge step.",
          "",
        ].join("\n")
      );

      const harness = [
        "set -u",
        trapSetup,
        // Override the hardcoded /workspace paths to test-controlled ones; the trap
        // reads $stderr_path at fire time, so the override takes effect.
        `stderr_path="${stderrPath}"`,
        // Simulate the moment the tail starved: pi already self-bounded (124) and the
        // script is mid-push when the whole-script reaper fires.
        'current_step="git-push"',
        "pi_status=124",
        "kill -TERM $$",
        // Neither line may run: the TERM trap must emit the marker and exit first.
        "sleep 5",
        "printf 'TAIL_COMPLETED\\n'",
      ].join("\n");

      // bash exits 143 (128 + SIGTERM) via the handler; the marker rides on stdout.
      const stdout = captureBashStdout(harness, {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      });

      const payload = decodeAgentLaneMarker(stdout);
      const stderrTail = markerString(payload, "stderrTail");

      expect({
        carriesPiStderr: stderrTail.includes("[pi-invoke self-bound]"),
        emittedErrorMarker: payload?.["status"] === "error",
        namesFailingStep: payload?.["failingStep"] === "git-push",
        preservesPiStatus: payload?.["piStatus"] === 124,
        scrubsCredentialsInStderr:
          stderrTail.includes("https://x:***@") &&
          !stderrTail.includes("supersecrettoken"),
        tailNeverCompleted: !stdout.includes("TAIL_COMPLETED"),
      }).toStrictEqual({
        carriesPiStderr: true,
        emittedErrorMarker: true,
        namesFailingStep: true,
        preservesPiStatus: true,
        scrubsCredentialsInStderr: true,
        tailNeverCompleted: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 20_000);

  it("falls back to a shell-only marker when node cannot emit under resource exhaustion", () => {
    // Hostile double for wound #23-A: the rich failure marker is built by node, but
    // node is the SAME runtime that OOMs during the normalize grind that breaks the
    // lane — so the recovery shared the failure mode of the failure it recovers and
    // the planner got a blind "did not emit a result marker." Here `node` is shimmed
    // to die like an OOM-kill (exit 137, no stdout, no sentinel). The shell-only
    // fallback (printf + base64, no V8 heap) must still surface a VALID error marker
    // naming the failing step, so the cause always reaches the planner.
    const trapSetupStart = command.indexOf("marker_emitted=0");
    const trapSetupEnd = command.indexOf("\nmark install-pi-agent");
    if (
      trapSetupStart === -1 ||
      trapSetupEnd === -1 ||
      trapSetupEnd <= trapSetupStart
    ) {
      throw new Error(
        "Could not locate the marker+trap machinery in the lane command."
      );
    }
    const trapSetup = command.slice(trapSetupStart, trapSetupEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-oom-marker-"));
    try {
      // node shim simulates an OOM-kill: writes nothing, never touches the sentinel,
      // exits 137. emit_failure_marker therefore sees no sentinel and must shell out.
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      const nodeShim = join(binDir, "node");
      writeFileSync(nodeShim, "#!/usr/bin/env bash\nexit 137\n");
      chmodSync(nodeShim, 0o755);

      const harness = [
        "set -u",
        trapSetup,
        // The OOM struck during the normalize step; pi itself had already exited 0.
        'current_step="normalize-output"',
        "pi_status=0",
        // Exit with the OOM-kill code so the marker carries a real exitCode.
        "exit 137",
      ].join("\n");

      const stdout = captureBashStdout(harness, {
        ...process.env,
        PATH: `${binDir}:${process.env["PATH"] ?? ""}`,
      });

      const payload = decodeAgentLaneMarker(stdout);
      const stderrTail = markerString(payload, "stderrTail");
      const markerCount = (stdout.match(/__PIWF_AGENT_LANE_RESULT__/gu) ?? [])
        .length;

      expect({
        carriesDegradedRecoveryNote: stderrTail.includes("degraded recovery"),
        emittedErrorMarker: payload?.["status"] === "error",
        exactlyOneMarker: markerCount === 1,
        namesFailingStep: payload?.["failingStep"] === "normalize-output",
        nodeNeverWroteRichMarker: !stderrTail.includes("self-bound"),
        preservesExitCode: payload?.["exitCode"],
        preservesPiStatus: payload?.["piStatus"],
      }).toStrictEqual({
        carriesDegradedRecoveryNote: true,
        emittedErrorMarker: true,
        exactlyOneMarker: true,
        namesFailingStep: true,
        nodeNeverWroteRichMarker: true,
        preservesExitCode: 137,
        preservesPiStatus: 0,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 20_000);

  it("bounds and diagnoses the transcript so an oversized output cannot ENOSPC the lane (wound #29)", () => {
    // Hostile double for wound #29: slice the REAL build-transcript block out of
    // buildPiAgentLaneCommand() and run it verbatim under production's `set -eu`
    // with an OVERSIZED raw output AND an oversized LANE_OUTPUT_PATH (the failed-
    // normalize persist copy) — exactly the live conditions where the bare
    // `> "$LANE_TRANSCRIPT_PATH"` redirect concatenated raw(1x) + lane(~1x) into the
    // transcript(~2x), peaked at ~4x on the lite disk, and tripped ENOSPC under
    // set -e with no marker and no receipt (two live runs named build-transcript:
    // a8bc84dc + f9a37a09). The pre-fix block left the transcript UNBOUNDED and
    // wrote NO diagnostics — both signals below flip against it: it would embed the
    // full 4096-byte raw output with no truncation notice, and record no sizes.
    const blockStart = command.indexOf("mark build-transcript");
    const blockEnd = command.indexOf("\nmark hash-artifacts");
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      throw new Error(
        "Could not locate the build-transcript block in the lane command."
      );
    }
    const transcriptBlock = command.slice(blockStart, blockEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-transcript-bound-"));
    try {
      const rawOutputPath = join(dir, "raw.txt");
      const laneOutputPath = join(dir, "lane-output.txt");
      const stderrPath = join(dir, "stderr.txt");
      const transcriptPath = join(dir, "transcript.md");
      const diagnosticsPath = join(dir, "diagnostics.txt");
      writeFileSync(rawOutputPath, "R".repeat(4096));
      writeFileSync(laneOutputPath, "N".repeat(4096));
      writeFileSync(stderrPath, "stderr-tail");

      const harness = [
        "set -eu",
        "mark() { :; }",
        'diag() { printf \'%s\\n\' "$1" >> "$diagnostics_path" 2>/dev/null || true; }',
        transcriptBlock,
        "printf 'POST_TRANSCRIPT_REACHED\\n'",
      ].join("\n");

      const stdout = execFileSync("bash", ["-c", harness], {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          LANE_ID: "lane-test",
          LANE_OUTPUT_PATH: laneOutputPath,
          LANE_TRANSCRIPT_PATH: transcriptPath,
          PIWF_TRANSCRIPT_SECTION_CAP_BYTES: "1024",
          RUN_ID: "run-test",
          WORKFLOW_SPAN_ID: "span-test",
          WORKFLOW_TRACE_ID: "trace-test",
          WORK_ITEM_ID: "work-test",
          diagnostics_path: diagnosticsPath,
          pi_status: "0",
          raw_output_path: rawOutputPath,
          stderr_path: stderrPath,
        },
        timeout: 15_000,
      });

      const transcript = readFileSync(transcriptPath, "utf-8");
      const diagnostics = existsSync(diagnosticsPath)
        ? readFileSync(diagnosticsPath, "utf-8")
        : "";

      expect({
        // the transcript can never balloon past its inputs: each section is capped,
        // so the file is far smaller than the un-capped raw(4096)+lane(4096) concat
        boundedBelowInputs: transcript.length < 4096,
        diagnosticsNamesLaneBytes: diagnostics.includes(
          "lane_output_bytes: 4096"
        ),
        diagnosticsNamesRawBytes: diagnostics.includes(
          "raw_output_bytes: 4096"
        ),
        diagnosticsNamesWriteExit: diagnostics.includes("write_exit: 0"),
        reachedPostTranscript: stdout.includes("POST_TRANSCRIPT_REACHED"),
        wroteTruncationNotice: transcript.includes("[transcript truncated:"),
      }).toStrictEqual({
        boundedBelowInputs: true,
        diagnosticsNamesLaneBytes: true,
        diagnosticsNamesRawBytes: true,
        diagnosticsNamesWriteExit: true,
        reachedPostTranscript: true,
        wroteTruncationNotice: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);

  it("a transcript write that cannot open its target does NOT abort the lane blind (wound #29)", () => {
    // Hostile double: same REAL build-transcript block, but the transcript path's
    // parent is a regular FILE, so the redirect cannot be opened (ENOTDIR) — a
    // cross-platform proxy for the live ENOSPC on the lite disk. The pre-fix bare
    // redirect under set -e ABORTED the lane here (no marker, no receipt, blind
    // re-drive); the fix wraps the write in set +e, records the failing exit to the
    // diagnostics channel, and continues so the lane still commits an honest result.
    const blockStart = command.indexOf("mark build-transcript");
    const blockEnd = command.indexOf("\nmark hash-artifacts");
    if (blockStart === -1 || blockEnd === -1 || blockEnd <= blockStart) {
      throw new Error(
        "Could not locate the build-transcript block in the lane command."
      );
    }
    const transcriptBlock = command.slice(blockStart, blockEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-transcript-enospc-"));
    try {
      const rawOutputPath = join(dir, "raw.txt");
      const laneOutputPath = join(dir, "lane-output.txt");
      const stderrPath = join(dir, "stderr.txt");
      const diagnosticsPath = join(dir, "diagnostics.txt");
      // The transcript's PARENT is a regular file, not a directory: opening the
      // redirect fails with ENOTDIR — a portable stand-in for the live ENOSPC.
      const blockerFile = join(dir, "not-a-dir");
      writeFileSync(blockerFile, "x");
      const transcriptPath = join(blockerFile, "transcript.md");
      writeFileSync(rawOutputPath, "raw");
      writeFileSync(laneOutputPath, "normalized");
      writeFileSync(stderrPath, "stderr-tail");

      const harness = [
        "set -eu",
        "mark() { :; }",
        'diag() { printf \'%s\\n\' "$1" >> "$diagnostics_path" 2>/dev/null || true; }',
        transcriptBlock,
        "printf 'POST_TRANSCRIPT_REACHED\\n'",
      ].join("\n");

      const stdout = execFileSync("bash", ["-c", harness], {
        cwd: dir,
        encoding: "utf-8",
        env: {
          ...process.env,
          LANE_ID: "lane-test",
          LANE_OUTPUT_PATH: laneOutputPath,
          LANE_TRANSCRIPT_PATH: transcriptPath,
          PIWF_TRANSCRIPT_SECTION_CAP_BYTES: "1024",
          RUN_ID: "run-test",
          WORKFLOW_SPAN_ID: "span-test",
          WORKFLOW_TRACE_ID: "trace-test",
          WORK_ITEM_ID: "work-test",
          diagnostics_path: diagnosticsPath,
          pi_status: "0",
          raw_output_path: rawOutputPath,
          stderr_path: stderrPath,
        },
        // the redirect-open failure is the POINT of this case; bash reports it on
        // the script's own stderr before the inner 2>/dev/null applies, so silence
        // the child's stderr to keep the suite output clean (we assert on stdout +
        // the diagnostics file, which carry the real signal).
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      });

      const diagnostics = existsSync(diagnosticsPath)
        ? readFileSync(diagnosticsPath, "utf-8")
        : "";

      expect({
        diagnosticsNamesDiskState: diagnostics.includes("disk:"),
        diagnosticsRecordsFailedWrite: /write_exit: [1-9]/u.test(diagnostics),
        reachedPostTranscript: stdout.includes("POST_TRANSCRIPT_REACHED"),
      }).toStrictEqual({
        diagnosticsNamesDiskState: true,
        diagnosticsRecordsFailedWrite: true,
        reachedPostTranscript: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 15_000);
});

describe(buildAgentLanePackageMountIndex, () => {
  it("turns pinned packages into sanitized sandbox mount records", () => {
    const pinnedPackage = buildPinnedPackageFixture();
    const mountIndex = buildAgentLanePackageMountIndex([pinnedPackage]);

    expect({
      mountPath: mountIndex.mounts.at(0)?.mountPath,
      packageId: mountIndex.mounts.at(0)?.metadata.packageId,
      redacted: mountIndex.redacted,
      schemaVersion: mountIndex.schemaVersion,
      scopedPackagePath: mountedPackagePathFor("@joelhooks/shitrat-kernel"),
    }).toStrictEqual({
      mountPath: "packages/badass-courses_claw-kernel",
      packageId: "badass-courses/claw-kernel",
      redacted: true,
      schemaVersion: "agent-lane.package-mounts.v1",
      scopedPackagePath: "packages/_joelhooks_shitrat-kernel",
    });
  });

  it("rejects package ids that collide after path sanitization", () => {
    expect(() =>
      buildAgentLanePackageMountIndex([
        buildPinnedPackageFixture({
          artifactRef: "artifact://packages/a-b/refs/v1",
          packageId: "a/b",
        }),
        buildPinnedPackageFixture({
          artifactRef: "artifact://packages/a_b/refs/v1",
          packageId: "a_b",
        }),
      ])
    ).toThrow("Package mount path collision");
  });
});

describe(agentLanePackageMountWriterNodeScript, () => {
  it("writes a package mount index plus manifest and pin files", () => {
    const pinnedPackage = buildPinnedPackageFixture();
    const mountIndex = buildAgentLanePackageMountIndex([pinnedPackage]);
    const mount = mountIndex.mounts.at(0);
    if (mount === undefined) {
      throw new Error("Expected one package mount.");
    }
    const cwd = mkdtempSync(join(tmpdir(), "piwf-package-mounts-"));

    try {
      execFileSync(
        process.execPath,
        ["-e", agentLanePackageMountWriterNodeScript],
        {
          cwd,
          env: {
            ...process.env,
            LANE_PACKAGE_MOUNT_INDEX_JSON: JSON.stringify(mountIndex),
          },
        }
      );

      const writtenIndex = AgentLanePackageMountIndexSchema.parse(
        JSON.parse(
          readFileSync(join(cwd, "packages", "pinned-packages.json"), "utf-8")
        )
      );
      const writtenManifest = PackageMetadataSchema.parse(
        JSON.parse(
          readFileSync(join(cwd, mount.mountPath, "package.json"), "utf-8")
        )
      );
      const writtenPin = PackagePinFileSchema.parse(
        JSON.parse(
          readFileSync(join(cwd, mount.mountPath, "pin.json"), "utf-8")
        )
      );

      expect({
        index: writtenIndex,
        manifest: writtenManifest,
        pin: writtenPin,
      }).toStrictEqual({
        index: mountIndex,
        manifest: pinnedPackage.metadata,
        pin: {
          artifactRef: pinnedPackage.artifactRef,
          fileHashes: pinnedPackage.fileHashes,
          manifestHash: pinnedPackage.manifestHash,
          pinnedAt: pinnedPackage.pinnedAt,
          redacted: true,
          version: pinnedPackage.version,
        },
      });
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe("selectLaneAbortDiagnostic — the blocker names WHICH actor halted", () => {
  it("leads with pi's stderr (not the clone log) when pi self-bound", () => {
    // The exact masking from wound #22's live re-drive: pi ran 285s, self-bound
    // (124), then the post-pi tail got SIGTERM'd at normalize-output. The git
    // log only holds the benign clone output; pi's stderr holds the cause.
    const diagnostic = selectLaneAbortDiagnostic({
      gitLogTail:
        "Cloning into '/workspace/piwf-agent-lane'... Switched to a new branch 'planner'",
      piStatus: 124,
      stderrTail:
        "[pi-invoke self-bound] pi exceeded its 283s budget and was terminated by timeout",
    });
    expect(diagnostic).toMatch(/^\[pi-invoke self-bound\]/u);
    expect(diagnostic).toContain("283s budget");
    // The clone log is still appended as context, never as the headline.
    expect(diagnostic).toContain("[git log: Cloning into");
  });

  it("leads with the git log when pi never ran (a pre-pi clone failure)", () => {
    const diagnostic = selectLaneAbortDiagnostic({
      gitLogTail: "fatal: could not read from remote repository",
      piStatus: null,
      stderrTail: "",
    });
    expect(diagnostic).toBe("fatal: could not read from remote repository");
  });

  it("falls back across tails and never emits an empty diagnostic", () => {
    expect(
      selectLaneAbortDiagnostic({ gitLogTail: "", piStatus: 1, stderrTail: "" })
    ).toBe("no diagnostic output");
    // pi ran but wrote nothing to stderr — surface the git log rather than blank.
    expect(
      selectLaneAbortDiagnostic({
        gitLogTail: "error: failed to push some refs",
        piStatus: 0,
        stderrTail: "",
      })
    ).toBe("error: failed to push some refs");
  });
});

describe("classifyAgentLaneIncompleteFailure — heartbeat names a burned agent run vs a transport outage (wound #28)", () => {
  // The EXACT step heartbeat the live re-drive run-live-20260614T165913566Z-a8bc84dc
  // left behind: pi-invoke ran 456s (1781456448 → 1781456904), normalize-output 67s,
  // then the lane FROZE at build-transcript and aborted under `set -e` with exit 1 and
  // no usable result marker. The executor reads /workspace/.piwf-heartbeat and joins
  // the last 20 lines with " | " — this is that joined tail, byte-for-byte.
  const liveA8bc84dcHeartbeatTail = [
    "1781456366 install-pi-agent",
    "1781456441 prepare-auth",
    "1781456441 clone-artifacts",
    "1781456446 checkout-branch",
    "1781456446 mount-packages",
    "1781456448 pi-invoke",
    "1781456904 normalize-output",
    "1781456971 build-transcript",
  ].join(" | ");

  it("classifies the live a8bc84dc no-marker abort as a burned agent run, NOT a transport outage", () => {
    // This is the regression lock on the production failure. Pre-fix, the executor
    // wrapped this into a bare Error and the planner flattened it to the transient
    // `adapter_unavailable`, which blind-re-drove the same burned run for ~40 minutes.
    // The fix keys off the ONE observable fact — the heartbeat reached build-transcript,
    // six steps PAST pi-invoke — so the agent demonstrably ran and the failure is
    // deterministic/lane-internal.
    const classified = classifyAgentLaneIncompleteFailure({
      cause: new Error(
        "Cloudflare Sandbox lane did not emit a result marker (exit 1)."
      ),
      detail: "Cloudflare Sandbox lane did not emit a result marker (exit 1).",
      heartbeatTail: liveA8bc84dcHeartbeatTail,
      runId: "run-live-20260614T165913566Z-a8bc84dc",
      workItemId: "work-a8bc84dc",
    });

    expect(classified).toBeInstanceOf(AgentLaneIncompleteError);
    expect({
      lastStep: classified?.lastStep,
      preservesCause: classified?.cause instanceof Error,
      reachedAgentInvocation: classified?.reachedAgentInvocation,
      runId: classified?.runId,
      // The classifier's message must read "the agent ran, the lane failed" — not a
      // transport outage — so the operator status endpoint stops guessing.
      saysLaneInternal: classified?.message.includes(
        "lane committed no usable result"
      ),
    }).toStrictEqual({
      lastStep: "build-transcript",
      preservesCause: true,
      reachedAgentInvocation: true,
      runId: "run-live-20260614T165913566Z-a8bc84dc",
      saysLaneInternal: true,
    });
  });

  it("classifies an ERROR-marker abort that reached pi-invoke the same way (both funnels share the catch)", () => {
    // The no-marker throw and the error-marker throw both land in the SAME executor
    // catch, so the classifier must treat them identically: what matters is the
    // heartbeat, not which marker (or no marker) came back. Here the lane aborted at
    // build-receipt with an error marker — still a burned agent run.
    const classified = classifyAgentLaneIncompleteFailure({
      cause: new Error('lane aborted at step "build-receipt" (exit 1, pi 0)'),
      detail: 'lane aborted at step "build-receipt" (exit 1, pi 0)',
      heartbeatTail: [
        "1781456448 pi-invoke",
        "1781456904 normalize-output",
        "1781456971 build-transcript",
        "1781456999 hash-artifacts",
        "1781457001 build-receipt",
      ].join(" | "),
      runId: "run-err-marker",
      workItemId: "work-err-marker",
    });

    expect(classified).toBeInstanceOf(AgentLaneIncompleteError);
    expect(classified?.lastStep).toBe("build-receipt");
  });

  it("returns null for a lane that FROZE before pi-invoke — a genuine transport outage stays retryable", () => {
    // Symmetric guard. A sandbox that never became reachable / a clone that failed
    // freezes the heartbeat at an EARLY step and never gets to pi-invoke. That IS the
    // retryable `adapter_unavailable`: null tells the executor to keep its bare
    // transport error so re-driving a transient outage is still correct.
    const frozenAtClone = classifyAgentLaneIncompleteFailure({
      cause: new Error("Cloudflare Sandbox lane did not emit a result marker."),
      detail: "Cloudflare Sandbox lane did not emit a result marker.",
      heartbeatTail: [
        "1781456366 install-pi-agent",
        "1781456441 prepare-auth",
        "1781456441 clone-artifacts",
      ].join(" | "),
      runId: "run-pre-pi",
      workItemId: "work-pre-pi",
    });

    expect(frozenAtClone).toBeNull();
  });

  it("treats a missing/garbled heartbeat as NOT-reached so a corrupt tail fails safe to retryable", () => {
    expect({
      // Empty / whitespace-only tails carry no usable step.
      emptyTail: lastHeartbeatStep(""),
      // A bare epoch with no step token is read verbatim as the token...
      epochOnlyToken: lastHeartbeatStep("1781456448"),
      separatorOnlyTail: lastHeartbeatStep("   |   |  "),
    }).toStrictEqual({
      emptyTail: null,
      epochOnlyToken: "1781456448",
      separatorOnlyTail: null,
    });

    expect({
      // ...but an unknown step token is never "reached pi-invoke" (fails safe).
      garbledEpochToken: laneStepReachedAgentInvocation("1781456448"),
      nullStep: laneStepReachedAgentInvocation(null),
      prePiInvokeStep: laneStepReachedAgentInvocation("install-pi-agent"),
      thePiInvokeStep: laneStepReachedAgentInvocation("pi-invoke"),
      wellPastPiInvoke: laneStepReachedAgentInvocation("git-push"),
    }).toStrictEqual({
      garbledEpochToken: false,
      nullStep: false,
      prePiInvokeStep: false,
      thePiInvokeStep: true,
      wellPastPiInvoke: true,
    });
  });

  it("reads the step the REAL mark() writer stamps — a faithful double of the heartbeat file", () => {
    // Hostile double: slice the REAL mark() function out of buildPiAgentLaneCommand()
    // and run it verbatim to write an actual heartbeat file, then read+join it EXACTLY
    // as the executor does and feed THAT to the classifier. This guarantees the
    // classifier parses the real on-disk format (`<epoch> <step>`) — if anyone changes
    // how mark() stamps steps, this test breaks instead of the live classification.
    const command = buildPiAgentLaneCommand();
    const markStart = command.indexOf("mark() {");
    const markEnd = command.indexOf("\nstarted_at=");
    if (markStart === -1 || markEnd === -1 || markEnd <= markStart) {
      throw new Error(
        "Could not locate the mark() writer in the lane command."
      );
    }
    const markBlock = command.slice(markStart, markEnd);

    const dir = mkdtempSync(join(tmpdir(), "piwf-heartbeat-"));
    try {
      const heartbeatPath = join(dir, "heartbeat");
      // Reproduce the a8bc84dc trajectory through the REAL mark() — install through
      // build-transcript, the post-pi step where the live lane froze.
      const harness = [
        "set -u",
        `hb_path=${JSON.stringify(heartbeatPath)}`,
        ': > "$hb_path"',
        markBlock,
        "mark install-pi-agent",
        "mark prepare-auth",
        "mark clone-artifacts",
        "mark checkout-branch",
        "mark mount-packages",
        "mark pi-invoke",
        "mark normalize-output",
        "mark build-transcript",
      ].join("\n");

      execFileSync("bash", ["-c", harness], { encoding: "utf-8" });

      // The EXACT executor read+join logic (cloudflare-sandbox-agent-lanes.ts catch).
      const heartbeatTail = readFileSync(heartbeatPath, "utf-8")
        .trim()
        .split("\n")
        .slice(-20)
        .join(" | ");

      const classified = classifyAgentLaneIncompleteFailure({
        cause: new Error("did not emit a result marker"),
        detail: "did not emit a result marker",
        heartbeatTail,
        runId: "run-faithful-double",
        workItemId: "work-faithful-double",
      });

      expect(classified).toBeInstanceOf(AgentLaneIncompleteError);
      expect({
        lastStep: classified?.lastStep,
        reachedAgentInvocation: classified?.reachedAgentInvocation,
      }).toStrictEqual({
        lastStep: "build-transcript",
        reachedAgentInvocation: true,
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
