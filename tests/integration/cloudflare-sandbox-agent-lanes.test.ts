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
