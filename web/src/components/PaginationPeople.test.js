import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let server, AuthContext, ImportPreview, DocumentsSection, EmployeeAssetsSection, MyAssets,
  ExistingEmployeeDocuments, DeveloperSettings, Administration, AddToTeam;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ AuthContext } = await server.ssrLoadModule('/src/auth/AuthContext.jsx'));
  ({ ImportPreview } = await server.ssrLoadModule('/src/components/EmployeeImport.jsx'));
  ({ DocumentsSection, EmployeeAssetsSection } = await server.ssrLoadModule('/src/components/EmployeeProfile.jsx'));
  ({ MyAssets } = await server.ssrLoadModule('/src/components/UserProfile.jsx'));
  ({ ExistingEmployeeDocuments } = await server.ssrLoadModule('/src/components/Directory.jsx'));
  ({ default: DeveloperSettings } = await server.ssrLoadModule('/src/components/DeveloperSettings.jsx'));
  ({ default: Administration } = await server.ssrLoadModule('/src/components/Administration.jsx'));
  ({ AddToTeam } = await server.ssrLoadModule('/src/components/Team.jsx'));
});
after(async () => { await server?.close(); });

function render(Component, props = {}, seeds = []) {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false, retryOnMount: false, staleTime: Infinity } } });
  for (const [key, data] of seeds) client.setQueryData(key, data);
  const auth = { user: { id: 'reviewer' }, employee: null, isSuperAdmin: true, assignments: [], permissions: [], rank: 1000 };
  try {
    return renderToStaticMarkup(React.createElement(QueryClientProvider, { client },
      React.createElement(AuthContext.Provider, { value: auth },
        React.createElement(MemoryRouter, null, React.createElement(Component, props)))));
  } finally { client.clear(); }
}

const documents = Array.from({ length: 67 }, (_, i) => ({ id: `doc-${i}`, title: `Document ${i}`, storage_path: `doc-${i}/file.pdf` }));
const assets = Array.from({ length: 67 }, (_, i) => ({ id: `asset-${i}`, name: `Asset ${i}`, status: 'Allocated', condition: 'Good' }));

test('large import previews mount 25 rows with the full review count and later pages', () => {
  const rows = Array.from({ length: 675 }, (_, i) => ({ _row: i + 2, full_name: `Import person ${i}`, status: 'new' }));
  const html = render(ImportPreview, { rows, resetKey: 'file-1' });
  assert.equal((html.match(/data-label="Name"/g) ?? []).length, 25);
  assert.match(html, /of 675 import rows/);
  assert.match(html, /Page 1 of 27/);
  assert.match(html, /aria-label="Last page"/);
  assert.doesNotMatch(html, /Import person 674/);
  assert.equal(rows.length, 675, 'Review paging must preserve every planned import row');
});

test('employee profile documents retain view and download actions while paging the full folder', () => {
  const html = render(DocumentsSection, { employeeId: 'employee-1' }, [[['documents', 'employee', 'employee-1'], documents]]);
  assert.equal((html.match(/class="emp-doc"/g) ?? []).length, 10);
  assert.equal((html.match(/title="View file"/g) ?? []).length, 10);
  assert.equal((html.match(/title="Download file"/g) ?? []).length, 10);
  assert.match(html, /of 67 documents/);
  assert.match(html, /Page 1 of 7/);
  assert.doesNotMatch(html, />Document 66</);
});

test('employee edit saved documents page without hiding file actions', () => {
  const html = render(ExistingEmployeeDocuments, { employeeId: 'employee-1', documents, onOpen() {} });
  assert.equal((html.match(/class="emp-doc"/g) ?? []).length, 10);
  assert.match(html, /Saved documents \(67\)/);
  assert.match(html, /of 67 saved documents/);
  assert.match(html, /aria-label="View Document 0"/);
  assert.doesNotMatch(html, />Document 66</);
});

test('employee and self profile assets independently bound large allocations', () => {
  const seeds = [[['assets', 'employee', 'employee-1'], assets]];
  for (const Component of [EmployeeAssetsSection, MyAssets]) {
    const html = render(Component, { employeeId: 'employee-1', onOpenAsset() {} }, seeds);
    assert.equal((html.match(/<li(?: |>)/g) ?? []).length, 10);
    assert.match(html, /of 67 assets/);
    assert.match(html, /Page 1 of 7/);
    assert.doesNotMatch(html, />Asset 66</);
  }
});

test('retained API keys are paged and key management remains available', () => {
  const keys = Array.from({ length: 67 }, (_, i) => ({ id: `key-${i}`, name: `Integration ${i}`, key_prefix: `prefix-${i}`,
    scopes: ['employees:read'], created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }));
  const html = render(DeveloperSettings, {}, [
    [['developer-settings', 'reviewer'], { enabled: false }], [['developer-api-keys', 'reviewer'], keys],
    [['org', 'all'], { entities: [], branches: [], departments: [], zones: [], designations: [] }],
  ]);
  assert.equal((html.match(/aria-label="Create replacement for Integration /g) ?? []).length, 10);
  assert.match(html, /of 67 API keys/);
  assert.match(html, /Create key/);
  assert.doesNotMatch(html, />Integration 66</);
});

test('custom role collections page while keeping role creation and editing available', () => {
  const roles = Array.from({ length: 67 }, (_, i) => ({ id: `role-${i}`, key: `custom_${i}`, name: `Custom ${i}`, permissionKeys: ['employee.read'] }));
  const html = render(Administration, { view: 'roles' }, [[['roles-with-perms'], roles], [['permission-catalog'], []]]);
  assert.match(html, /of 67 roles/);
  assert.match(html, /Page 1 of 7/);
  assert.match(html, /New role/);
  assert.match(html, /Custom 0/);
  assert.doesNotMatch(html, /Custom 66/);
});

test('short document and asset lists remain compact without pagination controls', () => {
  const html = render(ExistingEmployeeDocuments, { documents: documents.slice(0, 3), onOpen() {} });
  assert.equal((html.match(/class="emp-doc"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /pagination-shell/);
});

test('team picker shows the complete matching count without the obsolete 50-person limit message', () => {
  const candidates = Array.from({ length: 1205 }, (_, i) => ({ id: `person-${i}`, full_name: `Candidate ${i}`, employee_code: `EMP${i}` }));
  const html = render(AddToTeam, { department: { id: 'team-1', name: 'Team' }, onClose() {}, onPick() {} },
    [[['assignable-employees', 'team-1', ''], candidates]]);
  assert.match(html, /of 1205 people/);
  assert.match(html, /Page 1 of 121/);
  assert.match(html, />Candidate 9</);
  assert.doesNotMatch(html, />Candidate 10</);
  assert.doesNotMatch(html, /Showing the first 50 matches/);
});
