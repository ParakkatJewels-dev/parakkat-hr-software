export function parseMoneyDraft(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

export function formatMoneyDraft(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return String(rounded);
}

export function blankGrossComponent() {
  return { name: '', amount: '' };
}

function grossComponentAmountTotal(grossComponents = '') {
  if (Array.isArray(grossComponents)) {
    let total = 0;
    for (const row of grossComponents) {
      const text = String(row?.amount ?? '').trim();
      if (!text) continue;
      const amount = parseMoneyDraft(text);
      if (amount == null) return null;
      total += amount;
    }
    return total;
  }
  return parseMoneyDraft(grossComponents) ?? 0;
}

export function totalGrossComponentsDraft(grossComponents = []) {
  const total = grossComponentAmountTotal(grossComponents);
  return total == null ? '' : formatMoneyDraft(total);
}

export function totalGrossFromParts(basic, grossComponents = '') {
  const basicAmount = parseMoneyDraft(basic);
  if (basicAmount == null) return '';
  const componentsTotal = grossComponentAmountTotal(grossComponents);
  if (componentsTotal == null) return '';
  return formatMoneyDraft(basicAmount + componentsTotal);
}

export function otherGrossFromTotal(basic, gross) {
  const basicAmount = parseMoneyDraft(basic);
  const grossAmount = parseMoneyDraft(gross);
  if (basicAmount == null || grossAmount == null) return '';
  return formatMoneyDraft(grossAmount - basicAmount);
}

export function hasGrossComponentDrafts(grossComponents = []) {
  return Array.isArray(grossComponents)
    && grossComponents.some((row) => String(row?.name ?? '').trim() || String(row?.amount ?? '').trim());
}

export function normalizeGrossComponentsDraft(grossComponents = []) {
  const rows = Array.isArray(grossComponents) ? grossComponents : [];
  const components = [];
  let total = 0;

  for (const row of rows) {
    const name = String(row?.name ?? '').trim();
    const amountText = String(row?.amount ?? '').trim();
    if (!name && !amountText) continue;
    if (!name) return { error: 'Enter a gross name for every gross amount.' };
    if (!amountText) return { error: `Enter the amount for ${name}.` };
    const amount = parseMoneyDraft(amountText);
    if (amount == null) return { error: `${name} amount has to be a valid amount.` };
    if (amount < 0) return { error: 'Gross component amounts cannot be negative.' };
    components.push({ name, amount });
    total += amount;
  }

  return { components, total };
}

function parseSalaryNotes(notes) {
  const text = String(notes ?? '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* Existing free-text notes are preserved below. */
  }
  return { note: text };
}

export function salaryNotesFromGrossComponents(grossComponents = [], existingNotes = null) {
  const notes = parseSalaryNotes(existingNotes);
  const { components, error } = normalizeGrossComponentsDraft(grossComponents);
  if (error) return existingNotes ?? null;

  if (components.length) {
    notes.gross_components = components;
  } else {
    delete notes.gross_components;
  }

  return Object.keys(notes).length ? JSON.stringify(notes) : null;
}

export function grossComponentsFromNotes(notes, basic, gross) {
  const parsed = parseSalaryNotes(notes);
  const rows = Array.isArray(parsed.gross_components)
    ? parsed.gross_components
        .map((row) => {
          const name = String(row?.name ?? '').trim();
          const amount = parseMoneyDraft(row?.amount);
          if (!name || amount == null) return null;
          return { name, amount: formatMoneyDraft(amount) };
        })
        .filter(Boolean)
    : [];

  if (rows.length) return rows;

  const otherGross = otherGrossFromTotal(basic, gross);
  return parseMoneyDraft(otherGross) > 0
    ? [{ name: 'Other gross', amount: otherGross }]
    : [blankGrossComponent()];
}
