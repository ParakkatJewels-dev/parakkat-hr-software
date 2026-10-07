const coordinates = element => ({ left: element?.scrollLeft ?? 0, top: element?.scrollTop ?? 0 });
const tableIn = host => host?.querySelector('.payroll-input-table-wrap, .payroll-register-scroll');

// Read on the outgoing action, while the sheet still has its real rows and dimensions.
// No listener writes initial zero positions over a retained return destination.
export function capturePayrollSheetPosition(host, main, target) {
  const element = target?.currentTarget ?? target;
  return {
    table: coordinates(tableIn(host)), host: coordinates(host), main: coordinates(main),
    employeeId: element?.closest?.('[data-payroll-employee]')?.getAttribute('data-payroll-employee') ?? null,
  };
}

function applyPosition(element, position) {
  if (!element || !position) return true;
  element.scrollLeft = position.left;
  element.scrollTop = position.top;
  return Math.abs(element.scrollLeft - position.left) < 1 && Math.abs(element.scrollTop - position.top) < 1;
}

// The app shell resets its scroll in a route-change animation frame. Wait two frames,
// then allow a short bounded retry for row/layout sizing. Any user interaction wins.
export function restorePayrollSheetPosition(host, main, position, onDone = () => {}) {
  if (!host || !position) return () => {};
  const document = host.ownerDocument;
  let frame = 0, attempts = 0, stopped = false, focused = false;
  const events = ['pointerdown', 'wheel', 'touchstart', 'keydown'];
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    events.forEach(event => document?.removeEventListener(event, cancel, true));
  };
  const cancel = () => { stop(); onDone(); };
  const apply = () => {
    if (stopped) return;
    const table = tableIn(host);
    const mainReady = applyPosition(main, position.main);
    const hostReady = applyPosition(host, position.host);
    const tableReady = applyPosition(table, position.table);
    if (!focused && position.employeeId) {
      const target = [...host.querySelectorAll('[data-payroll-employee]')]
        .find(element => element.getAttribute('data-payroll-employee') === position.employeeId);
      if (target) { target.focus({ preventScroll: true }); focused = true; }
    }
    attempts += 1;
    if ((table && mainReady && hostReady && tableReady) || attempts >= 60) { stop(); onDone(); }
    else frame = requestAnimationFrame(apply);
  };
  events.forEach(event => document?.addEventListener(event, cancel, { capture: true, passive: true }));
  frame = requestAnimationFrame(() => { frame = requestAnimationFrame(apply); });
  return stop;
}
