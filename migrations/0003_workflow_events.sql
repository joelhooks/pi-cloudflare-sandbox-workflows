create table if not exists workflow_events (
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
);

create index if not exists idx_workflow_events_run_at
  on workflow_events (run_id, at);

create index if not exists idx_workflow_events_work_item
  on workflow_events (work_item_id, event_index);
