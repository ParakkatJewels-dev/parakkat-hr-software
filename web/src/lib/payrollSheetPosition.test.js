import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePayrollSheetPosition, restorePayrollSheetPosition } from './payrollSheetPosition.js';

function viewport(maxLeft = 1000, maxTop = 2000) {
  let left = 0, top = 0;
  return {
    maxLeft, maxTop,
    get scrollLeft() { return left; }, set scrollLeft(value) { left = Math.max(0, Math.min(this.maxLeft, value)); },
    get scrollTop() { return top; }, set scrollTop(value) { top = Math.max(0, Math.min(this.maxTop, value)); },
  };
}

function harness(verify) {
  const prior = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  const frames = new Map(), listeners = new Map(), focus = [];
  let sequence = 0;
  globalThis.requestAnimationFrame = callback => { const id = ++sequence; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  const target = { getAttribute: () => 'employee-52', focus: options => focus.push(options) };
  target.closest = () => target;
  const table = viewport(), main = viewport(), host = Object.assign(viewport(), {
    ownerDocument: {
      addEventListener: (event, callback) => listeners.set(event, callback),
      removeEventListener: event => listeners.delete(event),
    },
    querySelector: () => table,
    querySelectorAll: () => [target],
  });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  try { verify({ host, table, main, target, frames, listeners, focus, flush }); }
  finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

const saved = { table: { left: 720, top: 960 }, main: { left: 0, top: 600 }, host: { left: 0, top: 100 }, employeeId: 'employee-52' };

test('capture reads all scrolling containers and the clicked employee without retaining DOM nodes', () => {
  harness(({ host, table, main, target }) => {
    table.scrollLeft = 720; table.scrollTop = 960; main.scrollTop = 600; host.scrollTop = 100;
    assert.deepEqual(capturePayrollSheetPosition(host, main, target), saved);
    assert.deepEqual(capturePayrollSheetPosition(host, main, { currentTarget: target }), saved);
  });
});

test('return restores after the app shell frame and focuses the same source link without moving scroll', () => {
  harness(({ host, table, main, frames, listeners, focus, flush }) => {
    let done = 0;
    restorePayrollSheetPosition(host, main, saved, () => { done += 1; });
    assert.equal(table.scrollLeft, 0);
    flush(); main.scrollTop = 0;
    assert.equal(table.scrollLeft, 0, 'first frame leaves time for the app route reset');
    flush();
    assert.equal(table.scrollLeft, 720); assert.equal(table.scrollTop, 960);
    assert.equal(main.scrollTop, 600); assert.equal(host.scrollTop, 100);
    assert.deepEqual(focus, [{ preventScroll: true }]);
    assert.equal(done, 1); assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
  });
});

test('late row sizing is retried without replacing the requested destination with initial zeroes', () => {
  harness(({ host, table, main, frames, focus, flush }) => {
    table.maxTop = 0; table.maxLeft = 0;
    restorePayrollSheetPosition(host, main, saved);
    flush(); flush();
    assert.equal(table.scrollTop, 0); assert.equal(frames.size, 1);
    table.maxTop = 2000; table.maxLeft = 1000;
    flush();
    assert.equal(table.scrollTop, 960); assert.equal(table.scrollLeft, 720);
    assert.equal(frames.size, 0); assert.equal(focus.length, 1);
  });
});

test('restoration does not fight a user who scrolls or interacts while layout is pending', () => {
  harness(({ host, table, main, frames, listeners, flush }) => {
    let done = 0;
    table.maxTop = 0;
    restorePayrollSheetPosition(host, main, saved, () => { done += 1; });
    flush(); flush();
    listeners.get('wheel')();
    table.maxTop = 2000; table.scrollTop = 120; flush();
    assert.equal(table.scrollTop, 120); assert.equal(frames.size, 0); assert.equal(listeners.size, 0); assert.equal(done, 1);
  });
});

test('unmount cancels pending work while StrictMode replay can schedule it again', () => {
  harness(({ host, table, main, frames, listeners, flush }) => {
    let done = 0;
    const cleanup = restorePayrollSheetPosition(host, main, saved, () => { done += 1; });
    cleanup(); cleanup(); flush();
    assert.equal(table.scrollTop, 0); assert.equal(frames.size, 0); assert.equal(listeners.size, 0); assert.equal(done, 0);
    restorePayrollSheetPosition(host, main, saved, () => { done += 1; });
    flush(); flush(); assert.equal(table.scrollTop, 960); assert.equal(done, 1);
  });
});

test('a shorter filtered list clamps to its remaining content and ends the bounded retry', () => {
  harness(({ host, table, main, frames, listeners, flush }) => {
    let done = 0;
    table.maxTop = 100;
    restorePayrollSheetPosition(host, main, saved, () => { done += 1; });
    for (let frame = 0; frame < 65; frame += 1) flush();
    assert.equal(table.scrollTop, 100); assert.equal(done, 1); assert.equal(frames.size, 0); assert.equal(listeners.size, 0);
  });
});
