// Creative extras demo (?qa-ledger&qa-creative): shared campaigns, ideas and library, in memory only.
// Add qa-creative=admin to also choose the creative departments. The SQL suite owns the real rules
// (0174); this copies the few the screens show: stage log, derived status, idea → campaign once,
// concept → Developing, first wording kept.
import { addDays } from '../src/lib/ledger/periods.js';
import { fixture, tables, today } from './fixtures';

const params = new URL(window.location.href).searchParams;
export const creativeDemo = params.has('qa-creative');
const canConfigure = params.get('qa-creative') === 'admin';
const me = fixture.employees[0];
let serial = 0;
const nextId = (prefix) => `qa-${prefix}-${(serial += 1)}`;
const now = () => new Date().toISOString();
const STAGES = ['Captured', 'Developing', 'Decision', 'Approved', 'Production', 'Live', 'Reviewed'];
const statusOf = (stage) => (['Captured', 'Parked'].includes(stage) ? 'Planning' : ['Reviewed', 'Cancelled'].includes(stage) ? 'Done' : 'Active');

const store = {
  departments: [],
  brands: [['Parakkat Jewels', 'Jewels'], ['Parakkat Munnar Resort', 'Munnar'], ['Parakkat Riverscape', 'Riverscape'], ['Parakkat Adimali Retreat', 'Adimali'], ['General', 'General']]
    .map(([name, short], index) => ({ id: `qa-brand-${index + 1}`, name, short_label: short, sort_order: index + 1, foundation: {}, foundation_updated_at: null, deleted_at: null })),
  vendors: [
    { id: 'qa-vendor-1', name: 'Studio Lumen', role: 'Photographer', phone: '98470 11111', email: null, rate: '₹18,000 / day', rating: 5, notes: 'Best for jewellery close-ups', last_worked: addDays(today, -6), deleted_at: null },
    { id: 'qa-vendor-2', name: 'Sree Printers', role: 'Printer', phone: '0484 222 333', email: null, rate: null, rating: 4, notes: null, last_worked: addDays(today, -20), deleted_at: null }],
  templates: [
    ['Product shoot', 'Photography', ['Brief and shot list', 'Book photographer and studio', 'Select and style products', 'Shoot day', 'Select and retouch', 'Deliver final images']],
    ['Ad campaign', 'Ads', ['Objective and audience', 'Concept and copy', 'Design creatives', 'Internal review', 'Approval', 'Launch', 'Report results']],
    ['Print job', 'Print', ['Brief and sizes', 'Design', 'Internal review', 'Approval', 'Send to printer', 'Check proof', 'Delivery and installation']],
    ['Reel', 'Video', ['Concept and script', 'Shoot', 'Edit', 'Music and captions', 'Review', 'Post']],
  ].map(([name, type, subtasks], index) => ({ id: `qa-template-${index + 1}`, name, work_type: type, subtasks, seed_key: name, deleted_at: null })),
  key_dates: [['Diwali', 9, 'Parakkat Jewels', 30], ['Christmas', 65, 'Parakkat Munnar Resort', 45], ['New Year', 72, 'General', 30], ['Valentine’s Day', 116, 'Parakkat Jewels', 30]]
    .map(([name, days, brand, lead], index) => ({ id: `qa-date-${index + 1}`, name, on_date: addDays(today, days), brand, lead_days: lead, notes: null, seed_key: name, deleted_at: null })),
  campaigns: [
    { id: 'qa-campaign-1', name: 'Diwali gold festival', brand: 'Parakkat Jewels', stage: 'Decision', priority: 'High', launch_date: addDays(today, 7),
      decision: 'Lead with the temple collection or the lightweight range?', objective: 'Showroom footfall in Diwali week', next_action: 'Mock up both hero ads' },
    { id: 'qa-campaign-2', name: 'Monsoon stays', brand: 'Parakkat Munnar Resort', stage: 'Production', priority: 'Medium', launch_date: addDays(today, 20),
      objective: 'Weekday occupancy in July', next_action: 'Shoot the rain-window reel', blocker: null },
    { id: 'qa-campaign-3', name: 'Onam hampers', brand: 'Parakkat Riverscape', stage: 'Reviewed', priority: 'Low', launch_date: addDays(today, -40), results: { what: 'Sold out in 4 days' } },
  ].map((c) => ({ brief_link: null, notes: null, milestone: null, milestone_date: null, blocker: null, decision: null, budget: null, brief: {}, measure: {}, results: {},
    created_at: `${addDays(today, -14)}T10:00:00+05:30`, deleted_at: null, ...c })),
  log: [
    { campaign_id: 'qa-campaign-1', at: `${addDays(today, -14)}T10:00:00+05:30`, actor_name: me.full_name, text: 'Created at Captured' },
    { campaign_id: 'qa-campaign-1', at: `${addDays(today, -2)}T16:00:00+05:30`, actor_name: me.full_name, text: 'Stage: Developing → Decision' },
    { campaign_id: 'qa-campaign-2', at: `${addDays(today, -10)}T10:00:00+05:30`, actor_name: me.full_name, text: 'Created at Captured' }],
  ideas: [
    { id: 'qa-idea-1', text: 'Grandmother-to-granddaughter heirloom reel', original: 'Grandmother-to-granddaughter heirloom reel', brand: 'Parakkat Jewels', tags: ['reel', 'festive'],
      status: 'Open', concept: {}, author_name: me.full_name, author_employee: me.id, created_at: `${today}T09:30:00+05:30` },
    { id: 'qa-idea-2', text: 'Rainy-day spa package for couples', original: 'Spa offer', brand: 'Parakkat Munnar Resort', tags: ['offers'], status: 'Developing',
      concept: { oneLine: 'Monsoon spa for two', objective: 'Fill weekdays' }, author_name: fixture.employees[1].full_name, author_employee: fixture.employees[1].id, created_at: `${addDays(today, -3)}T12:00:00+05:30` },
    { id: 'qa-idea-3', text: 'Riverside breakfast pop-up', original: 'Riverside breakfast pop-up', brand: 'Parakkat Riverscape', tags: [], status: 'Parked',
      revisit_date: addDays(today, 3), revisit_when: 'after the monsoon', concept: {}, author_name: me.full_name, author_employee: me.id, created_at: `${addDays(today, -30)}T12:00:00+05:30` },
  ].map((i) => ({ links: null, revisit_date: null, revisit_when: null, task_id: null, campaign_id: null, deleted_at: null, ...i })),
  links: [],
};
if (creativeDemo) store.departments = (fixture.org?.departments ?? []).filter((d) => d.id === me.department_id);

