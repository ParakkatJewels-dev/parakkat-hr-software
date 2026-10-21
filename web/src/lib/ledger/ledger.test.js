import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { periodLabel, periodArgument, weekStart, longDate } from './periods.js';
import { buildShareText } from './shareText.js';
import { LEDGER_TABS, parseLedgerSheets, sheetsFromWorkbook, normaliseStatus, toDay, toDateTime, attachmentsFromNotes, tabKind, importBatches, IMPORT_ORDER } from './importWorkbook.js';
import { shareText, copyText } from './share.js';

test('period labels match the original report headings', () => {
  assert.equal(periodLabel({ period: 'day', from: '2026-10-07', to: '2026-10-07' }), '7 October 2026');
  assert.equal(periodLabel({ period: 'week', from: '2026-10-05', to: '2026-10-11' }), '5 Oct – 11 Oct 2026');
  assert.equal(periodLabel({ period: 'week', from: '2025-12-29', to: '2026-01-04' }), '29 Dec 2025 – 4 Jan 2026');
  assert.equal(periodLabel({ period: 'month', from: '2026-10-01', to: '2026-10-31' }), 'October 2026');
  assert.equal(periodLabel({ period: 'all', from: '2000-01-01', to: '2026-10-20' }), 'Everything up to 20 October 2026');
  assert.equal(periodLabel({ period: 'range', from: '2026-10-01', to: '2026-10-15' }), '1 Oct – 15 Oct 2026');
  assert.equal(weekStart('2026-10-11'), '2026-10-05', 'Sunday belongs to the week that started Monday');
  assert.equal(weekStart('2026-10-05'), '2026-10-05');
  assert.equal(periodArgument('range', { from: '2026-10-01', to: '2026-10-15' }), '2026-10-01|2026-10-15');
  assert.equal(periodArgument('month', { month: '2026-10' }), '2026-10');
  assert.equal(periodArgument('all'), null);
  assert.equal(longDate('2026-02-30'), '', 'impossible dates are not shown');
});

const dayReport = {
  period: 'day', from: '2026-10-07', to: '2026-10-07', today: '2026-10-07', single_day: true,
  worked_on: [
    { title: 'Diwali hoarding v2', brand_label: 'Jewels', event: 'Sent for internal review', is_new: true, notes: [{ date: '2026-10-07', note: 'note logged that day' }] },
    { title: 'Resort mornings reel', brand_label: 'Munnar', event: null, is_new: false, notes: [] },
  ],
  support: [{ title: 'Reviewed menu layout', for_whom: 'Priya', minutes: 20 }, { title: 'Unblocked the printer', for_whom: null, minutes: null }],
  delivered: [{ title: 'Resort reel edit', brand_label: 'Munnar', outcome: 'outcome text', notes: [{ date: '2026-10-05', note: 'rough cut' }, { date: '2026-10-07', note: 'final grade' }] }],
  pending_now: [
    { title: 'Diwali hoarding v2', brand_label: 'Jewels', untouched: false },
    { title: 'Brochure reprint', brand_label: 'Adimali', untouched: true },
  ],
  wins: [{ title: 'Resort reel edit', outcome: 'outcome text' }],
  by_brand: [{ brand: 'Parakkat Jewels', label: 'Jewels', items: 5, done: 2 }, { brand: 'General', label: 'General', items: 1, done: 0 }],
  by_campaign: [{ campaign: 'Diwali 2026', done: 3, total: 7, spend: 12000.0 }, { campaign: 'Monsoon', done: 0, total: 1, spend: 0 }],
  cost: { est: 20000, actual: 12000.5 },
  blocked: [{ title: 'Showroom signage', status: 'Awaiting Approval', waiting_on: 'MD' }, { title: 'Logo refresh', status: 'Internal Review', waiting_on: null }],
  overdue: [{ title: 'Brochure reprint', brand_label: 'Adimali', deadline: '2026-10-03' }],
};

