// Every financial mutation shares the company lock with generation/publication.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');
async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires disposable audit socket');
  const clients = Array.from({ length: 3 }, () => new Client({ host: socket, user: 'audit_owner', database: 'hr_payroll_integrity_audit' }));
  const [first, second, observer] = clients;
  try {
    await Promise.all(clients.map(async client => { await client.connect(); await client.query("set statement_timeout='8s'"); }));
    const { rows: [{ entity, employee, actor, request }] } = await observer.query('select register_test.id(1,61) entity,register_test.id(4,61) employee,register_test.id(3,61) actor,register_test.id(8,71) request');
    for (const client of [first, second]) {
      await client.query('set role authenticated');
      await client.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    }
    const secondPid = (await second.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitForLock = async () => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        if ((await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [secondPid])).rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('financial mutation must wait for company lock');
    };
    await first.query('begin');
    const advance = (await first.query("select public.create_payroll_advance($1,'2028-01-01',7000,'Concurrent advance',$2) value", [employee, request])).rows[0].value;
    const retry = second.query("select public.create_payroll_advance($1,'2028-01-01',7000,'Concurrent advance',$2) value", [employee, request]);
    retry.catch(() => {});
    await waitForLock();
    await first.query('commit');
    assert.equal((await retry).rows[0].value.id, advance.id, 'concurrent retried issue returns same advance');

    await first.query('begin');
    await first.query("select public.save_payroll_advance_recovery($1,'2028-02',4000)", [advance.id]);
    const overRecovery = second.query("select public.save_payroll_advance_recovery($1,'2028-03',4000)", [advance.id]);
    overRecovery.catch(() => {});
    await waitForLock();
    await first.query('commit');
    await assert.rejects(overRecovery, { code: '23514' });
    assert.equal(Number((await observer.query('select sum(amount) value from public.payroll_advance_recoveries where advance_id=$1', [advance.id])).rows[0].value), 4000);

    await observer.query(`insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes,computed_at)
      select e.id,d::date,'Present',1,'working',480,clock_timestamp() from public.employees e
      cross join generate_series('2028-02-01'::date,'2028-02-29'::date,'1 day')d where e.entity_id=$1`, [entity]);
    const generate = async () => {
      await first.query("select public.run_payroll($1,'2028-02')", [entity]);
      return (await first.query("select id,source_fingerprint from public.payroll_runs where entity_id=$1 and period='2028-02'", [entity])).rows[0];
    };
    let run = await generate();
    await first.query('begin');
    await first.query(`select public.save_payroll_adjustment($1,'2028-02','{"kind":"bonus","amount":25,"reason":"Concurrent bonus"}')`, [employee]);
    const stalePublication = second.query('select public.publish_payroll($1,$2)', [run.id, run.source_fingerprint]);
    stalePublication.catch(() => {});
    await waitForLock();
    await first.query('commit');
    await assert.rejects(stalePublication, { code: '55000' });
    run = await generate();
    await first.query('begin');
    await first.query('select public.publish_payroll($1,$2)', [run.id, run.source_fingerprint]);
    const lateBonus = second.query(`select public.save_payroll_adjustment($1,'2028-02','{"kind":"bonus","amount":25,"reason":"Late bonus"}')`, [employee]);
    lateBonus.catch(() => {});
    await waitForLock();
    await first.query('commit');
    await assert.rejects(lateBonus, { code: '55000' });

    const payment = (await first.query('select updated_at::text version from public.payroll_payments where run_id=$1 and employee_id=$2', [run.id, employee])).rows[0];
    await first.query('begin');
    await first.query("select public.set_payroll_payment_status($1,$2,'held','Concurrent hold',null,$3)", [run.id, employee, payment.version]);
    const stalePayment = second.query("select public.set_payroll_payment_status($1,$2,'paid',null,'BANK-CONCURRENT',$3)", [run.id, employee, payment.version]);
    stalePayment.catch(() => {});
    await waitForLock();
    await first.query('commit');
    await assert.rejects(stalePayment, { code: '40001' });
    assert.equal((await observer.query('select status from public.payroll_payments where run_id=$1 and employee_id=$2', [run.id, employee])).rows[0].status, 'held');
    console.log('PASS: concurrent advance issue is idempotent; allocations cannot overrecover; adjustments and publication serialize; payment cannot overtake a hold');
  } finally {
    await Promise.all(clients.map(async client => { try { await client.query('rollback'); } catch { /* connection may have failed */ } await client.end(); }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
