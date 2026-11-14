begin;

create or replace function public.hush_save_notion_connection(
  p_workspace_id uuid,
  p_user_id uuid,
  p_access_token_encrypted text,
  p_sources jsonb,
  p_notion_workspace_id uuid default null,
  p_notion_workspace_name text default null,
  p_connection_type text default 'internal',
  p_refresh_token_encrypted text default null,
  p_token_expires_at timestamptz default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_count integer;
  distinct_source_count integer;
begin
  if p_workspace_id is null or p_user_id is null or not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role = 'pm'
  ) then
    raise exception 'Only a PM in this workspace can change its Notion connection.'
      using errcode = '42501';
  end if;

  if p_access_token_encrypted is null
     or length(p_access_token_encrypted) > 12000
     or p_access_token_encrypted !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'
  then
    raise exception 'An encrypted access token is required.';
  end if;

  if p_refresh_token_encrypted is not null and (
    length(p_refresh_token_encrypted) > 12000 or
    p_refresh_token_encrypted !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'
  ) then
    raise exception 'The refresh token must be encrypted.';
  end if;

  if p_connection_type is null or p_connection_type not in ('internal', 'oauth') then
    raise exception 'Invalid connection type.';
  end if;

  if p_notion_workspace_name is not null and length(p_notion_workspace_name) > 300 then
    raise exception 'The workspace name is too long.';
  end if;

  if p_sources is null or jsonb_typeof(p_sources) <> 'array' then
    raise exception 'Task sources must be an array.';
  end if;

  source_count := jsonb_array_length(p_sources);
  if source_count < 1 or source_count > 20 then
    raise exception 'Choose between 1 and 20 task sources.';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_sources) as item(value)
    where jsonb_typeof(item.value) <> 'object'
      or coalesce(item.value ->> 'notion_data_source_id', '') !~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or coalesce(length(trim(item.value ->> 'name')), 0) = 0
      or length(item.value ->> 'name') > 200
      or jsonb_typeof(item.value -> 'name') is distinct from 'string'
      or (
        item.value ? 'date_is_deadline'
        and jsonb_typeof(item.value -> 'date_is_deadline') is distinct from 'boolean'
      )
  ) then
    raise exception 'Each task source needs a valid ID, name and date setting.';
  end if;

  select count(distinct lower(item.value ->> 'notion_data_source_id'))
  into distinct_source_count
  from jsonb_array_elements(p_sources) as item(value);

  if distinct_source_count <> source_count then
    raise exception 'A task source cannot be selected twice.';
  end if;

  -- Serialize connection changes for the same workspace.
  perform 1 from public.workspaces w
  where w.id = p_workspace_id
  for update;

  -- Recheck the role after acquiring the workspace lock.
  if not exists (
    select 1 from public.memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_user_id
      and m.role = 'pm'
  ) then
    raise exception 'Workspace access denied.' using errcode = '42501';
  end if;

  insert into hush_private.notion_connections (
    workspace_id, notion_workspace_id, notion_workspace_name,
    connection_type, access_token_encrypted, refresh_token_encrypted,
    token_expires_at
  ) values (
    p_workspace_id, p_notion_workspace_id, p_notion_workspace_name,
    p_connection_type, p_access_token_encrypted, p_refresh_token_encrypted,
    p_token_expires_at
  )
  on conflict (workspace_id) do update set
    notion_workspace_id = excluded.notion_workspace_id,
    notion_workspace_name = excluded.notion_workspace_name,
    connection_type = excluded.connection_type,
    access_token_encrypted = excluded.access_token_encrypted,
    refresh_token_encrypted = excluded.refresh_token_encrypted,
    token_expires_at = excluded.token_expires_at,
    updated_at = now();

  delete from hush_private.notion_sources s
  where s.workspace_id = p_workspace_id
    and not exists (
      select 1 from jsonb_array_elements(p_sources) as item(value)
      where (item.value ->> 'notion_data_source_id')::uuid = s.notion_data_source_id
    );

  insert into hush_private.notion_sources (
    workspace_id, notion_data_source_id, name,
    title_property_id, status_property_id, date_property_id,
    date_is_deadline, enabled
  )
  select
    p_workspace_id, item.notion_data_source_id, trim(item.name),
    item.title_property_id, item.status_property_id, item.date_property_id,
    coalesce(item.date_is_deadline, false), true
  from jsonb_to_recordset(p_sources) as item(
    notion_data_source_id uuid, name text,
    title_property_id text, status_property_id text,
    date_property_id text, date_is_deadline boolean
  )
  on conflict (workspace_id, notion_data_source_id) do update set
    name = excluded.name,
    title_property_id = excluded.title_property_id,
    status_property_id = excluded.status_property_id,
    date_property_id = excluded.date_property_id,
    date_is_deadline = excluded.date_is_deadline,
    enabled = true,
    updated_at = now();

  return jsonb_build_object('saved', true, 'source_count', source_count);
end;
$$;

grant select, update on public.workspaces to service_role;

revoke all on function public.hush_save_notion_connection(
  uuid, uuid, text, jsonb, uuid, text, text, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.hush_save_notion_connection(
  uuid, uuid, text, jsonb, uuid, text, text, text, timestamptz
) to service_role;

commit;

select
  has_function_privilege(
    'anon',
    'public.hush_save_notion_connection(uuid,uuid,text,jsonb,uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ) as anonymous_can_call,
  has_function_privilege(
    'authenticated',
    'public.hush_save_notion_connection(uuid,uuid,text,jsonb,uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ) as browser_user_can_call,
  has_function_privilege(
    'service_role',
    'public.hush_save_notion_connection(uuid,uuid,text,jsonb,uuid,text,text,text,timestamptz)',
    'EXECUTE'
  ) as server_can_call;
