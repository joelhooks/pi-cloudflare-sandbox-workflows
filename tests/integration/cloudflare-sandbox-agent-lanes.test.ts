import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AgentLanePackageMountIndexSchema,
  PackageMetadataSchema,
  PinnedPackageSchema,
} from "../../src/app/domain/schemas.ts";
import type { PinnedPackage } from "../../src/app/domain/schemas.ts";
import {
  extractFirstJsonValueText,
  jsonOutputNormalizerNodeScript,
} from "../../src/app/infrastructure/agent-lane-json-output.ts";
import {
  agentLanePackageMountWriterNodeScript,
  buildAgentLanePackageMountIndex,
  mountedPackagePathFor,
} from "../../src/app/infrastructure/agent-lane-package-mounts.ts";
import { buildPiAgentLaneCommand } from "../../src/app/infrastructure/cloudflare-sandbox-agent-lane-command.ts";
import { integrationTestPackageMetadata } from "./workflow-app-fixtures.ts";

const buildPinnedPackageFixture = (
  overrides: {
    readonly artifactRef?: string;
    readonly packageId?: string;
  } = {}
): PinnedPackage => {
  const metadata = integrationTestPackageMetadata.at(0);
  if (metadata === undefined) {
    throw new Error("Missing integration package metadata fixture.");
  }

  return {
    artifactRef: overrides.artifactRef ?? metadata.latestArtifactRef,
    fileHashes: {
      "package.json":
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    manifestHash:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    metadata: {
      ...metadata,
      packageId: overrides.packageId ?? metadata.packageId,
    },
    pinnedAt: "2026-06-08T20:00:00.000Z",
    version: metadata.latestVersion,
  };
};

const PackagePinFileSchema = PinnedPackageSchema.pick({
  artifactRef: true,
  fileHashes: true,
  manifestHash: true,
  pinnedAt: true,
  version: true,
}).extend({
  redacted: z.literal(true),
});

describe(extractFirstJsonValueText, () => {
  it("extracts the first complete JSON value from chatty agent output", () => {
    const jsonText = extractFirstJsonValueText(
      [
        "Here is the verification result:",
        "```json",
        '{ "status": "accepted", "message": "brace in string: }", "items": [1, 2] }',
        "```",
        "done",
      ].join("\n")
    );

    expect(JSON.parse(jsonText)).toStrictEqual({
      items: [1, 2],
      message: "brace in string: }",
      status: "accepted",
    });
  });

  it("skips bracket-like prose before the real JSON document", () => {
    const jsonText = extractFirstJsonValueText(
      'note [not json] before {"ok":true,"nested":{"value":1}} trailing'
    );

    expect(JSON.parse(jsonText)).toStrictEqual({
      nested: { value: 1 },
      ok: true,
    });
  });

  it("throws when the agent output has no complete JSON value", () => {
    expect(() => extractFirstJsonValueText("no structured output")).toThrow(
      "Agent lane output did not contain a complete JSON value."
    );
  });
});

describe(jsonOutputNormalizerNodeScript, () => {
  it("embeds the same extraction helper used by the TypeScript tests", () => {
    expect({
      avoidsBundlerHelpers: !jsonOutputNormalizerNodeScript.includes("__name"),
      readsRawOutputPath: jsonOutputNormalizerNodeScript.includes(
        "process.env.raw_output_path"
      ),
      usesExtractor: jsonOutputNormalizerNodeScript.includes(
        "extractFirstJsonValueText"
      ),
      writesPrettyJson: jsonOutputNormalizerNodeScript.includes(
        "JSON.stringify(parsed, null, 2)"
      ),
    }).toStrictEqual({
      avoidsBundlerHelpers: true,
      readsRawOutputPath: true,
      usesExtractor: true,
      writesPrettyJson: true,
    });
  });
});

describe(buildPiAgentLaneCommand, () => {
  const command = buildPiAgentLaneCommand();

  it("guarantees a result marker on any exit via an EXIT trap installed before fallible work", () => {
    const trapIndex = command.indexOf("trap emit_failure_marker EXIT");
    const cloneIndex = command.indexOf('git clone "$ARTIFACTS_GIT_REMOTE"');

    expect({
      emitsErrorStatusOnFailure: command.includes('status: "error"'),
      emitsOkStatusOnSuccess: command.includes('status: "ok"'),
      guardsAgainstDoubleEmit: command.includes(
        'if [ "$marker_emitted" = "1" ]'
      ),
      sameMarkerPrefixForBothPaths:
        (command.match(/__PIWF_AGENT_LANE_RESULT__/gu) ?? []).length === 2,
      scrubsCredentialsBeforeTailing: command.includes(
        "s#https://x:[^@]*@#https://x:***@#g"
      ),
      tracksFailingStepThroughPush: command.includes('current_step="git-push"'),
      trapInstalledBeforeClone: trapIndex !== -1 && trapIndex < cloneIndex,
    }).toStrictEqual({
      emitsErrorStatusOnFailure: true,
      emitsOkStatusOnSuccess: true,
      guardsAgainstDoubleEmit: true,
      sameMarkerPrefixForBothPaths: true,
      scrubsCredentialsBeforeTailing: true,
      tracksFailingStepThroughPush: true,
      trapInstalledBeforeClone: true,
    });
  });
});

describe(buildAgentLanePackageMountIndex, () => {
  it("turns pinned packages into sanitized sandbox mount records", () => {
    const pinnedPackage = buildPinnedPackageFixture();
    const mountIndex = buildAgentLanePackageMountIndex([pinnedPackage]);

    expect({
      mountPath: mountIndex.mounts.at(0)?.mountPath,
      packageId: mountIndex.mounts.at(0)?.metadata.packageId,
      redacted: mountIndex.redacted,
      schemaVersion: mountIndex.schemaVersion,
      scopedPackagePath: mountedPackagePathFor("@joelhooks/shitrat-kernel"),
    }).toStrictEqual({
      mountPath: "packages/badass-courses_claw-kernel",
      packageId: "badass-courses/claw-kernel",
      redacted: true,
      schemaVersion: "agent-lane.package-mounts.v1",
      scopedPackagePath: "packages/_joelhooks_shitrat-kernel",
    });
  });

  it("rejects package ids that collide after path sanitization", () => {
    expect(() =>
      buildAgentLanePackageMountIndex([
        buildPinnedPackageFixture({
          artifactRef: "artifact://packages/a-b/refs/v1",
          packageId: "a/b",
        }),
        buildPinnedPackageFixture({
          artifactRef: "artifact://packages/a_b/refs/v1",
          packageId: "a_b",
        }),
      ])
    ).toThrow("Package mount path collision");
  });
});

describe(agentLanePackageMountWriterNodeScript, () => {
  it("writes a package mount index plus manifest and pin files", () => {
    const pinnedPackage = buildPinnedPackageFixture();
    const mountIndex = buildAgentLanePackageMountIndex([pinnedPackage]);
    const mount = mountIndex.mounts.at(0);
    if (mount === undefined) {
      throw new Error("Expected one package mount.");
    }
    const cwd = mkdtempSync(join(tmpdir(), "piwf-package-mounts-"));

    try {
      execFileSync(
        process.execPath,
        ["-e", agentLanePackageMountWriterNodeScript],
        {
          cwd,
          env: {
            ...process.env,
            LANE_PACKAGE_MOUNT_INDEX_JSON: JSON.stringify(mountIndex),
          },
        }
      );

      const writtenIndex = AgentLanePackageMountIndexSchema.parse(
        JSON.parse(
          readFileSync(join(cwd, "packages", "pinned-packages.json"), "utf-8")
        )
      );
      const writtenManifest = PackageMetadataSchema.parse(
        JSON.parse(
          readFileSync(join(cwd, mount.mountPath, "package.json"), "utf-8")
        )
      );
      const writtenPin = PackagePinFileSchema.parse(
        JSON.parse(
          readFileSync(join(cwd, mount.mountPath, "pin.json"), "utf-8")
        )
      );

      expect({
        index: writtenIndex,
        manifest: writtenManifest,
        pin: writtenPin,
      }).toStrictEqual({
        index: mountIndex,
        manifest: pinnedPackage.metadata,
        pin: {
          artifactRef: pinnedPackage.artifactRef,
          fileHashes: pinnedPackage.fileHashes,
          manifestHash: pinnedPackage.manifestHash,
          pinnedAt: pinnedPackage.pinnedAt,
          redacted: true,
          version: pinnedPackage.version,
        },
      });
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});
