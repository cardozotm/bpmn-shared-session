-- Last-known diagram state per room. No version history.
create table if not exists public.rooms (
  id text primary key,
  xml text not null,
  revision integer not null default 0,
  legend jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

-- No policies for anon/authenticated: only the service role (bypasses RLS) reads/writes.
comment on table public.rooms is 'Shared BPMN room snapshots; access only via service role from the Node server.';
