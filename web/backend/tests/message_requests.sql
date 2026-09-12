\set ON_ERROR_STOP on
-- This file is loaded twice by testDatabase.js: synthetic legacy data before 0129, assertions
-- after the complete production migration history. No hosted credentials or external data.
do $$ begin
  if current_database() <> 'hr_message_requests_audit' then
    raise exception 'A disposable hr_message_requests_audit database is required.';
  end if;
end $$;

\if :message_requests_seed
create schema audit_message;
create function audit_message.id(prefix integer, n integer) returns uuid language sql immutable as $$
  select (prefix::text || '0000000-0000-0000-0000-' || lpad(n::text,12,'0'))::uuid
$$;
create table audit_message.refs(key text primary key, id uuid not null);
create function audit_message.ref(_key text) returns uuid language sql stable as $$
  select id from audit_message.refs where key = _key
$$;
grant usage on schema audit_message to authenticated, anon;
grant all on audit_message.refs to authenticated;
grant execute on function audit_message.id(integer, integer), audit_message.ref(text) to authenticated, anon;

insert into public.entities(id, code, name) values (audit_message.id(1,1), 'MSG-ENTITY', 'Synthetic message company');
insert into public.branches(id, entity_id, code, name)
  select audit_message.id(2,n), audit_message.id(1,1), 'MSG-B'||n, 'Synthetic message branch '||n
  from generate_series(1,2)n;
insert into auth.users(id, email)
  select audit_message.id(3,n), 'message-actor-'||n||'@audit.invalid' from generate_series(1,9)n;
insert into public.employees(id, entity_id, branch_id, employee_code, full_name, email, phone, salary, meta, status, user_id)
  select audit_message.id(4,n), audit_message.id(1,1),
    case when n < 3 then audit_message.id(2,1) when n < 7 then audit_message.id(2,2) else null end,
    'MSG-E'||n, 'Synthetic message employee '||n, 'private-'||n||'@audit.invalid', '999000000'||n,
    '{"private_salary":12345}'::jsonb, '{"private_personal_note":"restricted"}'::jsonb,
    case when n = 6 then 'Inactive' else 'Active' end, audit_message.id(3,n)
  from generate_series(1,8)n;
update public.profiles p set employee_id = e.id from public.employees e where p.user_id = e.user_id;
update public.profiles set is_super_admin = true where user_id = audit_message.id(3,9);
insert into public.role_assignments(user_id, role_id, scope_type)
  select audit_message.id(3,n), r.id, 'self' from generate_series(1,8)n
  cross join public.roles r where r.key = 'employee';

-- A pre-existing cross-branch conversation must remain accepted after the upgrade.
insert into public.conversations(id, kind, created_by, direct_key)
  values (audit_message.id(5,1), 'direct', audit_message.id(4,1), audit_message.id(4,1)::text||':'||audit_message.id(4,4)::text);
insert into public.conversation_members(conversation_id, employee_id, role, last_read_at)
  values (audit_message.id(5,1), audit_message.id(4,1), 'owner', now() - interval '1 day'),
    (audit_message.id(5,1), audit_message.id(4,4), 'member', now() - interval '1 day');
insert into audit_message.refs values ('legacy', audit_message.id(5,1));

