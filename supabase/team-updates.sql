begin;

create table hush_private.team_update_schedules (
  id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  title text not null check (length(btrim(title)) between 1 and 100),
  instructions text not null check (length(instructions) <= 1000),
  time_zone text not null,
  weekly boolean not null,
  reminder_minutes integer check (reminder_minutes between 0 and 2880),
  follow_up_minutes integer check (follow_up_minutes between 1 and 10080),
  next_local_due timestamp,
  next_open_at timestamptz,
  cancelled_at timestamptz
);
create index team_update_schedules_workspace_idx on hush_private.team_update_schedules(workspace_id);
create index team_update_schedules_open_idx on hush_private.team_update_schedules(next_open_at)
  where cancelled_at is null and next_open_at is not null;

create table hush_private.team_update_rounds (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references hush_private.team_update_schedules(id) on delete cascade,
  due_at timestamptz not null,
  opened_at timestamptz not null default now(),
  announce_at timestamptz,
  unique (schedule_id, due_at)
);
create index team_update_rounds_due_idx on hush_private.team_update_rounds(due_at);

create table hush_private.team_update_assignments (
  round_id uuid not null references hush_private.team_update_rounds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  update_text text check (length(btrim(update_text)) between 1 and 1800),
  submitted_at timestamptz,
  primary key (round_id, user_id),
  check ((update_text is null) = (submitted_at is null))
);
create index team_update_assignments_user_idx on hush_private.team_update_assignments(user_id);

create table hush_private.team_update_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  subscription jsonb not null,
  updated_at timestamptz not null default now()
);
create index team_update_devices_user_idx on hush_private.team_update_devices(user_id);

create table hush_private.team_update_deliveries (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references hush_private.team_update_rounds(id) on delete cascade,
  device_id uuid not null references hush_private.team_update_devices(id) on delete cascade,
  phase text not null check (phase in ('scheduled', 'due', 'follow-up')),
  claimed_at timestamptz not null default now(),
  outcome text check (outcome in ('accepted', 'failed')),
  unique (round_id, device_id, phase)
);
create index team_update_deliveries_device_idx on hush_private.team_update_deliveries(device_id);

alter table hush_private.team_update_schedules enable row level security;
alter table hush_private.team_update_rounds enable row level security;
alter table hush_private.team_update_assignments enable row level security;
alter table hush_private.team_update_devices enable row level security;
alter table hush_private.team_update_deliveries enable row level security;

revoke all on hush_private.team_update_schedules, hush_private.team_update_rounds,
  hush_private.team_update_assignments, hush_private.team_update_devices,
  hush_private.team_update_deliveries from public, anon, authenticated;
grant select, insert, update on hush_private.team_update_schedules,
  hush_private.team_update_rounds, hush_private.team_update_assignments,
  hush_private.team_update_deliveries to service_role;
grant select, insert, update, delete on hush_private.team_update_devices to service_role;

create function hush_private.open_team_update_round(p_schedule_id uuid, p_due_at timestamptz, p_announce_at timestamptz)
returns void language sql security invoker set search_path = ''
as $$
  with created as (
    insert into hush_private.team_update_rounds (schedule_id, due_at, announce_at)
    values (p_schedule_id, p_due_at, p_announce_at) on conflict (schedule_id, due_at) do nothing
    returning id, schedule_id
  )
  insert into hush_private.team_update_assignments (round_id, user_id)
  select c.id, m.user_id from created c
  join hush_private.team_update_schedules s on s.id = c.schedule_id
  join public.memberships m on m.workspace_id = s.workspace_id
  where m.user_id is distinct from s.created_by;
$$;

create function public.hush_schedule_team_update(
  p_id uuid, p_workspace_id uuid, p_user_id uuid, p_title text, p_instructions text,
  p_local_due timestamp, p_time_zone text, p_weekly boolean, p_announce boolean,
  p_reminder_minutes integer, p_follow_up_minutes integer
)
returns void language plpgsql security invoker set search_path = ''
as $$
declare
  due timestamptz;
begin
  if not exists (select 1 from public.memberships where workspace_id = p_workspace_id
    and user_id = p_user_id and role = 'pm') then
    raise exception 'Team manager required.' using errcode = '42501';
  end if;
  if exists (select 1 from hush_private.team_update_schedules
    where id = p_id and workspace_id = p_workspace_id and created_by = p_user_id) then return; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception 'Invalid time zone.' using errcode = '22023';
  end if;
  due := p_local_due at time zone p_time_zone;
  if due is null or due <= now() or not isfinite(due)
    or (due at time zone p_time_zone) <> p_local_due then
    raise exception 'Choose a valid future time in this time zone.' using errcode = '22023';
  end if;
  insert into hush_private.team_update_schedules (
    id, workspace_id, created_by, title, instructions, time_zone, weekly,
    reminder_minutes, follow_up_minutes, next_local_due, next_open_at
  ) values (
    p_id, p_workspace_id, p_user_id, btrim(p_title), btrim(p_instructions), p_time_zone,
    p_weekly, p_reminder_minutes, p_follow_up_minutes,
    case when p_weekly then p_local_due + interval '1 week' end,
    case when p_weekly then due end
  ) on conflict (id) do nothing;
  if not found then
    if exists (select 1 from hush_private.team_update_schedules
      where id = p_id and workspace_id = p_workspace_id and created_by = p_user_id) then return; end if;
    raise exception 'Cannot use this schedule ID.' using errcode = '42501';
  end if;
  perform hush_private.open_team_update_round(p_id, due, case when p_announce then now() end);
