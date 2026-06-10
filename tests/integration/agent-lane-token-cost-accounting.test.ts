import { Script } from "node:vm";

import { describe, expect, it } from "vitest";

import { AgentLaneTokenCostAccountingSchema } from "../../src/app/domain/schemas.ts";
import {
  agentLaneTokenCostAccountingNodeScript,
  parseAgentLaneTokenCostAccountingFromText,
} from "../../src/app/infrastructure/agent-lane-token-cost-accounting.ts";

describe("agent lane token/cost accounting", () => {
  it("parses JSON-style usage metadata", () => {
    const accounting = parseAgentLaneTokenCostAccountingFromText(
      JSON.stringify({
        cost_usd: 0.042,
        input_tokens: 1200,
        output_tokens: 345,
      })
    );

    expect(accounting).toStrictEqual({
      costEstimate: 0.042,
      currency: "USD",
      inputTokens: 1200,
      outputTokens: 345,
      redacted: true,
      source: "pi-cli-usage",
      tokenCount: 1545,
    });
  });

  it("parses text usage metadata without inventing missing cost", () => {
    const accounting = parseAgentLaneTokenCostAccountingFromText(
      ["Input tokens: 1,000", "Output tokens: 250"].join("\n")
    );

    expect(accounting).toStrictEqual({
      costEstimate: null,
      inputTokens: 1000,
      outputTokens: 250,
      redacted: true,
      source: "pi-cli-usage",
      tokenCount: 1250,
    });
  });

  it("returns null when no explicit usage metadata exists", () => {
    expect(
      parseAgentLaneTokenCostAccountingFromText("plain model output")
    ).toBeNull();
  });

  it("keeps the Cloudflare Sandbox receipt script executable", () => {
    const rawAccounting: unknown = new Script(
      [
        agentLaneTokenCostAccountingNodeScript,
        `parseAgentLaneTokenCostAccountingFromText(${JSON.stringify(
          "total_tokens: 999\ncost: $0.013"
        )})`,
      ].join("\n")
    ).runInNewContext();
    const accounting = AgentLaneTokenCostAccountingSchema.parse(
      structuredClone(rawAccounting)
    );

    expect(accounting).toStrictEqual({
      costEstimate: 0.013,
      currency: "USD",
      redacted: true,
      source: "pi-cli-usage",
      tokenCount: 999,
    });
  });
});
