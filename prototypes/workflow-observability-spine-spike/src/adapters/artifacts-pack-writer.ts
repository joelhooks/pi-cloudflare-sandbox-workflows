import type { ObservabilityPackWriter, WorkflowEventSink } from "../core/ports";
import type { WorkflowEvent } from "../core/events";

export class ArtifactsEventSink implements WorkflowEventSink {
  constructor(private readonly append: (path: string, line: string) => Promise<void>) {}
  async emit(event: WorkflowEvent): Promise<void> {
    await this.append("run/events.jsonl", JSON.stringify(event));
  }
}

export class ArtifactsObservabilityPackWriter implements ObservabilityPackWriter {
  constructor(private readonly writeJson: (path: string, value: unknown) => Promise<void>) {}
  async writePack(runId: string): Promise<{ refs: string[] }> {
    const refs = ["run/events.jsonl", "run/status.json", "run/metrics-summary.json", "run/trace-summary.json", "run/cost-summary.json", "run/agent-observability-summary.md"];
    await this.writeJson("run/observability-pack.json", { refs, runId });
    return { refs };
  }
}
