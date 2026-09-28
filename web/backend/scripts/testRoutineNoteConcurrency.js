// Exercise note evidence racing with completion ticks and identical retries in a private cluster.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires the disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({
    host: socket, user: 'audit_owner', database: 'hr_message_requests_audit',
  }));
  const [employee, competitor, observer] = clients;
  try {
    await Promise.all(clients.map(async client => {
      await client.connect();
      await client.query("set statement_timeout = '5s'");
    }));
    await Promise.all([employee, competitor].map(client => client.query(
      "set role authenticated; set request.jwt.claim.sub = 'e4000004-0000-0000-0000-000000000004'",
    )));
    const competitorPid = (await competitor.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitForLock = async () => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [competitorPid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('competing note/tick must wait on the parent routine lock');
    };
    const createRoutine = async () => {
      await observer.query("set role authenticated; set request.jwt.claim.sub = 'e4000004-0000-0000-0000-000000000002'");
      const { rows: [{ result }] } = await observer.query(`select public.create_routine_set(
        array[audit_routine.id(5,4)],'Concurrent note routine','[{"title":"Job one"},{"title":"Job two"}]',
        jsonb_build_object('frequency','daily','start_date',audit_routine.today())) result`);
      await observer.query("reset role; set request.jwt.claim.sub = ''");
      const routine = result.routine_ids[0];
      const job = (await observer.query('select id from public.routine_items where routine_id=$1 order by sort_order limit 1', [routine])).rows[0].id;
      return { routine, job };
    };
    const tick = (client, job) => client.query('select public.set_routine_job_tick($1,audit_routine.today(),true)', [job]);
    const note = (client, routine, token = randomUUID()) => client.query(
      'select public.add_routine_note($1,audit_routine.today(),$2,$3) id',
      [routine, 'Partial because the supplier is delayed.', token],
    );
    const saved = async id => (await observer.query('select completed_jobs,total_jobs,job_snapshot from public.routine_notes where id=$1', [id])).rows[0];

    // A completion commits first: the waiting note must see the committed completion.
    const first = await createRoutine();
    await employee.query('begin');
    await tick(employee, first.job);
    const waitingNote = note(competitor, first.routine);
    waitingNote.catch(() => {});
    await waitForLock();
    await employee.query('commit');
    const firstNote = await saved((await waitingNote).rows[0].id);
    assert.equal(firstNote.completed_jobs, 1);
    assert.equal(firstNote.total_jobs, 2);
    assert.equal(firstNote.job_snapshot[0].done, true);

    // A note commits first: a later tick cannot rewrite what the note observed.
    const second = await createRoutine();
    await employee.query('begin');
    const secondId = (await note(employee, second.routine)).rows[0].id;
    const waitingTick = tick(competitor, second.job);
    waitingTick.catch(() => {});
    await waitForLock();
    await employee.query('commit');
    await waitingTick;
    const secondNote = await saved(secondId);
    assert.equal(secondNote.completed_jobs, 0);
    assert.equal(secondNote.total_jobs, 2);
    assert.equal(secondNote.job_snapshot[0].done, false);
    assert.equal((await observer.query('select count(*)::integer count from public.routine_ticks where routine_item_id=$1', [second.job])).rows[0].count, 1);

    // Double submits before the first response keep one original author/time/snapshot.
    const third = await createRoutine();
    const token = randomUUID();
    await employee.query('begin');
    const thirdId = (await note(employee, third.routine, token)).rows[0].id;
    const retry = note(competitor, third.routine, token);
    retry.catch(() => {});
    await waitForLock();
    await employee.query('commit');
    assert.equal((await retry).rows[0].id, thirdId);
    assert.equal((await observer.query('select count(*)::integer count from public.routine_notes where client_id=$1', [token])).rows[0].count, 1);
    console.log('PASS: routine notes and ticks serialize in both lock orders; completion evidence stays immutable and concurrent retries save one note');
  } finally {
    await Promise.all(clients.map(async client => {
      try { await client.query('rollback'); } catch { /* connection may not have completed */ }
      await client.end();
    }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