\else
create function audit_message.expect_denied(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when insufficient_privilege then return;
    when raise_exception then
      if sqlerrm ~* '(cannot|not allowed|not permitted|only|permission|recipient|member|request|sign in|active employee|yourself)' then return; end if;
      raise;
  end;
  raise exception 'Statement should have been denied: %', statement;
end $$;
create function audit_message.expect_unchanged(statement text) returns void language plpgsql as $$
declare changed integer;
begin
  begin
    execute statement;
    get diagnostics changed = row_count;
    assert changed = 0, 'forbidden write must affect no rows';
  exception when insufficient_privilege then return;
  end;
end $$;
create function audit_message.expect_invalid(statement text) returns void language plpgsql as $$
begin
  begin execute statement;
  exception when invalid_parameter_value then return;
  end;
  raise exception 'Statement should have rejected invalid input: %', statement;
end $$;
grant execute on function audit_message.expect_denied(text), audit_message.expect_unchanged(text), audit_message.expect_invalid(text) to authenticated, anon;

do $$ begin
  assert (select request_status = 'accepted' and request_recipient_id is null from public.conversations where id = audit_message.ref('legacy')), 'legacy cross-branch conversation stays accepted';
  assert (select bool_and(last_delivered_at = last_read_at) from public.conversation_members where conversation_id = audit_message.ref('legacy')), 'legacy reading cursor is delivered, with no new fabricated seen time';
  assert not has_function_privilege('anon', 'public.start_direct_conversation(uuid)', 'execute'), 'anonymous cannot start a conversation';
  assert not has_function_privilege('anon', 'public.respond_to_message_request(uuid,boolean)', 'execute'), 'anonymous cannot answer a request';
  assert not has_function_privilege('anon', 'public.messaging_directory(text)', 'execute'), 'anonymous cannot list staff';
  assert not has_function_privilege('anon', 'public.acknowledge_message_receipts(uuid,uuid[],boolean)', 'execute'), 'anonymous cannot acknowledge receipts';
end $$;
select 'PASS: messaging legacy migration and anonymous RPC boundaries' as result;

set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
do $$ begin
  assert app.current_employee_id() = audit_message.id(4,1), 'synthetic sender JWT maps to employee';
  assert exists(select 1 from public.messaging_directory('') where id = audit_message.id(4,3)), 'cross-branch colleague is discoverable';
  assert not exists(select 1 from public.messaging_directory('') where id in (audit_message.id(4,1), audit_message.id(4,6))), 'directory excludes self and inactive staff';
  assert not exists(select 1 from public.employees where id = audit_message.id(4,3)), 'directory does not broaden employee PII access';
  assert (select array_agg(key order by key) = array['branch_code','branch_id','employee_code','full_name','id']::text[]
    from jsonb_object_keys((select to_jsonb(d) from public.messaging_directory('MSG-E3') d limit 1)) key), 'directory returns only approved identity columns';
end $$;
insert into audit_message.refs values ('same', public.start_direct_conversation(audit_message.id(4,2))),
  ('pending', public.start_direct_conversation(audit_message.id(4,3))),
  ('declined', public.start_direct_conversation(audit_message.id(4,5))),
  ('one-null', public.start_direct_conversation(audit_message.id(4,7)));
do $$ begin
  assert (select request_status = 'accepted' and request_recipient_id is null from public.conversations where id = audit_message.ref('same')), 'same branch needs no request';
  assert (select request_status = 'pending' and request_recipient_id = audit_message.id(4,3) from public.conversations where id = audit_message.ref('pending')), 'server routes different branches to recipient requests';
  assert (select request_status = 'pending' from public.conversations where id = audit_message.ref('one-null')), 'missing versus known branch requires a request';
  assert public.start_direct_conversation(audit_message.id(4,3)) = audit_message.ref('pending'), 'repeat start reuses direct pair';
  assert public.start_direct_conversation(audit_message.id(4,4)) = audit_message.ref('legacy'), 'legacy pair reuses accepted conversation';
  assert (select count(*)=2 from public.messaging_members(array[audit_message.ref('pending')])), 'participants can resolve cross-branch partner identity without HR table access';
  assert (select array_agg(key order by key)=array['branch','employee_code','full_name','id']::text[]
    from jsonb_object_keys((select employee from public.messaging_members(array[audit_message.ref('pending')])
      where employee_id=audit_message.id(4,3))) key), 'member identities contain only approved display fields';
end $$;
select audit_message.expect_invalid($q$select public.start_direct_conversation(audit_message.id(4,1))$q$);
select audit_message.expect_invalid($q$select public.start_direct_conversation(audit_message.id(4,6))$q$);
select audit_message.expect_denied($q$insert into public.conversations(kind,created_by,direct_key) values ('direct',audit_message.id(4,1),'forged-direct')$q$);
select audit_message.expect_denied($q$insert into public.conversation_members(conversation_id,employee_id) values (audit_message.ref('pending'),audit_message.id(4,2))$q$);
select audit_message.expect_unchanged($q$delete from public.conversation_members where conversation_id=audit_message.ref('pending') and employee_id=audit_message.id(4,3)$q$);
select audit_message.expect_denied($q$update public.conversations set request_status='accepted' where id=audit_message.ref('pending')$q$);
select audit_message.expect_denied($q$update public.conversations set request_recipient_id=audit_message.id(4,1) where id=audit_message.ref('pending')$q$);
select audit_message.expect_denied($q$update public.conversations set kind='group' where id=audit_message.ref('pending')$q$);
select audit_message.expect_denied($q$select public.respond_to_message_request(audit_message.ref('pending'),true)$q$);
select audit_message.expect_denied($q$select public.respond_to_message_request(audit_message.ref('pending'),false)$q$);

with message as (
  insert into public.messages(conversation_id,sender_id,body)
  values (audit_message.ref('pending'),audit_message.id(4,1),'A pending cross-branch request') returning id
) insert into audit_message.refs select 'request-message', id from message;
with message as (
  insert into public.messages(conversation_id,sender_id,body)
  values (audit_message.ref('declined'),audit_message.id(4,1),'A request that will be declined') returning id
) insert into audit_message.refs select 'decline-message', id from message;
select audit_message.expect_denied($q$insert into public.messages(conversation_id,sender_id,body,created_at) values (audit_message.ref('pending'),audit_message.id(4,1),'Future timestamp',now()+interval '1 year')$q$);
select audit_message.expect_denied($q$update public.messages set conversation_id=audit_message.ref('same') where id=audit_message.ref('request-message')$q$);
select audit_message.expect_denied($q$update public.messages set sender_id=audit_message.id(4,3) where id=audit_message.ref('request-message')$q$);
select audit_message.expect_denied($q$update public.messages set created_at=now()+interval '1 year' where id=audit_message.ref('request-message')$q$);
select audit_message.expect_denied($q$update public.conversation_members set last_read_at=now()+interval '1 year' where conversation_id=audit_message.ref('pending') and employee_id=audit_message.id(4,1)$q$);
select audit_message.expect_denied($q$update public.conversation_members set last_delivered_at=now() where conversation_id=audit_message.ref('pending') and employee_id=audit_message.id(4,3)$q$);
select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true);
do $$ begin
  assert (select last_delivered_at is null from public.conversation_members where conversation_id=audit_message.ref('pending') and employee_id=audit_message.id(4,3)), 'sender cannot acknowledge delivery on behalf of recipient';
