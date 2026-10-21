// Ideas, shared by the creative team: an inbox you capture into quickly (@brand, #tag), then develop
// with a concept card, park for later, or act on by turning into a task or a campaign.
import React, { useState } from 'react';
import { useCreativeIdeas, useCreativeWrite } from '../../data/creative';
import { parseQuickCapture } from '../../lib/ledger/quickCapture.js';
import Drawer from './Drawer';
import { useBrandNames } from './LedgerCampaigns';
import { BrandMark, Field, Message, Suggest, dateLabel, errorText, useLedger } from './ui';
import { btnClass } from '../ui/Btn';

export const IDEA_TABS = [
  { id: 'Open', label: 'Inbox' }, { id: 'Developing', label: 'Developing' }, { id: 'Parked', label: 'Parked' },
  { id: 'Promoted', label: 'Acted on' }, { id: 'Archived', label: 'Archived' },
];
const CONCEPT = [['oneLine', 'In one line'], ['insight', 'Insight'], ['objective', 'Objective'], ['approach', 'Approach'], ['outputs', 'Outputs'],
  ['needs', 'What it needs'], ['nextAction', 'Next action']];

function IdeaDrawer({ idea, onClose, onCampaign }) {
  const { open } = useLedger();
  const brands = useBrandNames();
  const write = useCreativeWrite();
  const [form, setForm] = useState({ text: idea.text, brand: idea.brand ?? '', tags: (idea.tags ?? []).join(', '), links: idea.links ?? '' });
  const [concept, setConcept] = useState(idea.concept ?? {});
  const [park, setPark] = useState(null);
  const [saved, setSaved] = useState('');
  const run = async (input, message) => {
    setSaved('');
    try { const result = await write.mutateAsync(input); if (message) setSaved(message); return result ?? true; } catch { return null; }
  };
  const save = async (event) => {
    event.preventDefault();
    const changes = {};
    if (form.text.trim() !== idea.text) changes.text = form.text.trim();
    if ((form.brand || null) !== (idea.brand || null)) changes.brand = form.brand || null;
    if (form.tags !== (idea.tags ?? []).join(', ')) changes.tags = form.tags;
    if ((form.links || null) !== (idea.links || null)) changes.links = form.links || null;
    if (JSON.stringify(concept) !== JSON.stringify(idea.concept ?? {})) {
      changes.concept = Object.fromEntries(CONCEPT.map(([key]) => [key, concept[key]?.trim()]).filter(([, value]) => value));
    }
    if (!Object.keys(changes).length) { setSaved('Nothing changed.'); return; }
    await run({ op: 'idea', id: idea.id, ...changes }, 'Saved.');
  };
  const setStatus = (status, extra = {}) => run({ op: 'idea', id: idea.id, status, ...extra }, `Moved to ${IDEA_TABS.find((t) => t.id === status)?.label}.`);
  const toCampaign = async () => {
    const result = await run({ op: 'idea-to-campaign', id: idea.id });
    if (result?.id) { onClose(); onCampaign(result.id); }
  };
  const toTask = () => {
    onClose();
    open('new-task', { title: concept.oneLine?.trim() || idea.text, description: [idea.text, concept.objective && `Objective: ${concept.objective}`].filter(Boolean).join('\n\n'),
      patch: { brand: idea.brand ?? null }, ideaId: idea.id, note: 'From an idea' });
  };
  return (
    <Drawer title="Idea" subtitle={[idea.status, `captured ${dateLabel(idea.created_at)}`, idea.by && `by ${idea.by}`].filter(Boolean).join(' · ')}
      onClose={onClose} initialFocus="#ledger-idea-text"
      footer={<button type="submit" form="ledger-idea" className={btnClass('primary')} disabled={write.isPending}>Save</button>}>
      <form id="ledger-idea" className="ledger-form" onSubmit={save}>
        <Field label="Idea" wide><textarea id="ledger-idea-text" className="ledger-input" rows={3} value={form.text} maxLength={4000}
          onChange={(e) => setForm({ ...form, text: e.target.value })} /></Field>
        {idea.edited && <p className="ledger-quiet ledger-form-wide">First written as: “{idea.original}”</p>}
        <Field label="Brand"><Suggest value={form.brand} onChange={(v) => setForm({ ...form, brand: v })} options={brands} maxLength={80} /></Field>
        <Field label="Tags" hint="comma separated"><input className="ledger-input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} /></Field>
        <Field label="Links" wide><textarea className="ledger-input" rows={2} value={form.links} onChange={(e) => setForm({ ...form, links: e.target.value })} /></Field>
        <fieldset className="ledger-concept ledger-form-wide">
          <legend>Concept card</legend>
          {CONCEPT.map(([key, label]) => (
            <Field key={key} label={label} wide><textarea className="ledger-input" rows={key === 'oneLine' ? 1 : 2} value={concept[key] ?? ''}
              onChange={(e) => setConcept({ ...concept, [key]: e.target.value })} /></Field>))}
        </fieldset>
        {idea.revisit_date && <p className="ledger-quiet ledger-form-wide">Revisit {dateLabel(idea.revisit_date)}{idea.revisit_when ? ` — when ${idea.revisit_when}` : ''}</p>}
        {idea.task_title && <p className="ledger-quiet ledger-form-wide">Became the task <button type="button" className="ledger-link" onClick={() => { onClose(); open('task', idea.task_id); }}>{idea.task_title}</button>.</p>}
        {idea.campaign_name && <p className="ledger-quiet ledger-form-wide">Became the campaign <button type="button" className="ledger-link" onClick={() => { onClose(); onCampaign(idea.campaign_id); }}>{idea.campaign_name}</button>.</p>}
      </form>
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
              <button type="button" className={btnClass('ghost')} onClick={toTask}>To task</button>
              <button type="button" className={btnClass('ghost')} onClick={toCampaign}>To campaign</button>
            </>}
            {idea.status !== 'Parked' && <button type="button" className={btnClass('ghost')} onClick={() => setPark({ date: '', when: '' })}>Park</button>}
            {['Parked', 'Archived'].includes(idea.status) && <button type="button" className={btnClass('ghost')} onClick={() => setStatus('Open')}>Back to inbox</button>}
            {idea.status !== 'Archived' && <button type="button" className={btnClass('ghost')} onClick={() => setStatus('Archived')}>Archive</button>}
            <button type="button" className="ledger-text-button ledger-quiet-action" onClick={async () => {
              if (window.confirm('Remove this idea?') && await run({ op: 'remove-idea', id: idea.id })) onClose();
            }}>Remove</button>
          </div>)}
      </div>
      <Message error={write.error}>{saved}</Message>
    </Drawer>
  );
}

