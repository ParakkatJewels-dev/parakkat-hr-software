import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.HR_QA_PLAYWRIGHT || 'playwright');
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'evidence');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
async function scenario(name, role, flags, path, run) {
  if (process.env.HR_QA_CASE && !name.includes(process.env.HR_QA_CASE)) return;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Kolkata' });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:5174/?qa-role=${role}&${flags}#/${path}`, { waitUntil: 'networkidle' });
    await page.locator(`.route-stage[data-route="/${path}"]`).waitFor();
    const evidence = await run(page);
    assert.deepEqual(errors, []);
    results.push({ name, role, status: 'PASS', evidence });
  } catch (error) {
    results.push({ name, role, status: 'FAIL', error: error.message, pageErrors: errors,
      screen: (await page.locator('.route-stage').innerText().catch(() => '')).slice(0,16000) });
  }
  await page.screenshot({ path: resolve(out, `workflow-${name}.png`), fullPage: true });
  await context.close();
  console.log(JSON.stringify(results.at(-1)));
  await writeFile(resolve(out, process.env.HR_QA_CASE ? `browser-workflows-${process.env.HR_QA_CASE}.json` : 'browser-workflows.json'), JSON.stringify(results, null, 2)+'\n');
}
const fixture = (page, table, filter) => page.evaluate(async ({ table, filter }) => {
  const { tables } = await import('/qa/fixtures.js');
  return tables[table].filter(row => Object.entries(filter).every(([k,v]) => row[k] === v));
}, { table, filter });
try {
await scenario('employee-ticket-create', 'employee', 'qa-workflow=1', 'helpdesk', async page => {
  await page.getByRole('button', { name: 'Raise Ticket', exact: true }).click();
  const form = page.getByRole('form', { name: 'Raise support ticket' });
  assert.equal(await form.getByRole('button', { name: 'Submit ticket' }).isDisabled(), true);
  await form.getByRole('combobox').nth(0).selectOption('qa-cat-it');
  await form.getByRole('combobox').nth(1).selectOption('High');
  await form.getByLabel('Subject', { exact: true }).fill('QA laptop test & <validation>');
  await form.getByLabel('Details (optional)', { exact: true }).fill('Synthetic issue from an employee.');
  await form.getByRole('button', { name: 'Submit ticket' }).click();
  await page.getByText('Ticket submitted to the category’s department.', { exact: true }).waitFor();
  await page.getByLabel('Search tickets', { exact: true }).fill('QA laptop test');
  const rows = await fixture(page, 'tickets', { subject: 'QA laptop test & <validation>' });
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 'Open'); assert.equal(rows[0].priority, 'High');
  assert.equal(rows[0].routed_department_id, 'dept-1');
  assert.equal(await page.getByLabel('Update status for QA laptop test & <validation>', { exact: true }).count(), 0);
  return { created: rows[0], selfEscalationControlAbsent: true };
});
await scenario('department-ticket-queue', 'dept_head', 'qa-workflow=1', 'helpdesk', async page => {
  const queue = page.getByRole('region', { name: 'Helpdesk tickets' });
  assert.equal(await queue.getByRole('button', { name: 'All tickets, 15 tickets needing action', exact: true }).count(), 1);
  await page.getByLabel('Update status for Laptop setup help 1', { exact: true }).selectOption('Resolved');
  await page.getByRole('button', { name: 'All tickets, 14 tickets needing action', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Needs action, 14 tickets needing action', exact: true }).click();
  await page.getByRole('article', { name: 'Ticket: Laptop setup help 1', exact: true }).waitFor({ state: 'hidden' });
  const rows = await fixture(page, 'tickets', { id: 'qa-ticket-000' });
  assert.equal(rows[0].status, 'Resolved');
  return { resolvedStatus: rows[0].status, unresolvedQueueCount: 14 };
});
for (const role of ['dept_head', 'hr_manager']) {
await scenario(`${role}-leave-decision`, role, 'qa-workflow=1', 'leave', async page => {
  await page.getByRole('button', { name: 'Review leave for Sample Employee 0025', exact: true }).click();
  const remarks = page.getByLabel(/^Remarks/);
  await remarks.waitFor();
  const form = remarks.locator('xpath=ancestor::form');
  assert.equal(await form.locator('button[type="submit"]').isDisabled(), true);
  await remarks.fill('QA verified handover and balance.');
  await form.locator('button[type="submit"]').click();
  await remarks.waitFor({ state: 'hidden' });
  const id = role === 'dept_head' ? 'qa-leave-department' : 'qa-leave-hr';
  const rows = await fixture(page, 'leaves', { id });
  assert.equal(rows[0].status, role === 'dept_head' ? 'Pending' : 'Approved');
  assert.equal(rows[0].approval_stage, role === 'dept_head' ? 'hr' : 'completed');
  const history = await fixture(page, 'leave_decisions', { leave_id: id, remarks: 'QA verified handover and balance.' });
  assert.equal(history.length, 1);
  assert.equal(await page.getByRole('button', { name: 'Review leave for Sample Employee 0001', exact: true }).count(), 0);
  return { status: rows[0].status, stage: rows[0].approval_stage, history, selfApprovalAbsent: true };
});
}
await scenario('failed-ticket-preserves-input', 'employee', 'qa-workflow=1&qa-block-write=1', 'helpdesk', async page => {
  await page.getByRole('button', { name: 'Raise Ticket', exact: true }).click();
  const form = page.getByRole('form', { name: 'Raise support ticket' });
  await form.getByRole('combobox').nth(0).selectOption('qa-cat-it');
  await form.getByLabel('Subject', { exact: true }).fill('QA denied ticket');
  await form.getByRole('button', { name: 'Submit ticket' }).click();
  await form.getByRole('alert').waitFor();
  assert.equal(await form.getByLabel('Subject', { exact: true }).inputValue(), 'QA denied ticket');
  assert.equal((await fixture(page, 'tickets', { subject: 'QA denied ticket' })).length, 0);
  return { error: await form.getByRole('alert').innerText(), inputRetained: true, inserted: 0 };
});
await scenario('employee-routine-tick', 'employee', 'qa-routines=1', 'tasks/routine', async page => {
  const today = await page.evaluate(async () => (await import('/qa/fixtures.js')).today);
  const tick = page.getByRole('button', { name: 'Tick Prepare the handover notes', exact: true });
  await tick.click();
  const untick = page.getByRole('button', { name: 'Untick Prepare the handover notes', exact: true });
  await untick.waitFor();
  let rows = await fixture(page, 'routine_ticks', { routine_item_id: 'qa-set-00-job-1', on_date: today });
  assert.equal(rows.length, 1);
  await untick.click();
  await tick.waitFor();
  rows = await fixture(page, 'routine_ticks', { routine_item_id: 'qa-set-00-job-1', on_date: today });
  assert.equal(rows.length, 0);
  return { savedTick: true, removedTick: true };
});
await scenario('goal-designation-selection', 'hr_manager', 'qa-goals=1', 'performance/team', async page => {
  await page.getByRole('button', { name: 'Set a goal', exact: true }).click();
  await page.getByPlaceholder('Name, code or designation').fill('Cashier');
  const people = page.getByRole('list', { name: 'Employee search results' });
  await people.getByRole('radio').first().click();
  const selected = await page.getByRole('group', { name: 'Selected employee' }).innerText();
  assert.match(selected, /Cashier/);
  await page.getByLabel(/^Goal title/).fill('QA cashier reconciliation');
  await page.getByLabel('Details (optional)', { exact: true }).fill('Close all reconciliation differences.');
  await page.getByRole('button', { name: 'Assign goal', exact: true }).click();
  await page.getByLabel(/^Goal title/).waitFor({ state: 'hidden' });
  const goals = await fixture(page, 'goals', { title: 'QA cashier reconciliation' });
  assert.equal(goals.length, 1); assert.equal(goals[0].progress, 0); assert.equal(goals[0].status, 'Active');
  assert.equal(goals[0].employee.designation.title, 'Cashier');
  return { selected, goal: goals[0] };
});
await scenario('multi-designation-routine-create', 'hr_manager', 'qa-routines=1', 'tasks/routine', async page => {
  await page.getByRole('button', { name: 'Create routine', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByLabel('Routine name', { exact: true }) });
  await form.getByLabel('Routine name', { exact: true }).fill('QA closing checklist');
  await form.getByLabel('Job 1 name', { exact: true }).fill('Verify closing stock');
  await form.getByRole('button', { name: 'Add job', exact: true }).click();
  await form.getByLabel('Job 2 name', { exact: true }).fill('Reconcile cash');
  await form.getByRole('combobox').filter({ has: page.locator('option[value="monthly"]') }).selectOption('monthly');
  await form.getByLabel('Day of month', { exact: true }).fill('32');
  await form.getByRole('checkbox', { name: 'Assign Sample Employee 0001 EMP0001', exact: true }).check();
  await form.getByRole('checkbox', { name: 'Assign Sample Employee 0004 EMP0004', exact: true }).check();
  assert.equal(await form.locator('button[type="submit"]').isDisabled(), true);
  await form.getByLabel('Day of month', { exact: true }).fill('31');
  await form.locator('button[type="submit"]').click();
  await page.getByText('Routine assigned to 2 employees.', { exact: true }).waitFor();
  const rows = await fixture(page, 'routine_sets', { title: 'QA closing checklist' });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.employee.designation.title).sort(), ['Cashier','Sales Associate']);
  assert.ok(rows.every(row => row.month_day === 31 && row.frequency === 'monthly'));
  return { assignedCount: rows.length, designations: rows.map(row => row.employee.designation.title), invalidDayBlocked: true };
});
await scenario('category-create-deactivate', 'entity_admin', 'qa-workflow=1', 'helpdesk', async page => {
  await page.getByRole('button', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'Add category', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByLabel('Category name', { exact: true }) });
  await form.getByLabel('Category name', { exact: true }).fill('QA benefits');
  await form.getByRole('combobox').selectOption('dept-2');
  await form.getByRole('checkbox', { name: 'HR queue', exact: true }).check();
  await form.getByRole('button', { name: 'Save category', exact: true }).click();
  await page.getByText('Category added.', { exact: true }).waitFor();
  const initial = await fixture(page, 'ticket_categories', { name: 'QA benefits' });
  assert.equal(initial.length, 1); assert.equal(initial[0].is_hr_queue, true);
  await page.getByRole('button', { name: 'Edit category QA benefits', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Available for new tickets', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Save category', exact: true }).click();
  await page.getByText('Category updated.', { exact: true }).waitFor();
  const updated = await fixture(page, 'ticket_categories', { name: 'QA benefits' });
  assert.equal(updated[0].is_active, false);
  await page.getByRole('button', { name: /^Tickets, / }).click();
  await page.getByRole('button', { name: 'Raise Ticket', exact: true }).click();
  assert.equal(await page.getByRole('form', { name: 'Raise support ticket' }).locator('option').filter({ hasText: 'QA benefits' }).count(), 0);
  return { initial: initial[0], deactivated: true, unavailableForNewTickets: true };
});
await scenario('employee-own-payslip-output', 'employee', '', 'payroll/payslips', async page => {
  const stage = page.locator('.route-stage');
  await stage.getByRole('button', { name: /Sample Employee 0001/ }).click();
  await stage.getByText('Earnings', { exact: true }).waitFor();
  const text = await stage.innerText();
  assert.match(text, /20,000/); assert.match(text, /22,000/); assert.match(text, /2,000/);
  assert.doesNotMatch(text, /Sample Employee 0002/);
  assert.equal(await stage.getByRole('button', { name: 'Run Payroll', exact: true }).count(), 0);
  return { validatedGross: 22000, validatedDeductions: 2000, validatedNet: 20000, otherEmployeeHidden: true };
});
await scenario('invalid-route-and-settings', 'employee', '', 'settings', async page => {
  await page.getByRole('button', { name: /12-hour/ }).click();
  const twelve = await page.getByRole('button', { name: /12-hour/ }).getAttribute('aria-pressed');
  assert.equal(twelve, 'true');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: /12-hour/ }).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => { location.hash = '/tasks/nonexistent'; });
  await page.getByRole('heading', { name: /Page not found/i }).waitFor();
  return { timePreferenceSurvivedReload: true, invalidRouteHandled: true };
});
for (const role of ['super_admin','entity_admin','hr_manager','zonal_manager','branch_manager','dept_head','employee']) {
await scenario(`calendar-route-${role}`, role, '', 'attendance/calendar', async page => {
  const text = await page.locator('.route-stage').innerText();
  assert.ok(text.length > 100);
  assert.doesNotMatch(text, /Something went wrong|Access restricted/);
  assert.match(text, /calendar|attendance/i);
  return { calendarLoaded: true, title: text.slice(0, 180) };
});
}
for (const role of ['super_admin','branch_manager','employee']) {
await scenario(`employee-detail-${role}`, role, '', 'directory/person-1', async page => {
  const stage = page.locator('.route-stage');
  if (role === 'employee') {
    await stage.getByText('Access restricted', { exact: true }).waitFor();
    return { deniedAsExpected: true };
  }
  await stage.getByRole('heading', { name: 'Sample Employee 0001', exact: true }).waitFor();
  return { loadedEmployee: 'Sample Employee 0001' };
});
}
await scenario('read-failure-reports', 'hr_manager', 'qa-fail=1', 'reports/leave', async page => {
  const text = await page.locator('.route-stage').innerText();
  const alerts = await page.locator('.route-stage [role="alert"]').allTextContents();
  assert.ok(alerts.length || /could not|failed|unavailable/i.test(text), 'Expected a report loading failure to be visible; observed empty report instead.');
  return { text, alerts };
});
} finally { await browser.close(); }
console.log(JSON.stringify({ total: results.length, passed: results.filter(r=>r.status==='PASS').length, failed: results.filter(r=>r.status==='FAIL').length }));
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
