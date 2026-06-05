import type { SecretMaterialUseRequest } from "./schemas.ts";

declare const secretStringBrand: unique symbol;

export type SecretString = string & {
  readonly [secretStringBrand]: "secret-string";
};

export interface GitHubAppSigningHandle {
  readonly appId: string;
  readonly installationId: string;
  readonly kind: "github-app-signing-handle";
  signJwt(input: GitHubAppJwtClaims): Promise<SecretString>;
}

export interface GitHubAppJwtClaims {
  expiresAtEpochSeconds: number;
  issuedAtEpochSeconds: number;
}

export interface SecretMaterialStore {
  withSecretMaterial<Result>(
    input: SecretMaterialUseRequest,
    use: (material: GitHubAppSigningHandle) => Promise<Result>
  ): Promise<Result>;
}
