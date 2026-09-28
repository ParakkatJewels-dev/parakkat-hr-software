import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const sourceUrl = new URL('./useRevealOnOpen.js', import.meta.url).href;
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === sourceUrl && specifier === 'react') return {
    url: `data:text/javascript,${encodeURIComponent('export const useRef = initial => ({current:initial}); export const useEffect = setup => { globalThis.revealHookSetup = setup; };')}`,
    shortCircuit: true,
  };
  return next(specifier, context);
} });
const { useRevealOnOpen: revealOnOpen } = await import(sourceUrl);
after(() => { loader.deregister(); delete globalThis.revealHookSetup; });

function withScheduler(options, verify) {
  const saved = Object.fromEntries(['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  const frames = new Map(), timers = new Map(), events = [];
  let nextId = 0;
  globalThis.window = { matchMedia: () => ({ matches: Boolean(options.reduced) }), getComputedStyle: () => ({ scrollMarginTop: '90px' }) };
  globalThis.requestAnimationFrame = callback => { const id = ++nextId; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.setTimeout = callback => { const id = ++nextId; timers.set(id, callback); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const node = {
    scrollIntoView: value => events.push(['scrollIntoView', value]),
    querySelector: () => ({ focus: value => events.push(['focus', value]) }),
    closest: () => options.container,
    getBoundingClientRect: () => ({ top: 900 }),
  };
  try {
    revealOnOpen(true, options).current = node;
    const flush = () => {
      for (const queue of [frames, timers]) {
        const pending = [...queue.values()]; queue.clear(); pending.forEach(callback => callback());
      }
    };
    verify({ setup: globalThis.revealHookSetup, frames, timers, events, flush });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

test('StrictMode effect replay still reveals and focuses a newly opened form', () => {
  withScheduler({}, ({ setup, frames, timers, events, flush }) => {
    const firstCleanup = setup();
    assert.equal(frames.size, 1); assert.equal(timers.size, 1);
    firstCleanup();
    assert.equal(frames.size, 0); assert.equal(timers.size, 0);
    const replayCleanup = setup();
    assert.equal(frames.size, 1, 'the replay reschedules the cancelled reveal');
    assert.equal(timers.size, 1, 'the replay reschedules the cancelled focus');
    flush();
    assert.deepEqual(events, [['scrollIntoView', { behavior: 'smooth', block: 'nearest' }], ['focus', { preventScroll: true }]]);
    replayCleanup();
  });
});

test('focused editors scroll their content container without moving shell chrome or stealing heading focus', () => {
  const positions = [];
  const container = { scrollTop: 400, clientTop: 2, getBoundingClientRect: () => ({ top: 120 }), scrollTo: value => positions.push(value) };
  withScheduler({ focus: false, block: 'start', containerSelector: '.page-content', container, reduced: true }, ({ setup, timers, events, flush }) => {
    const cleanup = setup(); flush();
    assert.deepEqual(positions, [{ top: 1088, behavior: 'auto' }]);
    assert.equal(timers.size, 0);
    assert.deepEqual(events, [], 'no ancestor scrolling or first-field focus');
    cleanup();
  });
});

test('closing before reveal cancels both scrolling and field focus', () => {
  withScheduler({}, ({ setup, events, flush }) => {
    const cleanup = setup(); cleanup(); flush();
    assert.deepEqual(events, []);
  });
});