test('the daily share text keeps the original format, order and wording', () => {
  assert.equal(buildShareText(dayReport), [
    '*Parakkat Work — Daily Report*',
    '7 October 2026',
    '',
    '*Worked on:*',
    '• Diwali hoarding v2 (Jewels) → Sent for internal review [new]',
    '    note logged that day',
    '• Resort mornings reel (Munnar)',
    '',
    '*Support & reviews (2):*',
    '• Reviewed menu layout — for Priya (20m)',
    '• Unblocked the printer',
    '',
    '*Delivered:*',
    '• Resort reel edit (Munnar) — outcome text',
    '    10-05 — rough cut',
    '    final grade',
    '',
    '*Still open, not touched today (1):*',
    '• Brochure reprint (Adimali)',
    '',
    '*Wins:*',
    '• Resort reel edit — outcome text',
    '',
    '*By brand:*',
    '• Jewels: 5 items · 2 done',
    '• General: 1 item · 0 done',
    '',
    '*By campaign:*',
    '• Diwali 2026: 3/7 done · ₹12000',
    '• Monsoon: 0/1 done',
    '',
    '*Spend:* est ₹20000 · actual ₹12001',
    '',
    '*Blocked / in review:*',
    '• Showroom signage (Awaiting Approval, waiting on MD)',
    '• Logo refresh (Internal Review)',
    '',
    '*Overdue:*',
    '⚠️ Brochure reprint (Adimali) — since 3 October 2026',
  ].join('\n'));
});

test('multi-day reports date every note and never list the backlog; empty periods say so', () => {
  const week = buildShareText({ ...dayReport, period: 'week', from: '2026-10-05', to: '2026-10-11', single_day: false, pending_now: [] });
  assert.match(week, /^\*Parakkat Work — Weekly Report\*\n5 Oct – 11 Oct 2026/);
  assert.match(week, /    10-07 — note logged that day/);
  assert.doesNotMatch(week, /Still open/);
  const empty = buildShareText({ period: 'month', from: '2026-11-01', to: '2026-11-30', single_day: false });
  assert.equal(empty, '*Parakkat Work — Monthly Report*\nNovember 2026\n\nNothing logged in this period yet.');
  const many = buildShareText({ ...dayReport, pending_now: Array.from({ length: 18 }, (_, i) => ({ title: `Open ${i}`, untouched: true })) });
  assert.match(many, /\*Still open, not touched today \(18\):\*/);
  assert.match(many, /• Open 14\n… \+3 more/);
  assert.doesNotMatch(many, /Open 15/);
});

test('status normalisation reads legacy values the way the original app did', () => {
  assert.deepEqual(normaliseStatus('Done'), { status: 'Delivered', legacy: true });
  assert.deepEqual(normaliseStatus('completed'), { status: 'Delivered', legacy: true });
  assert.deepEqual(normaliseStatus('Pending'), { status: 'Brief', legacy: true });
  assert.deepEqual(normaliseStatus('awaiting approval'), { status: 'Awaiting Approval', legacy: false });
  assert.deepEqual(normaliseStatus(''), { status: 'Brief', legacy: false });
  assert.equal(normaliseStatus('Someday').unknown, 'Someday');
});

test('dates from sheet serials, ISO text and day/month text', () => {
  assert.equal(toDay(46302), '2026-10-07', 'sheet serial');
  assert.equal(toDateTime(46302.5625), '2026-10-07T13:30', 'serial with time');
  assert.equal(toDay('2026-10-07'), '2026-10-07');
  assert.equal(toDateTime('2026-10-07T09:05'), '2026-10-07T09:05');
  assert.equal(toDay('07/10/2026'), '2026-10-07', 'day first by default');
  assert.equal(toDay('10/07/2026', 'MDY'), '2026-10-07', 'month first when asked');
  assert.equal(toDateTime('7/10/2026 4:30 pm'), '2026-10-07T16:30');
  assert.equal(toDay('31/02/2026'), null, 'impossible date rejected');
  assert.equal(toDay('soon'), null);
});

