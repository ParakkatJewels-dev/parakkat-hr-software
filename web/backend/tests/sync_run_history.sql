\set ON_ERROR_STOP on
-- Real permission helpers and RLS after the full migration replay; synthetic local records only.
do $$ begin
  if current_database() <> 'hr_role_matrix_audit' then raise exception 'Disposable audit database required'; end if;
end $$;

-- Safe reruns must preserve both the index and the independent account-revocation policy.
\ir ../supabase/migrations/0150_sync_run_history_performance.sql
begin;
reset role;
set local request.jwt.claim.sub='';
insert into public.sync_runs(kind,status,started_at)
  select case when n%2=0 then 'transactions' else 'employees' end,'success',
    timestamptz '2026-01-01 00:00:00+00' + (n/5)*interval '1 second'
  from generate_series(1,20000)n;
analyze public.sync_runs;

-- A branch-scoped HR manager really has device.manage, but cannot read unscoped telemetry.
insert into public.role_assignments(user_id,role_id,scope_type,scope_id)
  select audit_test.id(6,8),id,'branch',audit_test.id(3,1) from public.roles where key='hr_manager';

-- Examine actual execution, not an index's mere existence or an elapsed-time threshold.
create function audit_test.check_sync_plan(_query text,_expected_rows integer,_ordered boolean,_allowed boolean)
returns void language plpgsql as $$
declare _plan jsonb; _nodes jsonb; _permission_nodes jsonb;
begin
  execute 'explain (analyze,verbose,format json) '||_query into _plan;
  with recursive nodes(node) as (
    select _plan->0->'Plan'
    union all
    select child from nodes cross join lateral jsonb_array_elements(coalesce(node->'Plans','[]')) child
  ) select jsonb_agg(node) into _nodes from nodes;
  select jsonb_agg(node) into _permission_nodes from jsonb_array_elements(_nodes) node
    where node->>'Parent Relationship'='InitPlan'
      and (node->'Output')::text like '%has_perm_org_wide%';
  assert jsonb_array_length(_permission_nodes)=1,'sync permission is a single InitPlan';
  assert (_permission_nodes->0->>'Actual Loops')::integer=1,'permission checked exactly once per statement';
  assert (_plan->0->'Plan'->>'Actual Rows')::integer=_expected_rows,'query returns its expected bounded result';
  if _ordered then
    assert not exists(select 1 from jsonb_array_elements(_nodes) node
      where node->>'Node Type' in ('Sort','Incremental Sort')),'recent history uses index order without sorting all logs';
    assert exists(select 1 from jsonb_array_elements(_nodes) node
      where node->>'Index Name'='idx_sync_runs_started_id'
        and (node->>'Actual Loops')::integer<=1
        and (node->>'Actual Rows')::integer=_expected_rows
        and (not _allowed or coalesce((node->>'Rows Removed by Filter')::integer,0)=0)),
      'ordered index returns the requested page without scanning older logs for an allowed user';
  end if;
end $$;
grant execute on function audit_test.check_sync_plan(text,integer,boolean,boolean) to authenticated;

set local role authenticated;
do $$ declare _actor record; _count bigint; _first bigint[]; _second bigint[];
begin
  for _actor in select * from audit_test.actors order by ordinal loop
    perform set_config('request.jwt.claim.sub',_actor.user_id::text,true);
    select count(*) into _count from public.sync_runs;
    assert _count=case when _actor.ordinal<=3 then 20000 else 0 end,
      format('%s retains the existing device-manager scope boundary',_actor.key);
  end loop;
  assert app.has_perm_any_scope('device.manage'),'denied branch HR still has the actual permission';
  perform audit_test.check_sync_plan('select id,kind,started_at from public.sync_runs order by started_at desc,id desc limit 25',0,true,false);

  perform set_config('request.jwt.claim.sub',audit_test.id(6,3)::text,true);
  perform audit_test.check_sync_plan('select id,kind,started_at from public.sync_runs order by started_at desc,id desc limit 25',25,true,true);
  perform audit_test.check_sync_plan('select count(*) from public.sync_runs',1,false,true);
  select array_agg(id order by started_at desc,id desc) into _first
    from (select id,started_at from public.sync_runs order by started_at desc,id desc limit 25) page;
  select array_agg(id order by started_at desc,id desc) into _second
    from (select id,started_at from public.sync_runs order by started_at desc,id desc limit 25 offset 25) page;
  assert _first=(select array_agg(n::bigint order by n desc) from generate_series(19976,20000)n),
    'newest page keeps deterministic id ordering for equal start times';
  assert _second=(select array_agg(n::bigint order by n desc) from generate_series(19951,19975)n),
    'next page neither repeats nor omits tied start times';
end $$;
reset role;

-- An InitPlan is statement-local: retaining the same JWT must not retain access after revocation.
set local request.jwt.claim.sub='60000000-0000-0000-0000-000000000003';
update auth.users set banned_until=now()+interval '1 day' where id=audit_test.id(6,3);
set local role authenticated;
do $$ begin assert (select count(*) from public.sync_runs)=0,'same JWT loses sync history after banning'; end $$;
reset role;
update auth.users set banned_until=null,deleted_at=now() where id=audit_test.id(6,3);
set local role authenticated;
do $$ begin assert (select count(*) from public.sync_runs)=0,'same JWT loses sync history after account deletion'; end $$;
reset role;
update auth.users set deleted_at=null where id=audit_test.id(6,3);
update public.employees set status='Inactive' where id=audit_test.id(5,103);
set local role authenticated;
do $$ begin assert (select count(*) from public.sync_runs)=0,'same JWT loses sync history after employee deactivation'; end $$;
reset role;
update public.employees set status='Active' where id=audit_test.id(5,103);
set local role authenticated;
do $$ begin assert (select count(*) from public.sync_runs)=20000,'reactivation takes effect on the next statement'; end $$;
reset role;

set local role anon;
do $$ begin assert (select count(*) from public.sync_runs)=0,'anonymous users cannot read sync history'; end $$;
reset role;
rollback;
select 'PASS: Sync history checks permission once, pages 20,000 rows in index order, preserves role scopes and immediately revokes disabled accounts';
