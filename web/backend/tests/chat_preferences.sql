-- Shares the disposable full-migration messaging database, with independent synthetic rows.
\set ON_ERROR_STOP on
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then raise exception 'requires disposable messaging audit database'; end if;
end $$;
reset role;
set request.jwt.claim.sub = '';
create schema audit_chat_preferences;
create function audit_chat_preferences.id(prefix text, n integer) returns uuid language sql immutable as $$
  select (prefix || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
grant usage on schema audit_chat_preferences to authenticated, anon;
grant execute on function audit_chat_preferences.id(text, integer) to authenticated, anon;

insert into public.entities(id, code, name) values (audit_chat_preferences.id('c',1), 'CHAT-PREFS', 'Synthetic chat preferences company');
insert into auth.users(id, email)
  select audit_chat_preferences.id('a',n), 'chat-preferences-'||n||'@audit.invalid' from generate_series(1,5)n;
insert into public.employees(id, entity_id, user_id, full_name, employee_code)
  select audit_chat_preferences.id('b',n), audit_chat_preferences.id('c',1), audit_chat_preferences.id('a',n),
    'Synthetic chat preferences person '||n, 'CHAT-PREFS-'||n from generate_series(1,5)n where n <> 4;
update public.profiles p set employee_id = e.id from public.employees e
  where p.user_id = e.user_id and e.employee_code like 'CHAT-PREFS-%';
update public.profiles set is_super_admin = true
  where user_id in (audit_chat_preferences.id('a',4), audit_chat_preferences.id('a',5));
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_chat_preferences.id('a',n), r.id, 'self' from generate_series(1,3)n
  cross join public.roles r where r.key = 'employee';
insert into public.conversations(id, kind, title, created_by)
  values (audit_chat_preferences.id('e',1), 'group', 'Preferences group', audit_chat_preferences.id('b',1)),
    (audit_chat_preferences.id('e',2), 'group', 'Other private group', audit_chat_preferences.id('b',3));
insert into public.conversations(id, kind, created_by, direct_key, request_status, request_recipient_id)
  values (audit_chat_preferences.id('e',3), 'direct', audit_chat_preferences.id('b',1),
    audit_chat_preferences.id('b',1)::text||':'||audit_chat_preferences.id('b',3)::text,
    'pending', audit_chat_preferences.id('b',3));
insert into public.conversation_members(conversation_id, employee_id, role) values
  (audit_chat_preferences.id('e',1), audit_chat_preferences.id('b',1), 'owner'),
  (audit_chat_preferences.id('e',1), audit_chat_preferences.id('b',2), 'member'),
  (audit_chat_preferences.id('e',2), audit_chat_preferences.id('b',3), 'owner'),
  (audit_chat_preferences.id('e',3), audit_chat_preferences.id('b',1), 'member'),
  (audit_chat_preferences.id('e',3), audit_chat_preferences.id('b',3), 'member');

do $$ begin
  assert not has_table_privilege('anon', 'public.chat_preferences', 'select'), 'anonymous cannot read private preferences';
  assert not has_function_privilege('anon', 'public.set_chat_preference(uuid,boolean,boolean)', 'execute'), 'anonymous cannot change preferences';
  assert not has_function_privilege('anon', 'public.search_chat_messages(uuid,text,timestamptz,uuid,integer)', 'execute'), 'anonymous cannot search messages';
  assert not has_table_privilege('authenticated', 'public.chat_preferences', 'insert,update,delete'), 'clients cannot bypass the preference RPC';
end $$;
set role anon;
select audit_message.expect_denied($q$select * from public.chat_preferences$q$);
select audit_message.expect_denied($q$select public.set_chat_preference(audit_chat_preferences.id('e',1),true)$q$);
select audit_message.expect_denied($q$select public.search_chat_messages(audit_chat_preferences.id('e',1),'hello')$q$);
set role authenticated;
select audit_message.expect_denied($q$select public.set_chat_preference(audit_chat_preferences.id('e',1),true)$q$);
select audit_message.expect_denied($q$select public.search_chat_messages(audit_chat_preferences.id('e',1),'hello')$q$);
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
select audit_message.expect_invalid($q$select public.set_chat_preference(audit_chat_preferences.id('e',1))$q$);
select audit_message.expect_denied($q$select public.set_chat_preference(audit_chat_preferences.id('e',2),true)$q$);
select audit_message.expect_denied($q$insert into public.chat_preferences(employee_id,conversation_id,is_pinned)
  values (audit_chat_preferences.id('b',2),audit_chat_preferences.id('e',1),true)$q$);
do $$ begin
  assert (select is_pinned and not is_favourite from public.set_chat_preference(audit_chat_preferences.id('e',1),true)), 'new pin defaults favourite to false';
  assert (select is_pinned and is_favourite from public.set_chat_preference(audit_chat_preferences.id('e',1),_is_favourite=>true)), 'favourite-only update preserves pin';
  assert (select not is_pinned and is_favourite from public.set_chat_preference(audit_chat_preferences.id('e',1),false)), 'explicit false clears pin and preserves favourite';
  assert (select not is_pinned and not is_favourite from public.set_chat_preference(audit_chat_preferences.id('e',1),false,false)), 'both preferences can be cleared';
  assert (select is_pinned and is_favourite from public.set_chat_preference(audit_chat_preferences.id('e',1),true,true)), 'both preferences can be persisted';
end $$;

-- The second member starts without preferences, and choices do not affect the first member.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
do $$ begin
  assert not exists(select from public.chat_preferences), 'another member cannot read the first member''s preferences';
  perform public.set_chat_preference(audit_chat_preferences.id('e',1),false,true);
  assert (select count(*) = 1 from public.chat_preferences), 'only own preference is visible';
end $$;
select audit_message.expect_denied($q$update public.chat_preferences set is_pinned=false where employee_id=audit_chat_preferences.id('b',1)$q$);
select audit_message.expect_denied($q$delete from public.chat_preferences where employee_id=audit_chat_preferences.id('b',1)$q$);
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select is_pinned and is_favourite from public.chat_preferences where conversation_id=audit_chat_preferences.id('e',1)), 'preferences persist after switching users';
  assert (select count(*) = 1 from public.chat_preferences), 'other member''s settings remain private';
