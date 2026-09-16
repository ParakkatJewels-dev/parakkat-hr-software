/**
 * The timeline used by the attendance engine, including approved endpoint corrections. Device
 * evidence stays in row.punches; displaying that alone would hide corrected hours and breaks.
 * Keep the odd/even endpoint rules aligned with reconcilePunches in the attendance service.
 */
export function attendanceTimeline(row, fallback = []) {
  const raw = Array.isArray(row?.punches) ? row.punches : fallback;
  if (!row?.regularization_id) return raw;
  const start = row.check_in;
  const end = row.check_out;
  const before = (a, b) => new Date(a).getTime() < new Date(b).getTime();
  let timeline = [...raw];
  if (raw.length < 2) {
    const interior = raw.length && start && end && before(start, raw[0]) && before(raw[0], end) ? raw : [];
    return [start, ...interior, end].filter(Boolean);
  }
  if (start) {
    if (raw.length % 2 && before(start, raw[0])) timeline.unshift(start);
    else timeline[0] = start;
  }
  if (end) {
    if (raw.length % 2 && before(raw[raw.length - 1], end)) timeline.push(end);
    else timeline[timeline.length - 1] = end;
  }
  return timeline.filter((p, index) => index === 0 || index === timeline.length - 1
    || (before(timeline[0], p) && before(p, timeline[timeline.length - 1])));
}
