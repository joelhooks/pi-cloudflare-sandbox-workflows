import type { RedactionPolicy } from "./ports";

const blocked = [
  new RegExp(["ACCESS", "TOKEN"].join("_"), "iu"),
  new RegExp(["PI", "AUTH", "JSON", "B64"].join("_"), "iu"),
  new RegExp(["art", "v1", ""].join("_"), "u"),
  new RegExp(["-----BEGIN", "PRIVATE", "KEY-----"].join(" "), "u"),
];

export const defaultRedactionPolicy: RedactionPolicy = {
  classify(value) {
    return blocked.some((pattern) => pattern.test(value)) ? "secret-adjacent" : "public-safe";
  },
  redact(value) {
    let redacted = value;
    for (const pattern of blocked) {
      redacted = redacted.replaceAll(pattern, "[redacted]");
    }
    return redacted;
  },
};
