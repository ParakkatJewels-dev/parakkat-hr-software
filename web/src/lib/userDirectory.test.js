import test from 'node:test';
import assert from 'node:assert/strict';
import { accountFixtures } from '../test/scaleFixtures.js';
import { buildUserDirectory, filterUserDirectory } from './userDirectory.js';
import { paginationWindow } from './pagination.js';

const fixture = accountFixtures();
const rows = buildUserDirectory(fixture.users, fixture.employees, fixture.org, fixture.roles);
test('675 accounts stay reachable across three company filters', () => {
  assert.equal(rows.length, 675);
  for (const company of fixture.org.entities) {
    const matches = filterUserDirectory(rows, { company: company.id });
    assert.equal(matches.length, 225);
    assert.ok(matches.every((u) => u.employee.entity_id === company.id));
  }
});
test('search combines words across employee code, name, email, company and branch', () => {
  assert.equal(filterUserDirectory(rows, { search: 'emp0675 retail' })[0]?.user_id, 'user-675');
  assert.equal(filterUserDirectory(rows, { search: 'employee674@example.test b2' })[0]?.user_id, 'user-674');
  assert.equal(filterUserDirectory(rows, { search: 'EMP0675 Jewellery' }).length, 0);
});
test('role, branch and missing-role filters agree with the saved account', () => {
  assert.equal(filterUserDirectory(rows, { status: 'no_role' }).length, 45);
  const matches = filterUserDirectory(rows, { role: 'hr_manager', company: 'company-2', branch: 'branch-2' });
  assert.ok(matches.length > 0);
  assert.ok(matches.every((u) => u.hasRole && u.roles[0].role_key === 'hr_manager' && u.branchId === 'branch-2'));
});
test('every id appears once at every offered size, including the partial last page', () => {
  const sorted = filterUserDirectory(rows);
  for (const size of [10, 25, 50, 100]) {
    const seen = [];
    const { totalPages } = paginationWindow(sorted.length, 1, size);
    for (let page = 1; page <= totalPages; page++) {
      const window = paginationWindow(sorted.length, page, size);
      seen.push(...sorted.slice(window.from - 1, window.to).map((u) => u.user_id));
    }
    assert.equal(seen.length, 675); assert.equal(new Set(seen).size, 675);
    assert.equal(seen.at(-1), 'user-675');
  }
});
test('standalone scoped/global logins retain correct company labels without inventing Super Admin', () => {
  const standalone = buildUserDirectory([
    { user_id: 'a', email: 'a@example.test', roles: null },
    { user_id: 'b', roles: [{ role_key: 'hr_manager', scope_type: 'branch', scope_id: 'branch-2' }] },
    { user_id: 'c', is_super_admin: true },
    { user_id: 'd', roles: [{ role_key: 'custom_auditor', scope_type: 'global' }] },
  ], [], fixture.org, fixture.roles);
  assert.equal(filterUserDirectory(standalone, { company: 'unassigned' }).length, 1);
  assert.deepEqual(standalone[1].companyIds, ['company-2']);
  assert.equal(standalone[2].companyLabel, 'All companies');
  assert.equal(standalone[3].companyLabel, 'All companies');
  assert.equal(standalone[3].global, false);
  assert.equal(filterUserDirectory(standalone, { role: 'super_admin' }).length, 1);
});
test('duplicate names have a deterministic order and an empty search result is safe', () => {
  const same = buildUserDirectory([{ user_id: '2', employee_name: 'Same' }, { user_id: '1', employee_name: 'Same' }], [], {});
  assert.deepEqual(filterUserDirectory(same).map((u) => u.user_id), ['1', '2']);
  assert.deepEqual(filterUserDirectory(same, { search: 'missing' }), []);
});
