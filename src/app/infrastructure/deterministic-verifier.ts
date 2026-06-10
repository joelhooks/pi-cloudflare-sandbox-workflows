import type {
  ArtifactStoreContract,
  DeterministicVerifierPort,
} from "../application/ports.ts";
import { hashJson, sha256Hex } from "../domain/hash.ts";
import {
  VerificationResultArtifactSchema,
  VerificationResultDocumentSchema,
} from "../domain/schemas.ts";
import type { VerificationResultDocument } from "../domain/schemas.ts";

export interface ArtifactEvidenceDeterministicVerifierConfig {
  readonly artifacts: ArtifactStoreContract;
  readonly now?: () => string;
  readonly source?: "builtin:artifact-evidence-integrity.v1";
}

type VerificationFailure = VerificationResultDocument["failures"][number];
type VerificationSeverity = VerificationFailure["severity"];

const defaultSource = "builtin:artifact-evidence-integrity.v1";

const supportedCheckIds = new Set([
  "deterministic-output-evidence-present",
  "deterministic-output-evidence-hashes-match",
  "deterministic-side-effect-receipts-cover-plan",
  "deterministic-observability-pack-present",
]);

const severityFor = (
  checkId: string,
  fallback: VerificationSeverity
): VerificationSeverity => {
  if (fallback === "blocking") {
    return "blocking";
  }

  return checkId === "deterministic-output-evidence-hashes-match"
    ? "blocking"
    : fallback;
};

const evidenceHashMatches = (input: {
  readonly expectedHash: string;
  readonly mediaType: string;
  readonly text: string;
}): boolean | null => {
  if (input.mediaType === "application/json") {
    try {
      return (
        hashJson(JSON.parse(input.text) as unknown) === input.expectedHash ||
        sha256Hex(input.text) === input.expectedHash
      );
    } catch {
      return null;
    }
  }

  return sha256Hex(input.text) === input.expectedHash;
};

const failure = (input: {
  readonly checkId: string;
  readonly message: string;
  readonly severity?: VerificationSeverity;
}): VerificationFailure => ({
  checkId: input.checkId,
  message: input.message,
  severity: input.severity ?? "blocking",
});

export const createArtifactEvidenceDeterministicVerifier = (
  config: ArtifactEvidenceDeterministicVerifierConfig
): DeterministicVerifierPort => ({
  verifierKind: "deterministic",
  async verify(input) {
    const source = config.source ?? defaultSource;
    if (input.contract.verifier.kind !== "deterministic") {
      throw new Error(
        "Artifact evidence verifier requires a deterministic verification contract."
      );
    }
    if (input.contract.verifier.source !== source) {
      throw new Error(
        `Artifact evidence verifier source mismatch: expected ${source}.`
      );
    }

    const failures: VerificationFailure[] = [];
    for (const check of input.contract.checks) {
      if (!supportedCheckIds.has(check.checkId)) {
        failures.push(
          failure({
            checkId: check.checkId,
            message: `Deterministic verifier source ${source} cannot evaluate contract check ${check.checkId}.`,
            severity: check.severity,
          })
        );
      }
    }

    const outputEvidence = input.outputEvidence.filter(
      (evidence) =>
        !evidence.artifactRef.endsWith("/run/observability-pack.json")
    );
    if (
      input.plan.steps.some((step) => step.kind === "research.review") &&
      outputEvidence.length === 0
    ) {
      failures.push(
        failure({
          checkId: "deterministic-output-evidence-present",
          message:
            "Deterministic verification requires pinned worker output evidence for research/review steps.",
        })
      );
    }

    for (const evidence of input.outputEvidence) {
      const hashMatches = evidenceHashMatches({
        expectedHash: evidence.hash,
        mediaType: evidence.mediaType,
        text: evidence.text,
      });
      if (hashMatches === null) {
        failures.push(
          failure({
            checkId: "deterministic-output-evidence-hashes-match",
            message: `Evidence artifact ${evidence.artifactRef} is not valid JSON for its declared media type.`,
          })
        );
        continue;
      }

      if (!hashMatches) {
        failures.push(
          failure({
            checkId: "deterministic-output-evidence-hashes-match",
            message: `Evidence artifact ${evidence.artifactRef} hash does not match its pinned receipt.`,
          })
        );
      }
    }

    if (input.plan.sideEffects.length > input.capabilityReceipts.length) {
      failures.push(
        failure({
          checkId: "deterministic-side-effect-receipts-cover-plan",
          message:
            "Declared side effects are not covered by capability lease receipts.",
        })
      );
    }

    if (
      input.outputEvidence.every(
        (evidence) =>
          !evidence.artifactRef.endsWith("/run/observability-pack.json")
      )
    ) {
      failures.push(
        failure({
          checkId: "deterministic-observability-pack-present",
          message:
            "Deterministic verification requires the workflow observability pack as evidence.",
        })
      );
    }

    const blockingFailure = failures.find(
      (entry) => entry.severity === "blocking"
    );
    let status: VerificationResultDocument["status"];
    if (blockingFailure !== undefined) {
      status = "blocked";
    } else if (failures.length === 0) {
      status = "accepted";
    } else {
      status = "accepted_with_warnings";
    }

    const resultDocument = VerificationResultDocumentSchema.parse({
      checkedAt: config.now?.() ?? new Date().toISOString(),
      contractId: input.contract.contractId,
      failures: failures.map((entry) => ({
        ...entry,
        severity: severityFor(entry.checkId, entry.severity),
      })),
      resultId: `verification-result:${input.plan.runId}`,
      runId: input.plan.runId,
      schemaVersion: "workflow.verification-result.v1",
      status,
    });
    const writeReceipt = await config.artifacts.writeJson({
      path: input.contract.outputPath,
      redacted: true,
      runId: input.plan.runId,
      value: resultDocument,
    });

    return {
      result: VerificationResultArtifactSchema.parse({
        artifactRef: writeReceipt.artifactRef,
        hash: writeReceipt.contentHash,
        mediaType: "application/json",
        resultId: resultDocument.resultId,
      }),
      resultDocument,
    };
  },
});
