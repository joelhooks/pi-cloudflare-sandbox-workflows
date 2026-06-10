import { WorkflowTraceContextSchema } from "./schemas.ts";
import type { WorkflowTraceContext } from "./schemas.ts";

export const workflowTraceIdForRun = (runId: string): string =>
  `trace:${runId}`;

export const workflowRootSpanIdForRun = (runId: string): string =>
  `span:${runId}:workflow`;

export const workflowSpanIdForLane = (laneId: string): string =>
  `span:${laneId}`;

export const workflowSpanIdForCapability = (input: {
  readonly capability: string;
  readonly runId: string;
  readonly stepId: string;
}): string =>
  `span:${input.runId}:capability:${input.stepId}:${input.capability}`;

export const workflowTraceContextForLane = (input: {
  readonly laneId: string;
  readonly runId: string;
}): WorkflowTraceContext =>
  WorkflowTraceContextSchema.parse({
    parentSpanId: workflowRootSpanIdForRun(input.runId),
    redacted: true,
    spanId: workflowSpanIdForLane(input.laneId),
    traceId: workflowTraceIdForRun(input.runId),
  });

export const workflowTraceContextForCapability = (input: {
  readonly capability: string;
  readonly runId: string;
  readonly stepId: string;
}): WorkflowTraceContext =>
  WorkflowTraceContextSchema.parse({
    parentSpanId: workflowRootSpanIdForRun(input.runId),
    redacted: true,
    spanId: workflowSpanIdForCapability(input),
    traceId: workflowTraceIdForRun(input.runId),
  });
