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

export function totalGrossFromParts(basic, otherGross = '') {
  const basicAmount = parseMoneyDraft(basic);
  if (basicAmount == null) return '';
  return formatMoneyDraft(basicAmount + (parseMoneyDraft(otherGross) ?? 0));
}

export function otherGrossFromTotal(basic, gross) {
  const basicAmount = parseMoneyDraft(basic);
  const grossAmount = parseMoneyDraft(gross);
  if (basicAmount == null || grossAmount == null) return '';
  return formatMoneyDraft(grossAmount - basicAmount);
}