end;
$$;

create function public.hush_cancel_team_update(p_workspace_id uuid, p_user_id uuid, p_id uuid)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  if not exists (select 1 from public.memberships where workspace_id = p_workspace_id
    and user_id = p_user_id and role = 'pm') then
    raise exception 'Team manager required.' using errcode = '42501';
  end if;
  update hush_private.team_update_schedules set cancelled_at = coalesce(cancelled_at, now())
  where workspace_id = p_workspace_id and id = p_id;
  if not found then raise exception 'Schedule not found.' using errcode = '22023'; end if;
end;
$$;

create function public.hush_submit_team_update(p_workspace_id uuid, p_user_id uuid, p_round_id uuid, p_text text)
returns void language plpgsql security invoker set search_path = ''
as $$
begin
  update hush_private.team_update_assignments a
  set update_text = btrim(p_text), submitted_at = coalesce(a.submitted_at, now())
  from hush_private.team_update_rounds r, hush_private.team_update_schedules s
  where a.round_id = r.id and r.schedule_id = s.id and a.round_id = p_round_id and a.user_id = p_user_id
    and s.workspace_id = p_workspace_id and s.cancelled_at is null and a.submitted_at is null
    and exists (select 1 from public.memberships m where m.workspace_id = p_workspace_id and m.user_id = p_user_id);
  if not found and not exists (
    select 1 from hush_private.team_update_assignments a
    join hush_private.team_update_rounds r on r.id = a.round_id
    join hush_private.team_update_schedules s on s.id = r.schedule_id
    join public.memberships m on m.workspace_id = s.workspace_id and m.user_id = p_user_id
    where a.round_id = p_round_id and a.user_id = p_user_id and s.workspace_id = p_workspace_id
      and a.submitted_at is not null and a.update_text = btrim(p_text)
  ) then raise exception 'Update is unavailable or already submitted.' using errcode = '22023'; end if;
end;
$$;

create function public.hush_save_team_update_device(p_user_id uuid, p_subscription jsonb)
returns void language sql security invoker set search_path = ''
as $$
  insert into hush_private.team_update_devices (user_id, endpoint, subscription)
  values (p_user_id, p_subscription ->> 'endpoint', p_subscription)
  on conflict (endpoint) do update set user_id = excluded.user_id, subscription = excluded.subscription, updated_at = now();
$$;

create function public.hush_remove_team_update_device(p_user_id uuid, p_endpoint text)
returns void language sql security invoker set search_path = ''
as $$
  delete from hush_private.team_update_devices where user_id = p_user_id and endpoint = p_endpoint;
$$;

create function public.hush_team_updates(p_workspace_id uuid, p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with access as (
    select role from public.memberships where workspace_id = p_workspace_id and user_id = p_user_id
  ), rounds as (
    select r.id, r.due_at, s.id as schedule_id, s.title, s.instructions, s.time_zone, s.weekly,
      (a.user_id is not null) as assigned, a.update_text, a.submitted_at, access.role
    from access join hush_private.team_update_schedules s on s.workspace_id = p_workspace_id
    join hush_private.team_update_rounds r on r.schedule_id = s.id
    left join hush_private.team_update_assignments a on a.round_id = r.id and a.user_id = p_user_id
    where s.cancelled_at is null and (access.role = 'pm' or a.user_id is not null)
      and (r.due_at >= now() - interval '35 days' or (a.user_id is not null and a.submitted_at is null)
        or (access.role = 'pm' and r.due_at = (select max(latest.due_at) from hush_private.team_update_rounds latest where latest.schedule_id = s.id)))
    order by (r.due_at >= now()) desc, r.due_at desc limit 30
  )
  select jsonb_build_object('canManage', access.role = 'pm', 'rounds', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'scheduleId', r.schedule_id, 'title', r.title,
      'instructions', r.instructions, 'dueAt', r.due_at, 'timeZone', r.time_zone, 'weekly', r.weekly,
      'assigned', r.assigned, 'submittedAt', r.submitted_at, 'update', r.update_text, 'members', case when r.role = 'pm' then coalesce((
        select jsonb_agg(jsonb_build_object('id', a.user_id, 'name', p.full_name, 'submittedAt', a.submitted_at, 'update', a.update_text)
          order by p.full_name nulls last, a.user_id)
        from hush_private.team_update_assignments a
        join public.memberships m on m.workspace_id = p_workspace_id and m.user_id = a.user_id
        left join public.profiles p on p.id = a.user_id where a.round_id = r.id
      ), '[]'::jsonb) else '[]'::jsonb end) order by (r.due_at >= now()) desc, r.due_at desc)
    from rounds r
  ), '[]'::jsonb)) from access;
