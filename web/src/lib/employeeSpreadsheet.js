import { read, utils } from 'xlsx';

export function readEmployeeSheet(buffer) {
  // CSV columns such as employee codes and phone numbers are identifiers. Automatic number
  // inference drops their leading zeroes before the import preview can validate them.
  const workbook = read(buffer, { cellDates: true, raw: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = sheet ? utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' }) : [];
  if (!rows.length) throw new Error('That sheet is empty.');
  return rows;
}
