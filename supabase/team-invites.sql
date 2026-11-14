begin;

create table hush_private.team_invites (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invite_email text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_by uuid references auth.users(id) on delete cascade
);
create index team_invites_workspace_idx on hush_private.team_invites (workspace_id);
create index team_invites_creator_idx on hush_private.team_invites (created_by);
create index team_invites_recipient_idx on hush_private.team_invites (accepted_by) where accepted_by is not null;
alter table hush_private.team_invites enable row level security;
revoke all on hush_private.team_invites from public, anon, authenticated, service_role;
grant select, insert, update on hush_private.team_invites to service_role;

create function public.hush_create_team_invite(
  p_user_id uuid, p_workspace_id uuid, p_email text, p_token_hash text
)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if p_email is null or length(p_email) > 254
     or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid invitation.' using errcode = '22023';
  end if;

  insert into hush_private.team_invites (workspace_id, invite_email, created_by, token_hash)
  select m.workspace_id, lower(p_email), m.user_id, p_token_hash
  from public.memberships m
  where m.workspace_id = p_workspace_id and m.user_id = p_user_id and m.role = 'pm';

  if not found then
    raise exception 'Only a team administrator can create invitations.' using errcode = '42501';
  end if;
end;
$$;

create function public.hush_accept_team_invite(
  p_user_id uuid, p_verified_email text, p_token_hash text
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  invite hush_private.team_invites%rowtype;
  team_name text;
begin
  select * into invite from hush_private.team_invites
  where token_hash = p_token_hash for update;

  if not found or p_user_id is null or p_verified_email is null
     or invite.invite_email <> lower(p_verified_email)
     or invite.expires_at <= now()
     or (invite.accepted_by is not null and invite.accepted_by <> p_user_id) then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;

  if invite.accepted_by is null then
    if not exists (
      select 1 from public.memberships m
      where m.workspace_id = invite.workspace_id and m.user_id = invite.created_by and m.role = 'pm'
    ) then
      raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
    end if;

    insert into public.memberships (id, workspace_id, user_id, role)
    values (gen_random_uuid(), invite.workspace_id, p_user_id, 'member')
    on conflict (workspace_id, user_id) do nothing;

    update hush_private.team_invites set accepted_by = p_user_id
    where token_hash = p_token_hash;
  elsif not exists (
    select 1 from public.memberships m
    where m.workspace_id = invite.workspace_id and m.user_id = p_user_id
  ) then
    raise exception 'This invitation is unavailable for this account.' using errcode = '42501';
  end if;

  select w.name into team_name from public.workspaces w where w.id = invite.workspace_id;
  return jsonb_build_object('id', invite.workspace_id, 'name', team_name);
end;
$$;

revoke all on function public.hush_create_team_invite(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.hush_accept_team_invite(uuid, text, text) from public, anon, authenticated;
grant execute on function public.hush_create_team_invite(uuid, uuid, text, text) to service_role;
grant execute on function public.hush_accept_team_invite(uuid, text, text) to service_role;

commit;

select
  not has_table_privilege('authenticated', 'hush_private.team_invites', 'SELECT')
    and not has_table_privilege('anon', 'hush_private.team_invites', 'SELECT') as invites_private,
  not has_function_privilege('authenticated', 'public.hush_create_team_invite(uuid,uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.hush_create_team_invite(uuid,uuid,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.hush_create_team_invite(uuid,uuid,text,text)', 'EXECUTE') as create_server_only,
  not has_function_privilege('authenticated', 'public.hush_accept_team_invite(uuid,text,text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.hush_accept_team_invite(uuid,text,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.hush_accept_team_invite(uuid,text,text)', 'EXECUTE') as accept_server_only;
