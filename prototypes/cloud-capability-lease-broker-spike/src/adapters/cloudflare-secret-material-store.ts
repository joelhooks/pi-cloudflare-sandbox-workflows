import type { SecretMaterialUseRequest } from "../core/schemas.ts";
/* eslint-disable curly, func-style, import/no-duplicates, max-classes-per-file, no-bitwise, no-div-regex, no-duplicate-imports, no-use-before-define, require-await, unicorn/prefer-code-point, unicorn/prefer-string-replace-all */
import type { SecretMaterialStore } from "../core/secret-material-store.ts";
import type {
  GitHubAppJwtClaims,
  GitHubAppSigningHandle,
  SecretString,
} from "../core/secret-material-store.ts";

export interface CloudflareGitHubAppSecrets {
  appId: string | undefined;
  installationId: string | undefined;
  privateKeyPem: string | undefined;
}

const textEncoder = new TextEncoder();

export class CloudflareSecretMaterialStore implements SecretMaterialStore {
  private readonly secrets: CloudflareGitHubAppSecrets;

  constructor(secrets: CloudflareGitHubAppSecrets) {
    this.secrets = secrets;
  }

  async withSecretMaterial<Result>(
    input: SecretMaterialUseRequest,
    use: (material: GitHubAppSigningHandle) => Promise<Result>
  ): Promise<Result> {
    if (input.secretRef !== "githubApp:shitrat") {
      throw new Error("secret_unavailable");
    }
    if (
      !this.secrets.appId ||
      !this.secrets.installationId ||
      !this.secrets.privateKeyPem
    ) {
      throw new Error("secret_unavailable");
    }

    const handle = new CloudflareGitHubAppSigningHandle({
      appId: this.secrets.appId,
      installationId: this.secrets.installationId,
      privateKeyPem: this.secrets.privateKeyPem,
    });

    return use(handle);
  }
}

class CloudflareGitHubAppSigningHandle implements GitHubAppSigningHandle {
  readonly appId: string;
  readonly installationId: string;
  readonly kind = "github-app-signing-handle" as const;
  private readonly privateKeyPem: string;

  constructor(input: {
    appId: string;
    installationId: string;
    privateKeyPem: string;
  }) {
    this.appId = input.appId;
    this.installationId = input.installationId;
    this.privateKeyPem = input.privateKeyPem;
  }

  async signJwt(input: GitHubAppJwtClaims): Promise<SecretString> {
    const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
    const payload = base64UrlJson({
      exp: input.expiresAtEpochSeconds,
      iat: input.issuedAtEpochSeconds,
      iss: this.appId,
    });
    const unsigned = `${header}.${payload}`;
    const key = await importPkcs8PrivateKey(this.privateKeyPem);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      textEncoder.encode(unsigned)
    );
    return `${unsigned}.${base64UrlBytes(new Uint8Array(signature))}` as SecretString;
  }
}

async function importPkcs8PrivateKey(pem: string): Promise<CryptoKey> {
  const normalized = pem.replace(/\\n/gu, "\n");
  const isPkcs1 = normalized.includes("BEGIN RSA PRIVATE KEY");
  const base64 = normalized
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/gu, "")
    .replace(/\s/gu, "");
  const der = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    isPkcs1 ? wrapPkcs1RsaPrivateKeyAsPkcs8(der) : der,
    { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" },
    false,
    ["sign"]
  );
}

function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaEncryptionOid = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const privateKey = derSequence(0x04, pkcs1);
  return derSequence(0x30, concatBytes(version, rsaEncryptionOid, privateKey));
}

function derSequence(tag: number, body: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.from([tag]), derLength(body.byteLength), body);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(textEncoder.encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/gu, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}