/** idea: text @brand #tag — the same capture the quick-add bar uses. */
export function ideaFromText(text, today) {
  const parsed = parseQuickCapture(`idea: ${text}`, { today });
  return parsed.text ? { text: parsed.text, brand: parsed.brand ?? null, tags: parsed.tags ?? [] } : null;
}

export default function LedgerIdeas({ selected, onSelect, onCampaign }) {
  const { today } = useLedger();
  const ideas = useCreativeIdeas();
  const write = useCreativeWrite();
  const [tab, setTab] = useState('Open');
  const [text, setText] = useState('');
  const all = ideas.data ?? [];
  const shown = all.filter((idea) => idea.status === tab);
  const current = selected ? all.find((idea) => idea.id === selected) : null;
  const add = async (event) => {
    event.preventDefault();
    const idea = ideaFromText(text, today);
    if (!idea) return;
    try { await write.mutateAsync({ op: 'add-idea', ...idea }); setText(''); setTab('Open'); }
    catch { /* shown below */ }
  };
  return (
    <div className="ledger-ideas">
      <div className="ledger-segmented" role="radiogroup" aria-label="Ideas">
        {IDEA_TABS.map((item) => (
          <button key={item.id} type="button" role="radio" aria-checked={tab === item.id} className="ledger-segment" onClick={() => setTab(item.id)}>
            {item.label} <span className="ledger-count">{all.filter((idea) => idea.status === item.id).length}</span></button>))}
      </div>
      <form className="ledger-inline-form ledger-idea-add" onSubmit={add}>
        <input className="ledger-input" aria-label="New idea" placeholder="Capture an idea… @jewels #festive" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className={btnClass('primary')} disabled={!text.trim() || write.isPending}>Add idea</button>
      </form>
      {write.error && <p className="ledger-alert" role="alert">{errorText(write.error)}</p>}
      {ideas.isLoading && <p className="ledger-quiet">Loading ideas…</p>}
      {ideas.error && <Message error={ideas.error} />}
      {!ideas.isLoading && !shown.length && <p className="ledger-empty">Nothing in {IDEA_TABS.find((t) => t.id === tab).label.toLowerCase()}.</p>}
      <ul className="ledger-rows-list">
        {shown.map((idea) => (
          <li key={idea.id}>
            <button type="button" className="ledger-idea-row" onClick={() => onSelect(idea.id)}>
              <span className="ledger-item-title">{idea.text}</span>
              <span className="ledger-quiet"><BrandMark label={idea.brand} />{(idea.tags ?? []).map((tag) => ` #${tag}`).join('')} · {dateLabel(idea.created_at)}
                {idea.by ? ` · ${idea.by}` : ''}{idea.revisit_date ? ` · revisit ${dateLabel(idea.revisit_date)}` : ''}
                {idea.task_title ? ` · task: ${idea.task_title}` : ''}{idea.campaign_name ? ` · campaign: ${idea.campaign_name}` : ''}</span>
            </button>
          </li>))}
      </ul>
      {current && <IdeaDrawer key={current.id} idea={current} onClose={() => onSelect(null)} onCampaign={onCampaign} />}
    </div>
  );
}
