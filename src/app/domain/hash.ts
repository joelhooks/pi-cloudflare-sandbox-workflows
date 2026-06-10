import { createHash } from "node:crypto";

type JsonScalar = boolean | null | number | string;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const compareJsonKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
};

const normalizeJson = (value: unknown): JsonValue => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, unknown] => entry[1] !== undefined)
        .toSorted(([left], [right]) => compareJsonKeys(left, right))
        .map(([key, item]) => [key, normalizeJson(item)])
    );
  }

  throw new TypeError(
    `Value is not JSON-serializable: ${Object.prototype.toString.call(value)}`
  );
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeJson(value));

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export const hashJson = (value: unknown): string =>
  sha256Hex(canonicalJson(value));
