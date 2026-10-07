import { MONTHLY_INPUT_FIELDS, PAYROLL_REGISTER_COLUMNS, monthlyInputDraft, normalizeMonthlyInput } from './payrollWorksheet.js';

const inputKeys = new Set([...MONTHLY_INPUT_FIELDS.map(field => field.key), 'notes']);
const blankDraft = monthlyInputDraft(null);
const MAX_IMPORT_ROWS = 10000;
const MAX_IMPORT_COLUMNS = 100;
const headerKey = value => String(value ?? '').replace(/^\uFEFF/, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const identityKey = value => String(value ?? '').trim().toLowerCase();
const isBlank = value => value == null || (typeof value === 'string' && value.trim() === '');

/** Excel clipboard TSV, including quoted tabs/newlines and escaped double quotes. */
export function parsePayrollPaste(text) {
  if (typeof text !== 'string') throw new Error('Paste plain spreadsheet text.');
  if (!text.length) return [];
  const source = text.replace(/\r\n?/g, '\n');
  const rows = []; let row = []; let field = ''; let quoted = false; let closed = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') { quoted = false; closed = true; }
      else field += character;
    } else if (character === '\t' || character === '\n') {
      row.push(field); field = ''; closed = false;
      if (character === '\n') { rows.push(row); row = []; }
    } else if (closed) throw new Error('Invalid quoted spreadsheet cell.');
    else if (character === '"' && field === '') quoted = true;
    else field += character;
  }
  if (quoted) throw new Error('The pasted spreadsheet has an unfinished quoted cell.');
  // A terminal line break ends the preceding row; it is not another employee.
  if (!source.endsWith('\n') || row.length || field || closed) { row.push(field); rows.push(row); }
  const width = Math.max(0, ...rows.map(values => values.length));
  return rows.map(values => [...values, ...Array(width - values.length).fill('')]);
}

function inputText(key, value) {
  if (!inputKeys.has(key)) throw new Error(`Column ${key} is not an editable payroll input.`);
  if (value !== null && value !== undefined && !['string', 'number'].includes(typeof value)) {
    throw new Error(`Invalid value for ${key}. Paste values, not formulas or spreadsheet objects.`);
  }
  if (key === 'notes') return String(value ?? '');
  let text = String(value ?? '').trim();
  if (!text) return '';
  // Ordinary blank imported cells preserve existing inputs. AUTO is an explicit instruction
  // to remove an OT/late override, so it must survive parsing as an empty-string patch.
  if ((key === 'ot_hours' || key === 'late_hours') && /^auto$/i.test(text)) return '';
  // Accept ordinary Indian/Western currency display formatting, without guessing locale
  // decimals, removing arbitrary punctuation, or evaluating Excel expressions.
  text = text.replace(/^(?:₹|INR\s*|Rs\.?\s*)\s*/i, '');
  if (!text) throw new Error(`Enter a number for ${key}, not only a currency symbol.`);
  if (text.includes(',')) {
    if (!/^(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{0,2})?$/.test(text)) {
      throw new Error(`Invalid number grouping for ${key}. Use 1,000.00 or 1,00,000.00.`);
    }
    text = text.replaceAll(',', '');
  }
  // The merged draft is validated by the editor, including approval-note requirements.
  // This isolated check validates number precision/ranges without inventing a saved reason.
  const normalized = normalizeMonthlyInput({ ...blankDraft, [key]: text, notes: 'Input number validation' });
  return normalized[key] == null ? '' : String(normalized[key]);
}

/** Returns patches only; the caller owns drafts, merged-row validation and persistence. */
export function applyPayrollPaste({ rows, columns, startRow, startColumn, values }) {
  if (!Array.isArray(rows) || !Array.isArray(columns) || !Array.isArray(values)
      || !Number.isInteger(startRow) || !Number.isInteger(startColumn) || startRow < 0 || startColumn < 0) {
    throw new Error('Choose a valid starting payroll cell.');
  }
  if (!values.length) return [];
  const width = values[0]?.length;
  if (!width || values.some(row => !Array.isArray(row) || row.length !== width)) throw new Error('Paste a rectangular range of cells.');
  if (startRow + values.length > rows.length || startColumn + width > columns.length) {
    throw new Error('The pasted range exceeds the available employee rows or editable columns.');
  }
  const seen = new Set();
  return values.map((cells, offset) => {
    const employeeId = rows[startRow + offset]?.id;
    if (!employeeId || seen.has(employeeId)) throw new Error('The target employee rows are missing or duplicated.');
    seen.add(employeeId);
    const patch = {};
    cells.forEach((value, column) => {
      const descriptor = columns[startColumn + column];
      const key = typeof descriptor === 'string' ? descriptor : descriptor?.key;
      patch[key] = inputText(key, value);
    });
    return { employeeId, patch };
  });
}

