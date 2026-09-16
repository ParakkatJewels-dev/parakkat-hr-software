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
  const context = await browser.newContext({ viewport: { width: Number(process.env.HR_QA_WIDTH || 1440), height: 1000 }, timezoneId: 'Asia/Kolkata' });
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
  await page.screenshot({ path: resolve(out, `fix-${name}.png`), fullPage: true });
  await context.close();
  console.log(JSON.stringify(results.at(-1)));
  await writeFile(resolve(out, process.env.HR_QA_CASE ? `browser-workflows-${process.env.HR_QA_CASE}.json` : 'browser-fix-checks.json'), JSON.stringify(results, null, 2)+'\n');
}
const fixture = (page, table, filter) => page.evaluate(async ({ table, filter }) => {
  const { tables } = await import('/qa/fixtures.js');
  return tables[table].filter(row => Object.entries(filter).every(([k,v]) => row[k] === v));
}, { table, filter });

try {
await scenario('hr-exit-clearance-lifecycle', 'hr_manager', 'qa-workflow=1&qa-exits=1', 'helpdesk', async page => {
  const rows = await fixture(page, 'exits', {});
  const own = rows[0], other = rows[1];
  const ownCard = page.getByRole('article', { name: `Exit for ${own.employee.full_name}`, exact: true });
  const card = page.getByRole('article', { name: `Exit for ${other.employee.full_name}`, exact: true });
  assert.equal(await ownCard.getByRole('combobox').count(), 0);
  assert.equal(await card.getByRole('combobox').count(), 4);
  assert.equal(await card.getByRole('button', { name: 'Complete exit' }).count(), 0);
  for (const department of ['IT', 'Admin', 'Finance', 'HR']) {
    const select = card.getByLabel(`${department} clearance for ${other.employee.full_name}`, { exact: true });
    await select.selectOption('Approved');
    await page.waitForFunction(({ id, department }) => import('/qa/fixtures.js').then(({ tables }) => tables.exits.find(row => row.id === id).approvals[department] === 'Approved'), { id: other.id, department });
  }
  await card.getByText('Cleared', { exact: true }).waitFor();
  await card.screenshot({ path: resolve(out, `exit-cleared-${process.env.HR_QA_WIDTH || 1440}.png`) });
  await card.getByRole('button', { name: 'Complete exit', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Complete this exit?' });
  await dialog.getByRole('button', { name: 'Complete exit', exact: true }).click();
  await card.getByText('Completed', { exact: true }).waitFor();
  assert.equal(await card.getByRole('combobox').count(), 0);
  await card.screenshot({ path: resolve(out, `exit-completed-${process.env.HR_QA_WIDTH || 1440}.png`) });
  return { status: (await fixture(page, 'exits', { id: other.id }))[0].status, ownDecisionControls: 0 };
});
await scenario('exit-clearance-save-refusal', 'hr_manager', 'qa-workflow=1&qa-exits=1&qa-block-write=1', 'helpdesk', async page => {
  const row = (await fixture(page, 'exits', {}))[1];
  const select = page.getByLabel(`IT clearance for ${row.employee.full_name}`, { exact: true });
  await select.selectOption('Approved');
  await page.getByText('Clearance could not be saved.', { exact: true }).waitFor();
  assert.equal(await select.inputValue(), 'Pending');
  assert.equal((await fixture(page, 'exits', { id: row.id }))[0].approvals.IT, 'Pending');
  return { displayed: 'Pending', errorVisible: true };
});
await scenario('employee-exit-scope', 'employee', 'qa-workflow=1&qa-exits=1', 'helpdesk', async page => {
  const rows = await fixture(page, 'exits', {});
  assert.equal(await page.getByRole('article', { name: `Exit for ${rows[0].employee.full_name}`, exact: true }).count(), 1);
  assert.equal(await page.getByRole('article', { name: `Exit for ${rows[1].employee.full_name}`, exact: true }).count(), 0);
  assert.equal(await page.locator('select[aria-label*="clearance for"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Request Exit', exact: true }).count(), 0);
  return { ownRecordOnly: true, duplicateRequestHidden: true };
});
await scenario('recruitment-blank-title-browser', 'hr_manager', 'qa-workflow=1', 'recruitment', async page => {
  const writes = () => page.evaluate(async () => (await import('/qa/client.js')).qaState.mutations);
  const before = await writes();
  await page.getByRole('button', { name: 'Publish Opening', exact: true }).click();
  await page.locator('form select[required]').selectOption({ index: 1 });
  await page.getByPlaceholder('e.g. Sales Executive').fill('   ');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('Choose a company and enter a job title.', { exact: true }).waitFor();
  assert.equal(await writes(), before);
  assert.equal(await page.getByPlaceholder('e.g. Sales Executive').inputValue(), '   ');
  await page.getByPlaceholder('e.g. Sales Executive').fill('  QA Valid Role  ');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await page.getByText('QA mode: this write is intentionally blocked.', { exact: true }).waitFor();
  assert.equal(await page.getByPlaceholder('e.g. Sales Executive').inputValue(), '  QA Valid Role  ');
  return { blankWrites: 0, failedValidDraftRetained: true };
});
await scenario('monthly-leave-csv-output', 'hr_manager', 'qa-workflow=1', 'reports/leave', async page => {
  // A previously unopened month forces fresh request/allocation reads of the setup data.
  await page.evaluate(async () => {
    const { tables } = await import('/qa/fixtures.js');
    const original = tables.leaves[0];
    tables.leaves.splice(0, tables.leaves.length, { ...original, id: 'qa-cross-month', status: 'Approved', days: 3, day_fraction: 1,
      start_date: '2026-06-30', end_date: '2026-07-02' });
  });
  await page.locator('input[type="month"]').fill('2026-07');
  await page.locator('td[data-label="Approved Days"]').filter({ hasText: /^2$/ }).waitFor();
  const button = page.getByRole('button', { name: 'Requests (CSV)', exact: true });
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Requests (CSV)' && !b.disabled));
  const downloadPromise = page.waitForEvent('download'); await button.click();
  const download = await downloadPromise;
  const path = resolve(out, 'leave-period.csv'); await download.saveAs(path);
  const { readFile } = await import('node:fs/promises');
  const csv = await readFile(path, 'utf8');
  assert.match(csv, /Days in period,Request days/);
  assert.match(csv, /,2,3,Approved/);
  return { csv: 'leave-period.csv', periodDays: 2, requestDays: 3 };
});
} finally { await browser.close(); }
console.log(JSON.stringify({ total: results.length, passed: results.filter(r => r.status === 'PASS').length, failed: results.filter(r => r.status !== 'PASS').length }));
if (results.some(r => r.status !== 'PASS')) process.exitCode = 1;
