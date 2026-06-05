import type { WorkflowEvent } from "./events";

export interface WorkflowEventSink {
  emit(event: WorkflowEvent): Promise<void>;
}

export interface StatusProjectionStore {
  update(event: WorkflowEvent): Promise<void>;
  read(runId: string): Promise<unknown>;
}

export interface MetricsRecorder {
  record(event: WorkflowEvent): Promise<void>;
}

export interface TraceRecorder {
  span(event: WorkflowEvent): Promise<void>;
}

export interface RedactionPolicy {
  classify(value: string): "public-safe" | "private" | "secret-adjacent";
  redact(value: string): string;
}

export interface ObservabilityPackWriter {
  writePack(runId: string): Promise<{ refs: string[] }>;
}
