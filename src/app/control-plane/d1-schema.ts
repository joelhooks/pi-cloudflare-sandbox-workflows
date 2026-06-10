import { z } from "zod";

import {
  ArtifactRefSchema,
  CapabilityNameSchema,
  IsoDateTimeSchema,
  PackageKindSchema,
  SafetyEnvelopeStateSchema,
  Sha256HexSchema,
  TrustTierSchema,
  WorkflowStructuredLogValueSchema,
} from "../domain/schemas.ts";

export const APP_D1_SCHEMA_VERSION = "workflow-app-d1.2026-06-09";

export const APP_D1_TABLES = [
  "packages",
  "package_entitlements",
  "runs",
  "workflow_events",
  "capability_leases",
  "receipts",
  "review_gates",
  "workflow_telemetry_logs",
] as const;

export const APP_D1_SCHEMA_SQL = [
  `create table if not exists packages (
    package_id text primary key,
    title text not null,
    kind text not null,
    owner_ref text not null,
    latest_version text not null,
    artifact_ref text not null,
    manifest_path text not null default 'package.json',
    manifest_hash text,
    trust_tier text not null,
    created_at text not null default CURRENT_TIMESTAMP,
    updated_at text not null default CURRENT_TIMESTAMP
  )`,
  `create table if not exists package_entitlements (
    subject_type text not null,
    subject_id text not null,
    package_id text not null,
    version_range text not null,
    can_discover integer not null,
    can_mount integer not null,
    can_invoke integer not null,
    created_at text not null default CURRENT_TIMESTAMP,
    primary key (subject_type, subject_id, package_id)
  )`,
  `create table if not exists runs (
    run_id text primary key,
    work_item_id text not null,
    capsule_id text not null,
    actor_id text not null,
    status text not null,
    plan_ref text,
    plan_hash text,
    created_at text not null default CURRENT_TIMESTAMP,
    updated_at text not null default CURRENT_TIMESTAMP
  )`,
  `create table if not exists workflow_events (
    run_id text not null,
    event_index integer not null,
    work_item_id text not null,
    capsule_id text not null,
    actor_id text not null,
    state text not null,
    summary text not null,
    refs_json text not null,
    redacted integer not null,
    at text not null,
    created_at text not null default CURRENT_TIMESTAMP,
    primary key (run_id, event_index)
  )`,
  `create index if not exists idx_workflow_events_run_at
    on workflow_events (run_id, at)`,
  `create index if not exists idx_workflow_events_work_item
    on workflow_events (work_item_id, event_index)`,
  `create table if not exists capability_leases (
    lease_id text primary key,
    run_id text not null,
    capability text not null,
    resource_ref text not null,
    payload_hash text not null,
    policy_id text not null,
    status text not null,
    expires_at text not null,
    redacted integer not null,
    created_at text not null default CURRENT_TIMESTAMP
  )`,
  `create table if not exists receipts (
    receipt_id text primary key,
    run_id text not null,
    receipt_kind text not null,
    artifact_ref text not null,
    receipt_hash text not null,
    redacted integer not null,
    created_at text not null default CURRENT_TIMESTAMP
  )`,
  `create table if not exists review_gates (
    review_id text primary key,
    run_id text not null,
    capability text,
    resource_ref text,
    status text not null,
    approval_ref text,
    reviewer_actor_id text,
    created_at text not null default CURRENT_TIMESTAMP,
    updated_at text not null default CURRENT_TIMESTAMP
  )`,
  `create table if not exists workflow_telemetry_logs (
    log_id text primary key,
    run_id text not null,
    work_item_id text not null,
    trace_id text not null,
    span_id text not null,
    event_name text not null,
    severity text not null,
    lane_id text,
    capability text,
    lease_id text,
    artifact_ref text,
    payload_hash text,
    duration_ms integer,
    fields_json text not null,
    redacted integer not null,
    at text not null,
    created_at text not null default CURRENT_TIMESTAMP
  )`,
  `create index if not exists idx_workflow_telemetry_logs_run_at
    on workflow_telemetry_logs (run_id, at)`,
  `create index if not exists idx_workflow_telemetry_logs_trace_span
    on workflow_telemetry_logs (trace_id, span_id)`,
] as const;

export const D1PackageRowSchema = z.object({
  artifact_ref: ArtifactRefSchema,
  kind: PackageKindSchema,
  latest_version: z.string().min(1),
  manifest_hash: Sha256HexSchema.optional(),
  manifest_path: z.literal("package.json"),
  owner_ref: z.string().min(1),
  package_id: z.string().min(1),
  title: z.string().min(1),
  trust_tier: TrustTierSchema,
});

