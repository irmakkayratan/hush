begin;

create table hush_private.reminders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  task_id uuid,
  subscription jsonb not null,
  remind_at timestamptz not null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  outcome text check (outcome in ('accepted', 'failed')),
  foreign key (workspace_id, user_id)
    references public.memberships(workspace_id, user_id) on delete cascade
);
create index reminders_due_idx on hush_private.reminders(remind_at) where claimed_at is null;
create index reminders_user_idx on hush_private.reminders(user_id, created_at);
create index reminders_membership_idx on hush_private.reminders(workspace_id, user_id);
alter table hush_private.reminders enable row level security;
revoke all on hush_private.reminders from public, anon, authenticated, service_role;
grant select, insert, update, delete on hush_private.reminders to service_role;

create function public.hush_schedule_reminder(
  p_workspace_id uuid, p_user_id uuid, p_task_id uuid, p_subscription jsonb, p_remind_at timestamptz
)
returns jsonb language plpgsql security invoker set search_path = ''
as $$
declare
  existing_id uuid;
  existing_time timestamptz;
begin
  if not exists (
    select 1 from public.memberships m where m.workspace_id = p_workspace_id and m.user_id = p_user_id
  ) then
    raise exception 'Team access denied.' using errcode = '42501';
  end if;
  if p_remind_at is null or p_remind_at < now() or p_remind_at > now() + interval '366 days'
    or jsonb_typeof(p_subscription) is distinct from 'object'
    or coalesce(length(p_subscription ->> 'endpoint'), 0) not between 10 and 2048
    or pg_column_size(p_subscription) > 4096 then
    raise exception 'Invalid reminder.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hush-reminders:' || p_user_id::text, 0));
  select r.id, r.remind_at into existing_id, existing_time from hush_private.reminders r
  where r.user_id = p_user_id and r.workspace_id = p_workspace_id
    and r.task_id is not distinct from p_task_id and r.claimed_at is null
    and r.subscription ->> 'endpoint' = p_subscription ->> 'endpoint'
  order by r.created_at desc limit 1 for update;

  if found then
    if p_task_id is null then return jsonb_build_object('remindAt', existing_time); end if;
    update hush_private.reminders set subscription = p_subscription, remind_at = p_remind_at where id = existing_id;
    return jsonb_build_object('remindAt', p_remind_at);
  end if;

  if (select count(*) from hush_private.reminders r
      where r.user_id = p_user_id and (r.claimed_at is null or r.created_at > now() - interval '1 day')) >= 25 then
    raise exception 'Reminder limit reached.' using errcode = '54000';
  end if;
  insert into hush_private.reminders (workspace_id, user_id, task_id, subscription, remind_at)
  values (p_workspace_id, p_user_id, p_task_id, p_subscription, p_remind_at);
  return jsonb_build_object('remindAt', p_remind_at);
end;
$$;

create function public.hush_due_reminders()
returns table (id uuid, subscription jsonb, task_id uuid)
language plpgsql security invoker set search_path = ''
as $$
begin
  delete from hush_private.reminders r
  where r.remind_at < now() - interval '2 days'
    or r.finished_at < now() - interval '1 day';
  return query
  with due as (
    select r.id from hush_private.reminders r
    where r.claimed_at is null and r.remind_at <= now()
    order by r.remind_at limit 10 for update skip locked
  )
  update hush_private.reminders r set claimed_at = now()
  from due where r.id = due.id
  returning r.id, r.subscription, r.task_id;
end;
$$;

create function public.hush_finish_reminder(p_id uuid, p_outcome text)
returns void language sql security invoker set search_path = ''
as $$
  update hush_private.reminders
  set finished_at = now(), outcome = p_outcome, subscription = '{}'::jsonb
  where id = p_id and claimed_at is not null and finished_at is null;
$$;

revoke all on function public.hush_schedule_reminder(uuid,uuid,uuid,jsonb,timestamptz),
  public.hush_due_reminders(), public.hush_finish_reminder(uuid,text) from public, anon, authenticated;
grant execute on function public.hush_schedule_reminder(uuid,uuid,uuid,jsonb,timestamptz),
  public.hush_due_reminders(), public.hush_finish_reminder(uuid,text) to service_role;

commit;