/** Called once the Ledger demo has added its tasks: puts three of them on campaigns. */
export function seedCreativeTasks() {
  if (!creativeDemo) return;
  Object.assign(tables.tasks.find((t) => t.id === 'qa-work-1') ?? {}, { brand: 'Parakkat Jewels', work_type: 'Print', campaign_id: 'qa-campaign-1', vendor_id: 'qa-vendor-2', est_cost: 24000 });
  Object.assign(tables.tasks.find((t) => t.id === 'qa-work-2') ?? {}, { brand: 'Parakkat Munnar Resort', work_type: 'Reel', campaign_id: 'qa-campaign-2' });
  Object.assign(tables.tasks.find((t) => t.id === 'qa-work-8') ?? {}, { brand: 'Parakkat Jewels', work_type: 'Photography', campaign_id: 'qa-campaign-1', vendor_id: 'qa-vendor-1', actual_cost: 18000 });
}

const live = (rows) => rows.filter((row) => !row.deleted_at);
export function brandLabel(name) {
  const brand = live(store.brands).find((b) => b.name.toLowerCase() === String(name ?? '').trim().toLowerCase());
  return brand ? brand.short_label || brand.name : name || null;
}
export const campaignName = (id) => live(store.campaigns).find((c) => c.id === id)?.name ?? null;
export const vendorName = (id) => store.vendors.find((v) => v.id === id)?.name ?? null;
const campaignTasks = (id) => tables.tasks.filter((t) => t.campaign_id === id && !t.deleted_at);
const nameOf = (id) => fixture.employees.find((e) => e.id === id)?.full_name ?? null;
const step = (t) => ({ 'To Do': 'To do', 'In Progress': { 'Internal Review': 'In review', 'Awaiting Approval': 'Waiting for approval', Revisions: 'Changes needed', Approved: 'Approved' }[t.review_stage] ?? 'In progress' }[t.status] ?? t.status);

