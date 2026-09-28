// Exercise routine edits racing with employee ticks on the private testDatabase.js cluster.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires the disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({
    host: socket, user: 'audit_owner', database: 'hr_message_requests_audit',
  }));
  const [manager, employee, observer] = clients;
  try {
    await Promise.all(clients.map(async client => {
      await client.connect();
      await client.query("set statement_timeout = '5s'");
    }));
    await manager.query("set role authenticated; set request.jwt.claim.sub = 'e4000004-0000-0000-0000-000000000002'");
    await employee.query("set role authenticated; set request.jwt.claim.sub = 'e4000004-0000-0000-0000-000000000004'");
    const managerPid = (await manager.query('select pg_backend_pid() pid')).rows[0].pid;
    const employeePid = (await employee.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitForLock = async pid => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('the competing operation must wait on the routine lock');
    };
    const createEstablished = async () => {
      const { rows: [{ result }] } = await manager.query(`select public.create_routine_set(
        array[audit_routine.id(5,4)],'Concurrent routine','[{"title":"Preserved job"}]',
        jsonb_build_object('frequency','daily','start_date',audit_routine.today())) result`);
      const routine = result.routine_ids[0];
      await observer.query(`update public.routine_sets set start_date=audit_routine.today()-1,
        history_start_date=audit_routine.today()-1 where id=$1`, [routine]);
      const { rows: [job] } = await observer.query('select id,title from public.routine_items where routine_id=$1', [routine]);
      return { routine, job };
    };
    const edit = ({ routine, job }) => manager.query(`select public.replace_routine_set($1,'Concurrent routine',$2::jsonb,
      jsonb_build_object('frequency','daily','start_date',audit_routine.today())) id`,
    [routine, JSON.stringify([job, { title: 'Added job' }])]);
    const tick = job => employee.query('select public.set_routine_job_tick($1,audit_routine.today(),true)', [job.id]);

    // A tick has not committed yet. The waiting edit must see it and carry its original fact.
    const first = await createEstablished();
    await employee.query('begin');
    await tick(first.job);
    const originalTick = (await employee.query('select id,done_at,done_by from public.routine_ticks where routine_item_id=$1', [first.job.id])).rows[0];
    const waitingEdit = edit(first);
    waitingEdit.catch(() => {});
    await waitForLock(managerPid);
    await employee.query('commit');
    const newRoutine = (await waitingEdit).rows[0].id;
    const movedTick = (await observer.query(`select t.id,t.done_at,t.done_by,i.routine_id
      from public.routine_ticks t join public.routine_items i on i.id=t.routine_item_id where t.id=$1`, [originalTick.id])).rows[0];
    assert.equal(movedTick.routine_id, newRoutine, 'the committed tick follows the edited current routine');
    assert.equal(movedTick.done_at.getTime(), originalTick.done_at.getTime(), 'completion timestamp is preserved');
    assert.equal(movedTick.done_by, originalTick.done_by, 'completion actor is preserved');

    // An edit wins the lock. A stale client ticking the earlier version must be denied.
    const second = await createEstablished();
    await manager.query('begin');
    const secondNew = (await edit(second)).rows[0].id;
    const waitingTick = tick(second.job).then(() => ({ accepted: true }), error => ({ code: error.code }));
    await waitForLock(employeePid);
    await manager.query('commit');
    assert.equal((await waitingTick).code, '42501', 'stale ticks cannot recreate a completion on a retired version');
    const { rows: [counts] } = await observer.query(`select
      (select count(*)::integer from public.routine_ticks where routine_item_id=$1) old_ticks,
      (select count(*)::integer from public.routine_items where routine_id=$2) current_jobs`, [second.job.id, secondNew]);
    assert.equal(counts.old_ticks, 0, 'the stale tick leaves no completion behind');
    assert.equal(counts.current_jobs, 2, 'the committed edit retains its added job');
    console.log('PASS: routine edits and employee ticks serialize in both lock orders, preserve completion facts and reject stale versions');
  } finally {
    await Promise.all(clients.map(async client => {
      try { await client.query('rollback'); } catch { /* connection may not have completed */ }
      await client.end();
    }));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
