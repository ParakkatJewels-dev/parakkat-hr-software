import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, PayrollSheetFrame, getEntry;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ default: PayrollSheetFrame } = await server.ssrLoadModule('/src/components/PayrollSheetFrame.jsx'));
  ({ getPayrollSessionStateEntry: getEntry } = await server.ssrLoadModule('/src/lib/usePayrollSessionState.js'));
});
after(async () => { await server?.close(); });

function render(client, key) {
  let childProps;
  const html = renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
    React.createElement(PayrollSheetFrame, { title: 'Monthly inputs', defaultExpanded: true, sessionKey: key },
      props => { childProps = props; return props.control; })));
  return { html, ...childProps };
}

test('leaving full screen stays remembered after a route remount, including an explicit false value', () => {
  const client = new QueryClient(), key = ['input-frame', 'company-a', '2026-10'];
  try {
    const initial = render(client, key);
    assert.equal(initial.expanded, true); assert.match(initial.html, /Exit full screen/);
    initial.control.props.onClick();
    assert.equal(getEntry(client, key, {}).getSnapshot().expanded, false);
    const returned = render(client, key);
    assert.equal(returned.expanded, false); assert.doesNotMatch(returned.html, /role="dialog"/);
    returned.control.props.onClick();
    assert.equal(render(client, key).expanded, true);
  } finally { client.clear(); }
});

test('a different company, month or authenticated query scope never inherits another sheet position', () => {
  const client = new QueryClient(), other = new QueryClient(), key = ['input-frame', 'company-a', '2026-10'];
  try {
    const position = { table: { top: 400, left: 700 }, employeeId: 'employee-a' };
    getEntry(client, key, { expanded: false, position });
    assert.equal(render(client, key).expanded, false);
    assert.equal(render(client, ['input-frame', 'company-b', '2026-10']).expanded, true);
    assert.equal(render(client, ['input-frame', 'company-a', '2026-09']).expanded, true);
    assert.equal(render(other, key).expanded, true);
    assert.deepEqual(client.getQueryCache().getAll(), [], 'positions stay out of the persisted query cache');
    assert.equal(getEntry(client, key, {}).getSnapshot().position, position);
  } finally { client.clear(); other.clear(); }
});