function campaignJson(c, detail = false) {
  const work = campaignTasks(c.id);
  const out = { ...c, status: statusOf(c.stage), brand_label: brandLabel(c.brand), days_to_launch: c.launch_date ? Math.round((Date.parse(c.launch_date) - Date.parse(today)) / 864e5) : null,
    total: work.filter((t) => t.status !== 'Cancelled').length, done: work.filter((t) => t.status === 'Done').length,
    in_review: work.filter((t) => t.status === 'In Progress' && ['Internal Review', 'Awaiting Approval', 'Revisions'].includes(t.review_stage)).length,
    blocked: work.filter((t) => t.status === 'Blocked').length, spend: work.reduce((sum, t) => sum + (Number(t.actual_cost) || 0), 0) };
  if (!detail) return out;
  return { ...out,
    log: store.log.filter((l) => l.campaign_id === c.id).map((l) => ({ at: l.at, text: l.text, by: l.actor_name })).reverse(),
    tasks: work.map((t) => ({ id: t.id, title: t.title, status: step(t), deadline: t.due_date, priority: t.priority, vendor: vendorName(t.vendor_id),
      actual_cost: t.actual_cost ?? null, assignee: nameOf(t.employee_id), deliverables: tables.task_deliverables.filter((d) => d.task_id === t.id && !d.deleted_at) })),
    ideas: live(store.ideas).filter((i) => i.campaign_id === c.id || store.links.some((l) => l.campaign_id === c.id && l.idea_id === i.id))
      .map((i) => ({ id: i.id, text: i.text, links: i.links, status: i.status })) };
}
const ideaJson = (i) => ({ ...i, edited: i.text !== i.original, by: i.author_name, mine: i.author_employee === me.id,
  task_title: tables.tasks.find((t) => t.id === i.task_id)?.title ?? null, campaign_name: campaignName(i.campaign_id) });

function alerts() {
  const list = [];
  for (const c of live(store.campaigns)) {
    if (c.stage === 'Decision') list.push({ rank: 1, kind: 'decision', campaign_id: c.id, title: c.name, text: c.decision || 'Decision needed is not written yet' });
    if (c.blocker && !['Parked', 'Cancelled'].includes(c.stage)) list.push({ rank: 2, kind: 'blocked', campaign_id: c.id, title: c.name, text: c.blocker });
    if (c.launch_date && c.launch_date <= addDays(today, 14) && !['Parked', 'Cancelled', 'Live', 'Reviewed'].includes(c.stage)) {
      const days = campaignJson(c).days_to_launch;
      list.push({ rank: 3, kind: 'launch', campaign_id: c.id, title: c.name, date: c.launch_date, text: days < 0 ? 'Launch date has passed' : `Launches in ${days} days` });
    }
  }
  for (const i of live(store.ideas)) {
    if (i.status === 'Parked' && i.revisit_date && i.revisit_date <= addDays(today, 7)) {
      list.push({ rank: 6, kind: 'idea', idea_id: i.id, title: i.text, date: i.revisit_date, text: i.revisit_when ? `Revisit when ${i.revisit_when}` : 'Time to revisit' });
    }
  }
  return list.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...item }) => item);
}