function workbook() {
  const book = XLSX.utils.book_new();
  const add = (name, rows) => XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  add('WorkLog', [
    ['Logged At', 'Work Date', 'Brand', 'Task', 'Status', 'Priority', 'Deadline', 'Start Date', 'End Date', 'Delegated To',
      'Deadline Communicated', 'Delegated By', 'Notes / Links', 'Last Updated', 'Repeat', 'Pinned', 'Type', 'Campaign', 'Tags',
      'Revision', 'Status Since', 'Waiting On', 'Focus Date', 'Outcome', 'Est Cost', 'Actual Cost', 'Vendor', 'Brief', 'For',
      'Minutes', 'Entry Kind', 'Depends On', 'Approved Version'],
    ['2026-10-01T09:00', '2026-10-01', 'Parakkat Jewels', 'Diwali hoarding v2', 'Internal Review', 'high', '', '', '', '', '', '',
      '[1 Oct] Draft\n📎 proof.pdf — https://drive.example/proof', '2026-10-07', 'Mon–Fri', 'TRUE', 'Print', 'Diwali 2026',
      'print, outdoor', 2, '2026-10-07', '', '', '', '₹12,000', 11500, 'Lumen', '{"objective":"Footfall"}', '', '', '', 4],
    ['2026-09-01T10:00', '2026-09-01', 'General', 'Old thing', 'Done'],
    ['', '', 'General', '', 'Brief'],
    ['2026-09-02T10:00', '2026-09-02', 'General', 'Approval chaser', 'Pending', '', '', '', '', '', '', '', '', '', 'monthly', '', '', 'Monsoon', '', '', '', '', '', '', '', '', '', 'Not JSON at all'],
    ['2026-10-07T12:00', '2026-10-07', 'Parakkat Riverscape', 'Reviewed menu layout', 'Delivered', '', '', '', '', '', '', '', '', '2026-10-07',
      '', '', 'Review / Feedback', '', '', '', '', '', '', '', '', '', '', '', 'Priya', 20, 'support'],
  ]);
  add('Subtasks', [['Parent Row', 'Text', 'Done', 'Created At'], [2, 'Copy', 'TRUE', '2026-10-01T09:30'], [99, 'Orphan', '', '']]);
  add('Progress', [['Task Row', 'Date', 'Note', 'Minutes'], [2, '2026-10-07', 'Sent to MD', 15]]);
  add('Campaigns', [['Name', 'Brand', 'Launch Date', 'Brief Link', 'Notes', 'Created At', 'Stage', 'Status', 'Priority', 'Objective',
    'Next Action', 'Milestone', 'Milestone Date', 'Blocker', 'Decision', 'Budget', 'Brief JSON', 'Measure JSON', 'Results JSON', 'Log JSON', 'Idea Rows'],
    ['Diwali 2026', 'Parakkat Jewels', '2026-10-25', '', '', '2026-09-01T10:00', '', 'Done', 'High', '', '', '', '', '', '', '', '{bad', '', '', '[{"at":"2026-09-01T10:00","text":"Captured"}]', '2'],
    ['Old plan', '', '', '', '', '', '', 'Planning']]);
  add('Ideas', [['Text', 'Original', 'Brand', 'Tags', 'Links', 'Status', 'Created At', 'Revisit Date', 'Revisit When', 'Concept JSON', 'Task Row', 'Campaign Row'],
    ['Reel on mornings', 'reel', '', '#reel', '', 'Promoted', '2026-10-07T08:00', '', '', '', 2, 2]]);
  add('Notes to self', [['Anything'], ['ignored']]);
  return book;
}

test('the importer maps tabs by header name, keeps true row numbers and normalises legacy data', () => {
  const parsed = parseLedgerSheets(sheetsFromWorkbook(XLSX, workbook()));
  const tasks = parsed.kinds.tasks;
  assert.deepEqual(tasks.map((t) => t.legacy_row), [2, 3, 5, 6], 'row 4 (blank task) skipped, numbering kept');
  assert.equal(parsed.stats.tasks.skipped, 1);
  const [hoarding, old, chaser, support] = tasks;
  assert.equal(hoarding.priority, 'High');
  assert.equal(hoarding.repeat, 'weekdays');
  assert.equal(hoarding.pinned, true);
  assert.deepEqual(hoarding.tags, ['print', 'outdoor']);
  assert.equal(hoarding.est_cost, 12000);
  assert.deepEqual(hoarding.brief, { objective: 'Footfall' });
  assert.deepEqual(hoarding.attachments, [{ name: 'proof.pdf', url: 'https://drive.example/proof' }]);
  assert.equal(old.status, 'Delivered');
  assert.equal(chaser.status, 'Brief');
  assert.deepEqual(chaser.brief, { objective: 'Not JSON at all' }, 'unparsable brief becomes a plain objective');
  assert.equal(support.entry_kind, 'support');
  assert.equal(support.for_whom, 'Priya');
  assert.equal(parsed.legacy_statuses, 2);
  assert.deepEqual(parsed.kinds.links.find((l) => l.kind === 'task_depends'), undefined, 'dependency on a missing row is dropped');
  assert.ok(parsed.warnings.some((w) => /depends on row 4/.test(w)));
  assert.ok(parsed.problems.some((p) => /subtasks row 3 points to task row 99/.test(p)));
  assert.ok(parsed.warnings.some((w) => /Notes to self/.test(w)), 'unknown tabs are reported, not imported');
});

