// The switch-over check: paste the old app's report text and see where the new one differs.
// A line diff (longest common subsequence), ignoring trailing spaces and blank-line differences.

const clean = (textValue) => String(textValue ?? '').replace(/\r\n?/g, '\n').trim().split('\n').map((line) => line.replace(/\s+$/, ''))
  .filter((line, index, lines) => line !== '' || lines[index - 1] !== '');

/** → [{ type: 'same' | 'old' | 'new', line }] */
export function diffReports(oldText, newText) {
  const a = clean(oldText), b = clean(newText);
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ type: 'same', line: a[i] }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: 'old', line: a[i++] });
    else out.push({ type: 'new', line: b[j++] });
  }
  while (i < a.length) out.push({ type: 'old', line: a[i++] });
  while (j < b.length) out.push({ type: 'new', line: b[j++] });
  return out;
}

export const reportsMatch = (oldText, newText) => diffReports(oldText, newText).every((entry) => entry.type === 'same');
