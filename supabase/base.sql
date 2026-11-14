-- Initial schema for a new HUSH Supabase project.
begin;

create schema hush_private;
revoke all on schema hush_private from public, anon, authenticated;
grant usage on schema hush_private to service_role;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text
);
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('pm', 'member')),
  unique (workspace_id, user_id)
);
create table public.captures (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id) on delete cascade,
  file_type text not null check (file_type in ('text', 'audio', 'image')),
  note_text text,
  file_path text,
  status text not null default 'pending',
  transcription text,
  ai_summary text,
  detected_language text,
  created_at timestamptz not null default now()
);
create index memberships_user_idx on public.memberships(user_id);
create index captures_team_author_idx on public.captures(workspace_id, uploaded_by);
create index captures_author_idx on public.captures(uploaded_by);

alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.captures enable row level security;

revoke all on public.workspaces, public.profiles, public.memberships, public.captures from public, anon, authenticated;
grant select on public.workspaces, public.memberships to authenticated;
grant select, insert on public.captures to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.profiles, public.memberships, public.captures to service_role;

create policy "Members can read their teams" on public.workspaces for select to authenticated
  using (exists (select 1 from public.memberships m where m.workspace_id = workspaces.id and m.user_id = (select auth.uid())));
create policy "Members can read their memberships" on public.memberships for select to authenticated
  using (user_id = (select auth.uid()));
create policy "Users can read their profile" on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "Users can update their profile" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "Members can read team notes" on public.captures for select to authenticated
  using (exists (select 1 from public.memberships m where m.workspace_id = captures.workspace_id and m.user_id = (select auth.uid())));
create policy "Members can create their text notes" on public.captures for insert to authenticated
  with check (
    uploaded_by = (select auth.uid()) and status = 'pending' and transcription is null
    and ai_summary is null and detected_language is null and file_type = 'text' and file_path is null
    and length(btrim(note_text)) between 1 and 1800
    and exists (select 1 from public.memberships m where m.workspace_id = captures.workspace_id and m.user_id = (select auth.uid()))
  );

create function hush_private.create_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles(id) values (new.id) on conflict do nothing;
  return new;
end;
$$;
revoke all on function hush_private.create_profile() from public, anon, authenticated;
create trigger hush_create_profile after insert on auth.users
  for each row execute function hush_private.create_profile();
insert into public.profiles(id) select id from auth.users on conflict do nothing;

create table hush_private.notion_connections (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  notion_workspace_id uuid,
  notion_workspace_name text,
  connection_type text not null check (connection_type in ('internal', 'oauth')),
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table hush_private.notion_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references hush_private.notion_connections(workspace_id) on delete cascade,
  notion_data_source_id uuid not null,
  name text not null,
  title_property_id text,
  status_property_id text,
  date_property_id text,
  date_is_deadline boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, notion_data_source_id)
);
alter table hush_private.notion_connections enable row level security;
alter table hush_private.notion_sources enable row level security;
revoke all on hush_private.notion_connections, hush_private.notion_sources from public, anon, authenticated;
grant select, insert, update, delete on hush_private.notion_connections, hush_private.notion_sources to service_role;

create function public.hush_get_notion_connection(p_workspace_id uuid, p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select to_jsonb(c) || jsonb_build_object('sources', coalesce((
    select jsonb_agg(to_jsonb(s) order by s.name, s.id)
    from hush_private.notion_sources s where s.workspace_id = c.workspace_id and s.enabled
  ), '[]'::jsonb))
  from hush_private.notion_connections c where c.workspace_id = p_workspace_id
    and exists (select 1 from public.memberships m where m.workspace_id = c.workspace_id and m.user_id = p_user_id);
$$;
revoke all on function public.hush_get_notion_connection(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hush_get_notion_connection(uuid, uuid) to service_role;

commit;