end $$;
select 'PASS: server branch routing, minimal directory, direct conversation and message mutation bypass protection' as result;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000002';
select audit_message.expect_denied($q$select public.respond_to_message_request(audit_message.ref('pending'),true)$q$);
select audit_message.expect_denied($q$select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true)$q$);
do $$ begin
  assert not exists(select 1 from public.messages where conversation_id=audit_message.ref('pending')), 'nonparticipant cannot read request content';
  assert not exists(select 1 from public.messaging_members(array[audit_message.ref('pending')])), 'nonparticipant cannot read identities or receipt cursors';
end $$;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000009';
do $$ begin
  assert app.is_super_admin(), 'monitor actor is a real super admin';
  assert exists(select 1 from public.messages where id=audit_message.ref('request-message')), 'monitor keeps read access';
end $$;
select audit_message.expect_denied($q$select public.respond_to_message_request(audit_message.ref('pending'),true)$q$);
select audit_message.expect_denied($q$select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true)$q$);
select audit_message.expect_denied($q$insert into public.messages(conversation_id,sender_id,body) values (audit_message.ref('pending'),audit_message.id(4,3),'Forged recipient reply')$q$);
select audit_message.expect_denied($q$update public.conversation_members set last_read_at=now() where conversation_id=audit_message.ref('pending') and employee_id=audit_message.id(4,3)$q$);

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
do $$ begin
  assert public.start_direct_conversation(audit_message.id(4,1)) = audit_message.ref('pending'), 'recipient starting reverse pair cannot accept implicitly';
  assert (select request_status='pending' from public.conversations where id=audit_message.ref('pending')), 'reverse start preserves request';
end $$;
select audit_message.expect_denied($q$insert into public.messages(conversation_id,sender_id,body) values (audit_message.ref('pending'),audit_message.id(4,3),'Reply before accepting')$q$);
select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true);
do $$ begin
  assert (select cm.last_delivered_at=m.created_at and cm.last_delivered_message_id=m.id
    from public.conversation_members cm cross join public.messages m
    where cm.conversation_id=audit_message.ref('pending') and cm.employee_id=audit_message.id(4,3) and m.id=audit_message.ref('request-message')), 'recipient actual fetch acknowledges delivered';
  assert (select cm.last_read_at < m.created_at from public.conversation_members cm cross join public.messages m
    where cm.conversation_id=audit_message.ref('pending') and cm.employee_id=audit_message.id(4,3) and m.id=audit_message.ref('request-message')), 'pending request suppresses seen even when client requests it';
end $$;
select public.respond_to_message_request(audit_message.ref('pending'),true);
select public.respond_to_message_request(audit_message.ref('pending'),true);
select audit_message.expect_invalid($q$select public.respond_to_message_request(audit_message.ref('pending'),false)$q$);
select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true);
do $$ begin
  assert (select request_status='accepted' from public.conversations where id=audit_message.ref('pending')), 'recipient accepts';
  assert (select cm.last_read_at=m.created_at and cm.last_read_message_id=m.id and cm.last_delivered_at=m.created_at
    from public.conversation_members cm cross join public.messages m
    where cm.conversation_id=audit_message.ref('pending') and cm.employee_id=audit_message.id(4,3) and m.id=audit_message.ref('request-message')), 'accepted seen implies delivered at the actual message cursor';
