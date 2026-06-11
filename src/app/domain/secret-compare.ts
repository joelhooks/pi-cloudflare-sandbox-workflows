/**
 * Constant-time secret comparison over SHA-256 digests.
 *
 * Hashing first normalizes length so the byte loop never short-circuits on
 * the first mismatch, keeping comparison time independent of how much of the
 * candidate token matches.
 */
const sha256Bytes = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  );

export const timingSafeSecretMatch = async (input: {
  readonly actual: string;
  readonly expected: string;
}): Promise<boolean> => {
  const [actualHash, expectedHash] = await Promise.all([
    sha256Bytes(input.actual),
    sha256Bytes(input.expected),
  ]);
  let mismatch = actualHash.length === expectedHash.length ? 0 : 1;
  for (const [index, actualByte] of actualHash.entries()) {
    mismatch += actualByte === (expectedHash[index] ?? -1) ? 0 : 1;
  }

  return mismatch === 0;
};
