const matchingCloser = (char: string): string | null => {
  if (char === "{") {
    return "}";
  }

  if (char === "[") {
    return "]";
  }

  return null;
};

/**
 * Scan `raw` for the first balanced, parseable JSON value (`{...}` or `[...]`),
 * skipping any chatty prose, markdown fences, or bracket-like noise before it.
 * This is the low-level extractor used both for legacy bare-JSON output and as
 * the inner step that pulls a verdict out of an agent's final text message.
 */
export const extractFirstJsonValueText = (raw: string): string => {
  const findJsonEnd = (startIndex: number): number | null => {
    const expectedClosers = [matchingCloser(raw[startIndex] ?? "")];
    if (expectedClosers[0] === null) {
      return null;
    }

    let escaped = false;
    let inString = false;
    for (let index = startIndex + 1; index < raw.length; index += 1) {
      const char = raw[index] ?? "";
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      const closer = matchingCloser(char);
      if (closer !== null) {
        expectedClosers.push(closer);
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = expectedClosers.pop();
        if (expected !== char) {
          return null;
        }

        if (expectedClosers.length === 0) {
          return index;
        }
      }
    }

    return null;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char !== "{" && char !== "[") {
      continue;
    }

    const endIndex = findJsonEnd(index);
    if (endIndex === null) {
      continue;
    }

    const candidate = raw.slice(index, endIndex + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new SyntaxError(
    "Agent lane output did not contain a complete JSON value."
  );
};

/**
 * Thrown when the agent's final assistant message carries a terminal failure
 * `stopReason` ("error" or "aborted"). This is a real agent failure — the agent
 * produced no verdict because it crashed or was cut off — and must be surfaced
 * as such rather than as a generic "no JSON found" syntax error, so the carrier
 * can classify the blocker honestly instead of blaming the adapter.
 */
export class AgentLaneAgentError extends Error {
  readonly agentStopReason: string;

  constructor(message: string, agentStopReason: string) {
    super(message);
    this.name = "AgentLaneAgentError";
    this.agentStopReason = agentStopReason;
  }
}

/** Narrow an unknown JSON value to a plain object (non-null, non-array). */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Pull the concatenated `{type:"text"}` content out of a pi assistant message,
 * ignoring `thinking` and `toolCall` blocks. Tolerates the legacy string-content
 * shape too.
 */
const assistantMessageText = (message: Record<string, unknown>): string => {
  const { content } = message;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const block of content) {
    if (
      isRecord(block) &&
      block["type"] === "text" &&
      typeof block["text"] === "string"
    ) {
      parts.push(block["text"]);
    }
  }

  return parts.join("");
};

/** Parse a pi `--mode json` JSONL event stream, tolerating partial/garbage lines. */
const parsePiEventStream = (raw: string): Record<string, unknown>[] => {
  const events: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) {
        events.push(value);
      }
    } catch {
      continue;
    }
  }

  return events;
};

const tryExtract = (text: string): string | null => {
  try {
    return extractFirstJsonValueText(text);
  } catch {
    return null;
  }
};

const isAssistantMessage = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && value["role"] === "assistant";

/**
 * Resolve a verdict from an `agent_end` event's final assistant message. Throws
 * {@link AgentLaneAgentError} when that message ended in "error"/"aborted";
 * returns null when there is no usable assistant verdict so the caller can fall
 * back to the per-event walk.
 */
const verdictFromAgentEnd = (
  agentEnd: Record<string, unknown>
): string | null => {
  const { messages } = agentEnd;
  if (!Array.isArray(messages)) {
    return null;
  }

  let lastAssistant: Record<string, unknown> | undefined;
  for (const message of messages) {
    if (isAssistantMessage(message)) {
      lastAssistant = message;
    }
  }

  if (lastAssistant === undefined) {
    return null;
  }

  const { errorMessage, stopReason } = lastAssistant;
  if (stopReason === "error" || stopReason === "aborted") {
    const message =
      typeof errorMessage === "string"
        ? errorMessage
        : `Agent ended with stopReason "${stopReason}" and produced no usable output.`;
    throw new AgentLaneAgentError(message, stopReason);
  }

  return tryExtract(assistantMessageText(lastAssistant));
};

