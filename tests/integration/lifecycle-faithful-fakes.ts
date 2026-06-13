import type { ArtifactStoreContract } from "../../src/app/application/ports.ts";
import { hashJson, sha256Hex } from "../../src/app/domain/hash.ts";
import {
  ArtifactRefSchema,
  ArtifactWriteReceiptSchema,
} from "../../src/app/domain/schemas.ts";
import type {
  ArtifactRef,
  ArtifactWriteReceipt,
} from "../../src/app/domain/schemas.ts";

type LifecycleArtifactRecord =
  | {
      readonly kind: "json";
      readonly mediaType: "application/json";
      readonly value: unknown;
    }
  | {
      readonly kind: "text";
      readonly mediaType: string;
      readonly value: string;
    };

export interface LifecycleFaithfulArtifactStore extends ArtifactStoreContract {
  readonly driveId: string;
  readonly localRecords: Map<ArtifactRef, LifecycleArtifactRecord>;
  readonly seedFromRemote: boolean;
}

export interface LifecycleFaithfulArtifactsRemote {
  readonly cloneHistory: {
    readonly driveId: string;
    readonly recordCount: number;
    readonly seedFromRemote: boolean;
  }[];
  readonly namespace: string;
  readonly remoteRecords: Map<ArtifactRef, LifecycleArtifactRecord>;
  createDriveStore(input: {
    readonly driveId: string;
    readonly seedFromRemote: boolean;
  }): LifecycleFaithfulArtifactStore;
}

const artifactRefFor = (
  namespace: string,
  runId: string,
  path: string
): ArtifactRef =>
  ArtifactRefSchema.parse(`artifact://${namespace}/runs/${runId}/${path}`);

const cloneRecord = (
  record: LifecycleArtifactRecord
): LifecycleArtifactRecord =>
  record.kind === "json"
    ? {
        kind: "json",
        mediaType: "application/json",
        value: structuredClone(record.value),
      }
    : { ...record };

const cloneRecords = (
  records: ReadonlyMap<ArtifactRef, LifecycleArtifactRecord>
): Map<ArtifactRef, LifecycleArtifactRecord> =>
  new Map(
    [...records.entries()].map(([artifactRef, record]) => [
      artifactRef,
      cloneRecord(record),
    ])
  );

const missingArtifactError = (
  artifactRef: ArtifactRef
): Error & {
  code: "ENOENT";
} =>
  Object.assign(new Error(`Artifact not found: ${artifactRef}`), {
    code: "ENOENT" as const,
  });

const writeReceiptFor = (input: {
  readonly artifactCommitSha: string;
  readonly artifactRef: ArtifactRef;
  readonly mediaType: string;
  readonly redacted: true;
  readonly value: unknown;
}): ArtifactWriteReceipt =>
  ArtifactWriteReceiptSchema.parse({
    artifactCommitSha: input.artifactCommitSha,
    artifactRef: input.artifactRef,
    contentHash:
      typeof input.value === "string"
        ? sha256Hex(input.value)
        : hashJson(input.value),
    mediaType: input.mediaType,
    redacted: input.redacted,
  });

export const createLifecycleFaithfulArtifactsRemote = (
  namespace: string
): LifecycleFaithfulArtifactsRemote => {
  const remoteRecords = new Map<ArtifactRef, LifecycleArtifactRecord>();
  const cloneHistory: LifecycleFaithfulArtifactsRemote["cloneHistory"] = [];
  // One shared history: every write is a commit to the same Artifacts repo,
  // so the sha sequence is monotonic across drive stores, like git.
  let commitCounter = 0;
  const nextCommitSha = (): string => {
    commitCounter += 1;

    return commitCounter.toString(16).padStart(40, "0");
  };

  return {
    cloneHistory,
    createDriveStore(input) {
      const localRecords = input.seedFromRemote
        ? cloneRecords(remoteRecords)
        : new Map<ArtifactRef, LifecycleArtifactRecord>();
      cloneHistory.push({
        driveId: input.driveId,
        recordCount: localRecords.size,
        seedFromRemote: input.seedFromRemote,
      });

      return {
        artifactRef(storeInput) {
          return artifactRefFor(namespace, storeInput.runId, storeInput.path);
        },
        driveId: input.driveId,
        localRecords,
        readJson(readInput) {
          const record = localRecords.get(readInput.artifactRef);
          if (record === undefined) {
            return Promise.reject(missingArtifactError(readInput.artifactRef));
          }
          if (record.kind !== "json") {
            return Promise.reject(
              new TypeError(`JSON artifact not found: ${readInput.artifactRef}`)
            );
          }

          return Promise.resolve(record.value);
        },
        readText(readInput) {
          const record = localRecords.get(readInput.artifactRef);
          if (record === undefined) {
            return Promise.reject(missingArtifactError(readInput.artifactRef));
          }
          if (record.kind !== "text") {
            return Promise.reject(
              new TypeError(`Text artifact not found: ${readInput.artifactRef}`)
            );
          }

          return Promise.resolve(record.value);
        },
        seedFromRemote: input.seedFromRemote,
        writeJson(writeInput) {
          const artifactRef = artifactRefFor(
            namespace,
            writeInput.runId,
            writeInput.path
          );
          const record: LifecycleArtifactRecord = {
            kind: "json",
            mediaType: "application/json",
            value: structuredClone(writeInput.value),
          };
          localRecords.set(artifactRef, record);
          remoteRecords.set(artifactRef, cloneRecord(record));

          return Promise.resolve(
            writeReceiptFor({
              artifactCommitSha: nextCommitSha(),
              artifactRef,
              mediaType: "application/json",
              redacted: writeInput.redacted,
              value: writeInput.value,
            })
          );
        },
        writeText(writeInput) {
          const artifactRef = artifactRefFor(
            namespace,
            writeInput.runId,
            writeInput.path
          );
          const record: LifecycleArtifactRecord = {
            kind: "text",
            mediaType: writeInput.mediaType,
            value: writeInput.value,
          };
          localRecords.set(artifactRef, record);
          remoteRecords.set(artifactRef, cloneRecord(record));

          return Promise.resolve(
            writeReceiptFor({
              artifactCommitSha: nextCommitSha(),
              artifactRef,
              mediaType: writeInput.mediaType,
              redacted: writeInput.redacted,
              value: writeInput.value,
            })
          );
        },
      };
    },
    namespace,
    remoteRecords,
  };
};