end $$;
-- Pending request recipients can organize the chat without accepting it or gaining send rights.
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000003';
select public.set_chat_preference(audit_chat_preferences.id('e',3),true,true);
do $$ begin
  assert not app.can_send_conversation(audit_chat_preferences.id('e',3)), 'organizing a pending request does not accept it';
end $$;
select audit_message.expect_denied($q$select public.set_chat_preference(audit_chat_preferences.id('e',1),true)$q$);
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
do $$ begin
  assert app.can_read_conversation(audit_chat_preferences.id('e',1)), 'unlinked super admin can monitor conversations';
  assert not exists(select from public.chat_preferences), 'monitor cannot read preferences';
end $$;
select audit_message.expect_denied($q$select public.set_chat_preference(audit_chat_preferences.id('e',1),true)$q$);
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000005';
do $$ begin
  assert not exists(select from public.chat_preferences), 'linked super admin cannot read other people''s preferences';
end $$;
select audit_message.expect_denied($q$select public.set_chat_preference(audit_chat_preferences.id('e',1),true)$q$);
reset role;
set request.jwt.claim.sub = '';
delete from public.conversation_members
  where conversation_id=audit_chat_preferences.id('e',1) and employee_id=audit_chat_preferences.id('b',2);
do $$ begin
  assert not exists(select from public.chat_preferences where employee_id=audit_chat_preferences.id('b',2)), 'leaving a conversation removes its preferences';
  assert exists(select from public.chat_preferences where employee_id=audit_chat_preferences.id('b',1)), 'another member''s preferences survive membership removal';
end $$;
select 'PASS: private persistent chat preferences, partial updates, pending requests and nonmember/monitor/anonymous boundaries' as result;

