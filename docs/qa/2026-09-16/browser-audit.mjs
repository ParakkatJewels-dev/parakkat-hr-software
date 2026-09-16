// Run with the isolated QA server on 127.0.0.1:5174.
// HR_QA_PLAYWRIGHT may point to an already installed Playwright index.mjs.
// Product data is never contacted; each persona gets a fresh browser context.
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.HR_QA_PLAYWRIGHT || 'playwright');
const out = resolve(dirname(fileURLToPath(import.meta.url)), 'evidence');
await mkdir(out, { recursive: true });
const roles = ['super_admin', 'entity_admin', 'hr_manager', 'zonal_manager', 'branch_manager', 'dept_head', 'employee', 'unassigned'];
const titles = ['Group Administrator', 'Company Administrator', 'HR Manager', 'Regional Manager', 'Branch Manager', 'Department Supervisor', 'Sales Associate', 'Unassigned Trainee'];
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
const jobs = [1440, 390].flatMap(width => roles.map((role, i) => ({ role, designation: titles[i], width })));
async function run(job) {
  const context = await browser.newContext({ viewport: { width: job.width, height: job.width === 390 ? 844 : 1000 }, timezoneId: 'Asia/Kolkata' });
  const externalRequests = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    externalRequests.push(url.origin); return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:5174/?qa-role=${job.role}`, { waitUntil: 'networkidle' });
    await page.locator('#qa-sweep').waitFor({ state: 'attached' });
    // Seed varied job designations into the existing in-memory QA data. This is
    // fixture setup, not an assertion or a replacement of application behavior.
    const fixtureSummary = await page.evaluate(async ({ titles, designation }) => {
      const { fixture } = await import('/qa/fixtures.js');
      const definitions = titles.slice(0, 7).map((title, i) => ({ id: `audit-designation-${i}`, title, grade: String(i + 1), is_active: true }));
      fixture.org.designations.splice(0, fixture.org.designations.length, ...definitions);
      fixture.employees.forEach((employee, i) => {
        const chosen = definitions[i % definitions.length];
        Object.assign(employee, { designation_id: chosen.id, designation: chosen });
      });
      const chosen = definitions.find(item => item.title === designation) || definitions[6];
      Object.assign(fixture.employees[0], { designation_id: chosen.id, designation: chosen });
      return { employees: fixture.employees.length, entities: fixture.org.entities.length, zones: fixture.org.zones.length,
        branches: fixture.org.branches.length, departments: fixture.org.departments.length,
        designations: [...new Set(fixture.employees.map(employee => employee.designation.title))],
        signedInEmployee: fixture.employees[0].full_name, signedInDesignation: fixture.employees[0].designation.title };
    }, { titles, designation: job.designation });
    await page.locator('#qa-panel > summary').click();
    await page.locator('#qa-sweep').click();
    await page.waitForFunction(() => !document.querySelector('#qa-sweep').disabled && /Queries:|unassigned account/.test(document.querySelector('#qa-results').textContent), null, { timeout: 180000 });
    const output = await page.locator('#qa-results').innerText();
    const lines = output.split('\n').filter(line => /^(PASS|FAIL) /.test(line));
    const item = { ...job, fixtureSummary, passed: lines.filter(line => line.startsWith('PASS')).length,
      failed: lines.filter(line => line.startsWith('FAIL')), pageErrors: errors, externalRequests, output };
    results.push(item);
    await page.locator('#qa-panel > summary').click();
    await page.screenshot({ path: resolve(out, `roles-${job.role}-${job.width}.png`), fullPage: true });
    console.log(JSON.stringify({ role: job.role, width: job.width, passed: item.passed, failed: item.failed, pageErrors: errors }));
  } catch (error) {
    results.push({ ...job, fatal: error.message, pageErrors: errors, externalRequests });
    console.log(JSON.stringify({ ...job, fatal: error.message }));
  } finally { await context.close(); }
  await writeFile(resolve(out, 'browser-role-results.json'), JSON.stringify(results, null, 2) + '\n');
}
try {
  await Promise.all(Array.from({ length: 3 }, async () => { while (jobs.length) await run(jobs.shift()); }));
} finally { await browser.close(); }
console.log(JSON.stringify({ personas: results.length, assertions: results.reduce((n, r) => n + (r.passed || 0) + (r.failed?.length || 0), 0), failed: results.reduce((n, r) => n + (r.failed?.length || 0) + (r.fatal ? 1 : 0), 0) }));
if (results.some(result => result.fatal || result.failed?.length || result.pageErrors?.length)) process.exitCode = 1;
