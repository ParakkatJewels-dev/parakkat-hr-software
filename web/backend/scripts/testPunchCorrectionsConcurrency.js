// Two editors and the attendance/payroll writer share the same company lock. Private DB only.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({ host: socket, user: 'audit_owner', database: 'hr_message_requests_audit' }));
  const [first, second, observer] = clients;
  const entity = 'd6200010-0000-0000-0000-000000000001';
  const employee = 'd6200010-0000-0000-0000-000000000002';
  const actor = 'd6200010-0000-0000-0000-000000000003';
  const request = n => `d6200010-0000-0000-0000-${String(n + 10).padStart(12, '0')}`;
  try {
    await Promise.all(clients.map(async client => { await client.connect(); await client.query("set statement_timeout='8s'"); }));
    await observer.query("insert into public.entities(id,code,name) values($1,'PUNCH-CONCURRENT','Synthetic punch concurrency company')", [entity]);
    await observer.query("insert into auth.users(id,email) values($1,'punch-concurrent@audit.invalid')", [actor]);
    await observer.query("insert into public.employees(id,entity_id,employee_code,full_name,status,join_date) values($1,$2,'PUNCH-CONCURRENT','Synthetic punch concurrency employee','Active','2019-01-01')", [employee, entity]);
    await observer.query("insert into public.role_assignments(user_id,role_id,scope_type,scope_id) select $1,id,'entity',$2 from public.roles where key='hr_manager'", [actor, entity]);
    await Promise.all([first, second].map(async client => {
      await client.query('set role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    }));
    const secondPid = (await second.query('select pg_backend_pid() pid')).rows[0].pid;
    const revision = async date => (await first.query('select public.get_attendance_punch_correction_context($1,$2) context', [employee, date])).rows[0].context.source_revision;
    const save = (client, n, date, version) => client.query(`select public.save_attendance_punch_correction($1,$2,$3,null,$4,'Verified missing checkout',$5) result`,
      [request(n), employee, date, `${date}T18:00:00+05:30`, version]);
    const waitForLock = async () => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [secondPid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('correction must wait for the company lock');
    };

    const version = await revision('2020-09-01');
    await first.query('begin');
    await save(first, 1, '2020-09-01', version);
    const competing = save(second, 2, '2020-09-01', version);
    competing.catch(() => {});
    await waitForLock();
    await first.query('commit');
    await assert.rejects(competing, { code: '40001' });
    assert.equal((await observer.query("select count(*)::int n from public.attendance_regularizations where employee_id=$1 and status='Approved'", [employee])).rows[0].n, 1);
    assert.equal((await save(first, 1, '2020-09-01', version)).rows[0].result.already_saved, true);

    // Punch ingestion commits while the editor is waiting. The stored revision must be re-read.
    const beforePunch = await revision('2020-09-02');
    await observer.query('begin');
    await observer.query('select app.lock_payroll($1)', [entity]);
    await observer.query("insert into public.raw_punches(emp_code,employee_id,punch_time) values('PUNCH-CONCURRENT',$1,'2020-09-02T09:00:00+05:30')", [employee]);
    const afterPunch = save(second, 3, '2020-09-02', beforePunch);
    afterPunch.catch(() => {});
    await waitForLock();
    await observer.query('commit');
    await assert.rejects(afterPunch, { code: '40001' });

    // Publication uses this same lock and freezes even employee dates without attendance rows.
    const beforePublication = await revision('2020-08-02');
    await observer.query('begin');
    await observer.query('select app.lock_payroll($1)', [entity]);
    await observer.query("insert into public.payslips(employee_id,period,status,gross,deductions,net) values($1,'2020-08','Published',1000,0,1000)", [employee]);
    const afterPublication = save(second, 4, '2020-08-02', beforePublication);
    afterPublication.catch(() => {});
    await waitForLock();
    await observer.query('commit');
    await assert.rejects(afterPublication, { code: '55000' });
    assert.equal((await observer.query('select count(*)::int n from public.attendance_punch_correction_history where employee_id=$1', [employee])).rows[0].n, 1);
    console.log('PASS: concurrent HR edits reject stale snapshots; committed retry is idempotent; waiting corrections recheck raw punch changes and published salary locks');
  } finally {
    await Promise.all(clients.map(async client => { try { await client.query('rollback'); } catch { /* failed connection */ } await client.end(); }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
