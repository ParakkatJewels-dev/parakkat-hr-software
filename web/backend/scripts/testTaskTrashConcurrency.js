// Stale task editors must serialize with recoverable deletion on the disposable test cluster.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires the disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({ host: socket, user: 'audit_owner', database: 'hr_message_requests_audit' }));
  const [manager, employee, observer] = clients;
  try {
    await Promise.all(clients.map(async client => { await client.connect(); await client.query("set statement_timeout='5s'"); }));
    await manager.query("set role authenticated; set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000001'");
    await employee.query("set role authenticated; set request.jwt.claim.sub='a1550000-0000-0000-0000-000000000002'");
    const managerPid = (await manager.query('select pg_backend_pid() pid')).rows[0].pid;
    const employeePid = (await employee.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitForLock = async pid => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('competing operation must wait on the task row');
    };
    const remove = () => manager.query('select public.soft_delete_task(audit_task_trash.id(22))');
    const restore = () => manager.query('select public.restore_task(audit_task_trash.id(22))');
    const comment = body => employee.query(`insert into public.task_comments(task_id,author_user,body)
      values(audit_task_trash.id(22),audit_task_trash.id(2),$1) returning id`, [body]);

    // A delete wins. A comment from a stale open drawer must not land in the deleted task.
    await manager.query('begin');
    await remove();
    const stale = comment('Stale concurrent comment').then(() => ({ accepted: true }), error => ({ code: error.code }));
    await waitForLock(employeePid);
    await manager.query('commit');
    assert.equal((await stale).code, '42501');
    await restore();
    assert.equal((await observer.query("select count(*)::integer count from public.task_comments where body='Stale concurrent comment'")).rows[0].count, 0);

    // A valid comment wins. Deletion waits for it and restoration retains that committed message.
    await employee.query('begin');
    const saved = (await comment('Comment saved before deletion')).rows[0].id;
    const waitingDelete = remove();
    waitingDelete.catch(() => {});
    await waitForLock(managerPid);
    await employee.query('commit');
    await waitingDelete;
    await restore();
    assert.equal((await employee.query('select body from public.task_comments where id=$1', [saved])).rows[0].body, 'Comment saved before deletion');
    console.log('PASS: task deletion and content writes serialize in both lock orders, reject stale comments and preserve committed history');
  } finally {
    await Promise.all(clients.map(async client => { try { await client.query('rollback'); } catch {} await client.end(); }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
