import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { exportEmployeeDirectory } from './directoryExport.js';
import { istToday } from '../lib/dates.js';

test('Directory CSV round-trips 525 complete rows, quotes and newlines through the shared formula-safe exporter', async (t) => {
  const employees = Array.from({ length: 525 }, (_, i) => ({ employee_code: `EMP${String(i).padStart(4, '0')}`,
    full_name: `Person ${i}`, phone: '0123456789', status: 'Active', branch: { code: 'B1' } }));
  employees[0] = { ...employees[0], employee_code: '=2+3', full_name: 'Name "with quotes",\nand a new line', phone: '+919876543210',
    email: 'someone@example.test', entity: { name: 'Company, Ltd' }, branch: { name: 'Branch "A"' },
    department: { name: 'Sales' }, designation: { title: 'Executive' }, join_date: '2026-09-01' };
  let blob, download, clicked = 0, revoked;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag) {
    assert.equal(tag, 'a');
    return { set download(value) { download = value; }, click() { clicked += 1; } };
  } } });
  t.mock.method(URL, 'createObjectURL', (value) => { blob = value; return 'blob:directory-test'; });
  t.mock.method(URL, 'revokeObjectURL', (value) => { revoked = value; });
  try {
    exportEmployeeDirectory(employees);
    assert.equal(clicked, 1);
    assert.equal(download, `Employee_Directory_${istToday()}.csv`);
    assert.equal(revoked, 'blob:directory-test');
    const workbook = XLSX.read(await blob.text(), { type: 'string', raw: true });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: '' });
    assert.equal(rows.length, 526);
    assert.ok(rows.every((row) => row.length === 10));
    assert.deepEqual(rows[1], ["'=2+3", 'Name "with quotes",\nand a new line', 'someone@example.test', "'+919876543210",
      'Company, Ltd', 'Branch "A"', 'Sales', 'Executive', 'Active', '2026-09-01']);
    assert.equal(rows[2][3], '0123456789');
    assert.equal(rows.at(-1)[0], 'EMP0524');
  } finally {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else delete globalThis.document;
  }
});
