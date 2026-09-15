import { qaState, simulateChatActivity, simulateActionActivity } from './client.js';
import { actionsFixtures, chatFixtures, goalsFixtures } from './fixtures.js';
import { workflowFixtures } from './workflowFixtures.js';
import { routineFixtures } from './routineFixtures.js';
import { ROLE_NAMES, qaRole, roleMode, expectsDeniedScreen, qaExpectedCounts, qaExpectedDashboard } from './roles.js';
import { setChosenRole } from '../src/lib/viewRole.js';
import '../src/main.jsx';

if (new URL(window.location.href).searchParams.has('qa-clipboard-blocked')) {
  // Browser automation may replace clipboard APIs and bypass the document Permissions-Policy.
  // Keep this explicit local fixture deterministic without changing browser or product settings.
  Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {
    throw new DOMException('QA simulated clipboard denial', 'NotAllowedError');
  } });
}

const panel = document.createElement('details');
panel.id = 'qa-panel';
panel.style.cssText = 'position:fixed;right:4px;bottom:78px;z-index:99999;max-width:calc(100vw - 8px);max-height:65vh;overflow:auto;background:#fff;color:#111;border:2px solid #b45309;border-radius:8px;padding:8px;font:12px/1.5 sans-serif;box-shadow:0 2px 15px #0003';
panel.innerHTML = '<summary>QA · 525 synthetic employees</summary><p>Isolated fixtures. Writes and external connections blocked.</p><label>QA role <select id="qa-role" aria-label="QA role"></select></label><button id="qa-sweep">Run all-screen smoke checks</button> <button id="qa-fail">Simulate read failure</button><pre id="qa-results" style="white-space:pre-wrap;max-width:520px"></pre>';
document.body.appendChild(panel);
if (workflowFixtures) {
  panel.querySelector('p').textContent = 'Isolated leave and ticket fixtures. Decisions, categories, and tickets save in memory only. External connections and other writes are blocked.';
  Object.assign(panel.style, { top: '4px', left: '4px', right: 'auto', bottom: 'auto' });
}
if (routineFixtures) {
  panel.querySelector('p').textContent = 'Isolated recurring routine fixtures. Assignment, completion and retirement save in memory only. External connections and other writes are blocked.';
  Object.assign(panel.style, { top: '4px', left: '4px', right: 'auto', bottom: 'auto' });
}
if (goalsFixtures) {
  panel.querySelector('p').textContent = 'Isolated goal fixtures. New goals save in memory only. External connections and other writes are blocked.';
  Object.assign(panel.style, { top: '4px', left: '4px', right: 'auto', bottom: 'auto' });
}
if (new URL(window.location.href).searchParams.has('qa-mobile')) {
  panel.querySelector('p').textContent = 'Isolated phone fixtures. Routine ticks save in memory only; all other writes and external connections are blocked.';
}
if (chatFixtures) {
  panel.querySelector('p').textContent = 'Isolated chat fixtures. Synthetic messages and chat preferences save in memory only; external connections and other writes are blocked.';
  // Keep test controls away from the chat composer and its Send button on narrow screens.
  Object.assign(panel.style, { top: '4px', left: '4px', right: 'auto', bottom: 'auto' });
  const controls = document.createElement('div');
  for (const [action, label] of [['incoming', 'Simulate incoming message'], ['delivered', 'Simulate peer delivery'], ['read', 'Simulate peer read'], ['typing', 'Simulate peer typing'], ['stop', 'Stop peer typing']]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => simulateChatActivity(action);
    controls.appendChild(button);
  }
  panel.appendChild(controls);
}
if (actionsFixtures) {
  panel.querySelector('p').textContent = 'Isolated Home actions fixtures. Synthetic task status, message receipts, notification reads and remote approval save in memory only. External connections and all other writes are blocked.';
  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;max-width:420px';
  const result = document.createElement('p');
  result.setAttribute('role', 'status');
  result.setAttribute('aria-label', 'QA action result');
  for (const [action, label] of [
    ['complete-overdue', 'Complete own overdue task'],
    ['complete-today', 'Complete own due-today task'],
    ['complete-assigned', 'Complete own newly assigned task'],
    ['complete-self', 'Complete own personal to-do'],
    ['approve-request', 'Approve sample leave request'],
    ['partial-read', 'Read first unread Asha message'],
    ['incoming', 'Add incoming message and notification'],
  ]) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = async () => { result.textContent = await simulateActionActivity(action); };
    controls.appendChild(button);
  }
  panel.appendChild(controls);
  panel.appendChild(result);
}
if (new URL(window.location.href).searchParams.has('qa-developer')) {
  panel.querySelector('p').textContent = 'Isolated developer fixtures. API settings and unusable sample keys save in memory only; external connections and other writes are blocked.';
}
for (const role of [...ROLE_NAMES, 'unassigned']) {
  const option = document.createElement('option');
  option.value = role; option.textContent = role; option.selected = role === qaRole;
  document.getElementById('qa-role').appendChild(option);
}
document.getElementById('qa-role').onchange = (event) => {
  const url = new URL(window.location.href);
  url.searchParams.set('qa-role', event.target.value);
  url.hash = '/dashboard';
  setChosenRole(null);
  window.location.assign(url);
};
const faults = [];
window.addEventListener('error', (event) => faults.push(event.message));
window.addEventListener('unhandledrejection', (event) => faults.push(String(event.reason)));
const routes = ['dashboard', 'directory', 'employee-import', 'organization', 'attendance/today',
  'attendance/overview', 'attendance/exceptions', 'attendance/regularizations', 'attendance-person',
  'attendance-admin/mapping', 'attendance-admin/shifts', 'attendance-admin/holidays',
  'attendance-admin/leaveTypes', 'attendance-admin/sync', 'leave', 'tasks/board',
  'tasks/todo', 'tasks/requests', 'tasks/routine', 'messages', 'team',
  'payroll/payslips', 'payroll/salary', 'payroll/run', 'payroll/components', 'expense',
  'performance/mine', 'performance/team', 'assets', 'my-assets', 'documents/employee',
  'documents/company', 'recruitment', 'onboarding', 'helpdesk', 'reports/attendance',
  'reports/leave', 'reports/expenses', 'reports/headcount',
  'administration', 'admin-roles', 'admin-audit', 'admin-chats', 'admin-developer', 'profile', 'notifications', 'settings'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('qa-sweep').onclick = async (event) => {
  event.target.disabled = true;
  const output = document.getElementById('qa-results');
  setChosenRole(null);
  output.textContent = `Role: ${qaRole}; viewport: ${window.innerWidth}px\n`;
  if (qaRole === 'unassigned') {
    const denied = document.getElementById('root').textContent.includes("You're not authorized yet");
    output.textContent += `${denied ? 'PASS' : 'FAIL'} unassigned account cannot enter application`;
    event.target.disabled = false;
    return;
  }
  const beforeSkip = window.location.hash;
  document.querySelector('.skip-link')?.click();
  output.textContent += window.location.hash === beforeSkip && document.activeElement?.id === 'main-content'
    ? 'PASS keyboard skip preserves route and focuses content\n' : 'FAIL keyboard skip\n';
  for (const route of routes) {
    const previousFaults = faults.length;
    const started = performance.now();
    window.location.hash = `/${route}`;
    await sleep(200);
    for (let attempt = 0; attempt < 30; attempt++) {
      const stage = document.querySelector('.route-stage');
      if (stage?.dataset.route === `/${route}` && stage.textContent.trim() && stage.textContent.trim() !== 'Loading…'
          && !stage.querySelector('.animate-spin, .animate-pulse')) break;
      await sleep(100);
    }
    await sleep(200);
    const stage = document.querySelector('.route-stage');
    const text = stage?.textContent ?? '';
    const issues = [];
    if (stage?.dataset.route !== `/${route}`) issues.push('route render did not settle');
    if (!text.trim()) issues.push('empty screen');
    if (/Something went wrong|Maximum update depth|undefined is not|is not a function/.test(document.getElementById('root').textContent)) issues.push('render error');
    if (!window.location.hash.startsWith(`#/${route}`)) issues.push('unexpected route redirect');
    const denied = text.includes('Access restricted');
    if (denied !== expectsDeniedScreen(route)) issues.push(denied ? 'unexpected denial' : 'missing access denial');
    if (!roleMode && route === 'dashboard') {
      for (const expected of ['525', '420', '105']) if (!text.includes(expected)) issues.push(`missing expected total ${expected}`);
    }
    if (roleMode && route === 'dashboard') {
      const buttons = Array.from(stage.querySelectorAll('button'), (button) => (
        button.matches('.dashboard-kpi')
          ? button.querySelector('.dashboard-kpi-label').textContent + button.querySelector('.dashboard-kpi-body > p').textContent
          : button.textContent
      ).replace(/\s+/g, ''));
      for (const expected of qaExpectedDashboard[qaRole] ?? []) {
        if (!buttons.includes(expected.replace(/\s+/g, ''))) issues.push(`incorrect dashboard total: ${expected}`);
      }
    }
    if (route === 'directory' && !denied && !text.includes(`${qaExpectedCounts[qaRole]} people`)) issues.push(`incorrect scoped roster total: ${text.slice(0, 180)}`);
    if (route === 'payroll/payslips') {
      const expected = ['super_admin', 'entity_admin', 'hr_manager'].includes(qaRole) ? qaExpectedCounts[qaRole] : 1;
      if (expected > 1 && !text.includes(`${expected} payslips`)) issues.push('incorrect scoped payslip total');
      if (expected === 1 && (stage.querySelectorAll('.payslip-card').length > 1 || text.includes('Sample Employee 0002'))) issues.push('another employee payslip rendered');
    }
    if (qaRole === 'employee' && route === 'attendance/today' && !text.includes('My monthly calendar')) issues.push('employee can reach team attendance');
    if (qaRole === 'employee' && route === 'attendance/overview') {
      if (!text.includes('Attendance overview') || !text.includes('Total hours')) issues.push('attendance overview missing');
      if (!stage.querySelector('td[data-label="Status"]')) issues.push('personal attendance ledger missing');
      if (stage.querySelector('#att-person') || text.includes('Sample Employee 0002')) issues.push('other employees offered in personal attendance overview');
    }
    if (route.startsWith('payroll/') && !['super_admin', 'entity_admin', 'hr_manager'].includes(qaRole)
      && ['Run Payroll', 'Salary Structures', 'Deductions & Allowances'].some((label) => Array.from(stage.querySelectorAll('button')).some((b) => b.textContent.trim() === label))) issues.push('manager payroll action exposed');
    if (faults.length > previousFaults) issues.push(...faults.slice(previousFaults));
    const main = document.querySelector('main');
    if (main && main.scrollWidth > main.clientWidth + 2) issues.push(`content overflow ${main.scrollWidth}/${main.clientWidth}px`);
    output.textContent += `${issues.length ? 'FAIL' : 'PASS'} ${route}${denied ? (expectsDeniedScreen(route) ? ' [denied as expected]' : ' [unexpected denial]') : ''} (${Math.round(performance.now() - started)}ms)${issues.length ? ': ' + issues.join('; ') : ''}\n`;
  }
  output.textContent += `\nQueries: ${qaState.reads}; attempted writes: ${qaState.mutations}.\nTimes include test settling; these are not production latency measurements.`;
  event.target.disabled = false;
};
document.getElementById('qa-fail').onclick = () => {
  const url = new URL(window.location.href);
  if (qaState.failReads) url.searchParams.delete('qa-fail');
  else url.searchParams.set('qa-fail', '1');
  window.location.assign(url);
};
document.getElementById('qa-fail').textContent = qaState.failReads ? 'Restore successful reads' : 'Simulate read failure';
