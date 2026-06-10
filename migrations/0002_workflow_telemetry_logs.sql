create table if not exists workflow_telemetry_logs (
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
);

create index if not exists idx_workflow_telemetry_logs_run_at
  on workflow_telemetry_logs (run_id, at);

create index if not exists idx_workflow_telemetry_logs_trace_span
  on workflow_telemetry_logs (trace_id, span_id);
