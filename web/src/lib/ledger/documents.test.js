import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignBrief, groupReview, weeklyReview, monthlyDocument, formatMinutes } from './documents.js';

const diwali = {
  id: 1, name: 'Diwali 2026', brand: 'Parakkat Jewels', brand_label: 'Jewels', stage: 'Approved', status: 'On track', priority: 'High',
  launch_date: '2026-10-25', objective: 'Make Diwali the biggest gifting season', next_action: 'Lock hoarding sites',
  milestone: 'Final creative sign-off', milestone_date: '2026-10-15', blocker: null, decision: 'Approve the ₹ budget by 12 October', budget: 250000,
  brief: {
    insight: 'Families buy gold as a blessing, not an ornament', idea: 'Light a lamp in every home', example: 'A hoarding where the lamp is a gold coin',
    scope: 'Hoardings, reels, showroom displays', resources: 'In-house studio + 2 vendors', timing: '', outcome: 'More walk-ins',
    message: 'Gold that lights your home', tone: 'Warm, festive, not salesy', boundaries: 'No discount language', refs: 'Tanishq 2024 film',
    approval: 'Creative head, then MD', deliverables: '',
  },
  measure: { primary: 'Showroom walk-ins', target: '+20%', baseline: '1200 a week' },
  results: {},
  tasks: [
    { title: 'Hoarding design', status: 'Production', deadline: '2026-10-12', vendor: 'Studio Nila', deliverables: [{ type: 'Hoarding', version: 'v2', link: '', used_where: 'MG Road' }, { type: 'Reel', version: '', used_where: '' }] },
    { title: 'Showroom displays', status: 'Brief', deadline: null, vendor: '', deliverables: [] },
  ],
  ideas: [{ text: 'Coin-lamp motif', links: 'https://example.com/ref' }, { text: 'No links idea', links: '' }],
};

const parked = { name: 'Old Idea', brand: 'Parakkat Jewels', stage: 'Parked', priority: 'High', launch_date: '2026-10-20', budget: 5000 };
const cancelled = { name: 'Dead Idea', brand: 'General', stage: 'Cancelled' };

test('decision brief prints the exact text', () => {
  assert.equal(campaignBrief(diwali), [
    '*Campaign brief — Diwali 2026*',
    'Jewels · Approved',
    '',
    '*Objective*',
    'Make Diwali the biggest gifting season',
    '',
    '*Audience insight*',
    'Families buy gold as a blessing, not an ornament',
    '',
    '*Central idea*',
    'Light a lamp in every home',
    '',
    '*Example execution*',
    'A hoarding where the lamp is a gold coin',
    '',
    '*Scope*',
    'Hoardings, reels, showroom displays',
    '',
    '*Budget and resources*',
    '₹250000 · In-house studio + 2 vendors',
    '',
    '*Timing*',
    'Launch 25 October 2026',
    '',
    '*Expected outcome*',
    'More walk-ins',
    'Primary measure: Showroom walk-ins',
    'Target: +20%',
    'Baseline: 1200 a week',
    '',
    '*Decision required*',
    'Approve the ₹ budget by 12 October',
  ].join('\n'));
  assert.equal(campaignBrief(diwali, 'brief'), campaignBrief(diwali));
});

test('team brief prints the exact text', () => {
  assert.equal(campaignBrief(diwali, 'team'), [
    '*Team brief — Diwali 2026*',
    'Jewels · Approved',
    '',
    '*Message*',
    'Gold that lights your home',
    '',
    '*Tone*',
    'Warm, festive, not salesy',
    '',
    '*Deliverables*',
    '• Hoarding v2 — MG Road (Hoarding design)',
    '• Reel (Hoarding design)',
    '',
    '*References*',
    'Tanishq 2024 film',
    '• Coin-lamp motif — https://example.com/ref',
    '',
    '*Creative boundaries*',
    'No discount language',
    '',
    '*Responsibilities*',
    '• Studio Nila: Hoarding design, due 12 October 2026',
    '• Showroom displays',
    '',
    '*Milestones*',
    '• Final creative sign-off — 15 October 2026',
    '• Launch — 25 October 2026',
    '',
    '*Approval process*',
    'Creative head, then MD',
  ].join('\n'));
});

test('an empty campaign prints To be defined everywhere', () => {
  for (const empty of [{}, null, undefined]) {
    const brief = campaignBrief(empty);
    assert.match(brief, /^\*Campaign brief — Untitled campaign\*\nGeneral\n/);
    assert.match(brief, /\*Objective\*\nTo be defined/);
    assert.match(brief, /Primary measure: To be defined\nTarget: To be defined\nBaseline: To be defined/);
    assert.match(brief, /\*Decision required\*\nTo be defined$/);
    const team = campaignBrief(empty, 'team');
    assert.equal(team.split('To be defined').length - 1, 8, 'every team section falls back');
  }
  assert.match(campaignBrief({ brief: { audience: 'Brides' } }), /\*Audience insight\*\nBrides/);
  assert.match(campaignBrief({ brief: { deliverables: 'A reel and a poster' } }, 'team'), /\*Deliverables\*\nA reel and a poster/);
});

