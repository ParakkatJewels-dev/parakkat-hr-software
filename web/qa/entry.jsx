import { qaState } from './client.js';
import '../src/main.jsx';

const panel = document.createElement('details');
panel.id = 'qa-panel';
panel.style.cssText = 'position:fixed;right:4px;bottom:78px;z-index:99999;max-width:calc(100vw - 8px);max-height:65vh;overflow:auto;background:#fff;color:#111;border:2px solid #b45309;border-radius:8px;padding:8px;font:12px/1.5 sans-serif;box-shadow:0 2px 15px #0003';
panel.innerHTML = '<summary>QA · 525 synthetic employees</summary><p>Isolated fixtures. Writes and external connections blocked.</p><button id="qa-sweep">Run all-screen smoke checks</button> <button id="qa-fail">Simulate read failure</button><pre id="qa-results" style="white-space:pre-wrap;max-width:520px"></pre>';
document.body.appendChild(panel);
const faults = [];
window.addEventListener('error', (event) => faults.push(event.message));
window.addEventListener('unhandledrejection', (event) => faults.push(String(event.reason)));
const routes = ['dashboard', 'directory', 'employee-import', 'organization', 'attendance/today',
  'attendance/exceptions', 'attendance/regularizations', 'attendance-person',
  'attendance-admin/mapping', 'attendance-admin/shifts', 'attendance-admin/holidays',
  'attendance-admin/leaveTypes', 'attendance-admin/sync', 'leave', 'tasks/board',
  'tasks/todo', 'tasks/requests', 'tasks/routine', 'messages', 'team',
  'payroll/payslips', 'payroll/salary', 'payroll/run', 'payroll/components', 'expense',
  'performance/mine', 'performance/team', 'assets', 'my-assets', 'documents/employee',
  'documents/company', 'recruitment', 'onboarding', 'helpdesk', 'reports/attendance',
  'reports/leave', 'reports/expenses', 'reports/headcount',
  'administration', 'admin-roles', 'admin-audit', 'admin-chats', 'profile', 'notifications', 'settings'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
document.getElementById('qa-sweep').onclick = async (event) => {
  event.target.disabled = true;
  const output = document.getElementById('qa-results');
  output.textContent = '';
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
      if (stage?.textContent.trim() && stage.textContent.trim() !== 'Loading…'
          && !stage.querySelector('.animate-spin')) break;
      await sleep(100);
    }
    await sleep(200);
    const stage = document.querySelector('.route-stage');
    const text = stage?.textContent ?? '';
    const issues = [];
    if (!text.trim()) issues.push('empty screen');
    if (/Something went wrong|Maximum update depth|undefined is not|is not a function/.test(document.getElementById('root').textContent)) issues.push('render error');
    if (!window.location.hash.startsWith(`#/${route}`)) issues.push('unexpected route redirect');
    if (route === 'dashboard') {
      for (const expected of ['525', '420', '105']) if (!text.includes(expected)) issues.push(`missing expected total ${expected}`);
    }
    if (route === 'directory' && !text.includes('525 people')) issues.push('incorrect roster total');
    if (route === 'payroll/payslips' && !text.includes('525 payslips')) issues.push('incorrect payslip total');
    if (faults.length > previousFaults) issues.push(...faults.slice(previousFaults));
    const main = document.querySelector('main');
    if (main && main.scrollWidth > main.clientWidth + 2) issues.push(`content overflow ${main.scrollWidth}/${main.clientWidth}px`);
    output.textContent += `${issues.length ? 'FAIL' : 'PASS'} ${route} (${Math.round(performance.now() - started)}ms)${issues.length ? ': ' + issues.join('; ') : ''}\n`;
  }
  output.textContent += `\nQueries: ${qaState.reads}; blocked writes: ${qaState.mutations}.\nTimes include test settling; these are not production latency measurements.`;
  event.target.disabled = false;
};
document.getElementById('qa-fail').onclick = () => {
  const url = new URL(window.location.href);
  if (qaState.failReads) url.searchParams.delete('qa-fail');
  else url.searchParams.set('qa-fail', '1');
  window.location.assign(url);
};
document.getElementById('qa-fail').textContent = qaState.failReads ? 'Restore successful reads' : 'Simulate read failure';
