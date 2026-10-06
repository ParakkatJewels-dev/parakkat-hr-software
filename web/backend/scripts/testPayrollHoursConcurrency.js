// Payroll cannot publish attendance while a durable correction/punch refresh is pending.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({ host: socket, user: 'audit_owner', database: 'hr_payroll_integrity_audit' }));
  const [payroll, source, observer] = clients;
  try {
    await Promise.all(clients.map(async client => { await client.connect(); await client.query("set statement_timeout='8s'"); }));
    const { rows: [{ entity, employee, actor }] } = await observer.query('select register_test.id(1,3) entity,register_test.id(4,6) employee,register_test.id(3,6) actor');
    await observer.query(`insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
      select e.id,d::date,'Present',1,'working',480,clock_timestamp() from public.employees e
      cross join generate_series('2027-05-01'::date,'2027-05-31'::date,'1 day')d
      where e.entity_id=$1 and e.join_date<'2027-06-01'`, [entity]);
    await observer.query("update public.attendance set ot_minutes=60 where employee_id=$1 and work_date='2027-05-01'", [employee]);
    await payroll.query('set role authenticated');
    await payroll.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    const payrollPid = (await payroll.query('select pg_backend_pid() pid')).rows[0].pid;
    const sourcePid = (await source.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitForLock = async pid => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('payroll and pending source work must share a company lock');
    };
    const generate = async () => {
      await payroll.query("select public.run_payroll($1,'2027-05')", [entity]);
      return (await payroll.query("select id,source_fingerprint from public.payroll_runs where entity_id=$1 and period='2027-05'", [entity])).rows[0];
    };
    let run = await generate();
    await source.query('begin');
    await source.query("select public.enqueue_recompute($1,'2027-05-02','2027-05-02','Correction queued before publication')", [employee]);
    const publication = payroll.query('select public.publish_payroll($1,$2)', [run.id, run.source_fingerprint]);
    publication.catch(() => {});
    await waitForLock(payrollPid);
    await source.query('commit');
    await assert.rejects(publication, { code: '55000' });
    assert.equal((await observer.query('select status from public.payroll_runs where id=$1', [run.id])).rows[0].status, 'Draft');

    // A worker UPDATE locks its queue tuple before a BEFORE trigger runs. Its pure acknowledgement
    // must finish while an enqueuer holds the company lock; otherwise company -> tuple and
    // tuple -> company ordering deadlocks. The enqueuer then preserves the new request.
    const observerPid = (await observer.query('select pg_backend_pid() pid')).rows[0].pid;
    await observer.query('begin');
    await observer.query('select app.lock_payroll($1)', [entity]);
    await source.query('begin');
    await source.query("update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id=$1 and work_date='2027-05-02'", [employee]);
    const enqueueAfterAcknowledgement = observer.query("select public.enqueue_recompute($1,'2027-05-02','2027-05-02','New punch while prior generation is acknowledged')", [employee]);
    enqueueAfterAcknowledgement.catch(() => {});
    const lockDeadline = Date.now() + 2500;
    let waitingForQueue = false;
    while (Date.now() < lockDeadline) {
      const { rows } = await source.query('select wait_event_type from pg_stat_activity where pid=$1', [observerPid]);
      if (rows[0]?.wait_event_type === 'Lock') { waitingForQueue = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(waitingForQueue, 'enqueue must wait for the acknowledged queue tuple without blocking acknowledgement');
    await source.query('commit');
    await enqueueAfterAcknowledgement;
    await observer.query('commit');
    assert.equal(Number((await observer.query("select count(*) n from public.attendance_recompute_queue where employee_id=$1 and work_date='2027-05-02' and processed_at is null", [employee])).rows[0].n), 1);
    await source.query("update public.attendance_recompute_queue set processed_at=clock_timestamp() where employee_id=$1 and work_date='2027-05-02' and processed_at is null", [employee]);
    run = await generate();

    // The inverse order is also safe: once publication holds the company lock, a waiting
    // correction must discover that the employee-month is frozen before inserting its request.
    await payroll.query('begin');
    await payroll.query('select public.publish_payroll($1,$2)', [run.id, run.source_fingerprint]);
    const correction = source.query(`insert into public.attendance_regularizations(employee_id,work_date,check_out,reason)
      values($1,'2027-05-03','2027-05-03T15:00:00Z','Concurrent correction')`, [employee]);
    correction.catch(() => {});
    await waitForLock(sourcePid);
    await payroll.query('commit');
    await assert.rejects(correction, { code: '55000' });
    assert.equal(Number((await observer.query("select count(*) n from public.attendance_regularizations where employee_id=$1 and work_date='2027-05-03'", [employee])).rows[0].n), 0);

    // Late-arriving raw evidence remains ingestible, but cannot change released salary. Its
    // durable queue entry makes the unapplied evidence visible without rewriting the snapshot.
    const saved = (await observer.query("select payroll_register from public.payslips where employee_id=$1 and period='2027-05'", [employee])).rows[0].payroll_register;
    await source.query("insert into public.raw_punches(emp_code,employee_id,punch_time) values('HOURS-1',$1,'2027-05-04T14:00:00Z')", [employee]);
    assert.deepEqual((await observer.query("select payroll_register from public.payslips where employee_id=$1 and period='2027-05'", [employee])).rows[0].payroll_register, saved);
    assert.equal(Number((await observer.query("select count(*) n from public.attendance_recompute_queue where employee_id=$1 and work_date between '2027-05-03' and '2027-05-04' and processed_at is null", [employee])).rows[0].n), 2);
    console.log('PASS: pending attendance defeats publication; queue acknowledgement/enqueue avoid lock inversion and preserve new work; publication defeats corrections; late raw evidence preserves salary snapshots');
  } finally {
    await Promise.all(clients.map(async client => { try { await client.query('rollback'); } catch { /* connection may have failed */ } await client.end(); }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
