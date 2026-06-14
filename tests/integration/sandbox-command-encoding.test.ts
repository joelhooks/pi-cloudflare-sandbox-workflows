import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { encodeCommandToBase64 } from "../../src/app/infrastructure/sandbox-command-encoding.ts";

/**
 * Wound #21 chaos suite — the planner lane blocked terminal with a forged
 * `adapter_unavailable` ("Dynamic workflow planner failed: btoa() can only
 * operate on characters in the Latin1 (ISO/IEC 8859-1) range") the first time a
 * dream transcript carrying emoji / smart quotes / em-dashes flowed through the
 * Sandbox command encoder.
 *
 * The hostile double here is production's REAL decode transport: pipe the
 * encoded payload through bash `base64 -d` exactly as the Sandbox wrapper does,
 * then read the bytes back as UTF-8. A polite `atob` in JS would have hidden the
 * byte-vs-codepoint bug; `base64 -d` does not.
 */

/** Decode through the exact path the Sandbox wrapper uses: `base64 -d` → bytes → UTF-8. */
const decodeThroughBashBase64 = (encoded: string): string =>
  execFileSync("base64", ["-d"], { input: encoded }).toString("utf-8");

const NON_LATIN1_COMMAND = [
  'echo "🌙 dream review"',
  'echo "“smart quotes” and an em–dash"',
  'echo "café, naïve, Москва, 日本語, 🚀"',
].join("\n");

describe("encodeCommandToBase64 (wound #21: btoa Latin1 ceiling)", () => {
  it("encodes non-Latin1 content that raw btoa rejects", () => {
    // Lock in the regression: the original implementation threw here.
    expect(() => btoa(NON_LATIN1_COMMAND)).toThrow(/character/iu);
    // The fix does not throw — it encodes the UTF-8 bytes.
    expect(() => encodeCommandToBase64(NON_LATIN1_COMMAND)).not.toThrow();
  });

  it("round-trips through bash `base64 -d` (production decode transport)", () => {
    const encoded = encodeCommandToBase64(NON_LATIN1_COMMAND);
    expect(decodeThroughBashBase64(encoded)).toBe(NON_LATIN1_COMMAND);
  });

  it("round-trips plain ASCII unchanged", () => {
    const command = 'set -e\necho "hello world"\nexit 0';
    expect(decodeThroughBashBase64(encodeCommandToBase64(command))).toBe(
      command
    );
  });

  it("survives a multi-megabyte transcript without overflowing the arg stack", () => {
    // ~1 MB of 4-byte code points — the chunked fromCharCode path must not throw.
    const big = "🌙".repeat(250_000);
    const encoded = encodeCommandToBase64(big);
    expect(decodeThroughBashBase64(encoded)).toBe(big);
  });

  it("produces standard base64 (no URL-safe alphabet, padded)", () => {
    const encoded = encodeCommandToBase64(NON_LATIN1_COMMAND);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
  });
});
