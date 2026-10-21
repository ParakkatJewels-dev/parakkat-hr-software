// Campaigns, shared by the creative team: the pipeline list, a New campaign form, the monthly group
// review, and one campaign's detail — stage bar, decision panel, plan / brief / measure / results,
// its tasks and ideas, and the log. Tasks are ordinary tasks that name the campaign.
import React, { useState } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { CAMPAIGN_STAGES as STAGES, OFF_STAGES as OFF, fetchCampaignDetails, newId, useCreativeCampaign, useCreativeCampaigns,
  useCreativeLibrary, useCreativeWrite } from '../../data/creative';
import { campaignBrief, groupReview } from '../../lib/ledger/documents.js';
import DocumentDrawer from './DocumentDrawer';
import { BrandMark, Field, Message, PRIORITIES, StatusPill, Suggest, dateLabel, errorText, money, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

const SECTIONS = [
  { key: 'brief', label: 'Brief', fields: [['insight', 'Audience insight'], ['idea', 'Central idea'], ['example', 'Example execution'], ['audience', 'Audience'],
    ['message', 'Key message'], ['tone', 'Tone'], ['deliverables', 'Deliverables & sizes'], ['scope', 'Scope'], ['resources', 'Resources'], ['timing', 'Timing'],
    ['outcome', 'Expected outcome'], ['refs', 'References'], ['boundaries', 'Creative boundaries'], ['approval', 'Approval process']] },
  { key: 'measure', label: 'Measure', fields: [['primary', 'Primary measure (KPI)'], ['target', 'Target'], ['baseline', 'Baseline'], ['reviewDate', 'Review date', 'date']] },
  { key: 'results', label: 'Results', fields: [['what', 'What happened'], ['actual', 'Actual numbers'], ['learnings', 'Learnings'], ['next', 'Next time']] },
];

/** Brand names for suggestions, in the team's order. */
export function useBrandNames() {
  const library = useCreativeLibrary();
  return (library.data?.brands ?? []).map((brand) => brand.name);
}

export function CampaignForm({ initial = {}, onSaved, onCancel }) {
  const brands = useBrandNames();
  const write = useCreativeWrite();
  const [form, setForm] = useState({ stage: 'Captured', priority: 'Medium', brand: 'General', ...initial });
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event) => {
    event.preventDefault();
    const id = newId();
    try {
      await write.mutateAsync({ op: 'add-campaign', id, name: form.name?.trim(), brand: form.brand?.trim() || null, launch_date: form.launch_date || null,
        stage: form.stage, priority: form.priority, objective: form.objective?.trim() || null, brief_link: form.brief_link?.trim() || null,
        notes: form.notes?.trim() || null });
      onSaved(id);
    } catch { /* shown below */ }
  };
  return (
    <form className="ledger-form ledger-campaign-form" onSubmit={submit} aria-label="New campaign">
      <Field label="Name" wide><input className="ledger-input" required maxLength={160} value={form.name ?? ''} onChange={(e) => set('name')(e.target.value)} autoFocus /></Field>
      <Field label="Brand"><Suggest value={form.brand} onChange={set('brand')} options={brands} maxLength={80} /></Field>
      <Field label="Launch date"><input type="date" className="ledger-input" value={form.launch_date ?? ''} onChange={(e) => set('launch_date')(e.target.value)} /></Field>
      <Field label="Stage"><select className="ledger-input" value={form.stage} onChange={(e) => set('stage')(e.target.value)}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></Field>
      <Field label="Priority"><select className="ledger-input" value={form.priority} onChange={(e) => set('priority')(e.target.value)}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
      <Field label="Objective" wide><textarea className="ledger-input" rows={2} value={form.objective ?? ''} onChange={(e) => set('objective')(e.target.value)} /></Field>
      <Field label="Brief link" wide><input className="ledger-input" type="url" placeholder="https://…" value={form.brief_link ?? ''} onChange={(e) => set('brief_link')(e.target.value)} /></Field>
      <Field label="Notes" wide><textarea className="ledger-input" rows={2} value={form.notes ?? ''} onChange={(e) => set('notes')(e.target.value)} /></Field>
      <Message error={write.error} />
      <div className="ledger-actions ledger-form-wide">
        <button type="submit" className={btnClass('primary')} disabled={write.isPending}>Create campaign</button>
        <button type="button" className={btnClass('ghost')} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** A labelled value that turns into an input on click and saves on blur or Enter. */
function InlineField({ label, value, onSave, type = 'text', options, multiline = false }) {
  const [draft, setDraft] = useState(null);
  const shown = type === 'date' ? dateLabel(value) : value;
  if (draft === null) {
    return (
      <div className="ledger-inline-field"><dt>{label}</dt>
        <dd><button type="button" className="ledger-inline-value" onClick={() => setDraft(value ?? '')}>{shown || <span className="ledger-quiet">Add…</span>}</button></dd></div>
    );
  }
  const save = () => { const next = typeof draft === 'string' ? draft.trim() : draft; setDraft(null); if ((next || null) !== (value || null)) onSave(next || null); };
  const props = { className: 'ledger-input', 'aria-label': label, value: draft, autoFocus: true, onBlur: save, onChange: (e) => setDraft(e.target.value),
    onKeyDown: (e) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); save(); } if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } } };
  return (
    <div className="ledger-inline-field"><dt>{label}</dt><dd>
      {options ? <select {...props}>{options.map((o) => <option key={o}>{o}</option>)}</select>
        : multiline ? <textarea rows={3} {...props} /> : <input type={type} {...props} />}</dd></div>
  );
}