$$;

create function public.hush_due_team_updates()
returns table (id uuid, phase text, subscription jsonb)
language plpgsql security invoker set search_path = ''
as $$
declare
  schedule hush_private.team_update_schedules%rowtype;
  local_due timestamp;
  due timestamptz;
begin
  for schedule in select s.* from hush_private.team_update_schedules s
    where s.cancelled_at is null and s.next_open_at <= now() order by s.next_open_at limit 20 for update skip locked
  loop
    local_due := schedule.next_local_due + make_interval(weeks => greatest(0,
      floor(extract(epoch from ((now() at time zone schedule.time_zone) - schedule.next_local_due)) / 604800)::integer + 1));
    due := local_due at time zone schedule.time_zone;
    perform hush_private.open_team_update_round(schedule.id, due, null);
    update hush_private.team_update_schedules set next_local_due = local_due + interval '1 week', next_open_at = due
    where team_update_schedules.id = schedule.id;
  end loop;

  return query with eligible as (
    select r.id as round_id, d.id as device_id, event.phase_name
    from hush_private.team_update_rounds r
    join hush_private.team_update_schedules s on s.id = r.schedule_id and s.cancelled_at is null
    join hush_private.team_update_assignments a on a.round_id = r.id and a.submitted_at is null
    join public.memberships m on m.workspace_id = s.workspace_id and m.user_id = a.user_id
    join hush_private.team_update_devices d on d.user_id = a.user_id
    cross join lateral (values
      ('scheduled'::text, r.announce_at),
      ('due'::text, case when s.reminder_minutes is not null
        then greatest(r.opened_at, r.due_at - make_interval(mins => s.reminder_minutes)) end),
      ('follow-up'::text, case when s.follow_up_minutes is not null
        then r.due_at + make_interval(mins => s.follow_up_minutes) end)
    ) as event(phase_name, send_at)
    where (r.announce_at > now() - interval '1 hour'
        or r.due_at between now() - interval '8 days' and now() + interval '2 days')
      and event.send_at <= now() and event.send_at > now() - interval '1 hour'
      and (event.phase_name = 'follow-up' or event.phase_name = 'due' and s.reminder_minutes = 0 or r.due_at >= now())
      and (event.phase_name <> 'due' or s.follow_up_minutes is null
        or now() < r.due_at + make_interval(mins => s.follow_up_minutes))
      and not exists (select 1 from hush_private.team_update_deliveries sent
        where sent.round_id = r.id and sent.device_id = d.id and sent.phase = event.phase_name)
    order by event.send_at, r.id, d.id, event.phase_name limit 25
  ), claimed as (
    insert into hush_private.team_update_deliveries as delivery (round_id, device_id, phase)
    select e.round_id, e.device_id, e.phase_name from eligible e
    on conflict on constraint team_update_deliveries_round_id_device_id_phase_key do nothing
    returning delivery.id, delivery.device_id, delivery.phase
  )
  select c.id, c.phase, d.subscription from claimed c join hush_private.team_update_devices d on d.id = c.device_id;
end;
$$;

create function public.hush_finish_team_update(p_id uuid, p_outcome text, p_expired boolean)
returns void language sql security invoker set search_path = ''
as $$
  with finished as (
    update hush_private.team_update_deliveries set outcome = p_outcome
    where id = p_id and outcome is null returning device_id, claimed_at
  )
  delete from hush_private.team_update_devices d using finished f
  where p_expired and d.id = f.device_id and d.updated_at <= f.claimed_at;
$$;

revoke all on function hush_private.open_team_update_round(uuid,timestamptz,timestamptz),
  public.hush_schedule_team_update(uuid,uuid,uuid,text,text,timestamp,text,boolean,boolean,integer,integer),
  public.hush_cancel_team_update(uuid,uuid,uuid), public.hush_submit_team_update(uuid,uuid,uuid,text),
  public.hush_save_team_update_device(uuid,jsonb), public.hush_remove_team_update_device(uuid,text),
  public.hush_team_updates(uuid,uuid), public.hush_due_team_updates(), public.hush_finish_team_update(uuid,text,boolean)
  from public, anon, authenticated;
grant execute on function hush_private.open_team_update_round(uuid,timestamptz,timestamptz),
  public.hush_schedule_team_update(uuid,uuid,uuid,text,text,timestamp,text,boolean,boolean,integer,integer),
  public.hush_cancel_team_update(uuid,uuid,uuid), public.hush_submit_team_update(uuid,uuid,uuid,text),
  public.hush_save_team_update_device(uuid,jsonb), public.hush_remove_team_update_device(uuid,text),
  public.hush_team_updates(uuid,uuid), public.hush_due_team_updates(), public.hush_finish_team_update(uuid,text,boolean)
  to service_role;

commit;
