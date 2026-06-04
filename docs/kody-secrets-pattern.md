# Kody Secrets Pattern To Borrow

Kody's secret system is the right shape for our v2 secret broker.

Repo: `https://github.com/kentcdodds/kody`
Local inspected clone: `/Users/joel/.repo-autopsy/kentcdodds/kody`

## Borrow the separation

Kody separates these concerns:

1. encrypted value storage
2. metadata-only discovery
3. write-only persistence
4. policy approval
5. derived secret use at a gateway

That maps cleanly to Pi sandbox workflows:

```txt
secretRef
  -> supervisor/broker resolves policy
  -> broker mints task-scoped auth.json or network credential
  -> sandbox receives only the bounded derived artifact
  -> run record logs the lease/reference, not plaintext
```

## Receipts

| Concern                  | Kody file                                                     | Use here                                                                                           |
| ------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Secret scopes and expiry | `packages/worker/migrations/0008-secret-buckets.sql`          | `user` operator credential, `app` context-pack/integration credential, `session` capsule/run lease |
| Encryption               | `packages/worker/src/mcp/secrets/crypto.ts`                   | AES-GCM encrypted portable OAuth blob storage beyond Secrets Store size limits                     |
| Service boundary         | `packages/worker/src/mcp/secrets/service.ts`                  | save/list/resolve/delete APIs with plaintext only at trusted boundary                              |
| Storage repo             | `packages/worker/src/mcp/secrets/repo.ts`                     | D1 row model for buckets and entries                                                               |
| Placeholder parser       | `packages/worker/src/mcp/secrets/placeholders.ts`             | secret references as operational wiring, not prompt text                                           |
| Fetch gateway            | `packages/worker/src/mcp/fetch-gateway.ts`                    | server-side expansion after policy checks                                                          |
| Approval errors          | `packages/worker/src/mcp/secrets/errors.ts`                   | actionable approval URLs instead of retry loops                                                    |
| Metadata listing         | `packages/worker/src/mcp/capabilities/secrets/secret-list.ts` | discover references without plaintext                                                              |
| Write-only set           | `packages/worker/src/mcp/capabilities/secrets/secret-set.ts`  | trusted refresh paths can persist values without echoing them                                      |
| Host approval doctrine   | `docs/contributing/secret-host-approval.md`                   | generated workflows can request approvals, not grant themselves broader access                     |
| Rotation doctrine        | `docs/contributing/secret-rotation.md`                        | root key rotation means re-encryption migration                                                    |
| User docs                | `docs/use/secrets-and-values.md`                              | explain placeholders and host approval simply                                                      |

## Adjustments for Pi

- Kody trims secret values. For Pi auth blobs, store base64 or encrypted JSON bytes so whitespace is not semantics.
- Pi auth blob may be larger than Cloudflare Secrets Store's beta per-secret limit, so Secrets Store is better as a root key holder than the blob store.
- The generated dynamic harness should only see secret references and lease status.
- The supervisor sandbox, if used, is privileged but not all-powerful: it can ask the broker for leases under policy.

## First prototype stance

Use current `PI_AUTH_JSON_B64` for the first dogfood lane, but shape the interface as:

```ts
type SecretRef = {
  scope: "user" | "app" | "session";
  name: string;
};

type AuthLease = {
  id: string;
  ref: SecretRef;
  kind: "pi-auth-json";
  expiresAt: string;
  materializedPath: string;
};
```

Then swap the implementation from static Worker secret to encrypted D1/R2-backed broker later.