const aliases = new Map();
function alias(key, labels) { for (const label of [key, ...labels]) aliases.set(headerKey(label), key); }
alias('employee_id', ['Employee ID', 'Employee UUID']);
alias('employee_code', ['Employee Code', 'Emp Code', 'Emp. Code', 'Code']);
alias('employee_name', ['Employee Name', 'Full Name', 'Name']);
alias('branch', ['Branch', 'Branch Name', 'Branch Code']);
alias('notes', ['Notes', 'Input notes', 'Input notes / deduction reason', 'Deduction reason', 'Approval notes']);
for (const field of MONTHLY_INPUT_FIELDS) alias(field.key, [field.label]);
for (const field of PAYROLL_REGISTER_COLUMNS) {
  if (inputKeys.has(field.key)) alias(field.key, [field.label]);
}
alias('ot_hours', ['OT Hours', 'Overtime Hours', 'Approved OT Hours', 'Approved Overtime Hours']);
alias('late_hours', ['Late Hours', 'Approved Late Hours']);
alias('tea_expense', ['Tea Expence', 'Tea Expenses']);
alias('travel_food', ['Travel Allowance / Food Expence', 'Travel / Food', 'Travel Food']);
alias('special_allowance', ['Special Allowances']);
alias('advance_recovery', ['Salary Advance Refund', 'Advance Recovery']);
alias('other_deductions', ['Deduction for loss and damages/ other deductions', 'Other Deductions']);
const computedHeaders = new Set(PAYROLL_REGISTER_COLUMNS.filter(field => !inputKeys.has(field.key)
  && !['employee_name', 'branch'].includes(field.key)).flatMap(field => [headerKey(field.key), headerKey(field.label)]));
for (const label of ['Salary monthly', 'Salary earned', 'Monthly salary', 'Earned salary', 'Gross pay', 'Net pay']) computedHeaders.add(headerKey(label));

function resolveEmployee(source, employees) {
  const id = identityKey(source.employee_id); const code = identityKey(source.employee_code); const name = identityKey(source.employee_name);
  const key = id ? 'id' : code ? 'employee_code' : name ? 'full_name' : null;
  if (!key) throw new Error('Provide an Employee ID, Employee Code or exact Employee Name.');
  const expected = id || code || name;
  const matches = employees.filter(employee => identityKey(employee[key]) === expected);
  if (!matches.length) throw new Error(`No employee in the selected scope matches ${key === 'id' ? 'Employee ID' : key === 'employee_code' ? 'Employee Code' : 'Employee Name'} “${source[key === 'id' ? 'employee_id' : key === 'full_name' ? 'employee_name' : key]}”.`);
  if (matches.length !== 1) throw new Error(`Ambiguous ${key === 'full_name' ? 'employee name' : 'employee identifier'}; use a unique Employee ID.`);
  const employee = matches[0];
  if ((id && identityKey(employee.id) !== id) || (code && identityKey(employee.employee_code) !== code)
      || (name && identityKey(employee.full_name) !== name)) throw new Error('Employee ID, code and name do not identify the same employee.');
  return employee;
}

