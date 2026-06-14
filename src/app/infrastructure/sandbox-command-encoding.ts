/**
 * Base64-encoding for Sandbox command payloads.
 *
 * The Worker hands a bash script to the Sandbox by base64-encoding it, piping it
 * through `base64 -d` on the container side, and running the decoded bytes as a
 * script. The encode side runs in the Workers runtime, where `btoa()` only
 * accepts code points in the Latin1 (ISO/IEC 8859-1) range — it throws
 * `InvalidCharacterError` on any character above `0xFF`.
 *
 * Agent-lane commands embed model prompts, and the planner lane embeds the
 * source material it is planning over: dream transcripts, support threads, code.
 * Those carry emoji, smart quotes, em-dashes, accented Latin, and CJK — all
 * above `0xFF`. Encoding the raw string therefore blows up the moment real
 * content flows through, surfacing as a forged `adapter_unavailable` blocker
 * ("Dynamic workflow planner failed: btoa() can only operate on characters in
 * the Latin1 range").
 *
 * The fix is to base64-encode the **UTF-8 bytes** of the command rather than its
 * code points. `base64 -d` decodes back to those exact bytes, which bash reads
 * as the original UTF-8 script — the decode side never changes.
 */

/**
 * Encode an arbitrary UTF-8 string to standard base64, safe for the Workers
 * runtime and for the bash `base64 -d` decode path on the Sandbox side.
 *
 * Every input byte (0–255) maps to a single Latin1 code point before `btoa`, so
 * non-Latin1 source characters never reach `btoa` directly. Bytes are fed to
 * `String.fromCharCode` in 32 KiB chunks so multi-megabyte commands (large
 * transcripts) cannot overflow the argument stack.
 *
 * @param command - The command/script text, which may contain any UTF-8.
 * @returns Standard base64 of the command's UTF-8 byte sequence.
 */
export const encodeCommandToBase64 = (command: string): string => {
  const bytes = new TextEncoder().encode(command);
  const chunkSize = 32_768;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    // Every byte is 0–255, so fromCodePoint maps it to a single Latin1
    // character — identical to fromCharCode here, but lint-preferred.
    binary += String.fromCodePoint(
      ...bytes.subarray(offset, offset + chunkSize)
    );
  }
  return btoa(binary);
};
