import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { MONTHLY_INPUT_FIELDS, PAYROLL_REGISTER_COLUMNS } from './payrollWorksheet.js';
import {
  parsePayrollPaste, applyPayrollPaste, parsePayrollImportRows, readPayrollInputWorkbook,
  buildPayrollInputTemplateWorkbook,
} from './payrollInputGrid.js';

const employees = [
  { id: 'employee-1', employee_code: '001', full_name: 'Anu Kumar', branch: { name: 'Main' } },
  { id: 'employee-2', employee_code: '002', full_name: 'Anu Kumar', branch: { name: 'North' } },
  { id: 'employee-3', employee_code: '003', full_name: 'Binu Menon', branch: { name: 'Main' } },
];
const paste = (text, overrides = {}) => applyPayrollPaste({ rows: employees, columns: ['incentive', 'tea_expense', 'notes'],
  startRow: 0, startColumn: 0, values: parsePayrollPaste(text), ...overrides });
const importRows = rows => parsePayrollImportRows(rows, employees);

test('a calculated transaction register cannot be re-imported and count itemized amounts twice', () => {
  const result = importRows([['Employee Code', 'Incentive', 'Bonus', 'Gross Salary'], ['003', 500, 1000, 30000]]);
  assert.equal(result.rows.length, 0);
  assert.match(result.errors[0].message, /template.*twice/);
});
function workbookFile(workbook) {
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return { size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

test('Excel paste handles quoted tabs, multiline notes, escaped quotes and CRLF', () => {
  assert.deepEqual(parsePayrollPaste('100\t200\t"Approved\tby HR\r\nRef ""A1"""\r\n300\t\tNote\r\n'), [
    ['100', '200', 'Approved\tby HR\nRef "A1"'], ['300', '', 'Note'],
  ]);
  assert.deepEqual(parsePayrollPaste('1\t2\n3'), [['1', '2'], ['3', '']]);
  assert.deepEqual(parsePayrollPaste(''), []);
  assert.deepEqual(parsePayrollPaste('""\t0'), [['', '0']]);
  assert.throws(() => parsePayrollPaste('"unfinished'), /unfinished/);
  assert.throws(() => parsePayrollPaste('"closed"tail'), /quoted/);
});

test('paste normalizes only valid currency formatting, preserving notes as literal text', () => {
  assert.deepEqual(paste('₹ 1,23,456.70\t1,000.50\t=HYPERLINK("literal")'), [{ employeeId: 'employee-1',
    patch: { incentive: '123456.7', tea_expense: '1000.5', notes: '=HYPERLINK("literal")' } }]);
  assert.deepEqual(paste('0\t\n50\t0'), [
    { employeeId: 'employee-1', patch: { incentive: '0', tea_expense: '' } },
    { employeeId: 'employee-2', patch: { incentive: '50', tea_expense: '0' } },
  ]);
  for (const value of ['=1+2', '+100', '-100', '@SUM(A1)', '1e3', '0x10', '1,2', '2.001', '₹', 'Infinity', '10000000000']) {
    assert.throws(() => paste(value), undefined, value);
  }
  assert.throws(() => paste('745', { columns: ['ot_hours'] }), /744/);
});

test('AUTO explicitly clears hour overrides in paste and import while blank import cells preserve them', () => {
  assert.deepEqual(paste('AUTO\t0\nauto\t AUTO ', { columns: ['ot_hours', 'late_hours'] }), [
    { employeeId: 'employee-1', patch: { ot_hours: '', late_hours: '0' } },
    { employeeId: 'employee-2', patch: { ot_hours: '', late_hours: '' } },
  ]);
  const result = importRows([['Employee ID', 'Approved OT Hours', 'Late Hours'],
    ['employee-1', 'AUTO', ''], ['employee-2', '', 0], ['employee-3', '', 'AUTO']]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows.map(row => row.patch), [{ ot_hours: '' }, { late_hours: '0' }, { late_hours: '' }]);
  for (const key of ['pf', 'esi', 'incentive']) assert.throws(() => paste('AUTO', { columns: [key] }), /nonnegative/);
});

test('paste is bounded and returns no partial mutation on invalid cells or targets', () => {
  const original = structuredClone(employees);
  assert.throws(() => paste('1\n2', { startRow: 2 }), /exceeds/);
  assert.throws(() => paste('1\t2', { startColumn: 2 }), /exceeds/);
  assert.throws(() => paste('1', { startRow: -1 }), /starting/);
  assert.throws(() => paste('1', { startColumn: 0.5 }), /starting/);
  assert.throws(() => paste('1', { columns: ['gross_salary'] }), /not an editable/);
  assert.throws(() => paste('1\n2', { rows: [employees[0], employees[0]] }), /duplicated/);
  assert.throws(() => paste('1', { values: [['1'], ['2', '3']] }), /rectangular/);
  assert.deepEqual(employees, original);
});

test('imports exact identifiers, aliases, zero values and ignores blank inputs', () => {
  const result = importRows([
    ['Employee Code', 'Employee Name', 'Tea Expence', 'Travel Allowance / Food Expence', 'Pf', 'Notes', 'Source file'],
    ['001', 'Anu Kumar', '₹ 1,000', '0', '', '', 'july.xlsx'],
    ['003', 'Binu Menon', '', '', 0, 'Approved exclusion', ''],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /Ignored unknown column/);
  assert.deepEqual(result.rows, [
    { employeeId: 'employee-1', employeeName: 'Anu Kumar', patch: { tea_expense: '1000', travel_food: '0' } },
    { employeeId: 'employee-3', employeeName: 'Binu Menon', patch: { pf: '0', notes: 'Approved exclusion' } },
  ]);
});

test('names must be unambiguous, and supplied ID/code/name must agree', () => {
  const ambiguous = importRows([['Employee Name', 'Incentive'], ['Anu Kumar', '10'], ['Binu Menon', '20'], ['Binu', '30']]);
  assert.equal(ambiguous.errors.length, 2);
  assert.match(ambiguous.errors[0].message, /Ambiguous/);
  assert.equal(ambiguous.rows[0].employeeId, 'employee-3');
  const mismatch = importRows([['Employee ID', 'Employee Code', 'Incentive'], ['employee-1', '002', '50']]);
  assert.match(mismatch.errors[0].message, /same employee/);
  const noFallback = importRows([['Employee ID', 'Employee Code', 'Incentive'], ['not-in-scope', '001', '50']]);
  assert.match(noFallback.errors[0].message, /No employee/);
  assert.equal(noFallback.rows.length, 0);
  const duplicateCode = parsePayrollImportRows([['Employee Code', 'Incentive'], ['001', 10]], [employees[0], { ...employees[1], employee_code: '001' }]);
  assert.match(duplicateCode.errors[0].message, /Ambiguous/);
});

test('duplicate employees reject all copies, including an invalid first occurrence', () => {
  const result = importRows([['Employee ID', 'Incentive'], ['employee-1', 10], ['employee-1', 20], ['employee-3', 30]]);
  assert.deepEqual(result.rows.map(row => row.employeeId), ['employee-3']);
  assert.deepEqual(result.errors.map(error => error.row), [2, 3]);
  const invalidFirst = importRows([['Employee Code', 'Incentive'], ['001', '=1+2'], ['001', 20]]);
  assert.equal(invalidFirst.rows.length, 0);
  assert.ok(invalidFirst.errors.some(error => /Duplicate/.test(error.message)));
});

test('duplicate editable and identity aliases are rejected', () => {
  for (const headers of [
    ['Employee Code', 'Tea expense', 'Tea Expence'],
    ['Employee ID', 'Employee UUID', 'Incentive'],
    ['Employee Code', 'Code', 'Incentive'],
    ['Employee Name', 'Approved OT Hours', 'Ot Hours'],
  ]) {
    const result = importRows([headers, ['001', 20, 30]]);
    assert.ok(result.errors.length);
    assert.equal(result.rows.length, 0);
  }
  assert.match(importRows([['Incentive'], [10]]).errors[0].message, /Include Employee/);
  assert.match(importRows([['Employee ID'], ['employee-1']]).errors[0].message, /editable/);
});

test('the original 33-column register imports only its 14 editable inputs and permits both Salary headers', () => {
  const fields = new Set(MONTHLY_INPUT_FIELDS.map(field => field.key));
  const values = PAYROLL_REGISTER_COLUMNS.map(({ key }, index) => key === 'employee_name' ? 'Binu Menon'
    : key === 'branch' ? 'Main' : fields.has(key) ? index + 0.25 : { f: '1+2', v: 3 });
  const result = importRows([PAYROLL_REGISTER_COLUMNS.map(column => column.label), values]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].employeeId, 'employee-3');
  assert.equal(Object.keys(result.rows[0].patch).length, 14);
  for (const field of MONTHLY_INPUT_FIELDS.filter(field => field.group !== 'Attendance' && field.key !== 'tds')) {
    assert.equal(result.rows[0].patch[field.key], String(PAYROLL_REGISTER_COLUMNS.findIndex(column => column.key === field.key) + 0.25));
  }
  assert.equal(result.rows[0].patch.salary, undefined);
  assert.equal(result.rows[0].patch.gross_salary, undefined);
  assert.equal(result.rows[0].patch.notes, undefined);
  assert.equal(result.warnings.filter(warning => /Ignored calculated column “Salary”/.test(warning.message)).length, 2);
  assert.ok(result.warnings.every(warning => /Ignored calculated/.test(warning.message)));
});

test('import does not interpret formulas, malformed numbers or blank imports as zeros', () => {
  const result = importRows([['Employee ID', 'Incentive', 'Notes'], ['employee-1', '=1+2', ''], ['employee-2', { f: '1+2', v: 3 }, ''], ['employee-3', '', '']]);
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.match(result.warnings[0].message, /left unchanged/);
  assert.match(importRows([['Employee ID', 'Incentive'], ['employee-1', 10, 20]]).errors[0].message, /beyond/);
});

test('input template round-trips identifiers, automatic hours, nullable PF/ESI, numbers and formula-like text', async () => {
  const named = { ...employees[0], full_name: '=HYPERLINK("literal")', employee_code: '001', branch: { name: '@Main' } };
  const records = new Map([[named.id, { incentive: '1250.25', pf: '', esi: '0', notes: '+Literal approval' }]]);
  const workbook = buildPayrollInputTemplateWorkbook(XLSX, [named], records, '2026-10');
  const sheet = workbook.Sheets['Monthly inputs'];
  assert.equal(sheet.B2.t, 's'); assert.equal(sheet.B2.v, '001');
  assert.equal(sheet.C2.t, 's'); assert.equal(sheet.C2.f, undefined);
  assert.equal(sheet.C2.v, '=HYPERLINK("literal")');
  assert.equal(sheet.E2.t, 'n'); assert.equal(sheet.E2.v, 1250.25);
  const rows = await readPayrollInputWorkbook(workbookFile(workbook));
  assert.equal(rows[0].length, 4 + MONTHLY_INPUT_FIELDS.length + 1);
  assert.equal(rows[1][4 + MONTHLY_INPUT_FIELDS.findIndex(field => field.key === 'pf')], '');
  for (const key of ['ot_hours', 'late_hours']) {
    const column = 4 + MONTHLY_INPUT_FIELDS.findIndex(field => field.key === key);
    assert.equal(rows[1][column], 'AUTO');
    assert.equal(sheet[XLSX.utils.encode_cell({ r: 1, c: column })].t, 's');
  }
  const result = parsePayrollImportRows(rows, [named]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].patch.pf, undefined);
  assert.equal(result.rows[0].patch.esi, '0');
  assert.equal(result.rows[0].patch.notes, '+Literal approval');
  assert.equal(result.rows[0].patch.ot_hours, '');
  assert.equal(result.rows[0].patch.late_hours, '');
});

test('template export retains a numeric zero hour override instead of turning it into AUTO', async () => {
  const workbook = buildPayrollInputTemplateWorkbook(XLSX, [employees[0]], [{ employee_id: 'employee-1',
    ot_hours: 0, late_hours: null, notes: 'Reviewed no-overtime override' }], '2026-10');
  const rows = await readPayrollInputWorkbook(workbookFile(workbook));
  assert.equal(rows[1][4 + MONTHLY_INPUT_FIELDS.findIndex(field => field.key === 'ot_hours')], 0);
  assert.equal(rows[1][4 + MONTHLY_INPUT_FIELDS.findIndex(field => field.key === 'late_hours')], 'AUTO');
  const result = importRows(rows);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].patch.ot_hours, '0');
  assert.equal(result.rows[0].patch.late_hours, '');
});