/** Blank import inputs mean “preserve”; explicit zero is an actual patch. Row numbers are Excel row numbers. */
export function parsePayrollImportRows(aoa, employees) {
  const result = { rows: [], errors: [], warnings: [] };
  const fail = (row, message) => result.errors.push({ row, message });
  if (!Array.isArray(aoa) || !Array.isArray(employees)) { fail(1, 'Choose a valid payroll input workbook and employee scope.'); return result; }
  if (aoa.length > MAX_IMPORT_ROWS + 1) { fail(1, `Import at most ${MAX_IMPORT_ROWS} employees at a time.`); return result; }
  const headerIndex = aoa.findIndex(row => Array.isArray(row) && row.some(value => !isBlank(value)));
  if (headerIndex < 0) { fail(1, 'The workbook is empty.'); return result; }
  const headers = aoa[headerIndex];
  if (headers.some(header => String(header).trim().toLowerCase() === 'bonus')
    && headers.some(header => String(header).trim().toLowerCase() === 'gross salary')) {
    fail(headerIndex + 1, 'This calculated register includes itemized adjustments. Use the monthly input template to avoid importing those totals twice. Manage bonuses in Adjustments & advances.');
    return result;
  }
  if (headers.length > MAX_IMPORT_COLUMNS) { fail(headerIndex + 1, `Use at most ${MAX_IMPORT_COLUMNS} import columns.`); return result; }
  const mapped = []; const seenHeaders = new Set(); const ignoredComputed = new Set();
  headers.forEach((value, column) => {
    const normalized = headerKey(value);
    if (!normalized) { mapped.push(null); return; }
    const key = aliases.get(normalized);
    if (computedHeaders.has(normalized) && !key) {
      ignoredComputed.add(column); mapped.push(null);
      result.warnings.push({ row: headerIndex + 1, column: column + 1, message: `Ignored calculated column “${value}”; payroll recalculates this amount.` });
      return;
    }
    const duplicateKey = key || normalized;
    if (seenHeaders.has(duplicateKey)) fail(headerIndex + 1, `Duplicate column “${value}”. Keep one column for each input.`);
    seenHeaders.add(duplicateKey);
    if (!key) result.warnings.push({ row: headerIndex + 1, column: column + 1, message: `Ignored unknown column “${value}”.` });
    mapped.push(key || null);
  });
  if (!mapped.some(key => ['employee_id', 'employee_code', 'employee_name'].includes(key))) fail(headerIndex + 1, 'Include Employee ID, Employee Code or Employee Name.');
  if (!mapped.some(key => inputKeys.has(key))) fail(headerIndex + 1, 'Include at least one editable monthly input column.');
  if (result.errors.length) return result;
  const seenEmployees = new Map(); const duplicateEmployees = new Set();
  for (let index = headerIndex + 1; index < aoa.length; index += 1) {
    const cells = aoa[index]; const rowNumber = index + 1;
    if (!Array.isArray(cells)) { fail(rowNumber, 'Invalid spreadsheet row.'); continue; }
    if (!cells.some(value => !isBlank(value))) continue;
    try {
      if (cells.slice(headers.length).some(value => !isBlank(value))) throw new Error('This row has values beyond the header columns.');
      const source = {}; const rawPatch = {}; const patch = {};
      mapped.forEach((key, column) => {
        if (ignoredComputed.has(column)) return;
        const value = cells[column];
        if (value && typeof value === 'object') throw new Error('Import plain cell values, not formulas or spreadsheet objects.');
        if (!key || isBlank(value)) return;
        if (inputKeys.has(key)) rawPatch[key] = value;
        else source[key] = value;
      });
      const employee = resolveEmployee(source, employees);
      if (seenEmployees.has(employee.id)) {
        if (!duplicateEmployees.has(employee.id)) fail(seenEmployees.get(employee.id), 'Duplicate employee row; keep only one row per employee.');
        duplicateEmployees.add(employee.id);
        throw new Error('Duplicate employee row; keep only one row per employee.');
      }
      seenEmployees.set(employee.id, rowNumber);
      for (const [key, value] of Object.entries(rawPatch)) patch[key] = inputText(key, value);
      if (!Object.keys(patch).length) { result.warnings.push({ row: rowNumber, message: 'No nonblank input values; this employee was left unchanged.' }); continue; }
      result.rows.push({ employeeId: employee.id, employeeName: employee.full_name, patch });
    } catch (error) { fail(rowNumber, error.message); }
  }
  result.rows = result.rows.filter(row => !duplicateEmployees.has(row.employeeId));
  return result;
}

