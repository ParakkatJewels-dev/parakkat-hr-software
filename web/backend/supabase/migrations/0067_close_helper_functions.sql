-- Internal helpers stop being callable by signed-in users.
--
-- WHY NOW
-- Until today there was one login, so "any authenticated user can call this" and "the owner can
-- call this" were the same sentence. Handing out roles ends that, and it ends it quietly: nothing
-- breaks, nothing warns, and a department head simply becomes able to call things that were only
-- ever meant to be reached from inside another function.
--
-- All six below are SECURITY DEFINER, which means they run with the owner's rights and bypass RLS
-- entirely. That is correct for what they are — building blocks used by functions that DO check
-- permission first — and wrong for anything a browser can invoke. None of them is called from the
-- browser: the app uses sixteen RPCs and not one of these is among them.
--
-- Revoking EXECUTE does not break the callers. A SECURITY DEFINER function runs as its owner, so
-- when assert_login_email_allowed calls bind_login_email, or request_service_command calls
-- expire_stale_service_commands, the inner call is made by the owner and never checked against the
-- signed-in role.
--
-- WHAT EACH ONE WAS
--
--   app.bind_login_email(employee, email)
--     Writes employees.email for whoever you name, provided the row has none — and none of the 162
--     employees has one. The worst of the six: an arbitrary write to an identity field, and identity
--     is what the login flow matches on. Reachable properly through
--     assert_login_email_allowed, which checks super-admin and refuses a mismatch.
--
--   public.expire_stale_service_commands()
--     Marks queued sync work failed. Anyone could have cancelled a colleague's backfill mid-run.
--     0053 granted this to `authenticated` deliberately, expecting the screen to call it; the screen
--     never did, and request_service_command calls it internally anyway.
--
--   app.components_for(employee)
--     The pay components that apply to an employee — the company's pay structure, not one person's
--     salary, but not something to hand to whoever asks either.
--
--   public.shift_for_employee, public.calendar_for_employee, public.leave_working_days
--     Read helpers that answer questions about any employee: which shift, which holiday calendar,
--     how many working days in a span. Individually dull. Collectively they let somebody map the
--     roster of people they cannot otherwise see.
--
-- NOT INCLUDED: the twenty trigger functions that also lack a permission check. PostgreSQL refuses
-- to call a trigger function outside a trigger ("trigger functions can only be called as
-- triggers"), so they are not reachable however they are granted. And not document_for_object,
-- which the storage policies evaluate as the calling user and therefore genuinely needs EXECUTE —
-- it is guarded instead by requiring the caller to already know a document's uuid.

revoke execute on function app.bind_login_email(uuid, text)                    from public, anon, authenticated;
revoke execute on function public.expire_stale_service_commands()              from public, anon, authenticated;
revoke execute on function app.components_for(uuid)                            from public, anon, authenticated;
revoke execute on function public.shift_for_employee(uuid, date)               from public, anon, authenticated;
revoke execute on function public.calendar_for_employee(uuid)                  from public, anon, authenticated;
revoke execute on function public.leave_working_days(uuid, date, date, numeric) from public, anon, authenticated;

-- The attendance service connects as the database owner, not as `authenticated`, so its use of
-- calendar_for_employee in loadCalendarByEmployee is unaffected. service_role keeps everything.
grant execute on function public.shift_for_employee(uuid, date)                to service_role;
grant execute on function public.calendar_for_employee(uuid)                   to service_role;
grant execute on function public.leave_working_days(uuid, date, date, numeric) to service_role;

-- Assert it, because a revoke that silently failed to apply looks exactly like one that worked.
do $$
declare
  f text;
  still text[] := '{}';
begin
  foreach f in array array[
    'app.bind_login_email(uuid, text)',
    'public.expire_stale_service_commands()',
    'app.components_for(uuid)',
    'public.shift_for_employee(uuid, date)',
    'public.calendar_for_employee(uuid)',
    'public.leave_working_days(uuid, date, date, numeric)'
  ]
  loop
    if has_function_privilege('authenticated', f, 'EXECUTE') then
      still := still || f;
    end if;
  end loop;

  if array_length(still, 1) > 0 then
    raise exception 'still callable by authenticated: %', array_to_string(still, ', ');
  end if;
end $$;

-- And prove the RPCs the app depends on were not caught by the sweep.
do $$
declare
  f text;
  broken text[] := '{}';
begin
  foreach f in array array[
    'public.get_my_access()',
    'public.request_service_command(text, jsonb)',
    'public.grant_app_access(uuid, text, scope_type, uuid)',
    'public.link_user_to_employee(uuid, uuid)',
    'public.update_my_profile(text)'
  ]
  loop
    begin
      if not has_function_privilege('authenticated', f, 'EXECUTE') then
        broken := broken || f;
      end if;
    exception when undefined_function then
      -- Signature drift is not this migration's business; skip rather than fail the deploy.
      null;
    end;
  end loop;

  if array_length(broken, 1) > 0 then
    raise exception 'the app can no longer call: %', array_to_string(broken, ', ');
  end if;
end $$;
