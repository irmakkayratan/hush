begin;

alter table hush_private.notion_connections
  add column refresh_attempt uuid,
  add column refresh_started_at timestamptz,
  add column refresh_reconnect_required boolean not null default false;

create function hush_private.hush_reset_notion_refresh()
returns trigger language plpgsql security invoker set search_path = ''
as $$
begin
  if new.access_token_encrypted is distinct from old.access_token_encrypted
     or new.refresh_token_encrypted is distinct from old.refresh_token_encrypted then
    new.refresh_attempt := null;
    new.refresh_started_at := null;
    new.refresh_reconnect_required := false;
  end if;
  return new;
end;
$$;

create trigger hush_reset_notion_refresh
before update of access_token_encrypted, refresh_token_encrypted on hush_private.notion_connections
for each row execute function hush_private.hush_reset_notion_refresh();

revoke all on function hush_private.hush_reset_notion_refresh()
from public, anon, authenticated;

create function public.hush_rotate_notion_connection(
  p_workspace_id uuid, p_user_id uuid, p_expected_access text, p_attempt uuid,
  p_action text, p_access text default null, p_refresh text default null,
  p_expires_at timestamptz default null
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  c hush_private.notion_connections%rowtype;
begin
  if p_attempt is null or p_expected_access is null
     or p_action is null or p_action not in ('claim', 'finish', 'fail', 'release') then
    raise exception 'Invalid refresh operation.' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.memberships
    where workspace_id = p_workspace_id and user_id = p_user_id
  ) then
    raise exception 'Workspace access denied.' using errcode = '42501';
  end if;

  select * into c from hush_private.notion_connections
  where workspace_id = p_workspace_id for update;

  if not found then return jsonb_build_object('state', 'reconnect'); end if;
  if c.access_token_encrypted <> p_expected_access then
    return jsonb_build_object('state', 'changed');
  end if;

  if p_action = 'claim' then
    if c.connection_type <> 'oauth' or c.refresh_token_encrypted is null
       or c.refresh_reconnect_required then
      return jsonb_build_object('state', 'reconnect');
    end if;
    if c.refresh_attempt is not null then
      -- An interrupted rotation may already have consumed the old token.
      return jsonb_build_object('state',
        case when c.refresh_started_at < now() - interval '45 seconds'
          then 'reconnect' else 'busy' end);
    end if;
    update hush_private.notion_connections
    set refresh_attempt = p_attempt, refresh_started_at = now()
    where workspace_id = p_workspace_id;
    return jsonb_build_object('state', 'claimed', 'refresh', c.refresh_token_encrypted);
  end if;

  if c.refresh_attempt is distinct from p_attempt then
    return jsonb_build_object('state', 'changed');
  end if;

  if p_action = 'finish' then
    if p_access is null or p_refresh is null
       or length(p_access) > 12000 or length(p_refresh) > 12000
       or p_access !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$'
       or p_refresh !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' then
      raise exception 'Invalid encrypted credentials.' using errcode = '22023';
    end if;
    update hush_private.notion_connections
    set access_token_encrypted = p_access, refresh_token_encrypted = p_refresh,
        token_expires_at = p_expires_at, updated_at = now(),
        refresh_attempt = null, refresh_started_at = null, refresh_reconnect_required = false
    where workspace_id = p_workspace_id;
    return jsonb_build_object('state', 'saved');
  end if;

  update hush_private.notion_connections
  set refresh_attempt = null, refresh_started_at = null,
      refresh_reconnect_required = (p_action = 'fail')
  where workspace_id = p_workspace_id;
  return jsonb_build_object('state', 'cleared');
end;
$$;

revoke all on function public.hush_rotate_notion_connection(uuid,uuid,text,uuid,text,text,text,timestamptz)
from public, anon, authenticated;
grant execute on function public.hush_rotate_notion_connection(uuid,uuid,text,uuid,text,text,text,timestamptz)
to service_role;

create or replace function public.hush_manage_notion_connection(
  p_user_id uuid,
  p_workspace_id uuid,
  p_disconnect boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_disconnect is true then
    -- Use the same lock as the connection save operation.
    perform 1 from public.workspaces where id = p_workspace_id for update;
  end if;

  if not exists (
    select 1 from public.memberships
    where workspace_id = p_workspace_id and user_id = p_user_id and role = 'pm'
  ) then
    raise exception 'Only a team administrator can manage this connection.' using errcode = '42501';
  end if;

  if p_disconnect is true then
    delete from hush_private.notion_sources where workspace_id = p_workspace_id;
    delete from hush_private.notion_connections where workspace_id = p_workspace_id;
    return jsonb_build_object('connected', false);
  end if;

  return coalesce((
    select jsonb_build_object(
      'connected', true,
      'notionWorkspace', c.notion_workspace_name,
      'expired', coalesce(c.token_expires_at <= now(), false)
        or c.refresh_reconnect_required
        or coalesce(c.refresh_started_at < now() - interval '45 seconds', false),
      'sources', (
        select coalesce(jsonb_agg(s.name order by s.name), '[]'::jsonb)
        from hush_private.notion_sources s
        where s.workspace_id = c.workspace_id and s.enabled
      )
    )
    from hush_private.notion_connections c where c.workspace_id = p_workspace_id
  ), jsonb_build_object('connected', false));
end;
$$;

commit;

select not has_function_privilege('anon',
  'public.hush_rotate_notion_connection(uuid,uuid,text,uuid,text,text,text,timestamptz)', 'execute')
and not has_function_privilege('authenticated',
  'public.hush_rotate_notion_connection(uuid,uuid,text,uuid,text,text,text,timestamptz)', 'execute')
and has_function_privilege('service_role',
  'public.hush_rotate_notion_connection(uuid,uuid,text,uuid,text,text,text,timestamptz)', 'execute')
as notion_refresh_server_only;
