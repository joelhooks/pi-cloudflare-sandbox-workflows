export const buildObservabilityWorkflow = () => ({
  pattern: "generated-build-swarm",
  outputTarget: "github_pr",
  generatedHarnessExecutes: true,
  isolation: "sandbox-workspace-per-lane",
  reviewGate: "debugger-verifier-before-pr-publication",
});
