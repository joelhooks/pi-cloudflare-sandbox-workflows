import { z } from "zod";

export const WorkflowEventSchema = z.object({
  schemaVersion: z.literal("piwf.event.v0"),
  timestamp: z.string(),
  seq: z.number().int().positive(),
  traceId: z.string(),
  spanId: z.string(),
  runId: z.string(),
  laneId: z.string().optional(),
  actor: z.string(),
  state: z.string(),
  event: z.string(),
  severity: z.enum(["debug", "info", "warn", "error"]),
  redaction: z.enum(["public-safe", "private", "secret-adjacent"]),
  message: z.string(),
  artifactRefs: z.array(z.string()).default([]),
});

export type WorkflowEvent = z.infer<typeof WorkflowEventSchema>;
