// Ideas: an inbox you capture into quickly (@brand, #tag), then develop with a concept card, park
// for later, or act on by turning into a task or a campaign.
import React, { useState } from 'react';
import { newId, useLedgerAction, useLedgerIdeas } from '../../data/workLedger';
import { parseQuickCapture } from '../../lib/ledger/quickCapture.js';
import Drawer from './Drawer';
import { BrandMark, Field, Message, Suggest, dateLabel, errorText, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

export const IDEA_TABS = [
  { id: 'Open', label: 'Inbox' }, { id: 'Developing', label: 'Developing' }, { id: 'Parked', label: 'Parked' },
  { id: 'Promoted', label: 'Acted on' }, { id: 'Archived', label: 'Archived' },
];
const CONCEPT = [['oneLine', 'In one line'], ['insight', 'Insight'], ['objective', 'Objective'], ['approach', 'Approach'], ['outputs', 'Outputs'],
  ['needs', 'What it needs'], ['nextAction', 'Next action']];

function IdeaDrawer({ idea, onClose, onCampaign }) {
  const { readOnly, boot, open } = useLedger();
  const act = useLedgerAction();
  const [form, setForm] = useState({ text: idea.text, brand: idea.brand ?? '', tags: (idea.tags ?? []).join(', '), links: idea.links ?? '' });
  const [concept, setConcept] = useState(idea.concept ?? {});
  const [park, setPark] = useState(null);
  const [saved, setSaved] = useState('');
  const run = async (name, args, message) => {
    setSaved('');
    try { const result = await act.mutateAsync({ name, args }); if (message) setSaved(message); return result ?? true; } catch { return null; }
  };
  const save = async (event) => {
    event.preventDefault();
    const changes = {};
    if (form.text.trim() !== idea.text) changes.text = form.text.trim();
    if ((form.brand || null) !== (idea.brand || null)) changes.brand = form.brand || null;
    if (form.tags !== (idea.tags ?? []).join(', ')) changes.tags = form.tags;
    if ((form.links || null) !== (idea.links || null)) changes.links = form.links || null;
    if (JSON.stringify(concept) !== JSON.stringify(idea.concept ?? {})) changes.concept = Object.fromEntries(CONCEPT.map(([key]) => [key, concept[key]?.trim() || null]));
    if (!Object.keys(changes).length) { setSaved('Nothing changed.'); return; }
    await run('ledger_update_idea', { _id: idea.id, _u: changes }, 'Saved.');
  };
  const setStatus = (status, extra = {}) => run('ledger_update_idea', { _id: idea.id, _u: { status, ...extra } }, `Moved to ${IDEA_TABS.find((t) => t.id === status)?.label}.`);
  const toCampaign = async () => {
    const id = newId();
    const result = await run('ledger_idea_to_campaign', { _idea: idea.id, _campaign: id });
    if (result) { onClose(); onCampaign(result.id ?? id); }
  };
  const disabled = readOnly;
  return (
    <Drawer title="Idea" subtitle={`${idea.status} · captured ${dateLabel(idea.created_at)}`} onClose={onClose} initialFocus="#ledger-idea-text"
      footer={!disabled && <button type="submit" form="ledger-idea" className={btnClass('primary')} disabled={act.isPending}>Save</button>}>
      <form id="ledger-idea" className="ledger-form" onSubmit={save}>
        <Field label="Idea" wide><textarea id="ledger-idea-text" className="ledger-input" rows={3} disabled={disabled} value={form.text} maxLength={4000}
          onChange={(e) => setForm({ ...form, text: e.target.value })} /></Field>
        {idea.edited && <p className="ledger-quiet ledger-form-wide">First written as: “{idea.original}”</p>}
        <Field label="Brand"><Suggest disabled={disabled} value={form.brand} onChange={(v) => setForm({ ...form, brand: v })} options={(boot?.brands ?? []).map((b) => b.name)} maxLength={80} /></Field>
        <Field label="Tags" hint="comma separated"><input className="ledger-input" disabled={disabled} value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></Field>
        <Field label="Links" wide><textarea className="ledger-input" rows={2} disabled={disabled} value={form.links} onChange={(e) => setForm({ ...form, links: e.target.value })} /></Field>
        <fieldset className="ledger-concept ledger-form-wide">
          <legend>Concept card</legend>
          {CONCEPT.map(([key, label]) => (
            <Field key={key} label={label} wide><textarea className="ledger-input" rows={key === 'oneLine' ? 1 : 2} disabled={disabled} value={concept[key] ?? ''}
              onChange={(e) => setConcept({ ...concept, [key]: e.target.value })} /></Field>))}
        </fieldset>
        {idea.revisit_date && <p className="ledger-quiet ledger-form-wide">Revisit {dateLabel(idea.revisit_date)}{idea.revisit_when ? ` — when ${idea.revisit_when}` : ''}</p>}
        {idea.task_title && <p className="ledger-quiet ledger-form-wide">Became the task “{idea.task_title}”.</p>}
        {idea.campaign_name && <p className="ledger-quiet ledger-form-wide">Became the campaign <button type="button" className="ledger-link" onClick={() => { onClose(); onCampaign(idea.campaign_id); }}>{idea.campaign_name}</button>.</p>}
      </form>
      {!disabled && (
        <div className="ledger-idea-actions">
          {park ? (
            <form className="ledger-inline-form" onSubmit={async (e) => { e.preventDefault(); if (await setStatus('Parked', { revisit_date: park.date || null, revisit_when: park.when || null })) setPark(null); }}>
              <input type="date" className="ledger-input ledger-input-date" aria-label="Revisit on" value={park.date} onChange={(e) => setPark({ ...park, date: e.target.value })} />
              <input className="ledger-input" aria-label="Revisit when" placeholder="Revisit when… (e.g. budget frees up)" value={park.when} onChange={(e) => setPark({ ...park, when: e.target.value })} />
              <button type="submit" className={btnClass('ghost')}>Park it</button>
              <button type="button" className={btnClass('ghost')} onClick={() => setPark(null)}>Cancel</button>
            </form>
          ) : (
            <div className="ledger-actions">
              {idea.status !== 'Promoted' && <>
                <button type="button" className={btnClass('ghost')} onClick={() => { onClose(); open('task', { task: idea.text, brand: idea.brand ?? 'General', idea_id: idea.id,
                  brief: { objective: concept.objective ?? '' } }); }}>To task</button>
                <button type="button" className={btnClass('ghost')} onClick={toCampaign}>To campaign</button>
              </>}
              {idea.status !== 'Parked' && <button type="button" className={btnClass('ghost')} onClick={() => setPark({ date: '', when: '' })}>Park</button>}
              {['Parked', 'Archived'].includes(idea.status) && <button type="button" className={btnClass('ghost')} onClick={() => setStatus('Open')}>Back to inbox</button>}
              {idea.status !== 'Archived' && <button type="button" className={btnClass('ghost')} onClick={() => setStatus('Archived')}>Archive</button>}
              <button type="button" className="ledger-text-button ledger-quiet-action" onClick={async () => {
                if (window.confirm('Delete this idea?') && await run('ledger_delete_idea', { _id: idea.id })) onClose();
              }}>Delete</button>
            </div>)}
        </div>)}
      <Message error={act.error}>{saved}</Message>
    </Drawer>
  );
}

export default function LedgerIdeas({ selected, onSelect, onCampaign }) {
  const { owner, readOnly, today } = useLedger();
  const ideas = useLedgerIdeas(null, owner);
  const act = useLedgerAction();
  const [tab, setTab] = useState('Open');
  const [text, setText] = useState('');
  const all = ideas.data ?? [];
  const shown = all.filter((idea) => idea.status === tab);
  const current = selected ? all.find((idea) => idea.id === selected) : null;
  const add = async (event) => {
    event.preventDefault();
    const parsed = parseQuickCapture(`idea: ${text}`, { today });
    if (!parsed.text) return;
    try { await act.mutateAsync({ name: 'ledger_add_idea', args: { _id: newId(), _text: parsed.text, _brand: parsed.brand ?? null, _tags: parsed.tags ?? [] } }); setText(''); setTab('Open'); }
    catch { /* shown below */ }
  };
  return (
    <div className="ledger-ideas">
      <div className="ledger-segmented" role="radiogroup" aria-label="Ideas">
        {IDEA_TABS.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={tab === item.id} className="ledger-segment" onClick={() => setTab(item.id)}>
            {item.label} <span className="ledger-count">{all.filter((idea) => idea.status === item.id).length}</span></button>))}
      </div>
      {!readOnly && (
        <form className="ledger-inline-form ledger-idea-add" onSubmit={add}>
          <input className="ledger-input" aria-label="New idea" placeholder="Capture an idea… @jewels #festive" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
          <button type="submit" className={btnClass('primary')} disabled={!text.trim() || act.isPending}>Add idea</button>
        </form>)}
      {act.error && <p className="ledger-alert" role="alert">{errorText(act.error)}</p>}
      {ideas.isLoading && <p className="ledger-quiet">Loading ideas…</p>}
      {ideas.error && <Message error={ideas.error} />}
      {!ideas.isLoading && !shown.length && <p className="ledger-empty">Nothing in {IDEA_TABS.find((t) => t.id === tab).label.toLowerCase()}.</p>}
      <ul className="ledger-rows-list">
        {shown.map((idea) => (
          <li key={idea.id}>
            <button type="button" className="ledger-idea-row" onClick={() => onSelect(idea.id)}>
              <span className="ledger-item-title">{idea.text}</span>
              <span className="ledger-quiet"><BrandMark label={idea.brand} />{(idea.tags ?? []).map((tag) => ` #${tag}`).join('')} · {dateLabel(idea.created_at)}
                {idea.revisit_date ? ` · revisit ${dateLabel(idea.revisit_date)}` : ''}{idea.task_title ? ` · task: ${idea.task_title}` : ''}{idea.campaign_name ? ` · campaign: ${idea.campaign_name}` : ''}</span>
            </button>
          </li>))}
      </ul>
      {current && <IdeaDrawer key={current.id} idea={current} onClose={() => onSelect(null)} onCampaign={onCampaign} />}
    </div>
  );
}