const campaigns = [
  diwali,
  parked,
  cancelled,
  { name: 'Monsoon Escape', brand: 'Parakkat Munnar Resort', brand_label: 'Munnar', stage: 'Decision', priority: 'Medium', launch_date: '2026-12-10', budget: 80000, brief: { resources: '' } },
  { name: 'Retreat teaser', brand: 'Parakkat Adimali Retreat', stage: 'Captured', launch_date: '2026-11-06' },
  { name: 'Onam 2026', brand: 'Parakkat Riverscape', stage: 'Reviewed', priority: 'High', launch_date: '2026-09-01', measure: { primary: 'Bookings', target: '40' }, results: { actual: '46' } },
  { name: 'Summer sale', brand: 'Parakkat Jewels', stage: 'Live', measure: { primary: 'Sales', target: '₹5L' }, results: { actual: '₹6L', next: 'Repeat in May' } },
  { name: 'Brand film', brand: 'Zeta Studio', stage: 'Developing', brief: { resources: 'Drone team' } },
  { name: 'Staff day', stage: 'Developing' },
];

test('group review: order, exclusions, tags, launch window', () => {
  const out = groupReview(campaigns, { today: '2026-10-07' });
  assert.match(out, /^\*Monthly group review\*\n7 October 2026\n\n\*Jewels\*/);
  assert.doesNotMatch(out, /Old Idea|Dead Idea/, 'Parked and Cancelled are ignored');
  const order = ['*Jewels*', '*Parakkat Munnar Resort*', '*Munnar*', '*Parakkat Riverscape*', '*Parakkat Adimali Retreat*', '*General*', '*Zeta Studio*'];
  const positions = ['*Jewels*', '*Munnar*', '*Parakkat Riverscape*', '*Parakkat Adimali Retreat*', '*General*', '*Zeta Studio*'].map((h) => out.indexOf(h));
  assert.ok(positions.every((p) => p >= 0), `all brand headings present: ${positions}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'brand order then alphabetical extras');
  assert.ok(order.length);
  assert.match(out, /_Priorities_\n• Diwali 2026 — Approved\n/);
  assert.doesNotMatch(out, /• Onam 2026 — Reviewed/, 'reviewed campaigns are not priorities');
  assert.match(out, /• Monsoon Escape — Decision \[needs decision\]/);
  assert.match(out, /• Retreat teaser — Captured\n/);
  assert.match(out, /_Resource requirements_\n• Diwali 2026 — ₹250000 · In-house studio \+ 2 vendors/);
  assert.match(out, /• Monsoon Escape — ₹80000\n/);
  assert.match(out, /• Brand film — Drone team/);
  assert.doesNotMatch(out, /Summer sale — ₹/, 'Live is not before Live');
  assert.match(out, /_Upcoming launches_\n• Diwali 2026 — 25 October 2026/);
  assert.match(out, /• Retreat teaser — 6 November 2026/, '30 days out is included');
  assert.doesNotMatch(out, /Monsoon Escape — 10 December/, '64 days out is excluded');
  assert.match(out, /• Onam 2026 — measure Bookings, target 40, actual 46; next: To be defined/);
  assert.match(out, /• Summer sale — measure Sales, target ₹5L, actual ₹6L; next: Repeat in May/);
  assert.match(out, /\*General\*\n_Proposed campaigns_\n• Staff day — Developing/);
});

test('group review launch window edges and empty state', () => {
  const edge = (launch_date) => groupReview([{ name: 'X', stage: 'Approved', launch_date }], { today: '2026-10-07' });
  assert.match(edge('2026-10-07'), /Upcoming launches/, 'today counts');
  assert.match(edge('2026-11-21'), /Upcoming launches/, 'day 45 counts');
  assert.doesNotMatch(edge('2026-11-22'), /Upcoming launches/, 'day 46 does not');
  assert.doesNotMatch(edge('2026-10-06'), /Upcoming launches/, 'past does not');
  assert.equal(groupReview([parked, cancelled], { today: '2026-10-07' }), '*Monthly group review*\n7 October 2026\n\nNo active campaigns.');
  assert.equal(groupReview([], { today: '2026-10-07' }).endsWith('No active campaigns.'), true);
  const custom = groupReview([{ name: 'A', brand: 'General', stage: 'Captured' }, { name: 'B', brand: 'Parakkat Jewels', stage: 'Captured' }], { today: '2026-10-07', brandOrder: ['General'] });
  assert.ok(custom.indexOf('*General*') < custom.indexOf('*Parakkat Jewels*'), 'custom brandOrder wins');
});

const weekReport = {
  period: 'week', from: '2026-10-05', to: '2026-10-11', single_day: false,
  worked_on: [{ title: 'Diwali hoarding v2', brand_label: 'Jewels', event: 'Sent for review', is_new: false, notes: [{ date: '2026-10-05', note: 'a' }, { date: '2026-10-05', note: 'b' }, { date: '2026-10-07', note: 'c' }, { date: '2026-10-08', note: 'd' }] },
    { title: 'Resort reel', brand_label: 'Munnar', event: null, notes: [] }],
  delivered: [{ title: 'Menu redesign', brand_label: 'Riverscape', outcome: 'Printed' }, { title: 'Poster', outcome: '' }],
  support: [{ title: 'r1', minutes: 65 }, { title: 'r2', minutes: 20 }, { title: 'r3', minutes: 15 }],
  support_by_person: [{ person: 'Priya', count: 3, minutes: 65 }, { person: 'Arun', count: 1, minutes: 35 }],
  support_minutes: 100,
  blocked: [{ title: 'Signage', status: 'Awaiting Approval', waiting_on: 'MD' }, { title: 'Logo', status: 'Internal Review' }],
  overdue: [{ title: 'Brochure', brand_label: 'Adimali', deadline: '2026-10-03' }],
  wins: [{ title: 'Menu redesign', outcome: 'Printed' }],
  ideas_captured: [{}, {}],
  cost: { est: 20000, actual: 12000.5 },
};

test('weekly review sections and free-text bullets', () => {
  const out = weeklyReview(weekReport, { slipped: 'Brochure reprint\n\n  • Signage approval  \n- Logo feedback', nextWeek: 'Shoot reel' });
  assert.equal(out, [
    '*Weekly review*',
    '5 Oct – 11 Oct 2026',
    '',
    '*What shipped*',
    '• Menu redesign (Riverscape) — Printed',
    '• Poster',
    '',
    '*Worked on*',
    '• Diwali hoarding v2 (Jewels) → Sent for review',
    '• Resort reel (Munnar)',
    '',
    '*Blocked*',
    '• Signage (Awaiting Approval, waiting on MD)',
    '• Logo (Internal Review)',
    '',
    '*Overdue*',
    '• Brochure (Adimali) — since 3 October 2026',
    '',
    '*Support*',
    '3 entries · 1h 40m',
    '• Priya — 3 (1h 5m)',
    '• Arun — 1 (35m)',
    '',
    '*What slipped*',
    '• Brochure reprint',
    '• Signage approval',
    '- Logo feedback',
    '',
    '*Next week*',
    '• Shoot reel',
  ].join('\n'));
  const bare = weeklyReview({ period: 'week', from: '2026-10-05', to: '2026-10-11' }, { slipped: '  \n', nextWeek: '' });
  assert.equal(bare, '*Weekly review*\n5 Oct – 11 Oct 2026');
  assert.doesNotMatch(bare, /slipped|Next week/);
});

test('monthly document: title, section order, day counting', () => {
  const report = { ...weekReport, period: 'month', from: '2026-10-01', to: '2026-10-31' };
  const doc = monthlyDocument(report, { campaigns, today: '2026-10-31' });
  assert.equal(doc.title, 'Parakkat Creative — October 2026');
  assert.deepEqual(doc.sections.map((s) => s.heading), ['Summary', 'Campaigns', 'Wins & outcomes', 'Support & reviews', 'Worked on', 'Delivered', 'Blocked', 'Overdue']);
  assert.deepEqual(doc.sections[0].lines, ['2 delivered · 2 worked on · 3 support entries (1h 40m) · 2 ideas captured · spend est ₹20000 / actual ₹12001']);
  const campaignLines = doc.sections[1].lines.join('\n');
  assert.match(campaignLines, /• Diwali 2026 — Approved, launch 25 October 2026/);
  assert.match(campaignLines, /• Staff day — Developing$/m);
  assert.doesNotMatch(campaignLines, /Old Idea|Dead Idea/);
  assert.deepEqual(doc.sections[3].lines, ['• Priya — 3 reviews, 1h 5m', '• Arun — 1 review, 35m']);
  assert.deepEqual(doc.sections[4].lines, ['• Diwali hoarding v2 (Jewels) — 3 days', '• Resort reel (Munnar) — 1 day']);
  assert.ok(doc.text.startsWith('*Parakkat Creative — October 2026*\n\n*Summary*\n2 delivered'));
  assert.match(doc.text, /\n\n\*Worked on\*\n• Diwali hoarding v2 \(Jewels\) — 3 days\n/);
  assert.match(doc.text, /\*Overdue\*\n• Brochure \(Adimali\) — since 3 October 2026$/);
});

test('monthly document omits empty sections except Summary', () => {
  const doc = monthlyDocument({ period: 'month', from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(doc.sections.map((s) => s.heading), ['Summary']);
  assert.equal(doc.text, '*Parakkat Creative — November 2026*\n\n*Summary*\n0 delivered · 0 worked on · 0 support entries (0m) · 0 ideas captured · spend est ₹0 / actual ₹0');
});

test('formatMinutes', () => {
  assert.equal(formatMinutes(45), '45m');
  assert.equal(formatMinutes(60), '1h');
  assert.equal(formatMinutes(65), '1h 5m');
  assert.equal(formatMinutes(0), '0m');
  assert.equal(formatMinutes(null), '0m');
  assert.equal(formatMinutes(undefined), '0m');
  assert.equal(formatMinutes(200), '3h 20m');
});