export const D1EntitlementRowSchema = z.object({
  can_discover: z.union([z.literal(0), z.literal(1)]),
  can_invoke: z.union([z.literal(0), z.literal(1)]),
  can_mount: z.union([z.literal(0), z.literal(1)]),
  package_id: z.string().min(1),
  subject_id: z.string().min(1),
  subject_type: z.enum(["actor", "organization", "role", "service"]),
  version_range: z.string().min(1),
});

export const D1RunRowSchema = z.object({
  actor_id: z.string().min(1),
  capsule_id: z.string().min(1),
  plan_hash: Sha256HexSchema.optional(),
  plan_ref: ArtifactRefSchema.optional(),
  run_id: z.string().min(1),
  status: SafetyEnvelopeStateSchema,
  work_item_id: z.string().min(1),
});

export const D1WorkflowEventRowSchema = z.object({
  actor_id: z.string().min(1),
  at: IsoDateTimeSchema,
  capsule_id: z.string().min(1),
  event_index: z.number().int().min(1),
  redacted: z.union([z.literal(0), z.literal(1)]),
  refs_json: z
    .string()
    .min(2)
    .refine((value) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return false;
      }

      return z.record(z.string(), z.string()).safeParse(parsed).success;
    }, "refs_json must be a JSON object of string values."),
  run_id: z.string().min(1),
  state: SafetyEnvelopeStateSchema,
  summary: z.string().min(1),
  work_item_id: z.string().min(1),
});

export const D1LeaseRowSchema = z.object({
  capability: CapabilityNameSchema,
  expires_at: IsoDateTimeSchema,
  lease_id: z.string().min(1),
  payload_hash: Sha256HexSchema,
  policy_id: z.string().min(1),
  redacted: z.union([z.literal(0), z.literal(1)]),
  resource_ref: z.string().min(1),
  run_id: z.string().min(1),
  status: z.enum(["issued", "executed", "denied", "expired", "revoked"]),
});

export const D1ReceiptRowSchema = z.object({
  artifact_ref: ArtifactRefSchema,
  receipt_hash: Sha256HexSchema,
  receipt_id: z.string().min(1),
  receipt_kind: z.enum([
    "plan",
    "machine",
    "harness",
    "verification-contract",
    "agent-lane",
    "lease",
    "discord",
    "github",
    "linear",
    "wzrrd",
    "review-summary",
    "telemetry",
  ]),
  redacted: z.union([z.literal(0), z.literal(1)]),
  run_id: z.string().min(1),
});

export const D1ReviewGateRowSchema = z.object({
  approval_ref: z.string().min(1).optional(),
  capability: CapabilityNameSchema.optional(),
  resource_ref: z.string().min(1).optional(),
  review_id: z.string().min(1),
  reviewer_actor_id: z.string().min(1).optional(),
  run_id: z.string().min(1),
  status: z.enum([
    "approval-required",
    "approved",
    "rejected",
    "summary-captured",
  ]),
});

export const D1WorkflowTelemetryLogRowSchema = z.object({
  artifact_ref: ArtifactRefSchema.optional(),
  at: IsoDateTimeSchema,
  capability: CapabilityNameSchema.optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  event_name: z.string().min(1),
  fields_json: z
    .string()
    .min(2)
    .refine((value) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        return false;
      }

      return z
        .record(z.string(), WorkflowStructuredLogValueSchema)
        .safeParse(parsed).success;
    }, "fields_json must be a JSON object of structured log values."),
  lane_id: z.string().min(1).optional(),
  lease_id: z.string().min(1).optional(),
  log_id: z.string().min(1),
  payload_hash: Sha256HexSchema.optional(),
  redacted: z.union([z.literal(0), z.literal(1)]),
  run_id: z.string().min(1),
  severity: z.enum(["debug", "info", "warn", "error"]),
  span_id: z.string().min(1),
  trace_id: z.string().min(1),
  work_item_id: z.string().min(1),
});

export const APP_D1_ROW_SCHEMAS = {
  entitlement: D1EntitlementRowSchema,
  lease: D1LeaseRowSchema,
  package: D1PackageRowSchema,
  receipt: D1ReceiptRowSchema,
  reviewGate: D1ReviewGateRowSchema,
  run: D1RunRowSchema,
  telemetryLog: D1WorkflowTelemetryLogRowSchema,
  workflowEvent: D1WorkflowEventRowSchema,
} as const;
