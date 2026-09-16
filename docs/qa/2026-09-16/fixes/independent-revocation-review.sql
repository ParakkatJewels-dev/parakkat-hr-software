\set ON_ERROR_STOP on
begin;
-- A stale JWT keeps the same identity through a database-side ban.
update auth.users set banned_until=now()+interval '1 day' where id=payroll_test.id(4,2);
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,2)::text,true);
select payroll_test.expect('review/banned JWT has no direct employee profile or payslip access',
 jsonb_build_object('session',app.session_is_active(),'employees',(select count(*) from public.employees),'profiles',(select count(*) from public.profiles),'payslips',(select count(*) from public.payslips)),
 '{"session":false,"employees":0,"profiles":0,"payslips":0}');
select payroll_test.expect('review/banned JWT cannot call profile access or internal helper reads',
 jsonb_build_object('access',payroll_test.error('select public.get_my_access()'),
 'actor',payroll_test.error('select app.actor_name(payroll_test.id(4,1))'),
 'password',payroll_test.error('select app.derive_login_password(payroll_test.id(5,1))')),
 '{"access":"42501","actor":"42501","password":"42501"}');
select payroll_test.expect('review/banned JWT cannot send internal notifications or take transfer early-return',
 jsonb_build_object('notification',payroll_test.error($q$select app.notify_perm_holders('payroll.manage',payroll_test.id(1,1),null,null,null,'audit','Revocation audit only',null,null,null)$q$),
 'transfer',payroll_test.error('select public.move_employee_to_department(payroll_test.id(5,1),payroll_test.id(3,1))')),
 '{"notification":"42501","transfer":"42501"}');
reset role;
set request.jwt.claim.sub = '';
select payroll_test.expect('review/no notifications escaped revoked call',
 (select to_jsonb(count(*)) from public.notifications where title='Revocation audit only'),'0');
update auth.users set banned_until=null where id=payroll_test.id(4,2);
update public.employees set status='Inactive' where id=payroll_test.id(5,2);
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,2)::text,true);
select payroll_test.expect('review/inactive linked employee immediately loses own payroll and directory access',
 jsonb_build_object('session',app.session_is_active(),'payslips',(select count(*) from public.payslips),'directory',payroll_test.error('select public.messaging_directory()')),
 '{"session":false,"payslips":0,"directory":"42501"}');
reset role;
set request.jwt.claim.sub = '';
-- A custom manage-only role must retain legitimate photo uploads (no implicit read grant).
insert into public.roles(id,key,name) values(payroll_test.id(8,1),'review_asset_manager','Review asset manager');
insert into public.role_permissions(role_id,permission_id) select payroll_test.id(8,1),id from public.permissions where key='asset.manage';
delete from public.role_assignments where user_id=payroll_test.id(4,3);
insert into public.role_assignments(user_id,role_id,scope_type,scope_id) values(payroll_test.id(4,3),payroll_test.id(8,1),'entity',payroll_test.id(1,2));
insert into public.assets(id,name,owner_entity_id,owner_branch_id) values(payroll_test.id(9,1),'Review synthetic asset',payroll_test.id(1,2),payroll_test.id(2,2));
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,3)::text,true);
select payroll_test.expect('review/active asset manager retains lookup without asset.read',
 jsonb_build_object('read',app.has_perm('asset.read',payroll_test.id(1,2),null,null,null,null),
 'lookup',(select count(*) from public.asset_for_object(payroll_test.id(9,1)::text||'/photo.jpg'))),
 '{"read":false,"lookup":1}');
insert into storage.objects(bucket_id,name) values('asset-photos',payroll_test.id(9,1)::text||'/photo.jpg');
reset role;
set request.jwt.claim.sub = '';
select payroll_test.expect('review/active manage-only photo upload succeeds',
 (select to_jsonb(count(*)) from storage.objects where name=payroll_test.id(9,1)::text||'/photo.jpg'),'1');
update auth.users set banned_until=now()+interval '1 day' where id=payroll_test.id(4,3);
set role authenticated;
select set_config('request.jwt.claim.sub',payroll_test.id(4,3)::text,true);
select payroll_test.expect('review/banned asset manager loses lookup and upload using same JWT',
 jsonb_build_object('lookup',(select count(*) from public.asset_for_object(payroll_test.id(9,1)::text||'/photo.jpg')),
 'upload',payroll_test.error($q$insert into storage.objects(bucket_id,name) values('asset-photos',payroll_test.id(9,1)::text||'/second.jpg')$q$)),
 '{"lookup":0,"upload":"42501"}');
reset role;
select 'PASS: independent revocation review '||count(*)||' assertions; banned/inactive existing identities, direct RLS, internal helper ACLs, early-return guard, and manage-only asset Storage control' from payroll_test.results where label like 'review/%';
rollback;
