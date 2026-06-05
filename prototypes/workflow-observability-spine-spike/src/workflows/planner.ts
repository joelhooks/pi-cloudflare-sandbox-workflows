export interface ObservabilityBuildLane {
  laneId: string;
  owns: string[];
  dependsOn: string[];
}

export const seedObservabilityBuildLanes = (): ObservabilityBuildLane[] => [
  { laneId: "core-ports-and-events", owns: ["src/core/**"], dependsOn: [] },
  { laneId: "cloudflare-adapters", owns: ["src/adapters/**"], dependsOn: ["core-ports-and-events"] },
  { laneId: "dynamic-harness-runtime", owns: ["src/workflows/**"], dependsOn: ["core-ports-and-events"] },
  { laneId: "verifier-debugger", owns: ["src/workflows/debugger.ts"], dependsOn: ["core-ports-and-events"] },
  { laneId: "docs-and-capture", owns: ["README.generated.md", ".brain/**"], dependsOn: ["core-ports-and-events"] },
];
