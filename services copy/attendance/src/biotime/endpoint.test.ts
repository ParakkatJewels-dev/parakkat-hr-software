// Which addresses are tried, and in what order.
//
//   npx tsx --test src/biotime/endpoint.test.ts
//
// This decides where punches are read from. Getting it wrong means either silently reading from
// the wrong server, or refusing to recover when a DHCP lease moves and the configured IP goes
// stale — which is the failure this exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostname } from 'node:os';
import { candidates } from './endpoint';

test('the configured address is always tried first', () => {
  const c = candidates('http://192.168.1.45:8081');
  assert.equal(c[0], 'http://192.168.1.45:8081',
    'if somebody wrote it down, it is the intended answer');
});

test('a LAN address gains a loopback alternative on the same port', () => {
  const c = candidates('http://192.168.1.45:8081');
  assert.ok(c.includes('http://127.0.0.1:8081'), 'same server, no network hop');
});

test('the machine hostname is offered too, since it survives a DHCP change', () => {
  const c = candidates('http://192.168.1.45:8081');
  assert.ok(c.some((u) => u.includes(hostname())));
});

test('a loopback address gets no alternatives — there is nowhere better to go', () => {
  assert.deepEqual(candidates('http://127.0.0.1:8081'), ['http://127.0.0.1:8081']);
  assert.deepEqual(candidates('http://localhost:8081'), ['http://localhost:8081']);
});

test('the port is carried across, never assumed', () => {
  const c = candidates('http://192.168.1.45:9999');
  assert.ok(c.includes('http://127.0.0.1:9999'), 'not 8081');
});

test('https stays https', () => {
  const c = candidates('https://192.168.1.45:8443');
  assert.ok(c.every((u) => u.startsWith('https://')));
  assert.ok(c.includes('https://127.0.0.1:8443'));
});

test('a default port is inferred rather than dropped', () => {
  const c = candidates('http://192.168.1.45');
  assert.ok(c.includes('http://127.0.0.1:80'));
});

test('a trailing slash does not create a duplicate address', () => {
  const c = candidates('http://192.168.1.45:8081/');
  assert.equal(c[0], 'http://192.168.1.45:8081');
  assert.equal(new Set(c).size, c.length, 'no repeats');
});

test('something unparseable is passed through untouched rather than guessed at', () => {
  assert.deepEqual(candidates('not a url'), ['not a url']);
});
