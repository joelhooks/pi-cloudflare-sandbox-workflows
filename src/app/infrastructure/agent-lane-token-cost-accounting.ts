import { AgentLaneTokenCostAccountingSchema } from "../domain/schemas.ts";
import type { AgentLaneTokenCostAccounting } from "../domain/schemas.ts";

const numberCapture = String.raw`([0-9][0-9,_]*(?:\.[0-9]+)?)`;

const integerFrom = (
  text: string,
  patterns: readonly RegExp[]
): number | undefined => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (raw === undefined) {
      continue;
    }

    const parsed = Number.parseFloat(raw.replaceAll(/[,_]/gu, ""));
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
};

const numberFrom = (
  text: string,
  patterns: readonly RegExp[]
): number | undefined => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (raw === undefined) {
      continue;
    }

    const parsed = Number.parseFloat(raw.replaceAll(/[,_$]/gu, ""));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
};

export const parseAgentLaneTokenCostAccountingFromText = (
  text: string
): AgentLaneTokenCostAccounting | null => {
  const inputTokens = integerFrom(text, [
    new RegExp(String.raw`"input_tokens"\s*:\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`"inputTokens"\s*:\s*${numberCapture}`, "u"),
    new RegExp(String.raw`"prompt_tokens"\s*:\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`"promptTokens"\s*:\s*${numberCapture}`, "u"),
    new RegExp(String.raw`\binput_tokens\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`\bprompt_tokens\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`\binput\s+tokens?\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`\bprompt\s+tokens?\s*[:=]\s*${numberCapture}`, "iu"),
  ]);
  const outputTokens = integerFrom(text, [
    new RegExp(String.raw`"output_tokens"\s*:\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`"outputTokens"\s*:\s*${numberCapture}`, "u"),
    new RegExp(String.raw`"completion_tokens"\s*:\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`"completionTokens"\s*:\s*${numberCapture}`, "u"),
    new RegExp(String.raw`\boutput_tokens\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`\bcompletion_tokens\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`\boutput\s+tokens?\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(
      String.raw`\bcompletion\s+tokens?\s*[:=]\s*${numberCapture}`,
      "iu"
    ),
  ]);
  const explicitTokenCount = integerFrom(text, [
    new RegExp(String.raw`"total_tokens"\s*:\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`"totalTokens"\s*:\s*${numberCapture}`, "u"),
    new RegExp(String.raw`\btotal_tokens\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(String.raw`\btotal\s+tokens?\s*[:=]\s*${numberCapture}`, "iu"),
    new RegExp(
      String.raw`(?:^|[\n\r])\s*(?:tokens?|token count)\s*[:=]\s*${numberCapture}`,
      "iu"
    ),
  ]);
  const tokenCount =
    explicitTokenCount ??
    (inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens);
  if (tokenCount === undefined) {
    return null;
  }

  const costEstimate = numberFrom(text, [
    new RegExp(String.raw`"cost_estimate"\s*:\s*"?\$?${numberCapture}"?`, "iu"),
    new RegExp(String.raw`"costEstimate"\s*:\s*"?\$?${numberCapture}"?`, "u"),
    new RegExp(String.raw`"cost_usd"\s*:\s*"?\$?${numberCapture}"?`, "iu"),
    new RegExp(String.raw`"costUsd"\s*:\s*"?\$?${numberCapture}"?`, "u"),
    new RegExp(String.raw`\bcost_estimate\s*[:=]\s*\$?${numberCapture}`, "iu"),
    new RegExp(String.raw`\bcost_usd\s*[:=]\s*\$?${numberCapture}`, "iu"),
    new RegExp(
      String.raw`\bcost(?:\s+usd)?\s*[:=]\s*\$?${numberCapture}`,
      "iu"
    ),
  ]);

  return AgentLaneTokenCostAccountingSchema.parse({
    ...(costEstimate === undefined ? {} : { currency: "USD" }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    costEstimate: costEstimate ?? null,
    redacted: true,
    source: "pi-cli-usage",
    tokenCount,
  });
};

export const agentLaneTokenCostAccountingNodeScript = String.raw`
const numberCapture = "([0-9][0-9,_]*(?:\\.[0-9]+)?)";
const integerFrom = (text, patterns) => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (raw === undefined) {
      continue;
    }

    const parsed = Number.parseFloat(raw.replaceAll(/[,_]/gu, ""));
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
};
const numberFrom = (text, patterns) => {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const raw = match?.[1];
    if (raw === undefined) {
      continue;
    }

    const parsed = Number.parseFloat(raw.replaceAll(/[,_$]/gu, ""));
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
};
const parseAgentLaneTokenCostAccountingFromText = (text) => {
  const inputTokens = integerFrom(text, [
    new RegExp('"input_tokens"\\s*:\\s*' + numberCapture, "iu"),
    new RegExp('"inputTokens"\\s*:\\s*' + numberCapture, "u"),
    new RegExp('"prompt_tokens"\\s*:\\s*' + numberCapture, "iu"),
    new RegExp('"promptTokens"\\s*:\\s*' + numberCapture, "u"),
    new RegExp('\\binput_tokens\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\bprompt_tokens\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\binput\\s+tokens?\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\bprompt\\s+tokens?\\s*[:=]\\s*' + numberCapture, "iu"),
  ]);
  const outputTokens = integerFrom(text, [
    new RegExp('"output_tokens"\\s*:\\s*' + numberCapture, "iu"),
    new RegExp('"outputTokens"\\s*:\\s*' + numberCapture, "u"),
    new RegExp('"completion_tokens"\\s*:\\s*' + numberCapture, "iu"),
    new RegExp('"completionTokens"\\s*:\\s*' + numberCapture, "u"),
    new RegExp('\\boutput_tokens\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\bcompletion_tokens\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\boutput\\s+tokens?\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\bcompletion\\s+tokens?\\s*[:=]\\s*' + numberCapture, "iu"),
  ]);
  const explicitTokenCount = integerFrom(text, [
    new RegExp('"total_tokens"\\s*:\\s*' + numberCapture, "iu"),
    new RegExp('"totalTokens"\\s*:\\s*' + numberCapture, "u"),
    new RegExp('\\btotal_tokens\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('\\btotal\\s+tokens?\\s*[:=]\\s*' + numberCapture, "iu"),
    new RegExp('(?:^|[\\n\\r])\\s*(?:tokens?|token count)\\s*[:=]\\s*' + numberCapture, "iu"),
  ]);
  const tokenCount =
    explicitTokenCount ??
    (inputTokens === undefined || outputTokens === undefined
      ? undefined
      : inputTokens + outputTokens);
  if (tokenCount === undefined) {
    return null;
  }

  const costEstimate = numberFrom(text, [
    new RegExp('"cost_estimate"\\s*:\\s*"?\\$?' + numberCapture + '"?', "iu"),
    new RegExp('"costEstimate"\\s*:\\s*"?\\$?' + numberCapture + '"?', "u"),
    new RegExp('"cost_usd"\\s*:\\s*"?\\$?' + numberCapture + '"?', "iu"),
    new RegExp('"costUsd"\\s*:\\s*"?\\$?' + numberCapture + '"?', "u"),
    new RegExp('\\bcost_estimate\\s*[:=]\\s*\\$?' + numberCapture, "iu"),
    new RegExp('\\bcost_usd\\s*[:=]\\s*\\$?' + numberCapture, "iu"),
    new RegExp('\\bcost(?:\\s+usd)?\\s*[:=]\\s*\\$?' + numberCapture, "iu"),
  ]);

  return {
    ...(costEstimate === undefined ? {} : { currency: "USD" }),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    costEstimate: costEstimate ?? null,
    redacted: true,
    source: "pi-cli-usage",
    tokenCount,
  };
};
`;
