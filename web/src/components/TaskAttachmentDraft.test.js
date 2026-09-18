import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server, TaskAttachmentDraft;
before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ default: TaskAttachmentDraft } = await server.ssrLoadModule('/src/components/TaskAttachmentDraft.jsx'));
});
after(async () => { await server?.close(); });

const render = (value = {}, disabled = false) => renderToStaticMarkup(React.createElement(TaskAttachmentDraft, {
  value, disabled, onChange: () => {},
}));

test('new task drafts expose a labelled multi-file picker, file limits, and a link field before creation', () => {
  const html = render();
  assert.match(html, /Files &amp; links \(optional\)/);
  assert.match(html, /type="file" multiple="" accept="\.pdf,\.jpg/);
  assert.match(html, /Up to 10 MB per file/);
  assert.match(html, /inputMode="url"/);
  assert.match(html, /Add another link/);
});

test('chosen files and multiple link drafts stay visible with named removal controls', () => {
  const html = render({
    files: [{ name: 'Reference.pdf', size: 1048576 }],
    links: [{ url: 'https://example.com', label: 'Instructions' }, { url: 'https://example.org', label: '' }],
  });
  assert.match(html, /Reference\.pdf/);
  assert.match(html, /1\.0 MB/);
  assert.match(html, /aria-label="Remove file Reference\.pdf"/);
  assert.match(html, /aria-label="Remove link 1"/);
  assert.match(html, /aria-label="Remove link 2"/);
  assert.match(html, /value="Instructions"/);
});

test('draft attachments lock while saving or after the task was partially saved', () => {
  assert.match(render({}, true), /^<fieldset disabled=""/);
});