end $$;
with message as (
  insert into public.messages(conversation_id,sender_id,body)
  values (audit_message.ref('pending'),audit_message.id(4,3),'Accepted recipient reply') returning id
) insert into audit_message.refs select 'reply-message', id from message;
select 'PASS: recipient-only acceptance, monitor read-only access, actual recipient delivery and accepted-only seen' as result;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000005';
select public.respond_to_message_request(audit_message.ref('declined'),false);
select public.respond_to_message_request(audit_message.ref('declined'),false);
select audit_message.expect_invalid($q$select public.respond_to_message_request(audit_message.ref('declined'),true)$q$);
select audit_message.expect_denied($q$insert into public.messages(conversation_id,sender_id,body) values (audit_message.ref('declined'),audit_message.id(4,5),'Reply after declining')$q$);
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';
select audit_message.expect_denied($q$insert into public.messages(conversation_id,sender_id,body) values (audit_message.ref('declined'),audit_message.id(4,1),'Ignore decline')$q$);
select audit_message.expect_denied($q$insert into storage.objects(bucket_id,name) values ('chat-media',audit_message.ref('declined')::text||'/denied.webm')$q$);
select audit_message.expect_denied($q$update public.messages set body='Rewrite request after decline' where id=audit_message.ref('decline-message')$q$);
update public.messages set deleted_at=clock_timestamp() where id=audit_message.ref('decline-message');
select audit_message.expect_denied($q$update public.messages set deleted_at=null where id=audit_message.ref('decline-message')$q$);
select audit_message.expect_denied($q$select public.respond_to_message_request(audit_message.ref('declined'),true)$q$);
do $$ begin
  assert public.start_direct_conversation(audit_message.id(4,5))=audit_message.ref('declined'), 'restarting pair reuses declined room';
  assert (select request_status='declined' from public.conversations where id=audit_message.ref('declined')), 'sender cannot reset declined state';
end $$;

-- A read cursor advances only over actual received rows from the chosen room, never sender-owned
-- rows, guessed UUIDs, another room, or a timestamp supplied by the client.
select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('reply-message')],true);
select audit_message.expect_invalid($q$select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('decline-message')],true)$q$);
select audit_message.expect_invalid($q$select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.id(9,999)],true)$q$);
select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true);
do $$ begin
  assert (select cm.last_read_message_id=m.id and cm.last_delivered_message_id=m.id
    from public.conversation_members cm cross join public.messages m
    where cm.conversation_id=audit_message.ref('pending') and cm.employee_id=audit_message.id(4,1) and m.id=audit_message.ref('reply-message')), 'irrelevant acknowledgement IDs cannot move or regress receipt';
  assert (select deleted_at is not null from public.messages where id=audit_message.ref('decline-message')), 'sender retains deletion rights after decline';
end $$;
select 'PASS: declined send, body rewrites and upload blocked; sender can still delete; receipt IDs are scoped' as result;

reset role;
set request.jwt.claim.sub = '';
-- Synthetic equal-time and future-time rows exercise the server cursor boundary without giving
-- API clients permission to create their own timestamps.
insert into public.conversations(id,kind,created_by,direct_key)
  values (audit_message.id(5,2),'direct',audit_message.id(4,2),audit_message.id(4,2)::text||':'||audit_message.id(4,3)::text);
insert into audit_message.refs values ('ties',audit_message.id(5,2));
insert into public.conversation_members(conversation_id,employee_id,last_read_at)
  values (audit_message.ref('ties'),audit_message.id(4,2),now()-interval '1 day'),
    (audit_message.ref('ties'),audit_message.id(4,3),now()-interval '1 day');
insert into public.messages(id,conversation_id,sender_id,body,created_at)
  values (audit_message.id(7,1),audit_message.ref('ties'),audit_message.id(4,2),'First at same timestamp',now()-interval '1 minute'),
    (audit_message.id(7,2),audit_message.ref('ties'),audit_message.id(4,2),'Second at same timestamp',now()-interval '1 minute'),
    (audit_message.id(7,3),audit_message.ref('ties'),audit_message.id(4,2),'Future legacy timestamp',now()+interval '1 day');