function JsonSection({ section, campaign, onSave }) {
  const stored = campaign[section.key] ?? {};
  const [draft, setDraft] = useState(null);
  const values = draft ?? stored;
  const filled = section.fields.filter(([key]) => String(stored[key] ?? '').trim()).length;
  const save = async (event) => {
    event.preventDefault();
    const clean = Object.fromEntries(Object.entries({ ...stored, ...draft }).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => [k, String(v).trim()]));
    if (await onSave({ [section.key]: clean })) setDraft(null);
  };
  return (
    <details className="ledger-editor-part">
      <summary>{section.label} <span className="ledger-count">{filled}/{section.fields.length}</span></summary>
      <form className="ledger-form" onSubmit={save}>
        {section.fields.map(([key, label, type]) => (
          <Field key={key} label={label} wide={type !== 'date'}>{type === 'date'
            ? <input type="date" className="ledger-input" value={values[key] ?? ''} onChange={(e) => setDraft({ ...values, [key]: e.target.value })} />
            : <textarea className="ledger-input" rows={2} value={values[key] ?? ''} onChange={(e) => setDraft({ ...values, [key]: e.target.value })} />}</Field>))}
        <div className="ledger-actions ledger-form-wide"><button type="submit" className={btnClass('ghost')} disabled={!draft}>Save {section.label.toLowerCase()}</button></div>
      </form>
    </details>
  );
}

