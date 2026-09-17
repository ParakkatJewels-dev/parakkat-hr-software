import { before, mock, test } from 'node:test';
import assert from 'node:assert/strict';

let buildRegisterRows: typeof import('./registerReport').buildRegisterRows;

before(() => {
  mock.module(require.resolve('../config/env'), { namedExports: { env: { APP_TIMEZONE: 'America/New_York' } } });
  mock.module(require.resolve('../lib/logger'), { namedExports: { logger: { info() {}, warn() {}, error() {} } } });
  mock.module(require.resolve('../lib/db'), { namedExports: { prisma: { $queryRaw: async () => Array.from({ length: 675 }, (_, i) => ({
    employee_id: `employee-${i}`, employee_code: `EMP${i}`, full_name: `Worker ${i}`, branch_name: 'Branch A', department_name: 'Operations',
    work_date: new Date('2026-07-01T00:00:00.000Z'), status: 'Present', is_lop: false, is_late: false,
    day_fraction: 1, leave_fraction: null, ot_minutes: 60,
  })) } } });
  ({ buildRegisterRows } = require('./registerReport'));
});

test('675 SQL calendar dates retain their exact register day in a timezone west of UTC', async () => {
  const result = await buildRegisterRows({ year: 2026, month: 7 });
  assert.equal(result.rows.length, 675);
  assert.equal(result.dates[0], '2026-07-01');
  for (const row of result.rows) {
    assert.deepEqual([...row.days.keys()], ['2026-07-01']);
    assert.equal(row.totals.present, 1);
    assert.equal(row.totals.payable, 1);
    assert.equal(row.totals.otHours, 1);
  }
});