-- Literal full-history search has its own read-only authorization and keyset cursor contract.
insert into public.messages(id, conversation_id, sender_id, body, created_at, deleted_at) values
  (audit_chat_preferences.id('f',1),audit_chat_preferences.id('e',1),audit_chat_preferences.id('b',1),'Older HELLO match','2026-01-01 09:00:00+00',null),
  (audit_chat_preferences.id('f',2),audit_chat_preferences.id('e',1),audit_chat_preferences.id('b',1),'Second hello match','2026-01-02 09:00:00+00',null),
  (audit_chat_preferences.id('f',3),audit_chat_preferences.id('e',1),audit_chat_preferences.id('b',1),'Third hello match','2026-01-02 09:00:00+00',null),
  (audit_chat_preferences.id('f',4),audit_chat_preferences.id('e',1),audit_chat_preferences.id('b',1),'hello deleted','2026-01-03 09:00:00+00',now()),
  (audit_chat_preferences.id('f',5),audit_chat_preferences.id('e',1),audit_chat_preferences.id('b',1),'Literal 50% done_one *star','2026-01-04 09:00:00+00',null),
  (audit_chat_preferences.id('f',6),audit_chat_preferences.id('e',2),audit_chat_preferences.id('b',3),'hello secret in another thread','2026-01-05 09:00:00+00',null);
insert into public.messages(id, conversation_id, sender_id, body, created_at)
  select audit_chat_preferences.id('f',n),audit_chat_preferences.id('e',1),audit_chat_preferences.id('b',1),
    'Older batch searchable item '||n,'2025-01-01 09:00:00+00'::timestamptz + n * interval '1 second'
  from generate_series(100,159)n;
set role authenticated;
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000001';
do $$ begin
  assert (select array_agg(id)=array[audit_chat_preferences.id('f',3),audit_chat_preferences.id('f',2),audit_chat_preferences.id('f',1)]
    from public.search_chat_messages(audit_chat_preferences.id('e',1),' HeLLo ')), 'search covers older history, case-insensitive, ordered by timestamp and ID';
  assert (select count(*)=0 from public.search_chat_messages(audit_chat_preferences.id('e',1),'   ')), 'blank query returns no messages';
  assert (select count(*)=0 from public.search_chat_messages(audit_chat_preferences.id('e',1),E'\t\n\r ')), 'all whitespace queries return no messages';
  assert (select count(*)=0 from public.search_chat_messages(audit_chat_preferences.id('e',1),null)), 'null query returns no messages';
  assert (select count(*)=1 from public.search_chat_messages(audit_chat_preferences.id('e',1),'%')), 'percent is literal';
  assert (select count(*)=1 from public.search_chat_messages(audit_chat_preferences.id('e',1),'_')), 'underscore is literal';
  assert (select count(*)=1 from public.search_chat_messages(audit_chat_preferences.id('e',1),'*')), 'asterisk is literal';
  assert (select array_agg(id)=array[audit_chat_preferences.id('f',2),audit_chat_preferences.id('f',1)]
    from public.search_chat_messages(audit_chat_preferences.id('e',1),'hello','2026-01-02 09:00:00+00',audit_chat_preferences.id('f',3))), 'cursor handles equal timestamps without duplicate or skipped messages';
  assert (select count(*)=1 from public.search_chat_messages(audit_chat_preferences.id('e',1),'hello',_limit=>0)), 'minimum limit is one';
  assert (select count(*)=51 from public.search_chat_messages(audit_chat_preferences.id('e',1),'batch',_limit=>999)), 'maximum limit is 51';
  assert (select count(*)=51 from public.search_chat_messages(audit_chat_preferences.id('e',1),'batch',_limit=>null)), 'null limit uses page default';
end $$;
select audit_message.expect_invalid($q$select public.search_chat_messages(audit_chat_preferences.id('e',1),'hello',_before_at=>'2026-01-02 09:00:00+00')$q$);
select audit_message.expect_invalid($q$select public.search_chat_messages(audit_chat_preferences.id('e',1),'hello',_before_id=>audit_chat_preferences.id('f',3))$q$);
select audit_message.expect_denied($q$select public.search_chat_messages(audit_chat_preferences.id('e',2),'hello')$q$);
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000002';
select audit_message.expect_denied($q$select public.search_chat_messages(audit_chat_preferences.id('e',1),'hello')$q$);
set request.jwt.claim.sub = 'a0000000-0000-0000-0000-000000000004';
do $$ begin
  assert (select count(*)=3 from public.search_chat_messages(audit_chat_preferences.id('e',1),'hello')), 'super-admin monitor retains read-only search rights, excluding deleted messages';
  assert (select count(*)=1 from public.search_chat_messages(audit_chat_preferences.id('e',2),'hello')), 'monitor can search a different authorized thread';
end $$;
reset role;
set request.jwt.claim.sub = '';
select 'PASS: full-history message search authorization, deleted-message exclusion, literal text, stable cursors and bounded pages' as result;