export function CampaignDetail({ id, onBack }) {
  const { open } = useLedger();
  const detail = useCreativeCampaign(id);
  const write = useCreativeWrite();
  const [doc, setDoc] = useState(null);
  const [decision, setDecision] = useState(null);
  const [note, setNote] = useState('');
  if (detail.isLoading) return <p className="ledger-quiet">Opening the campaign…</p>;
  if (detail.error) return <><button type="button" className="ledger-link" onClick={onBack}><ArrowLeft size={13} /> All campaigns</button><Message error={detail.error} /></>;
  const c = detail.data;
  const save = async (changes, logText) => {
    try {
      await write.mutateAsync({ op: 'campaign', id: c.id, ...changes });
      if (logText) await write.mutateAsync({ op: 'campaign-note', id: c.id, text: logText });
      return true;
    } catch { return false; }
  };
  const addNote = async () => {
    try { await write.mutateAsync({ op: 'campaign-note', id: c.id, text: note.trim() }); setNote(''); } catch { /* shown */ }
  };
  const stageIndex = STAGES.indexOf(c.stage);
  const off = OFF.includes(c.stage);
  return (
    <article className="ledger-campaign" aria-labelledby="ledger-campaign-name">
      <button type="button" className="ledger-link ledger-back" onClick={onBack}><ArrowLeft size={13} /> All campaigns</button>
      <header className="ledger-campaign-head">
        <p className="ledger-kicker"><BrandMark label={c.brand_label} /> · {c.status}</p>
        <h2 id="ledger-campaign-name">{c.name}</h2>
        <p className="ledger-quiet">{c.done}/{c.total} tasks done · {c.in_review} in review · {c.blocked} blocked{Number(c.spend) ? ` · ${money(c.spend)} spent` : ''}
          {c.launch_date ? ` · launch ${dateLabel(c.launch_date)}${c.days_to_launch >= 0 ? ` (in ${c.days_to_launch} days)` : ''}` : ''}</p>
      </header>
      <ol className="ledger-pipeline" aria-label="Stage">
        {STAGES.map((stage, index) => (
          <li key={stage} data-state={off ? 'off' : index < stageIndex ? 'done' : index === stageIndex ? 'current' : 'next'}>
            <button type="button" aria-current={stage === c.stage ? 'step' : undefined} onClick={() => stage !== c.stage && save({ stage })}>{stage}</button>
          </li>))}
      </ol>
      <div className="ledger-actions">
        {off ? <button type="button" className={btnClass('primary')} onClick={() => save({ stage: 'Developing' }, 'Reactivated')}>Reactivate</button> : <>
          {c.stage !== 'Reviewed' && <button type="button" className={btnClass('primary')} onClick={() => save({ stage: STAGES[stageIndex + 1] })}>
            Advance to {STAGES[stageIndex + 1]} <ArrowRight size={14} /></button>}
          <button type="button" className={btnClass('ghost')} onClick={() => save({ stage: 'Parked' })}>Park</button>
          <button type="button" className={btnClass('ghost')} onClick={() => save({ stage: 'Cancelled' })}>Cancel campaign</button>
        </>}
        {off && <StatusPill status={c.stage} />}
      </div>
      {c.stage === 'Decision' && (
        <section className="ledger-decision" aria-label="Decision">
          <h3>Decision needed</h3>
          <textarea className="ledger-input" rows={3} aria-label="Decision needed" value={decision ?? c.decision ?? ''} onChange={(e) => setDecision(e.target.value)} />
          <div className="ledger-actions">
            <button type="button" className={btnClass('ghost')} disabled={decision === null} onClick={async () => { if (await save({ decision: decision.trim() || null })) setDecision(null); }}>Save decision</button>
            <button type="button" className={btnClass('primary')} onClick={() => save({ stage: 'Approved', ...(decision !== null ? { decision: decision.trim() || null } : {}) })}>Approve</button>
            <button type="button" className={btnClass('ghost')} onClick={() => save({ stage: 'Parked' })}>Park</button>
            <button type="button" className={btnClass('ghost')} onClick={() => save({ stage: 'Cancelled' })}>Cancel</button>
          </div>
        </section>)}
      <Message error={write.error} />
      <dl className="ledger-inline-fields">
        <InlineField label="Name" value={c.name} onSave={(v) => v && save({ name: v })} />
        <InlineField label="Brand" value={c.brand} onSave={(v) => save({ brand: v })} />
        <InlineField label="Priority" value={c.priority} options={PRIORITIES} onSave={(v) => save({ priority: v })} />
        <InlineField label="Launch date" type="date" value={c.launch_date} onSave={(v) => save({ launch_date: v })} />
        <InlineField label="Budget" value={c.budget} onSave={(v) => save({ budget: v })} />
        <InlineField label="Brief link" value={c.brief_link} onSave={(v) => save({ brief_link: v })} />
      </dl>
      <h3 className="ledger-subhead">Plan</h3>
      <dl className="ledger-inline-fields">
        <InlineField label="Objective" value={c.objective} multiline onSave={(v) => save({ objective: v })} />
        <InlineField label="Next action" value={c.next_action} onSave={(v) => save({ next_action: v })} />
        <InlineField label="Milestone" value={c.milestone} onSave={(v) => save({ milestone: v })} />
        <InlineField label="Milestone date" type="date" value={c.milestone_date} onSave={(v) => save({ milestone_date: v })} />
        <InlineField label="Blocker" value={c.blocker} onSave={(v) => save({ blocker: v })} />
        <InlineField label="Notes" value={c.notes} multiline onSave={(v) => save({ notes: v })} />
      </dl>
      {SECTIONS.map((section) => <JsonSection key={section.key} section={section} campaign={c} onSave={save} />)}
      <div className="ledger-actions">
        <button type="button" className={btnClass('ghost')} onClick={() => setDoc('brief')}>Campaign brief</button>
        <button type="button" className={btnClass('ghost')} onClick={() => setDoc('team')}>Team brief</button>
        <button type="button" className={btnClass('ghost')} onClick={() => open('new-task', { patch: { campaign_id: c.id, brand: c.brand ?? null }, note: `For the campaign “${c.name}”` })}>
          Add a task to this campaign</button>
      </div>
      <section className="ledger-section" aria-label="Linked tasks">
        <h3>Tasks <span className="ledger-count">{c.total}</span></h3>
        {c.tasks.length ? <ul className="ledger-plain-list">{c.tasks.map((task) => (
          <li key={task.id}><button type="button" className="ledger-text-button" onClick={() => open('task', task.id)}>{task.title}</button> <StatusPill status={task.status} />
            {task.assignee && <span className="ledger-quiet"> · {task.assignee}</span>}
            {task.deadline && <span className="ledger-quiet"> · due {dateLabel(task.deadline)}</span>}{task.vendor && <span className="ledger-quiet"> · {task.vendor}</span>}</li>))}</ul>
          : <p className="ledger-quiet">{c.total ? 'The tasks on this campaign are assigned to people you do not manage.' : 'No tasks yet.'}</p>}
        {c.tasks.length > 0 && c.tasks.length < c.total && <p className="ledger-quiet">{c.total - c.tasks.length} more are assigned to people you do not manage.</p>}
      </section>
      {c.ideas.length > 0 && (
        <section className="ledger-section" aria-label="Linked ideas">
          <h3>Ideas <span className="ledger-count">{c.ideas.length}</span></h3>
          <ul className="ledger-plain-list">{c.ideas.map((idea) => <li key={idea.id}><button type="button" className="ledger-text-button" onClick={() => open('idea', idea.id)}>{idea.text}</button></li>)}</ul>
        </section>)}
      <section className="ledger-section" aria-label="Log">
        <h3>Log</h3>
        <form className="ledger-inline-form" onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote(); }}>
          <input className="ledger-input" aria-label="Add a note to the log" placeholder="Add a note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
          <button type="submit" className={btnClass('ghost')} disabled={!note.trim() || write.isPending}>Add</button>
        </form>
        <ul className="ledger-plain-list">{c.log.map((line, index) => (
          <li key={index}><span className="ledger-date">{dateLabel(line.at)}</span>{line.text}{line.by && <span className="ledger-quiet"> — {line.by}</span>}</li>))}</ul>
      </section>
      <p><button type="button" className="ledger-text-button ledger-quiet-action" onClick={async () => {
        if (!window.confirm(`Remove “${c.name}”? Its tasks stay; they just stop naming the campaign.`)) return;
        try { await write.mutateAsync({ op: 'remove-campaign', id: c.id }); onBack(); } catch { /* shown */ }
      }}>Remove campaign</button></p>
      {doc && <DocumentDrawer title={doc === 'team' ? 'Team brief' : 'Campaign brief'} subtitle={c.name} text={campaignBrief(c, doc)} onClose={() => setDoc(null)} printable />}
    </article>
  );
}

