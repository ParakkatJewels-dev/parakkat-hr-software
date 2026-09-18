// Device evidence is separate from the corrected/reconstructed times used to calculate pay.
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function recordedPunches(row) {
  const source = Array.isArray(row?.punches) && row.punches.length
    ? row.punches
    : [row?.first_punch_at, row?.last_punch_at];
  return [...new Map(source.filter(validTime).map(time => [Date.parse(time), time])).entries()]
    .sort(([a], [b]) => a - b)
    .map(([, time]) => time);
}

export const firstRecordedPunch = row => recordedPunches(row)[0] ?? null;
export const latestRecordedPunch = row => recordedPunches(row).at(-1) ?? null;

export function punchDate(iso) {
  return validTime(iso) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : '';
}