/**
 * Normalize raw agent-lane output into a single JSON verdict string.
 *
 * pi `--mode json` emits a JSONL event stream (a `session` header line followed
 * by lifecycle events, terminated by an `agent_end` carrying the final
 * `messages[]`). The verdict the lane asked for lives in the last assistant
 * message's text content — NOT on stdout as a bare value — because pi's human
 * text mode only echoes the final message and goes silent when the run ends on a
 * tool call, error, or abort. So we read the event stream:
 *
 * 1. last `agent_end` → last `role:"assistant"` message
 * 2. if its `stopReason` is "error"/"aborted" → throw {@link AgentLaneAgentError}
 *    (honest agent failure, not "no JSON")
 * 3. else extract the verdict JSON from its text (fence/prose tolerant)
 *
 * Fallbacks keep older lanes working: a truncated stream falls back to the last
 * assistant message event, and non-event-stream output (legacy text mode, a
 * clean bare JSON value, chatty prose) falls back to a whole-buffer scan.
 */
export const normalizeAgentLaneJsonOutput = (raw: string): string => {
  const events = parsePiEventStream(raw);
  const looksLikeEventStream = events.some(
    (event) => typeof event["type"] === "string"
  );

  let agentEnd: Record<string, unknown> | undefined;
  for (const event of events) {
    if (event["type"] === "agent_end" && Array.isArray(event["messages"])) {
      agentEnd = event;
    }
  }

  if (agentEnd !== undefined) {
    const fromAgentEnd = verdictFromAgentEnd(agentEnd);
    if (fromAgentEnd !== null) {
      return fromAgentEnd;
    }
  }

  // Defensive fallback for truncated streams: walk message-bearing events from
  // the end and take the latest assistant message that yields a verdict.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const message = events[index]?.["message"];
    if (isAssistantMessage(message)) {
      const extracted = tryExtract(assistantMessageText(message));
      if (extracted !== null) {
        return extracted;
      }
    }
  }

  if (looksLikeEventStream) {
    // A recognized event stream that carried no parseable verdict. Do NOT scan
    // the whole buffer — that would happily return the `session` header object.
    throw new SyntaxError(
      "Agent lane output did not contain a complete JSON value."
    );
  }

  // Legacy / non-event-stream output: a bare JSON value or chatty text.
  return extractFirstJsonValueText(raw);
};

/**
 * Node program (run inside the sandbox lane) that mirrors
 * {@link normalizeAgentLaneJsonOutput}. It reads the raw agent output, writes the
 * recovered verdict to `LANE_OUTPUT_PATH`, and ALWAYS writes a normalization
 * outcome to `LANE_OUTPUT_NORMALIZATION_PATH` so the receipt can record an honest
 * `outputNormalization` ({normalized, reason, agentStopReason}) instead of the
 * carrier clobbering pi's real exit status. Exits non-zero only when no verdict
 * could be recovered. Kept in lockstep with the TypeScript implementation above;
 * the integration suite asserts the two stay equivalent.
 */