export default function LedgerCampaigns({ selected, onSelect }) {
  const { today } = useLedger();
  const list = useCreativeCampaigns();
  const [review, setReview] = useState(null);
  const [reviewError, setReviewError] = useState(null);
  const creating = selected === 'new';
  if (selected && !creating) return <CampaignDetail id={selected} onBack={() => onSelect(null)} />;
  const openReview = async () => {
    setReviewError(null);
    try { setReview(groupReview(await fetchCampaignDetails(), { today })); } catch (failure) { setReviewError(failure); }
  };
  const campaigns = list.data ?? [];
  const groups = [...STAGES, ...OFF].map((stage) => ({ stage, items: campaigns.filter((c) => c.stage === stage) })).filter((g) => g.items.length);
  return (
    <div className="ledger-campaigns">
      <div className="ledger-toolbar">
        <p className="ledger-quiet">{campaigns.length} campaign{campaigns.length === 1 ? '' : 's'} shared by the creative team, by stage then launch date.</p>
        <button type="button" className={btnClass('ghost')} onClick={openReview}>Monthly group review</button>
        {!creating && <button type="button" className={btnClass('primary')} onClick={() => onSelect('new')}>New campaign</button>}
      </div>
      {reviewError && <p className="ledger-alert" role="alert">{errorText(reviewError)}</p>}
      {creating && (
        <section className="ledger-section"><h3>New campaign</h3>
          <CampaignForm onSaved={(id) => onSelect(id)} onCancel={() => onSelect(null)} /></section>)}
      {list.isLoading && <p className="ledger-quiet">Loading campaigns…</p>}
      {list.error && <Message error={list.error} />}
      {!list.isLoading && !campaigns.length && <p className="ledger-empty">No campaigns yet.</p>}
      {groups.map((group) => (
        <section key={group.stage} className="ledger-section" aria-label={group.stage}>
          <h3>{group.stage} <span className="ledger-count">{group.items.length}</span></h3>
          <ul className="ledger-campaign-list">{group.items.map((c) => (
            <li key={c.id}>
              <button type="button" className="ledger-campaign-row" onClick={() => onSelect(c.id)}>
                <span className="ledger-item-title">{c.name}</span> <BrandMark label={c.brand_label} />
                <span className="ledger-quiet">{c.done}/{c.total} done{c.in_review ? ` · ${c.in_review} in review` : ''}{c.blocked ? ` · ${c.blocked} blocked` : ''}
                  {c.launch_date ? ` · launch ${dateLabel(c.launch_date)}` : ''}{c.priority === 'High' ? ' · High' : ''}</span>
                {c.next_action && <span className="ledger-campaign-next">Next: {c.next_action}</span>}
              </button>
            </li>))}</ul>
        </section>))}
      {review !== null && <DocumentDrawer title="Monthly group review" text={review || 'No active campaigns.'} onClose={() => setReview(null)} printable />}
    </div>
  );
}
