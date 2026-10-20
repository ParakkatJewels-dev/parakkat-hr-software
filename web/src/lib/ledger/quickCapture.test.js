import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickCapture, describeCapture, BRAND_TOKENS } from './quickCapture.js';

const WED = '2026-10-07';
const parse = (input, today = WED) => parseQuickCapture(input, { today });

test('plain text and odd input are searches', () => {
  assert.deepEqual(parse('  diwali  '), { kind: 'search', query: 'diwali' });
  assert.deepEqual(parse('tasks: not a prefix'), { kind: 'search', query: 'tasks: not a prefix' });
  assert.deepEqual(parseQuickCapture(null, { today: WED }), { kind: 'search', query: '' });
  assert.deepEqual(parseQuickCapture(42, { today: WED }), { kind: 'search', query: '' });
  assert.deepEqual(parseQuickCapture(undefined), { kind: 'search', query: '' });
});

test('task example', () => {
  assert.deepEqual(parse('task: Diwali hoarding v2 @jewels !high by fri'), {
    kind: 'task', title: 'Diwali hoarding v2', brand: 'Parakkat Jewels', priority: 'High', deadline: '2026-10-09', repeat: null,
  });
});

test('prefix is case-insensitive and tolerates spaces; empty bodies', () => {
  assert.equal(parse('Task : x').title, 'x');
  assert.equal(parse('  TASK:x').title, 'x');
  assert.deepEqual(parse('task:'), { kind: 'task', title: '', brand: null, priority: 'Medium', deadline: null, repeat: null });
  assert.deepEqual(parse('idea:   '), { kind: 'idea', text: '', brand: null, tags: [] });
  assert.equal(parse('help:').title, '');
  assert.equal(parse('help:').date, WED);
  assert.equal(parse('remind:').text, '');
  assert.equal(parse('remind:').dueAt, '2026-10-07T09:00');
});

test('brands: # works, river alias, first wins, unknown kept for task', () => {
  assert.equal(parse('task: a #munnar').brand, BRAND_TOKENS.munnar);
  assert.equal(parse('task: a @river').brand, 'Parakkat Riverscape');
  assert.equal(parse('task: a @adimali').brand, 'Parakkat Adimali Retreat');
  assert.equal(parse('task: a @general').brand, 'General');
  const t = parse('task: a @jewels @munnar');
  assert.equal(t.brand, 'Parakkat Jewels');
  assert.equal(t.title, 'a @munnar');
  assert.equal(parse('task: a @unknown b').title, 'a @unknown b');
  assert.equal(parse('task: a @constructor').title, 'a @constructor');
});

test('priority and urgent', () => {
  assert.equal(parse('task: a').priority, 'Medium');
  assert.equal(parse('task: a !low').priority, 'Low');
  assert.equal(parse('task: a !MEDIUM').priority, 'Medium');
  const u = parse('task: fix urgent leak');
  assert.equal(u.priority, 'High');
  assert.equal(u.title, 'fix leak');
});

test('weekday rules and date edge cases', () => {
  assert.equal(parse('task: a wed').deadline, WED, 'same weekday means today');
  assert.equal(parse('task: a thursday').deadline, '2026-10-08');
  assert.equal(parse('task: a mon').deadline, '2026-10-12');
  assert.equal(parse('task: a sun', '2026-10-10').deadline, '2026-10-11', 'Saturday -> Sunday');
  assert.equal(parse('task: a today').deadline, WED);
  assert.equal(parse('task: a tomorrow', '2026-12-31').deadline, '2027-01-01');
  assert.equal(parse('task: a tomorrow', '2026-02-28').deadline, '2026-03-01');
  assert.equal(parse('task: a due 2026-11-02').deadline, '2026-11-02');
  assert.equal(parse('task: a due 2026-11-02').title, 'a');
  const bad = parse('task: a 2026-02-30');
  assert.equal(bad.deadline, null);
  assert.equal(bad.title, 'a 2026-02-30');
  assert.equal(parse('task: a on mon').title, 'a');
});

test('only the first date counts; later ones and their "by" stay', () => {
  const t = parse('task: a by fri then by sat');
  assert.equal(t.deadline, '2026-10-09');
  assert.equal(t.title, 'a then by sat');
});

test('tokens mid-title, punctuation and uppercase', () => {
  assert.equal(parse('task: send @jewels banner by fri. today').title, 'send banner today');
  assert.equal(parse('task: send banner by fri.').deadline, '2026-10-09');
  assert.equal(parse('task: ship it, !high; weekly.').repeat, 'weekly');
  assert.equal(parse('task: Review menu, then post.').title, 'Review menu, then post.');
  assert.deepEqual(parse('TASK: DIWALI HOARDING @JEWELS !HIGH BY FRI'), {
    kind: 'task', title: 'DIWALI HOARDING', brand: 'Parakkat Jewels', priority: 'High', deadline: '2026-10-09', repeat: null,
  });
});

test('repeat words', () => {
  assert.equal(parse('task: report weekly').repeat, 'weekly');
  assert.equal(parse('task: standup weekdays').repeat, 'weekdays');
  assert.equal(parse('task: rent monthly').repeat, 'monthly');
  assert.equal(parse('task: water plants daily').title, 'water plants');
});

