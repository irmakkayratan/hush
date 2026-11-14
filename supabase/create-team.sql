begin;

create or replace function public.hush_create_team(
  p_user_id uuid,
  p_workspace_id uuid,
  p_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  clean_name text;
  existing_name text;
  managed_count integer;
begin
  clean_name := trim(regexp_replace(p_name, '\s+', ' ', 'g'));
  if p_user_id is null or p_workspace_id is null
     or clean_name is null or length(clean_name) < 2 or length(clean_name) > 80 then
    raise exception 'Use a team name between 2 and 80 characters.' using errcode = '22023';
  end if;

  -- Serialize attempts by this account, including retries after network failures.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));

  select w.name into existing_name
  from public.workspaces w where w.id = p_workspace_id;
  if found then
    if exists (
      select 1 from public.memberships m
      where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.role = 'pm'
    ) and existing_name = clean_name then
      return jsonb_build_object('id', p_workspace_id, 'name', existing_name);
    end if;
    raise exception 'That workspace ID is already in use.' using errcode = '42501';
  end if;

  select count(*) into managed_count from public.memberships m
  where m.user_id = p_user_id and m.role = 'pm';
  if managed_count >= 10 then
    raise exception 'This account already manages 10 teams.' using errcode = '22023';
  end if;

  insert into public.workspaces (id, name) values (p_workspace_id, clean_name);
  insert into public.memberships (id, workspace_id, user_id, role)
  values (gen_random_uuid(), p_workspace_id, p_user_id, 'pm');

  return jsonb_build_object('id', p_workspace_id, 'name', clean_name);
end;
$$;

grant select, insert on public.workspaces to service_role;
grant select, insert on public.memberships to service_role;
revoke all on function public.hush_create_team(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.hush_create_team(uuid, uuid, text) to service_role;
commit;

select
  has_function_privilege('anon', 'public.hush_create_team(uuid,uuid,text)', 'EXECUTE') as anonymous_can_call,
  has_function_privilege('authenticated', 'public.hush_create_team(uuid,uuid,text)', 'EXECUTE') as browser_user_can_call,
  has_function_privilege('service_role', 'public.hush_create_team(uuid,uuid,text)', 'EXECUTE') as server_can_call;
