// Multi-connection proof that calculation, source edits, input revisions and publication agree.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Client } = require('pg');

async function main() {
  const socket = process.argv[2];
  assert.ok(socket?.startsWith(join(tmpdir(), 'hr-database-audit-')), 'requires disposable audit socket');
  const clients = Array.from({ length: 4 }, () => new Client({ host: socket, user: 'audit_owner', database: 'hr_payroll_integrity_audit' }));
  const [payroll, writer, observer, sourceWriter] = clients;
  try {
    await Promise.all(clients.map(async client => {
      await client.connect();
      await client.query("set statement_timeout='8s'");
    }));
    const { rows: [{ entity, employee, actor }] } = await observer.query('select register_test.id(1,1) entity,register_test.id(4,1) employee,register_test.id(3,1) actor');
    await observer.query(`insert into public.attendance(employee_id,work_date,status,day_fraction,day_type,worked_minutes)
      select e.id,d::date,'Present',1,'working',480 from public.employees e
      cross join generate_series('2026-10-01'::date,'2026-10-31'::date,'1 day')d where e.entity_id=$1`, [entity]);
    await observer.query("insert into public.payroll_runs(entity_id,period) values($1,'2026-11')", [entity]);
    await payroll.query("set role authenticated");
    await payroll.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    const writerPid = (await writer.query('select pg_backend_pid() pid')).rows[0].pid;
    const payrollPid = (await payroll.query('select pg_backend_pid() pid')).rows[0].pid;
    const sourcePid = (await sourceWriter.query('select pg_backend_pid() pid')).rows[0].pid;
    const waitForLock = async pid => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const { rows } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
        if (rows[0]?.wait_event_type === 'Lock') return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('competing payroll operation must wait on the company or source row lock');
    };
    const generate = () => payroll.query("select public.run_payroll($1,'2026-10') result", [entity]);
    const fingerprint = async run => (await payroll.query('select source_fingerprint from public.payroll_runs where id=$1', [run])).rows[0].source_fingerprint;
    const publish = async (run, reviewed) => payroll.query('select public.publish_payroll($1,$2)', [run, reviewed ?? await fingerprint(run)]);
    const editDay = (day, fraction) => writer.query('update public.attendance set day_fraction=$1 where employee_id=$2 and work_date=$3', [fraction, employee, day]);

    // Generation wins the company lock. The later source edit must mark the finished draft stale.
    await payroll.query('begin');
    const run = (await generate()).rows[0].result.run_id;
    const firstReviewed = await fingerprint(run);
    const afterGeneration = editDay('2026-10-01', 0);
    afterGeneration.catch(() => {});
    await waitForLock(writerPid);
    await payroll.query('commit');
    await afterGeneration;
    assert.equal((await observer.query('select needs_recalculation from public.payroll_runs where id=$1', [run])).rows[0].needs_recalculation, true);
    assert.equal((await observer.query("select needs_recalculation from public.payroll_runs where entity_id=$1 and period='2026-11'", [entity])).rows[0].needs_recalculation, false);
    await assert.rejects(publish(run), { code: '55000' });

    // Source edit wins the lock. The waiting calculation sees its committed credits, not an old
    // salary paired with a fingerprint of newer attendance.
    await writer.query('begin');
    await editDay('2026-10-02', 0);
    const afterSource = generate();
    afterSource.catch(() => {});
    await waitForLock(payrollPid);
    await writer.query('commit');
    await afterSource;
    await assert.rejects(publish(run, firstReviewed), { code: '40001' });
    const earned = (await observer.query("select payroll_register->>'earned_salary' amount from public.payslips where employee_id=$1 and period='2026-10'", [employee])).rows[0].amount;
    assert.equal(Number(earned), 28064.52);

    await writer.query('set role authenticated');
    await writer.query("select set_config('request.jwt.claim.sub',$1,false)", [actor]);
    // Both browser sessions loaded the same policy. Only the first exact revision may save.
    const revision = (await observer.query('select updated_at::text revision from public.payroll_policies where entity_id=$1', [entity])).rows[0].revision;
    await payroll.query('begin');
    await payroll.query('select public.save_payroll_policy($1,$2,$3)', [entity, { notes: 'First concurrent review' }, revision]);
    const stalePolicy = writer.query('select public.save_payroll_policy($1,$2,$3)', [entity, { notes: 'Stale overwrite' }, revision]);
    stalePolicy.catch(() => {});
    await waitForLock(writerPid);
    await payroll.query('commit');
    await assert.rejects(stalePolicy, { code: '40001' });
    assert.equal((await observer.query('select notes from public.payroll_policies where entity_id=$1', [entity])).rows[0].notes, 'First concurrent review');

    // A second session cannot overwrite an input row it believed did not exist.
    await payroll.query('begin');
    await payroll.query("select public.save_payroll_monthly_input($1,'2026-10',$2,null)", [employee, { incentive: 100 }]);
    const staleInput = writer.query("select public.save_payroll_monthly_input($1,'2026-10',$2,null)", [employee, { incentive: 999 }]);
    staleInput.catch(() => {});
    await waitForLock(writerPid);
    await payroll.query('commit');
    await assert.rejects(staleInput, { code: '40001' });
    assert.equal(Number((await observer.query("select incentive from public.payroll_monthly_inputs where employee_id=$1 and period='2026-10'", [employee])).rows[0].incentive), 100);

    // Two grid sessions submitting the same revisions serialize as one batch each. The loser
    // cannot overwrite either the existing row or the newly created employee row.
    const { rows: [{ revision: inputRevision, colleague }] } = await observer.query(
      "select updated_at::text revision,register_test.id(4,3) colleague from public.payroll_monthly_inputs where employee_id=$1 and period='2026-10'", [employee]);
    const batch = [
      { employee_id: employee, input: { incentive: 200 }, expected_updated_at: inputRevision },
      { employee_id: colleague, input: { incentive: 300 }, expected_updated_at: null },
    ];
    await payroll.query('begin');
    const savedBatch = await payroll.query("select public.save_payroll_monthly_inputs($1,'2026-10',$2::jsonb) saved", [entity, JSON.stringify(batch)]);
    assert.equal(savedBatch.rows[0].saved.length, 2);
    const staleBatch = writer.query("select public.save_payroll_monthly_inputs($1,'2026-10',$2::jsonb)", [entity, JSON.stringify(batch)]);
    staleBatch.catch(() => {});
    await waitForLock(writerPid);
    await payroll.query('commit');
    await assert.rejects(staleBatch, { code: '40001' });
    assert.deepEqual((await observer.query("select incentive from public.payroll_monthly_inputs where employee_id=any($1::uuid[]) and period='2026-10' order by employee_id", [[employee, colleague]])).rows.map(row => Number(row.incentive)), [200, 300]);

    // Publication wins. A writer already waiting on its rows must recheck published evidence.
    await generate();
    await writer.query("reset role; set request.jwt.claim.sub=''");
    await payroll.query('begin');
    await publish(run);
    const afterPublication = editDay('2026-10-03', 0);
    afterPublication.catch(() => {});
    await waitForLock(writerPid);
    await payroll.query('commit');
    await assert.rejects(afterPublication, { code: '55000' });
    assert.equal(Number((await observer.query("select day_fraction from public.attendance where employee_id=$1 and work_date='2026-10-03'", [employee])).rows[0].day_fraction), 1);

    // The input writer checked an employee before a transfer committed. After waiting on the
    // old company's lock it must refresh both identity and scope, never stamp obsolete ancestry.
    await writer.query('begin');
    await writer.query('update public.employees set branch_id=register_test.id(2,2) where id=$1', [employee]);
    const afterTransfer = payroll.query("select public.save_payroll_monthly_input($1,'2026-11',$2,null)", [employee, { incentive: 50 }]);
    afterTransfer.catch(() => {});
    const sourceAfterTransfer = sourceWriter.query('update public.salary_structures set gross=gross+100 where employee_id=$1', [employee]);
    sourceAfterTransfer.catch(() => {});
    await waitForLock(payrollPid);
    await waitForLock(sourcePid);
    await writer.query('commit');
    await assert.rejects(afterTransfer, { code: '40001' });
    await assert.rejects(sourceAfterTransfer, { code: '40001' });
    await assert.rejects(payroll.query("select public.save_payroll_monthly_input($1,'2026-11',$2,null)", [employee, { incentive: 50 }]), { code: '42501' });
    assert.equal(Number((await observer.query("select count(*) n from public.payroll_monthly_inputs where employee_id=$1 and period='2026-11'", [employee])).rows[0].n), 0);
    assert.equal(Number((await observer.query('select gross from public.salary_structures where employee_id=$1', [employee])).rows[0].gross), 30000);
    console.log('PASS: payroll generation/source edits serialize in both orders; unrelated months stay fresh; stale policy/input/batch/review revisions rejected; published attendance immutable; concurrent transfers cannot bypass input scope');
  } finally {
    await Promise.all(clients.map(async client => {
      try { await client.query('rollback'); } catch { /* connection can have failed */ }
      await client.end();
    }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
