// Plain-text documents for the Work Ledger: campaign briefs, the monthly group review, the guided
// weekly review and the monthly management document. Pure functions, same *bold* / • conventions
// as buildShareText. Missing fields print exactly "To be defined".
import { longDate, parseDay, periodLabel } from './periods.js';
import { istToday } from '../dates.js';

export const TBD = 'To be defined';
export const DEFAULT_BRAND_ORDER = ['Parakkat Jewels', 'Parakkat Munnar Resort', 'Parakkat Riverscape', 'Parakkat Adimali Retreat', 'General'];
const PIPELINE = ['Captured', 'Developing', 'Decision', 'Approved', 'Production', 'Live', 'Reviewed'];
const OFF_PIPELINE = ['Parked', 'Cancelled'];
const LAUNCH_WINDOW_DAYS = 45;

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());
const orTbd = (value) => text(value) || TBD;
const isActive = (campaign) => !OFF_PIPELINE.includes(campaign?.stage);
const brandPart = (item) => (item.brand_label ? ` (${item.brand_label})` : '');
const money = (value) => `₹${Math.round(Number(value) || 0)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const joinParts = (parts, sep) => parts.map(text).filter(Boolean).join(sep);

/** 45m, 1h, 1h 5m, 0m */
export function formatMinutes(total) {
  const minutes = Math.max(0, Math.round(Number(total) || 0));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const block = (heading, lines) => [`*${heading}*`, ...lines].join('\n');
const asList = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean).join(', ') : text(value));

function headerLines(title, campaign) {
  const brand = text(campaign.brand_label) || text(campaign.brand) || 'General';
  return [`*${title} — ${text(campaign.name) || 'Untitled campaign'}*`, joinParts([brand, campaign.stage], ' · ')].join('\n');
}

function moneyOrText(value) {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? (n ? money(n) : '') : text(value);
}

function deliverableLines(campaign) {
  const lines = [];
  for (const task of campaign.tasks ?? []) {
    for (const d of task.deliverables ?? []) {
      let line = joinParts([d.type, d.version], ' ');
      if (text(d.used_where)) line = line ? `${line} — ${text(d.used_where)}` : text(d.used_where);
      if (text(task.title)) line = line ? `${line} (${text(task.title)})` : text(task.title);
      if (line) lines.push(`• ${line}`);
    }
  }
  return lines.length ? lines : [orTbd(campaign.brief?.deliverables)];
}

/** kind 'brief' (decision brief, default) or 'team'. */
export function campaignBrief(campaign, kind = 'brief') {
  const c = campaign ?? {}, brief = c.brief ?? {}, measure = c.measure ?? {};
  if (kind === 'team') {
    const refs = [];
    if (text(brief.refs)) refs.push(text(brief.refs));
    for (const idea of c.ideas ?? []) {
      const links = asList(idea.links);
      if (text(idea.text) && links) refs.push(`• ${text(idea.text)} — ${links}`);
    }
    const responsibilities = (c.tasks ?? []).filter((t) => text(t.title)).map((t) => {
      const due = t.deadline ? `, due ${longDate(t.deadline)}` : '';
      return text(t.vendor) ? `• ${text(t.vendor)}: ${text(t.title)}${due}` : `• ${text(t.title)}${due}`;
    });
    const milestones = [];
    if (text(c.milestone)) milestones.push(`• ${text(c.milestone)}${c.milestone_date ? ` — ${longDate(c.milestone_date)}` : ''}`);
    if (c.launch_date) milestones.push(`• Launch — ${longDate(c.launch_date)}`);
    return [
      headerLines('Team brief', c),
      block('Message', [orTbd(brief.message)]),
      block('Tone', [orTbd(brief.tone)]),
      block('Deliverables', deliverableLines(c)),
      block('References', refs.length ? refs : [TBD]),
      block('Creative boundaries', [orTbd(brief.boundaries)]),
      block('Responsibilities', responsibilities.length ? responsibilities : [TBD]),
      block('Milestones', milestones.length ? milestones : [TBD]),
      block('Approval process', [orTbd(brief.approval)]),
    ].join('\n\n');
  }
  const budgetResources = joinParts([moneyOrText(c.budget), brief.resources], ' · ');
  const timing = text(brief.timing) || (c.launch_date ? `Launch ${longDate(c.launch_date)}` : '');
  const outcome = [
    ...(text(brief.outcome) ? [text(brief.outcome)] : []),
    `Primary measure: ${orTbd(measure.primary)}`,
    `Target: ${orTbd(measure.target)}`,
    `Baseline: ${orTbd(measure.baseline)}`,
  ];
  return [
    headerLines('Campaign brief', c),
    block('Objective', [orTbd(c.objective)]),
    block('Audience insight', [orTbd(brief.insight || brief.audience)]),
    block('Central idea', [orTbd(brief.idea)]),
    block('Example execution', [orTbd(brief.example)]),
    block('Scope', [orTbd(brief.scope)]),
    block('Budget and resources', [orTbd(budgetResources)]),
    block('Timing', [orTbd(timing)]),
    block('Expected outcome', outcome),
    block('Decision required', [orTbd(c.decision)]),
  ].join('\n\n');
}

function daysBetween(from, to) {
  const a = parseDay(from), b = parseDay(to);
  return a && b ? Math.round((b - a) / 86400000) : null;
}

/** The monthly group review across all campaigns, one block per brand. */
export function groupReview(campaigns, { today, brandOrder = DEFAULT_BRAND_ORDER } = {}) {
  const day = today || istToday();
  const byBrand = new Map();
  for (const c of (campaigns ?? []).filter((x) => x && isActive(x))) {
    const key = text(c.brand) || 'General';
    if (!byBrand.has(key)) byBrand.set(key, []);
    byBrand.get(key).push(c);
  }
  const keys = [
    ...brandOrder.filter((b) => byBrand.has(b)),
    ...[...byBrand.keys()].filter((b) => !brandOrder.includes(b)).sort((a, b) => a.localeCompare(b)),
  ];
  const nameOf = (c) => text(c.name) || 'Untitled campaign';
  const blocks = [];
  for (const key of keys) {
    const list = byBrand.get(key);
    const heading = text(list.find((c) => text(c.brand_label))?.brand_label) || key;
    const subs = [];
    const add = (title, lines) => { if (lines.length) subs.push(`_${title}_`, ...lines); };
    add('Priorities', list.filter((c) => text(c.priority).toLowerCase() === 'high' && c.stage !== 'Reviewed')
      .map((c) => `• ${nameOf(c)} — ${orTbd(c.stage)}`));
    add('Proposed campaigns', list.filter((c) => ['Captured', 'Developing', 'Decision'].includes(c.stage))
      .map((c) => `• ${nameOf(c)} — ${c.stage}${c.stage === 'Decision' ? ' [needs decision]' : ''}`));
    add('Resource requirements', list.filter((c) => PIPELINE.indexOf(c.stage) < PIPELINE.indexOf('Live'))
      .map((c) => [c, joinParts([moneyOrText(c.budget), c.brief?.resources], ' · ')]).filter(([, r]) => r)
      .map(([c, r]) => `• ${nameOf(c)} — ${r}`));
    add('Upcoming launches', list.map((c) => [c, daysBetween(day, c.launch_date)])
      .filter(([, d]) => d !== null && d >= 0 && d <= LAUNCH_WINDOW_DAYS)
      .sort((a, b) => a[1] - b[1])
      .map(([c]) => `• ${nameOf(c)} — ${longDate(c.launch_date)}`));
    add('Previous campaign results', list.filter((c) => c.stage === 'Reviewed' || (c.stage === 'Live' && text(c.results?.actual)))
      .map((c) => `• ${nameOf(c)} — measure ${orTbd(c.measure?.primary)}, target ${orTbd(c.measure?.target)}, actual ${orTbd(c.results?.actual)}; next: ${orTbd(c.results?.next)}`));
    if (subs.length) blocks.push([`*${heading}*`, ...subs].join('\n'));
  }
  if (!blocks.length) blocks.push('No active campaigns.');
  return [`*Monthly group review*\n${longDate(day)}`, ...blocks].join('\n\n');
}

const freeTextBullets = (value) => text(value).split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => (/^[•-]/.test(l) ? l : `• ${l}`));

const blockedLine = (b) => `• ${b.title} (${joinParts([b.status, b.waiting_on ? `waiting on ${b.waiting_on}` : ''], ', ')})`;
const overdueLine = (o) => `• ${o.title}${brandPart(o)}${o.deadline ? ` — since ${longDate(o.deadline)}` : ''}`;
const deliveredLine = (d) => `• ${d.title}${brandPart(d)}${text(d.outcome) ? ` — ${text(d.outcome)}` : ''}`;

function supportTotals(report) {
  const entries = report.support ?? [];
  const people = report.support_by_person ?? [];
  const minutes = report.support_minutes ?? (entries.length ? entries.reduce((s, e) => s + (Number(e.minutes) || 0), 0)
    : people.reduce((s, p) => s + (Number(p.minutes) || 0), 0));
  const count = entries.length || people.reduce((s, p) => s + (Number(p.count) || 0), 0);
  return { count, minutes: Number(minutes) || 0, people };
}

/** Guided weekly review from a week report plus two free-text answers. */
export function weeklyReview(report, { slipped, nextWeek } = {}) {
  const r = report ?? {};
  const sections = [];
  const add = (heading, lines) => { if (lines.length) sections.push(block(heading, lines)); };
  add('What shipped', (r.delivered ?? []).map(deliveredLine));
  add('Worked on', (r.worked_on ?? []).map((w) => `• ${w.title}${brandPart(w)}${w.event ? ` → ${w.event}` : ''}`));
  add('Blocked', (r.blocked ?? []).map(blockedLine));
  add('Overdue', (r.overdue ?? []).map(overdueLine));
  const s = supportTotals(r);
  if (s.count || s.minutes) {
    add('Support', [`${plural(s.count, 'entry', 'entries')} · ${formatMinutes(s.minutes)}`,
      ...s.people.map((p) => `• ${p.person} — ${p.count ?? 0} (${formatMinutes(p.minutes)})`)]);
  }
  add('What slipped', freeTextBullets(slipped));
  add('Next week', freeTextBullets(nextWeek));
  return [`*Weekly review*\n${periodLabel(r)}`, ...sections].join('\n\n');
}

function dayCount(item) {
  const days = new Set((item.notes ?? []).map((n) => n.date).filter(Boolean));
  return Math.max(1, days.size);
}

/** The management document for a month: { title, sections: [{ heading, lines }], text }. */
export function monthlyDocument(report, { campaigns = [] } = {}) {
  const r = report ?? {};
  const title = `Parakkat Creative — ${periodLabel(r)}`;
  const s = supportTotals(r);
  const est = Number(r.cost?.est) || 0, actual = Number(r.cost?.actual) || 0;
  const sections = [{
    heading: 'Summary',
    lines: [[
      `${(r.delivered ?? []).length} delivered`,
      `${(r.worked_on ?? []).length} worked on`,
      `${plural(s.count, 'support entry', 'support entries')} (${formatMinutes(s.minutes)})`,
      `${(r.ideas_captured ?? []).length} ideas captured`,
      `spend est ${money(est)} / actual ${money(actual)}`,
    ].join(' · ')],
  }];
  const add = (heading, lines) => { if (lines.length) sections.push({ heading, lines }); };
  add('Campaigns', (campaigns ?? []).filter((c) => c && isActive(c))
    .map((c) => `• ${text(c.name) || 'Untitled campaign'} — ${joinParts([c.stage, c.launch_date ? `launch ${longDate(c.launch_date)}` : ''], ', ')}`));
  add('Wins & outcomes', (r.wins ?? []).map((w) => `• ${w.title}${text(w.outcome) ? ` — ${text(w.outcome)}` : ''}`));
  add('Support & reviews', s.people.map((p) => `• ${p.person} — ${plural(p.count ?? 0, 'review', 'reviews')}, ${formatMinutes(p.minutes)}`));
  add('Worked on', (r.worked_on ?? []).map((w) => `• ${w.title}${brandPart(w)} — ${plural(dayCount(w), 'day', 'days')}`));
  add('Delivered', (r.delivered ?? []).map(deliveredLine));
  add('Blocked', (r.blocked ?? []).map(blockedLine));
  add('Overdue', (r.overdue ?? []).map(overdueLine));
  const body = sections.map((sec) => block(sec.heading, sec.lines)).join('\n\n');
  return { title, sections, text: `*${title}*\n\n${body}` };
}

