begin;

create table hush_private.notion_deliveries (
  capture_id uuid primary key references public.captures(id) on delete cascade,
  task_id uuid not null,
  attempt_id uuid not null,
  started_at timestamptz not null default now(),
  delivered_at timestamptz,
  warning boolean not null default false,
  result_message text
);

alter table hush_private.notion_deliveries enable row level security;
revoke all on hush_private.notion_deliveries from public, anon, authenticated, service_role;
grant select, insert, update on hush_private.notion_deliveries to service_role;
grant select on public.captures to service_role;

create function public.hush_notion_delivery(
  p_workspace_id uuid,
  p_user_id uuid,
  p_capture_id uuid,
  p_action text,
  p_task_id uuid default null,
  p_attempt_id uuid default null,
  p_warning boolean default false,
  p_message text default null
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  delivery hush_private.notion_deliveries%rowtype;
begin
  if not exists (
    select 1 from public.captures c
    join public.memberships m on m.workspace_id = c.workspace_id and m.user_id = p_user_id
    where c.id = p_capture_id and c.workspace_id = p_workspace_id
      and c.uploaded_by = p_user_id and c.file_type = 'text'
  ) then
    raise exception 'Note not found or access denied.' using errcode = '42501';
  end if;

  if p_action = 'claim' and p_task_id is not null and p_attempt_id is not null then
    insert into hush_private.notion_deliveries (capture_id, task_id, attempt_id)
    values (p_capture_id, p_task_id, p_attempt_id)
    on conflict (capture_id) do nothing;
    if found then return jsonb_build_object('state', 'claimed'); end if;
  elsif p_action = 'finish' and p_attempt_id is not null and p_message is not null then
    update hush_private.notion_deliveries
    set delivered_at = now(), warning = coalesce(p_warning, false), result_message = left(p_message, 500)
    where capture_id = p_capture_id and attempt_id = p_attempt_id and delivered_at is null;
    if not found then
      raise exception 'Delivery reservation not found.' using errcode = '22023';
    end if;
  elsif p_action is distinct from 'check' then
    raise exception 'Invalid delivery operation.' using errcode = '22023';
  end if;

  select * into delivery from hush_private.notion_deliveries where capture_id = p_capture_id;
  if not found then return jsonb_build_object('state', 'new'); end if;
  return jsonb_build_object(
    'state', case when delivery.delivered_at is null then 'pending' else 'delivered' end,
    'taskId', delivery.task_id,
    'warning', delivery.warning,
    'message', delivery.result_message
  );
end;
$$;

revoke all on function public.hush_notion_delivery(uuid,uuid,uuid,text,uuid,uuid,boolean,text)
from public, anon, authenticated;
grant execute on function public.hush_notion_delivery(uuid,uuid,uuid,text,uuid,uuid,boolean,text)
to service_role;

commit;

select not has_function_privilege('anon',
  'public.hush_notion_delivery(uuid,uuid,uuid,text,uuid,uuid,boolean,text)', 'execute')
and not has_function_privilege('authenticated',
  'public.hush_notion_delivery(uuid,uuid,uuid,text,uuid,uuid,boolean,text)', 'execute')
and has_function_privilege('service_role',
  'public.hush_notion_delivery(uuid,uuid,uuid,text,uuid,uuid,boolean,text)', 'execute')
as notion_delivery_server_only;
