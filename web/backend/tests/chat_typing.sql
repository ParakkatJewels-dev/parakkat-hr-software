\set ON_ERROR_STOP on
-- Uses only the disposable message-request fixture, never hosted credentials or real people.
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then
    raise exception 'A disposable hr_message_requests_audit database is required.';
  end if;
end $$;
begin;

do $$ begin
  assert not has_function_privilege('anon', 'public.set_chat_typing(uuid,boolean)', 'execute'), 'anonymous cannot send typing activity';
  assert not has_table_privilege('anon', 'public.chat_typing', 'select'), 'anonymous cannot read typing activity';
  assert not has_table_privilege('authenticated', 'public.chat_typing', 'insert,update,delete,truncate'), 'clients cannot forge identities or server timestamps';
  assert (select relreplident = 'd' from pg_class where oid = 'public.chat_typing'::regclass), 'DELETE replication uses only the opaque primary key';
  assert (select array_agg(a.attname::text order by a.attnum) = array['id']::text[]
    from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = 'public.chat_typing'::regclass and i.indisprimary), 'deleted rows cannot disclose conversation or employee identifiers';
  assert exists(select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_typing'), 'typing changes are published';
end $$;

set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select public.set_chat_typing(audit_message.ref('same'), true);
select public.set_chat_typing(audit_message.ref('group'), true);
do $$ begin
  assert (select employee_id = audit_message.id(4,1) and is_typing
    and expires_at - updated_at = interval '6 seconds' and updated_at <= clock_timestamp()
    from public.chat_typing where conversation_id = audit_message.ref('same')), 'server derives author and exact six-second TTL';
end $$;
select audit_message.expect_denied($q$insert into public.chat_typing(conversation_id,employee_id,is_typing,expires_at)
  values (audit_message.ref('same'),audit_message.id(4,2),true,now()+interval '1 year')$q$);
select audit_message.expect_denied($q$update public.chat_typing set expires_at=now()+interval '1 year'$q$);
select audit_message.expect_denied($q$select public.set_chat_typing(audit_message.ref('one-null'),true)$q$);
select audit_message.expect_denied($q$select public.set_chat_typing(audit_message.ref('declined'),true)$q$);
select audit_message.expect_invalid($q$select public.set_chat_typing(audit_message.ref('same'),null)$q$);
do $$ declare before_at timestamptz; begin
  select updated_at into before_at from public.chat_typing where conversation_id = audit_message.ref('same');
  perform public.set_chat_typing(audit_message.ref('same'),true);
  assert (select updated_at = before_at from public.chat_typing where conversation_id = audit_message.ref('same')), 'repeated keystrokes are throttled on the server';
end $$;
select 'PASS: typing derives identity/timestamps, expires in six seconds, throttles repeats and excludes pending/declined requests' as result;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
do $$ begin
  assert exists(select 1 from public.chat_typing where conversation_id = audit_message.ref('same') and employee_id = audit_message.id(4,1)), 'accepted peer sees actual typing';
  assert not exists(select 1 from public.chat_typing where conversation_id = audit_message.ref('group')), 'removed/nonmembers cannot read activity';
end $$;
select audit_message.expect_denied($q$select public.set_chat_typing(audit_message.ref('group'),true)$q$);
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000009';
do $$ begin
  assert app.is_super_admin(), 'monitor fixture is a super admin';
  assert not exists(select 1 from public.chat_typing), 'monitoring conversations does not grant live typing visibility';
end $$;
select audit_message.expect_denied($q$select public.set_chat_typing(audit_message.ref('same'),true)$q$);
set request.jwt.claim.sub = '';
select audit_message.expect_denied($q$select public.set_chat_typing(audit_message.ref('same'),true)$q$);
select 'PASS: typing visibility and writes require actual accepted membership, including for administrators' as result;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select public.set_chat_typing(audit_message.ref('same'),false);
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
do $$ begin
  assert (select not is_typing and expires_at = updated_at from public.chat_typing
    where conversation_id = audit_message.ref('same') and employee_id = audit_message.id(4,1)), 'stop remains readable so Realtime can deliver it under RLS';
end $$;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select public.set_chat_typing(audit_message.ref('same'),true);
insert into public.messages(conversation_id,sender_id,body)
  values (audit_message.ref('same'),audit_message.id(4,1),'Synthetic message stops typing');
do $$ begin
  assert (select not is_typing from public.chat_typing where conversation_id = audit_message.ref('same')), 'sending a message stops typing in the same transaction';
end $$;
select public.set_chat_typing(audit_message.ref('same'),true);
reset role;
update public.chat_typing set updated_at = clock_timestamp() - interval '10 seconds', expires_at = clock_timestamp() - interval '4 seconds'
  where conversation_id = audit_message.ref('same');
set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
do $$ begin
  assert not exists(select 1 from public.chat_typing where conversation_id = audit_message.ref('same')), 'expired activity is absent even when no client sent stop';
end $$;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
select public.set_chat_typing(audit_message.ref('group'),true);
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
delete from public.conversation_members where conversation_id = audit_message.ref('group') and employee_id = audit_message.id(4,3);
reset role;
do $$ begin
  assert not exists(select 1 from public.chat_typing where conversation_id = audit_message.ref('group') and employee_id = audit_message.id(4,3)), 'removing a participant removes their typing metadata';
end $$;
set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
select audit_message.expect_denied($q$select public.set_chat_typing(audit_message.ref('group'),true)$q$);
select 'PASS: typing stops on explicit stop/send, expires server-side, and is removed with membership' as result;
reset role;
set request.jwt.claim.sub = '';
rollback;