export const jsonOutputNormalizerNodeScript = String.raw`
const fs = require("fs");
const matchingCloser = (char) => {
  if (char === "{") {
    return "}";
  }

  if (char === "[") {
    return "]";
  }

  return null;
};
const extractFirstJsonValueText = (raw) => {
  const findJsonEnd = (startIndex) => {
    const expectedClosers = [matchingCloser(raw[startIndex] ?? "")];
    if (expectedClosers[0] === null) {
      return null;
    }

    let escaped = false;
    let inString = false;
    for (let index = startIndex + 1; index < raw.length; index += 1) {
      const char = raw[index] ?? "";
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }

        if (char === "\\") {
          escaped = true;
          continue;
        }

        if (char === '"') {
          inString = false;
        }

        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      const closer = matchingCloser(char);
      if (closer !== null) {
        expectedClosers.push(closer);
        continue;
      }

      if (char === "}" || char === "]") {
        const expected = expectedClosers.pop();
        if (expected !== char) {
          return null;
        }

        if (expectedClosers.length === 0) {
          return index;
        }
      }
    }

    return null;
  };

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    if (char !== "{" && char !== "[") {
      continue;
    }

    const endIndex = findJsonEnd(index);
    if (endIndex === null) {
      continue;
    }

    const candidate = raw.slice(index, endIndex + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new SyntaxError("Agent lane output did not contain a complete JSON value.");
};
const assistantMessageText = (message) => {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        block.type === "text" &&
        typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("");
};
const parsePiEventStream = (raw) => {
  const events = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    try {
      const value = JSON.parse(trimmed);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        events.push(value);
      }
    } catch {
      continue;
    }
  }

  return events;
};
const tryExtract = (text) => {
  try {
    return extractFirstJsonValueText(text);
  } catch {
    return null;
  }
};
const normalizeAgentLaneJsonOutput = (raw) => {
  const events = parsePiEventStream(raw);
  const looksLikeEventStream = events.some(
    (event) => typeof event.type === "string"
  );

  let agentEnd;
  for (const event of events) {
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      agentEnd = event;
    }
  }

  if (agentEnd !== undefined) {
    let lastAssistant;
    for (const message of agentEnd.messages) {
      if (
        typeof message === "object" &&
        message !== null &&
        message.role === "assistant"
      ) {
        lastAssistant = message;
      }
    }

    if (lastAssistant !== undefined) {
      const stopReason = lastAssistant.stopReason;
      if (stopReason === "error" || stopReason === "aborted") {
        const errorMessage =
          typeof lastAssistant.errorMessage === "string"
            ? lastAssistant.errorMessage
            : 'Agent ended with stopReason "' + stopReason + '" and produced no usable output.';
        const agentError = new Error(errorMessage);
        agentError.code = "AGENT_ERROR";
        agentError.agentStopReason = stopReason;
        throw agentError;
      }

      const fromAgentEnd = tryExtract(assistantMessageText(lastAssistant));
      if (fromAgentEnd !== null) {
        return fromAgentEnd;
      }
    }
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const message = events[index] && events[index].message;
    if (
      typeof message === "object" &&
      message !== null &&
      message.role === "assistant"
    ) {
      const extracted = tryExtract(assistantMessageText(message));
      if (extracted !== null) {
        return extracted;
      }
    }
  }

  if (looksLikeEventStream) {
    throw new SyntaxError("Agent lane output did not contain a complete JSON value.");
  }

  return extractFirstJsonValueText(raw);
};
const raw = fs.readFileSync(process.env.raw_output_path, "utf8");
const normalizationPath = process.env.LANE_OUTPUT_NORMALIZATION_PATH;
let outcome;
try {
  const jsonText = normalizeAgentLaneJsonOutput(raw);
  const parsed = JSON.parse(jsonText);
  fs.writeFileSync(process.env.LANE_OUTPUT_PATH, JSON.stringify(parsed, null, 2) + "\n");
  outcome = { normalized: true, reason: null, agentStopReason: null };
} catch (error) {
  outcome = {
    normalized: false,
    reason: error && error.code === "AGENT_ERROR" ? "agent_error" : "no_parseable_output",
    agentStopReason: error && error.agentStopReason ? error.agentStopReason : null,
    detail: error && error.message ? String(error.message).slice(0, 500) : null
  };
}
if (normalizationPath) {
  fs.writeFileSync(normalizationPath, JSON.stringify(outcome) + "\n");
}
if (!outcome.normalized) {
  process.exitCode = 1;
}
`;
