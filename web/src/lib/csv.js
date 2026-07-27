// Tiny client-side CSV download. Values are quoted per RFC 4180 and a BOM is prepended so Excel
// opens UTF-8 (₹, names in Malayalam/Hindi) correctly.
//
// Formula injection: spreadsheet apps execute a cell that starts with = + - @ (or a leading tab /
// carriage return), so untrusted text must be neutralised before export. These files carry text
// an ordinary employee can write — an expense description, for instance — and are opened by HR
// and admins, so a raw `=cmd|...` or `=WEBSERVICE(...)` cell would run on the reader's machine.
// Prefixing with an apostrophe makes the cell literal text in Excel, LibreOffice and Sheets.
const RISKY_LEAD = /^[=+\-@\t\r]/;

function escapeCsv(value) {
  const s = value == null ? '' : String(value);
  const safe = RISKY_LEAD.test(s) ? `'${s}` : s;
  // Always quote a neutralised value so the apostrophe cannot be split off by a delimiter.
  return /[",\n\r\t]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function downloadCsv(filename, headers, rows) {
  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map((r) => r.map(escapeCsv).join(',')),
  ];
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