test('workbook reader ignores additional sheets and rejects formulas in editable first-sheet inputs', async () => {
  const workbook = buildPayrollInputTemplateWorkbook(XLSX, employees, [], '2026-10');
  XLSX.utils.book_append_sheet(workbook, { A1: { t: 'n', f: '1+2', v: 3 }, '!ref': 'A1' }, 'Formula');
  const aoa = await readPayrollInputWorkbook(workbookFile(workbook));
  assert.equal(aoa[0][0], 'Employee ID');
  workbook.Sheets['Monthly inputs'].E2 = { t: 'n', f: '1+2', v: 3 };
  await assert.rejects(readPayrollInputWorkbook(workbookFile(workbook)), /Monthly inputs!E2/);
  await assert.rejects(readPayrollInputWorkbook({ size: 11 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) }), /10 MB/);
});

test('calculated gross/salary formulas are ignored but identity, unknown and input formulas are rejected', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Employee Code', 'Salary', 'Salary', 'Gross Salary', 'Incentive', 'Unknown'],
    ['003', 100, 100, 120, 20, ''],
  ]);
  for (const address of ['B2', 'C2', 'D2']) sheet[address] = { t: 'n', f: '1+2', v: 3 };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Register');
  const result = importRows(await readPayrollInputWorkbook(workbookFile(workbook)));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0].patch, { incentive: '20' });
  for (const address of ['A2', 'E2', 'F2']) {
    const original = sheet[address];
    sheet[address] = { t: 'n', f: '1+2', v: 3 };
    await assert.rejects(readPayrollInputWorkbook(workbookFile(workbook)), new RegExp(`Register!${address}`));
    sheet[address] = original;
  }
  sheet.D2 = { t: 'n', f: '1+2', v: 3, F: 'D2:E2' };
  await assert.rejects(readPayrollInputWorkbook(workbookFile(workbook)), /Register!D2/);
});

