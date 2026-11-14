begin;

create function public.hush_manage_notion_connection(
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
      'expired', coalesce(c.token_expires_at <= now(), false),
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

revoke all on function public.hush_manage_notion_connection(uuid, uuid, boolean)
from public, anon, authenticated;
grant execute on function public.hush_manage_notion_connection(uuid, uuid, boolean)
to service_role;

commit;

select not has_function_privilege('anon', 'public.hush_manage_notion_connection(uuid,uuid,boolean)', 'execute')
  and not has_function_privilege('authenticated', 'public.hush_manage_notion_connection(uuid,uuid,boolean)', 'execute')
  and has_function_privilege('service_role', 'public.hush_manage_notion_connection(uuid,uuid,boolean)', 'execute')
as notion_management_server_only;
