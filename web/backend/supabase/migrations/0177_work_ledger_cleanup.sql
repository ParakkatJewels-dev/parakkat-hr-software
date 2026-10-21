-- 0177 Remove the retired personal Work Ledger (0169-0172).
--
-- Since 0173 the Ledger runs on task records and since 0174 the creative team shares campaigns, ideas
-- and the library, so the personal-ledger tables, their functions and the ledger-files storage rules
-- have nothing left to serve. Agreed with the owner on 2026-10-21. Kept, because they are still in use:
-- reminders and Google Calendar (ledger_reminders, app.ledger_google*, their RPCs), the date helpers the
-- reports use (ledger_today, ledger_period…), the festival calendar seed (app.ledger_seed_key_dates)
-- and the ledger.use permission. Idempotent: safe to re-run.
begin;

-- Reminders now link only to real tasks.
create or replace function app.ledger_reminder_json(_r public.ledger_reminders)
returns jsonb language sql stable set search_path = pg_catalog as $$
  select jsonb_build_object('id', _r.id, 'text', _r.text, 'due_at', to_char(_r.due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI'),
    'repeat', _r.repeat, 'done', _r.done, 'source', _r.source, 'task_id', _r.work_task_id,
    'task_title', (select t.title from public.tasks t where t.id = _r.work_task_id and t.deleted_at is null),
    'overdue', not _r.done and _r.due_at < now(), 'calendar_state', _r.calendar_state);
$$;
revoke all on function app.ledger_reminder_json(public.ledger_reminders) from public, anon, authenticated, service_role;

create or replace function public.ledger_add_reminder(_id uuid, _r jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare _owner uuid := app.ledger_owner(); _row public.ledger_reminders; _repeat text; _due timestamptz; _connected boolean;
begin
  if _id is null or _r is null or jsonb_typeof(_r) <> 'object' then raise exception using errcode = '22023', message = 'Send an id and the reminder.'; end if;
  select * into _row from public.ledger_reminders where id = _id;
  if _row.id is not null then
    if _row.owner_user <> _owner then raise exception using errcode = '42501', message = 'That id is taken.'; end if;
    return jsonb_build_object('reminder', app.ledger_reminder_json(_row), 'calendar', app.ledger_calendar_connected(_owner));
  end if;
  if (_r->>'due_at') is null or (_r->>'due_at') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then
    raise exception using errcode = '22023', message = 'A reminder needs a time like 2026-10-08T10:00.';
  end if;
  _repeat := app.ledger_pick(_r->>'repeat', array['daily','weekly','weekdays','monthly'], 'Repeat');
  _due := app.ledger_reminder_due(app.ledger_ist_timestamp(_r->>'due_at'), _repeat);
  _connected := app.ledger_calendar_connected(_owner);
  insert into public.ledger_reminders(id, owner_user, text, due_at, repeat, source, work_task_id, calendar_state)
    values (_id, _owner, coalesce(app.ledger_json_text(_r, 'text', 500), 'Reminder'), _due, _repeat,
      coalesce(app.ledger_pick(_r->>'source', array['reminder','followup'], 'Source'), 'reminder'),
      (select t.id from public.tasks t where t.id = nullif(_r->>'task_id', '')::uuid and t.deleted_at is null and app.can_read_task(t.id)),
      case when _connected then 'pending' else 'none' end)
    returning * into _row;
  return jsonb_build_object('reminder', app.ledger_reminder_json(_row), 'calendar', _connected);
end $$;
revoke all on function public.ledger_add_reminder(uuid,jsonb) from public, anon, service_role;
grant execute on function public.ledger_add_reminder(uuid,jsonb) to authenticated;

-- The old functions, every overload.
do $$
declare _f record;
begin
  for _f in
    select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'hr_agent' and p.proname = 'ledger_task_brief')
       or (n.nspname in ('public','app') and p.proname = any (array[
        -- app
        'ledger_alerts','ledger_apply_update','ledger_bootstrap_data','ledger_brand_order','ledger_campaign_json','ledger_campaign_stages',
        'ledger_can_read','ledger_day_label','ledger_ensure_brand','ledger_ensure_campaign','ledger_ensure_vendor','ledger_finish',
        'ledger_home_data','ledger_idea_json','ledger_import_rows','ledger_json_date','ledger_json_number','ledger_json_tags','ledger_log',
        'ledger_own_task','ledger_reader','ledger_report_data','ledger_seed','ledger_statuses','ledger_task_json','ledger_add_seed_dates',
        -- public
        'ledger_add_deliverable','ledger_add_file','ledger_add_follow_up','ledger_add_idea','ledger_add_link','ledger_add_subtask',
        'ledger_add_task','ledger_advance_campaign','ledger_bootstrap','ledger_bulk_mark_done','ledger_bulk_update','ledger_campaign',
        'ledger_campaign_details','ledger_campaigns','ledger_cancel_task','ledger_delete_campaign','ledger_delete_deliverable',
        'ledger_delete_idea','ledger_delete_library_item','ledger_delete_progress','ledger_delete_subtask','ledger_delete_task',
        'ledger_export_tasks','ledger_file_uploadable','ledger_file_visible','ledger_home','ledger_idea_to_campaign','ledger_ideas',
        'ledger_import_batch','ledger_import_lock','ledger_import_preview','ledger_insights','ledger_library','ledger_list_tasks',
        'ledger_log_progress','ledger_log_support','ledger_mark_done','ledger_open','ledger_refresh_key_dates','ledger_remove_attachment',
        'ledger_report','ledger_save_brand','ledger_save_campaign','ledger_save_key_date','ledger_save_template','ledger_save_vendor',
        'ledger_search','ledger_set_focus','ledger_set_pin','ledger_set_sound','ledger_set_subtask','ledger_task','ledger_team_members',
        'ledger_update_idea','ledger_update_task']))
  loop
    execute format('drop function if exists %s cascade', _f.signature);
  end loop;
end $$;

-- The old link from a reminder to a personal-ledger task.
alter table public.ledger_reminders drop column if exists task_id;

-- The old tables (dropping them also drops their policies, triggers and realtime entries).
drop table if exists public.ledger_campaign_ideas, public.ledger_campaign_log, public.ledger_attachments, public.ledger_progress,
  public.ledger_deliverables, public.ledger_subtasks, public.ledger_task_log, public.ledger_ideas, public.ledger_tasks,
  public.ledger_campaigns, public.ledger_vendors, public.ledger_templates, public.ledger_key_dates, public.ledger_brands,
  public.ledger_settings cascade;

-- Files of the old ledger: no more access rules; the bucket goes if it is empty (otherwise remove it in
-- Supabase → Storage, where any files can be checked first).
drop policy if exists ledger_files_read on storage.objects;
drop policy if exists ledger_files_insert on storage.objects;
drop policy if exists ledger_files_delete on storage.objects;
do $$
begin
  if exists (select 1 from storage.buckets where id = 'ledger-files')
     and not exists (select 1 from storage.objects where bucket_id = 'ledger-files') then
    delete from storage.buckets where id = 'ledger-files';
  end if;
exception when others then
  raise notice 'The ledger-files bucket was left in place (%). Remove it in Supabase -> Storage.', sqlerrm;
end $$;

notify pgrst, 'reload schema';
commit;
