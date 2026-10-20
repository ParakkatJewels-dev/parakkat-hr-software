// The report text people copy into WhatsApp / Slack (buildShareText in the original app).
// Sections appear only when they have content, in the original order, with *bold* headings.
import { PERIOD_TITLES, longDate, monthDay, periodLabel } from './periods.js';

const STILL_OPEN_LIMIT = 15;
const money = (value) => `₹${Math.round(Number(value) || 0)}`;
const brandPart = (item) => (item.brand_label ? ` (${item.brand_label})` : '');

function noteLines(notes, report) {
  return (notes ?? []).map((note) => {
    const dated = !report.single_day || note.date !== report.from;
    return `    ${dated && note.date ? `${monthDay(note.date)} — ` : ''}${note.note}`;
  });
}

function section(title, lines) {
  return lines.length ? [`*${title}*`, ...lines] : [];
}

export function buildShareText(report) {
  const header = [`*Parakkat Work — ${PERIOD_TITLES[report.period] ?? 'Period'} Report*`, ...(report.subject ? [report.subject] : []), periodLabel(report)];
  const blocks = [];

  const worked = (report.worked_on ?? []).flatMap((item) => [
    `• ${item.title}${brandPart(item)}${item.event ? ` → ${item.event}` : ''}${item.is_new ? ' [new]' : ''}`,
    ...noteLines(item.notes, report),
  ]);
  const support = (report.support ?? []).map((item) =>
    `• ${item.title}${item.for_whom ? ` — for ${item.for_whom}` : ''}${item.minutes ? ` (${item.minutes}m)` : ''}`);
  const delivered = (report.delivered ?? []).flatMap((item) => [
    `• ${item.title}${brandPart(item)}${item.outcome ? ` — ${item.outcome}` : ''}`,
    ...noteLines(item.notes, report),
  ]);

  if (!worked.length && !support.length && !delivered.length) blocks.push(['Nothing logged in this period yet.']);
  blocks.push(section('Worked on:', worked));
  blocks.push(section(`Support & reviews (${support.length}):`, support));
  blocks.push(section('Delivered:', delivered));

  if (report.single_day) {
    const untouched = (report.pending_now ?? []).filter((item) => item.untouched);
    const shown = untouched.slice(0, STILL_OPEN_LIMIT).map((item) => `• ${item.title}${brandPart(item)}`);
    if (untouched.length > STILL_OPEN_LIMIT) shown.push(`… +${untouched.length - STILL_OPEN_LIMIT} more`);
    blocks.push(section(`Still open, not touched today (${untouched.length}):`, shown));
  }

  blocks.push(section('Wins:', (report.wins ?? []).map((item) => `• ${item.title} — ${item.outcome}`)));
  blocks.push(section('By brand:', (report.by_brand ?? []).map((item) =>
    `• ${item.label ?? item.brand}: ${item.items} item${item.items === 1 ? '' : 's'} · ${item.done} done`)));
  blocks.push(section('By campaign:', (report.by_campaign ?? []).map((item) =>
    `• ${item.campaign}: ${item.done}/${item.total} done${Number(item.spend) > 0 ? ` · ${money(item.spend)}` : ''}`)));
  const est = Number(report.cost?.est) || 0, actual = Number(report.cost?.actual) || 0;
  if (est || actual) blocks.push([`*Spend:* est ${money(est)} · actual ${money(actual)}`]);
  blocks.push(section('Blocked / in review:', (report.blocked ?? []).map((item) =>
    `• ${item.title} (${item.status}${item.waiting_on ? `, waiting on ${item.waiting_on}` : ''})`)));
  blocks.push(section('Overdue:', (report.overdue ?? []).map((item) =>
    `⚠️ ${item.title}${brandPart(item)} — since ${longDate(item.deadline)}`)));
  if (report.full_data?.length) blocks.push(section('Full data:', report.full_data));

  return [header.join('\n'), ...blocks.filter((block) => block.length).map((block) => block.join('\n'))].join('\n\n');
}