set role authenticated;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
select public.acknowledge_message_receipts(audit_message.ref('ties'),array[audit_message.id(7,1)],true);
do $$ begin
  assert (select last_read_message_id=audit_message.id(7,1) and last_delivered_message_id=audit_message.id(7,1)
    from public.conversation_members where conversation_id=audit_message.ref('ties') and employee_id=audit_message.id(4,3)), 'first equal-time message receives its own cursor';
  assert (select unread_count=2 from public.my_conversations where id=audit_message.ref('ties')), 'later UUID at the same timestamp remains unread';
end $$;
select public.acknowledge_message_receipts(audit_message.ref('ties'),array[audit_message.id(7,2)],false);
select public.acknowledge_message_receipts(audit_message.ref('ties'),array[audit_message.id(7,1)],true);
do $$ begin
  assert (select last_read_message_id=audit_message.id(7,1) and last_delivered_message_id=audit_message.id(7,2)
    from public.conversation_members where conversation_id=audit_message.ref('ties') and employee_id=audit_message.id(4,3)), 'delivery advances independently of seen and older acknowledgements never regress either';
end $$;
select public.acknowledge_message_receipts(audit_message.ref('ties'),array[audit_message.id(7,2)],true);
select public.acknowledge_message_receipts(audit_message.ref('ties'),array[audit_message.id(7,3)],true);
do $$ begin
  assert (select last_read_message_id=audit_message.id(7,2) and last_delivered_message_id=audit_message.id(7,2)
    and last_read_at <= clock_timestamp() and last_delivered_at <= clock_timestamp()
    from public.conversation_members where conversation_id=audit_message.ref('ties') and employee_id=audit_message.id(4,3)), 'future legacy rows cannot move receipt cursors into the future';
end $$;
select 'PASS: sent, delivered and seen cursors handle timestamp ties, independent stages, out-of-order acknowledgements and future rows' as result;

set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000001';

-- Group membership and normal text sending retain the existing behavior.
with conversation as (
  insert into public.conversations(kind,title,created_by)
  values ('group','Synthetic working group',audit_message.id(4,1)) returning id
) insert into audit_message.refs select 'group', id from conversation;
insert into public.conversation_members(conversation_id,employee_id,role)
  values (audit_message.ref('group'),audit_message.id(4,1),'owner'),
    (audit_message.ref('group'),audit_message.id(4,2),'member'),
    (audit_message.ref('group'),audit_message.id(4,3),'member');
with message as (
  insert into public.messages(conversation_id,sender_id,body)
  values (audit_message.ref('group'),audit_message.id(4,1),'Group message') returning id
) insert into audit_message.refs select 'group-message', id from message;
update public.conversations set title='Renamed working group' where id=audit_message.ref('group');
delete from public.conversation_members where conversation_id=audit_message.ref('group') and employee_id=audit_message.id(4,2);
do $$ begin
  assert (select request_status='accepted' and request_recipient_id is null and title='Renamed working group'
    from public.conversations where id=audit_message.ref('group')), 'groups remain accepted and editable';
  assert (select count(*)=2 from public.conversation_members where conversation_id=audit_message.ref('group')), 'group membership changes still work';
end $$;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000003';
select public.acknowledge_message_receipts(audit_message.ref('group'),array[audit_message.ref('group-message')],true);
do $$ begin
  assert (select last_read_message_id=audit_message.ref('group-message') and last_delivered_message_id=audit_message.ref('group-message')
    from public.conversation_members where conversation_id=audit_message.ref('group') and employee_id=audit_message.id(4,3)), 'group recipients can acknowledge their own received messages';
end $$;
set request.jwt.claim.sub = '30000000-0000-0000-0000-000000000007';
insert into audit_message.refs values ('both-null',public.start_direct_conversation(audit_message.id(4,8)));
do $$ begin
  assert (select request_status='accepted' from public.conversations where id=audit_message.ref('both-null')), 'two unassigned branches follow the same-branch null contract';
end $$;
reset role;
set request.jwt.claim.sub = '';
select 'PASS: groups retain creation, membership, messaging and rename behavior; null-branch routing is explicit' as result;
set role authenticated;
select audit_message.expect_denied($q$select public.start_direct_conversation(audit_message.id(4,2))$q$);
select audit_message.expect_denied($q$select public.messaging_directory('')$q$);
select audit_message.expect_denied($q$select public.messaging_members(array[audit_message.ref('pending')])$q$);
select audit_message.expect_denied($q$select public.acknowledge_message_receipts(audit_message.ref('pending'),array[audit_message.ref('request-message')],true)$q$);
reset role;
select 'PASS: missing authentication cannot reach authorized messaging RPCs' as result;
\endif