function library() {
  return {
    vendors: live(store.vendors).map((v) => ({ ...v, tasks: tables.tasks.filter((t) => t.vendor_id === v.id && !t.deleted_at).length })),
    templates: live(store.templates).map((t) => ({ id: t.id, name: t.name, type: t.work_type, subtasks: t.subtasks })),
    key_dates: live(store.key_dates).map((k) => ({ id: k.id, name: k.name, date: k.on_date, brand: k.brand, lead_days: k.lead_days, notes: k.notes, starter: Boolean(k.seed_key) }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    brands: live(store.brands).map((b) => ({ id: b.id, name: b.name, label: b.short_label || b.name, sort_order: b.sort_order, foundation: b.foundation, foundation_updated_at: b.foundation_updated_at })),
    campaigns: live(store.campaigns).map((c) => ({ id: c.id, name: c.name, brand: c.brand, stage: c.stage })),
  };
}

function settings() {
  return { member: creativeDemo, can_configure: canConfigure, departments: store.departments.map((d) => ({ id: d.id, name: d.name, branch: null })) };
}

function read(name, args) {
  if (name === 'creative_settings') return settings();
  if (!creativeDemo) return name === 'creative_home' ? null : undefined;
  if (name === 'creative_home') {
    const soon = live(store.key_dates).filter((k) => k.on_date >= today && k.on_date <= addDays(today, 150)).sort((a, b) => a.on_date.localeCompare(b.on_date));
    return { alerts: alerts(),
      campaigns: live(store.campaigns).filter((c) => !['Parked', 'Cancelled', 'Reviewed'].includes(c.stage)).map((c) => campaignJson(c)),
      key_dates: soon.map((k) => ({ id: k.id, name: k.name, date: k.on_date, brand: k.brand, lead_days: k.lead_days, days_away: Math.round((Date.parse(k.on_date) - Date.parse(today)) / 864e5),
        brand_label: brandLabel(k.brand), has_campaign: live(store.campaigns).some((c) => !['Parked', 'Cancelled'].includes(c.stage) && c.launch_date && c.launch_date <= k.on_date
          && c.launch_date >= addDays(k.on_date, -Math.max(k.lead_days ?? 30, 30))) })),
      ideas: live(store.ideas).filter((i) => ['Open', 'Developing'].includes(i.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 6).map(ideaJson),
      ideas_open: live(store.ideas).filter((i) => i.status === 'Open').length };
  }
  if (name === 'creative_campaigns') {
    const order = (c) => (STAGES.includes(c.stage) ? STAGES.indexOf(c.stage) : 8 + ['Parked', 'Cancelled'].indexOf(c.stage));
    return live(store.campaigns).sort((a, b) => order(a) - order(b) || String(a.launch_date ?? '9').localeCompare(String(b.launch_date ?? '9'))).map((c) => campaignJson(c));
  }
  if (name === 'creative_campaign') {
    const c = live(store.campaigns).find((x) => x.id === args._id);
    return c ? campaignJson(c, true) : { error: { code: 'P0002', message: 'Campaign not found.' } };
  }
  if (name === 'creative_campaign_details') return live(store.campaigns).map((c) => campaignJson(c, true));
  if (name === 'creative_ideas') return live(store.ideas).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(ideaJson);
  if (name === 'creative_library') return library();
  return undefined;
}

function write(name, args) {
  if (name === 'set_creative_departments') {
    if (!canConfigure) return { error: { code: '42501', message: 'Only a super admin chooses the creative team.' } };
    store.departments = (fixture.org?.departments ?? []).filter((d) => (args._departments ?? []).includes(d.id));
    return settings();
  }
  if (!creativeDemo) return { error: { code: '42501', message: 'Campaigns are for the creative team.' } };
  if (name === 'creative_campaign_note') {
    if (!String(args._text ?? '').trim()) return { error: { code: '22023', message: 'Write the note (up to 2000 characters).' } };
    store.log.push({ campaign_id: args._campaign, at: now(), actor_name: me.full_name, text: args._text.trim() });
    return null;
  }
  if (name === 'creative_idea_to_campaign') {
    const idea = live(store.ideas).find((i) => i.id === args._idea);
    if (!idea) return { error: { code: 'P0002', message: 'Idea not found.' } };
    if (!idea.campaign_id) {
      const id = args._campaign ?? nextId('campaign');
      store.campaigns.push({ ...store.campaigns[2], id, name: idea.concept?.oneLine || idea.text, brand: idea.brand, stage: 'Developing', priority: 'Medium', launch_date: null,
        objective: idea.concept?.objective ?? null, next_action: idea.concept?.nextAction ?? null, results: {}, created_at: now() });
      store.log.push({ campaign_id: id, at: now(), actor_name: me.full_name, text: `From idea: ${idea.text}` });
      store.links.push({ campaign_id: id, idea_id: idea.id });
      Object.assign(idea, { status: 'Promoted', campaign_id: id });
    }
    return campaignJson(store.campaigns.find((c) => c.id === idea.campaign_id), true);
  }
  if (name === 'creative_refresh_key_dates') return 0;
  return undefined;
}

export function creativeRpc(name, args, { canWrite }) {
  if (!name.startsWith('creative_') && name !== 'set_creative_departments') return undefined;
  const value = read(name, args ?? {});
  if (value !== undefined) return value?.error ? value : { rows: [structuredClone(value)], one: true };
  if (!canWrite) return { error: { code: '42501', message: 'Writes are blocked in this demo.' } };
  const written = write(name, args ?? {});
  if (written === undefined) return { error: { code: 'PGRST202', message: `Demo has no ${name}.` } };
  if (written?.error) return written;
  return { mutated: true, one: true, rows: [structuredClone(written)] };
}

const TABLES = { creative_campaigns: 'campaigns', creative_ideas: 'ideas', creative_vendors: 'vendors', creative_templates: 'templates', creative_key_dates: 'key_dates', creative_brands: 'brands' };

/** Table writes on the creative tables. Returns undefined when the table is not one of them. */
export function creativeTableWrite(query) {
  const key = TABLES[query.table];
  if (!key) return undefined;
  if (!creativeDemo) return { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } };
  const rows = store[key];
  const result = (changed) => ({ data: structuredClone(query.one ? changed[0] ?? null : changed), error: null });
  if (query.operation === 'insert') {
    const row = { id: nextId(key), deleted_at: null, created_at: now(), ...query.payload };
    if (key === 'campaigns') {
      row.name = String(row.name ?? '').trim();
      if (live(rows).some((c) => c.name.toLowerCase() === row.name.toLowerCase())) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "creative_campaigns_name_idx"' } };
      Object.assign(row, { brief: {}, measure: {}, results: {}, ...row });
      store.log.push({ campaign_id: row.id, at: now(), actor_name: me.full_name, text: `Created at ${row.stage ?? 'Captured'}` });
      row.stage ??= 'Captured';
    }
    if (key === 'ideas') {
      row.text = String(row.text ?? '').trim();
      Object.assign(row, { original: row.text, status: 'Open', concept: {}, author_name: me.full_name, author_employee: me.id, links: null, revisit_date: null,
        revisit_when: null, task_id: null, campaign_id: null, tags: [...new Set((row.tags ?? []).map((t) => t.toLowerCase()))] });
    }
    rows.push(row);
    return result([row]);
  }
  if (query.operation === 'update') {
    const changed = rows.filter((row) => query.filters.every((filter) => filter(row)));
    for (const row of changed) {
      const before = { ...row };
      Object.assign(row, query.payload);
      if (key === 'ideas') {
        row.original = before.original;
        if (before.status === 'Open' && row.status === 'Open' && Object.values(row.concept ?? {}).some((v) => String(v ?? '').trim())) row.status = 'Developing';
      }
      if (key === 'campaigns') {
        if (row.stage !== before.stage) store.log.push({ campaign_id: row.id, at: now(), actor_name: me.full_name, text: `Stage: ${before.stage} → ${row.stage}` });
        if (row.decision !== before.decision && String(row.decision ?? '').trim()) store.log.push({ campaign_id: row.id, at: now(), actor_name: me.full_name, text: `Decision: ${row.decision}` });
      }
      if (key === 'brands' && 'foundation' in query.payload) row.foundation_updated_at = now();
    }
    return result(changed);
  }
  return undefined;
}