test('campaign stages fall back from legacy status; links resolve ideas both ways', () => {
  const parsed = parseLedgerSheets(sheetsFromWorkbook(XLSX, workbook()));
  const [diwali, old] = parsed.kinds.campaigns;
  assert.equal(diwali.stage, 'Reviewed', 'Done → Reviewed');
  assert.equal(old.stage, 'Captured', 'Planning → Captured');
  assert.deepEqual(diwali.brief, { insight: '{bad' });
  assert.deepEqual(diwali.log, [{ at: '2026-09-01T10:00', text: 'Captured' }]);
  assert.deepEqual(parsed.kinds.links.filter((l) => l.kind !== 'task_depends'), [
    { kind: 'idea_refs', legacy_row: 2, task_row: 2, campaign_row: 2 },
    { kind: 'campaign_ideas', legacy_row: 2, idea_rows: [2] },
  ]);
  assert.equal(parsed.campaigns_created_from_tasks, 1, '"Monsoon" exists only as a task campaign');
  assert.ok(!('idea_rows' in diwali) && !('task_row' in parsed.kinds.ideas[0]), 'reference columns move to the links pass');
});

test('tab names, attachment lines and batching', () => {
  assert.equal(tabKind('WorkLog'), 'tasks');
  assert.equal(tabKind('Brand Foundations.csv'), 'brands');
  assert.equal(tabKind('Key Dates'), 'key_dates');
  assert.equal(tabKind('Payroll'), null);
  assert.equal(tabKind('Subtasks'), 'subtasks', 'not mistaken for the task tab');
  assert.equal(tabKind('Parakkat Work Ledger - WorkLog.csv'), 'tasks', 'Google Sheets CSV file names');
  assert.deepEqual(attachmentsFromNotes('x\n📎 a b.png – https://x.test/1\n📎 c - https://x.test/2'), [
    { name: 'a b.png', url: 'https://x.test/1' }, { name: 'c', url: 'https://x.test/2' }]);
  assert.deepEqual(importBatches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(IMPORT_ORDER.at(-1), 'links');
});

test('share uses the share sheet when present and falls back to the clipboard', async () => {
  const copied = [];
  const clipboard = { writeText: async (value) => { copied.push(value); } };
  assert.equal(await shareText('hi', { nav: { share: async () => {}, clipboard } }), 'shared');
  assert.equal(await shareText('hi', { nav: { share: async () => { const e = new Error('no'); e.name = 'AbortError'; throw e; }, clipboard } }), 'cancelled');
  assert.equal(await shareText('hi', { nav: { clipboard } }), 'copied');
  assert.deepEqual(copied, ['hi']);
  assert.equal(await copyText('hi', { nav: { clipboard: { writeText: async () => { throw new Error('denied'); } } } }), 'failed');
});

test('every Sheet field the database import reads is one the importer sends', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../../backend/supabase/migrations/0175_work_import.sql', import.meta.url), 'utf8');
  const worker = sql.slice(sql.indexOf('function app.work_import_rows'), sql.indexOf('function public.work_import_batch'));
  // One row in every tab, under every header the importer knows: each kind's rows then carry every field it sends.
  const parsed = parseLedgerSheets(Object.fromEntries(Object.values(LEDGER_TABS).map((spec) => [spec.names[0], [
    Object.values(spec.fields).map((aliases) => aliases[0]), Object.keys(spec.fields).map((field) => (field === spec.key ? '2' : null))]])));
  const sections = [...worker.matchAll(/if _kind (?:= '(\w+)'|in \(([^)]*)\)) then/g)];
  assert.ok(sections.length >= 10, 'every kind has a branch');
  sections.forEach((match, index) => {
    let kinds = match[1] ? [match[1]] : [...match[2].matchAll(/'(\w+)'/g)].map((m) => m[1]);
    // Subtasks, deliverables and progress share one branch (with an else for progress).
    const children = ['subtasks', 'deliverables', 'progress'];
    if (kinds.every((kind) => children.includes(kind))) kinds = children;
    const body = worker.slice(match.index, sections[index + 1]?.index ?? worker.length);
    const sent = new Set(kinds.flatMap((kind) => (parsed.kinds[kind] ?? []).flatMap((row) => Object.keys(row))));
    if (!sent.size || kinds.includes('links')) return;
    for (const [, field] of body.matchAll(/_r->>?'(\w+)'/g)) assert.ok(sent.has(field), `${kinds.join('/')}.${field} is sent by the importer`);
  });
});