/** Reads only the first worksheet; formulas are allowed only in ignored calculated columns. Nothing is evaluated. */
export async function readPayrollInputWorkbook(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose an Excel payroll input file.');
  if (file.size > 10 * 1024 * 1024) throw new Error('The payroll input file must be no larger than 10 MB.');
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: true, cellText: false, cellDates: false });
  if (!workbook.SheetNames.length) throw new Error('The workbook has no worksheets.');
  const name = workbook.SheetNames[0];
  const sheet = workbook.Sheets[name];
  if (sheet['!ref']) {
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (range.e.r >= MAX_IMPORT_ROWS + 1 || range.e.c >= MAX_IMPORT_COLUMNS) throw new Error(`Use at most ${MAX_IMPORT_ROWS} employee rows and ${MAX_IMPORT_COLUMNS} columns.`);
  }
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true, range: 0 });
  const headerIndex = aoa.findIndex(row => row.some(value => !isBlank(value)));
  const ignoredColumns = new Set((aoa[headerIndex] ?? []).flatMap((value, column) => {
    const normalized = headerKey(value);
    return computedHeaders.has(normalized) && !aliases.has(normalized) ? [column] : [];
  }));
  for (const [address, cell] of Object.entries(sheet)) {
    if (address.startsWith('!') || (cell.f == null && cell.F == null)) continue;
    const position = XLSX.utils.decode_cell(address);
    const range = cell.F ? XLSX.utils.decode_range(cell.F) : { s: position, e: position };
    let ignored = headerIndex >= 0 && position.r > headerIndex && ignoredColumns.has(position.c) && range.s.r > headerIndex;
    // An array formula spilling into an editable or unidentified column is not safe to import.
    if (range.e.c >= MAX_IMPORT_COLUMNS) ignored = false;
    else for (let column = range.s.c; column <= range.e.c; column += 1) ignored = ignored && ignoredColumns.has(column);
    if (!ignored) throw new Error(`Formula found in ${name}!${address}. Paste values into employee and monthly input columns before importing.`);
    if (aoa[position.r]) aoa[position.r][position.c] = '';
  }
  return aoa;
}

function employeeRecord(records, id) {
  if (records instanceof Map) return records.get(id);
  if (Array.isArray(records)) return records.find(record => (record.employee_id ?? record.employeeId ?? record.id) === id);
  return records?.[id];
}

export function buildPayrollInputTemplateWorkbook(XLSX, employees, records = [], period = '') {
  const headers = ['Employee ID', 'Employee Code', 'Employee Name', 'Branch', ...MONTHLY_INPUT_FIELDS.map(field => field.label), 'Notes'];
  const rows = employees.map(employee => {
    const record = employeeRecord(records, employee.id);
    const draft = monthlyInputDraft(record?.draft ?? record);
    return [String(employee.id ?? ''), String(employee.employee_code ?? ''), String(employee.full_name ?? ''),
      String(employee.branch?.name ?? employee.branch?.code ?? employee.branch_name ?? ''),
      ...MONTHLY_INPUT_FIELDS.map(field => {
        const value = inputText(field.key, draft[field.key]);
        return value === '' ? (field.auto ? 'AUTO' : '') : Number(value);
      }), String(draft.notes ?? '')];
  });
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  for (let row = 0; row <= rows.length; row += 1) {
    for (let column = 0; column < headers.length; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
      if (!cell) continue;
      if (row === 0 || column < 4 || column === headers.length - 1 || typeof cell.v === 'string') { cell.t = 's'; delete cell.f; }
      else cell.z = '#,##0.00';
    }
  }
  sheet['!cols'] = headers.map((_, index) => ({ wch: index === 0 ? 38 : index === 2 || index === headers.length - 1 ? 30 : 20 }));
  sheet['!autofilter'] = { ref: sheet['!ref'] };
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: `Payroll monthly inputs ${period}` };
  XLSX.utils.book_append_sheet(workbook, sheet, 'Monthly inputs');
  return workbook;
}

export async function exportPayrollInputTemplate(employees, records, period) {
  const XLSX = await import('xlsx');
  const workbook = buildPayrollInputTemplateWorkbook(XLSX, employees, records, period);
  const safePeriod = String(period ?? '').replace(/[^a-zA-Z0-9_-]+/g, '-');
  XLSX.writeFile(workbook, `Payroll-inputs-${safePeriod || 'template'}.xlsx`);
}
