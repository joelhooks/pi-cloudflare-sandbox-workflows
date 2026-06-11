import { describe, expect, it } from "vitest";
import { z } from "zod";

import { memoryFabricPackageMetadata } from "../../src/cartridges/memory-fabric/package-seed.ts";
import { dreamTranscriptReviewSourceProfile } from "../../src/cartridges/memory-fabric/source-profile.ts";
import {
  MEMORY_FABRIC_NODE_CONFIG_SCHEMAS,
  memoryFabricNodeConfigContracts,
  memoryFabricNodeConfigContractNotes,
} from "../../src/cartridges/memory-fabric/workflow-node-adapter.ts";

const paletteNodeTypes = memoryFabricPackageMetadata.exports.flatMap(
  (exportRecord) =>
    exportRecord.kind === "workflow-node" && exportRecord.nodeType !== undefined
      ? [exportRecord.nodeType]
      : []
);

const advertisedGuidance = dreamTranscriptReviewSourceProfile.plannerGuidance
  ? [
      dreamTranscriptReviewSourceProfile.plannerGuidance.intent,
      ...dreamTranscriptReviewSourceProfile.plannerGuidance.stochasticNotes,
    ].join("\n")
  : "";

describe("memory-fabric node config advertisement registry sync", () => {
  it("advertises a config contract for exactly the registry nodeTypes", () => {
    const advertisedNodeTypes = memoryFabricNodeConfigContracts()
      .map((contract) => contract.nodeType)
      .toSorted();
    expect(advertisedNodeTypes).toStrictEqual(
      Object.keys(MEMORY_FABRIC_NODE_CONFIG_SCHEMAS).toSorted()
    );
  });

  it("advertises a config contract for exactly the palette nodeTypes", () => {
    // Fails if a node is added to the registry/palette but not advertised, or vice versa.
    const advertisedNodeTypes = memoryFabricNodeConfigContracts()
      .map((contract) => contract.nodeType)
      .toSorted();
    expect(advertisedNodeTypes).toStrictEqual([...paletteNodeTypes].toSorted());
  });

  it("derives each advertised config schema from the same registry schema the executor parses", () => {
    const advertisedByNodeType = new Map(
      memoryFabricNodeConfigContracts().map((contract) => [
        contract.nodeType,
        contract.configJsonSchema,
      ])
    );
    for (const [nodeType, schema] of Object.entries(
      MEMORY_FABRIC_NODE_CONFIG_SCHEMAS
    )) {
      // The advertised JSON Schema must be byte-identical to converting the live
      // registry schema, proving a single source of truth (no hand-maintained drift).
      expect(advertisedByNodeType.get(nodeType)).toStrictEqual(
        z.toJSONSchema(schema, { target: "draft-7" })
      );
    }
  });
});

describe("memory-fabric planner prompt config contract notes", () => {
  it("mentions every palette nodeType's config contract in the planner guidance the prompt copies", () => {
    for (const nodeType of paletteNodeTypes) {
      expect(advertisedGuidance).toContain(nodeType);
    }
  });

  it("advertises the signals/search enum leash and a concrete capture-artifact ref example", () => {
    const notes = memoryFabricNodeConfigContractNotes().join("\n");
    // Enum options must be advertised exactly so the planner stops guessing.
    expect(notes).toContain("workflow-pattern");
    // The worked example must steer capture-artifact at a producing step ref,
    // not the bare artifactKinds/capturePurpose intent the executor cannot resolve.
    expect(notes).toContain("artifactStepId");
    // The leash defaults must be advertised so an omitted query is recoverable.
    expect(notes).toContain('"query"');
  });

  it("flows the contract notes verbatim into the source profile planner guidance", () => {
    const notes = memoryFabricNodeConfigContractNotes();
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(
        dreamTranscriptReviewSourceProfile.plannerGuidance?.stochasticNotes
      ).toContain(note);
    }
  });
});