test('workbook row errors keep Excel row numbers after leading blank rows', async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['Employee Code', 'Incentive'], ['missing', 10]], { origin: 'A3' });
  XLSX.utils.book_append_sheet(workbook, sheet, 'Input');
  const result = importRows(await readPayrollInputWorkbook(workbookFile(workbook)));
  assert.equal(result.errors[0].row, 4);
});

test('reviewed attendance template round-trips H:MM text without interpreting it as decimal hours', () => {
  const records = [{ employee_id: employees[0].id, attendance_source: 'reviewed', worked_minutes: 11985,
    actual_working_days: 23.5, public_holiday_days: 0, off_days: 0, tds: 400, notes: 'Approved HR working sheet' }];
  const workbook = buildPayrollInputTemplateWorkbook(XLSX, [employees[0]], records, '2026-09');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['Monthly inputs'], { header: 1 });
  const result = parsePayrollImportRows(rows, employees);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows[0].patch.worked_minutes, '199:45');
  assert.equal(result.rows[0].patch.attendance_source, 'reviewed');
  assert.equal(result.rows[0].patch.tds, '400');
  assert.equal(result.rows[0].patch.off_days, '0');
  const invalid = parsePayrollImportRows([['Employee ID', 'Reviewed worked time'], [employees[0].id, 199.45]], employees);
  assert.match(invalid.errors[0].message, /H:MM/);
});