test('idea example, tags, and no date/priority parsing', () => {
  assert.deepEqual(parse('idea: reel series on resort mornings @munnar #reels'), {
    kind: 'idea', text: 'reel series on resort mornings', brand: 'Parakkat Munnar Resort', tags: ['reels'],
  });
  const i = parse('idea: post by fri !high daily #Launch @Promo #launch');
  assert.equal(i.text, 'post by fri !high daily');
  assert.deepEqual(i.tags, ['launch', 'promo']);
  assert.equal(i.brand, null);
});

test('help example and extras', () => {
  assert.deepEqual(parse('help: reviewed menu layout for Priya 20m @riverscape'), {
    kind: 'help', title: 'reviewed menu layout', brand: 'Parakkat Riverscape', forWhom: 'Priya', minutes: 20,
    supportType: 'Review / Feedback', date: WED,
  });
  assert.equal(parse('help: fixed logo for Anu Mathew').forWhom, 'Anu Mathew');
  assert.equal(parse('help: fixed logo for Anu Mathew').title, 'fixed logo');
  assert.equal(parse('help: fixed logo for Priya, again').title, 'fixed logo again');
  assert.equal(parse('help: talked for hours').forWhom, null);
  assert.equal(parse('help: a 45min').minutes, 45);
  assert.equal(parse('help: a 45 mins').minutes, 45);
  assert.equal(parse('help: a 45 mins').title, 'a');
  assert.equal(parse('help: a 1.5h').minutes, 90);
  assert.equal(parse('help: a 2h').minutes, 120);
  assert.equal(parse('help: a 1h30m').minutes, 90);
  assert.equal(parse('help: a 2026').minutes, null);
  const s = parse('help: unblocked the shoot yesterday on fri');
  assert.equal(s.supportType, 'Team support');
  assert.equal(s.title, 'unblocked the shoot yesterday');
  assert.equal(s.date, '2026-10-09');
  assert.equal(parse('help: gave support to team').title, 'gave support to team');
  assert.equal(parse('help: a !high daily').title, 'a !high daily', 'help has no priority/repeat');
});

test('remind examples and times', () => {
  assert.deepEqual(parse('remind: call printer tomorrow 10am'), {
    kind: 'remind', text: 'call printer', brand: null, dueAt: '2026-10-08T10:00', repeat: null,
  });
  assert.equal(parse('remind: pay vendor at 4:30pm').dueAt, '2026-10-07T16:30');
  assert.equal(parse('remind: pay vendor at 4:30pm').text, 'pay vendor');
  assert.equal(parse('remind: x 4.30pm').dueAt, '2026-10-07T16:30');
  assert.equal(parse('remind: x 14:00').dueAt, '2026-10-07T14:00');
  assert.equal(parse('remind: x noon').dueAt, '2026-10-07T12:00');
  assert.equal(parse('remind: x midnight').dueAt, '2026-10-07T00:00');
  assert.equal(parse('remind: x 12am').dueAt, '2026-10-07T00:00');
  assert.equal(parse('remind: x 12pm').dueAt, '2026-10-07T12:00');
  assert.equal(parse('remind: x 13pm').text, 'x 13pm');
  assert.equal(parse('remind: x').dueAt, '2026-10-07T09:00');
  const r = parse('remind: stock count by fri at 9:15am weekly @jewels');
  assert.deepEqual(r, { kind: 'remind', text: 'stock count', brand: 'Parakkat Jewels', dueAt: '2026-10-09T09:15', repeat: 'weekly' });
  assert.equal(parse('remind: x 2026-12-31 11PM').dueAt, '2026-12-31T23:00');
});

test('invalid or missing today never throws', () => {
  assert.equal(parseQuickCapture('task: a tomorrow', { today: 'nope' }).deadline, null);
  assert.equal(parseQuickCapture('task: a tomorrow', { today: 'nope' }).title, 'a tomorrow');
  assert.equal(parseQuickCapture('task: a 2026-11-02', {}).deadline, '2026-11-02');
  assert.equal(parseQuickCapture('remind: a', {}).dueAt, null);
});

test('describeCapture chips', () => {
  const task = parse('task: Diwali hoarding v2 @jewels !high by fri weekly');
  assert.deepEqual(describeCapture(task), ['Task', 'Jewels', 'High', 'Due Fri 9 Oct', 'Repeats weekly']);
  assert.deepEqual(describeCapture(parse('task: x')), ['Task', 'Medium']);
  assert.deepEqual(describeCapture(parse('remind: call printer tomorrow 10am daily')), ['Reminder', 'Due Thu 8 Oct, 10:00 AM', 'Repeats daily']);
  assert.deepEqual(describeCapture(parse('remind: x noon @munnar')), ['Reminder', 'Munnar', 'Due Wed 7 Oct, 12:00 PM']);
  assert.deepEqual(describeCapture(parse('idea: a @munnar #reels')), ['Idea', 'Munnar', '#reels']);
  assert.deepEqual(describeCapture(parse('help: a for Priya 1h30m')), ['Help', 'For Priya', '1h 30m', 'Review / Feedback', 'Wed 7 Oct']);
  assert.deepEqual(describeCapture(parse('plain')), []);
});
