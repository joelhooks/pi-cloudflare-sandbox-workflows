create table if not exists packages (
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
);

create table if not exists package_entitlements (
  subject_type text not null,
  subject_id text not null,
  package_id text not null,
  version_range text not null,
  can_discover integer not null,
  can_mount integer not null,
  can_invoke integer not null,
  created_at text not null default CURRENT_TIMESTAMP,
  primary key (subject_type, subject_id, package_id)
);

create table if not exists runs (
  run_id text primary key,
  work_item_id text not null,
  capsule_id text not null,
  actor_id text not null,
  status text not null,
  plan_ref text,
  plan_hash text,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP
);

create table if not exists capability_leases (
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
);

create table if not exists receipts (
  receipt_id text primary key,
  run_id text not null,
  receipt_kind text not null,
  artifact_ref text not null,
  receipt_hash text not null,
  redacted integer not null,
  created_at text not null default CURRENT_TIMESTAMP
);

create table if not exists review_gates (
  review_id text primary key,
  run_id text not null,
  capability text,
  resource_ref text,
  status text not null,
  approval_ref text,
  reviewer_actor_id text,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP
);
