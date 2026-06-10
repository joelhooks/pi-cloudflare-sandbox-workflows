const matchingCloser = (char: string): string | null => {
  if (char === "{") {
    return "}";
  }

  if (char === "[") {
    return "]";
  }

  return null;
};

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
const raw = fs.readFileSync(process.env.raw_output_path, "utf8");
const jsonText = extractFirstJsonValueText(raw);
const parsed = JSON.parse(jsonText);
fs.writeFileSync(process.env.LANE_OUTPUT_PATH, JSON.stringify(parsed, null, 2) + "\n");
`;
