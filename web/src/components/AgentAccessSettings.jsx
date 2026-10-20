import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Check, ChevronRight, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useMyAgentAccess, useMyAgentKeys } from '../data/developerSettings';
import { supabase } from '../lib/supabaseClient';
import {
  AGENT_KEY_EXPIRY_DAYS, AGENT_KEY_SCOPES, agentEndpoint, createMyAgentKey, developerKeyStatus, hermesConfig,
  myAgentKeysKey, revokeMyAgentKey, scopeLabel,
} from '../lib/developerSettings';
import FormSection, { Field, FormError } from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import { SkeletonRows } from './ui/Skeleton';
import { CopyValue } from './DeveloperSettings';
import './developerSettings.css';

const dateLabel = value => {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function currentEndpoint() {
  const origin = typeof window !== 'undefined' && /^https?:$/.test(window.location?.protocol) ? window.location.origin : '';
  return agentEndpoint(import.meta.env.VITE_PUBLIC_APP_URL, origin);
}

/** Settings → AI assistant: a person's own keys for Hermes, which acts as them. */
export default function AgentAccessSettings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const access = useMyAgentAccess();
  const allowed = access.data?.allowed === true;
  const enabled = access.data?.enabled === true;
  const keys = useMyAgentKeys(allowed);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const activeCount = (keys.data ?? []).filter(key => developerKeyStatus(key) === 'active').length;

  const revoke = async () => {
    if (busy || !confirm) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await revokeMyAgentKey(supabase, confirm.id);
      if (created?.key.id === confirm.id) setCreated(null);
      queryClient.setQueryData(myAgentKeysKey(user?.id), current => current?.map(key => key.id === confirm.id ? { ...key, revoked_at: new Date().toISOString() } : key));
      await keys.refetch();
      setConfirm(null); setNotice('Key revoked. Hermes can no longer use it.');
    } catch (err) { setError(err.message || 'Could not revoke this key. Please try again.'); }
    finally { setBusy(false); }
  };
  const confirmation = confirm && <ConfirmDialog title="Revoke assistant key?" confirmLabel="Revoke key" busy={busy} error={error}
    onCancel={() => { if (!busy) { setConfirm(null); setError(''); } }} onConfirm={revoke}>
    <p><strong>{confirm.name}</strong> will stop working immediately. Create a new key if you connect Hermes again.</p>
  </ConfirmDialog>;

  let body;
  if (access.isLoading) body = <SkeletonRows rows={2} avatar={false} label="Loading AI assistant settings" />;
  else if (access.error) {
    body = <div className="developer-empty"><FormError message={access.error.message || 'AI assistant settings could not be loaded.'} />
      <button type="button" className={btnClass('ghost')} onClick={() => access.refetch()}>Try again</button></div>;
  } else if (!allowed) {
    body = <p className="developer-copy-note">Your role does not include connecting an AI assistant. Ask your administrator if you need it.</p>;
  } else {
    body = <>
      {!enabled && <p className="developer-copy-note">Your administrator has not turned on AI assistant access yet. Keys you create will work once it is on.</p>}
      {notice && <p role="status" className="developer-notice"><Check size={16} />{notice}</p>}
      {error && !confirm && <FormError message={error} />}
      {created && <AgentKeyCreated value={created.api_key} name={created.key.name} endpoint={currentEndpoint()} onDone={() => setCreated(null)} />}
      {showCreate && <AgentKeyForm onClose={() => setShowCreate(false)} onCreated={result => {
        setCreated(result); setShowCreate(false); setNotice('');
        queryClient.setQueryData(myAgentKeysKey(user?.id), current => [result.key, ...(current ?? []).filter(key => key.id !== result.key.id)]);
        keys.refetch();
      }} />}
      {keys.isLoading ? <SkeletonRows rows={2} avatar={false} label="Loading your keys" />
        : keys.error ? <div className="developer-empty"><FormError message="Your keys could not be loaded." /><button type="button" className={btnClass('ghost')} onClick={() => keys.refetch()}>Try again</button></div>
          : keys.data?.length ? <div className="developer-key-list">{keys.data.map(key => <AgentKeyRow key={key.id} item={key}
            onRevoke={() => { setError(''); setNotice(''); setConfirm(key); }} />)}</div>
            : !showCreate && !created && <p className="agent-access-empty">You have no assistant keys yet.</p>}
    </>;
  }

  return <div className="developer-settings agent-access">
    <section className="premium-card" aria-labelledby="agent-access-title">
      <div className="developer-section-heading">
        <div><h2 id="agent-access-title"><Bot size={18} /> Connect an AI assistant</h2>
          <p>Hermes can manage tasks, requests, leave approvals, assets and goals for you from chat.</p></div>
        {allowed && <button type="button" className={btnClass('primary')} disabled={showCreate || Boolean(created) || keys.isLoading || activeCount >= 5}
          onClick={() => { setShowCreate(true); setNotice(''); setError(''); }}><Plus size={16} /> Create key</button>}
      </div>
      <ul className="agent-access-rules">
        <li>It acts as you. Everything it does shows your name.</li>
        <li>It can only do what your role already allows here.</li>
        <li>It cannot delete anything, and has no access to attendance, payroll or documents.</li>
      </ul>
      {body}
    </section>
    {confirmation && (typeof document === 'undefined' ? confirmation : createPortal(confirmation, document.body))}
  </div>;
}

export function AgentKeyForm({ onClose, onCreated }) {
  const id = useId();
  const [name, setName] = useState('Hermes');
  const [scopes, setScopes] = useState(['tasks:manage']);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) { setError('Give this key a name.'); return; }
    if (!scopes.length) { setError('Choose at least one area.'); return; }
    setError(''); setBusy(true);
    try { onCreated(await createMyAgentKey(supabase, { name: name.trim(), scopes, expiresInDays })); }
    catch (err) { setError(err.message || 'Could not create this key. Please try again.'); }
    finally { setBusy(false); }
  };
  return <FormSection title="Create assistant key" subtitle="Choose what Hermes may manage for you." icon={KeyRound}
    onClose={busy ? undefined : onClose} onSubmit={submit} submitLabel={busy ? 'Creating…' : 'Create key'} busy={busy} error={error}>
    <Field label="Key name" htmlFor={`${id}-name`} required><input id={`${id}-name`} className="developer-input" autoComplete="off"
      placeholder="e.g. Hermes on my laptop" required maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Field>
    <fieldset className="developer-scopes" disabled={busy}><legend>Areas</legend><p>Hermes can look up people and departments you can see, plus the areas you tick.</p>
      {AGENT_KEY_SCOPES.map(scope => <label key={scope.key} className="developer-scope-choice"><input type="checkbox" checked={scopes.includes(scope.key)}
        onChange={event => setScopes(current => event.target.checked ? [...current, scope.key] : current.filter(key => key !== scope.key))} />
        <span><strong>{scope.label}</strong><small>{scope.description}</small></span></label>)}</fieldset>
    <Field label="Expires after" htmlFor={`${id}-expiry`}><select id={`${id}-expiry`} className="developer-input" value={expiresInDays}
      onChange={event => setExpiresInDays(Number(event.target.value))} disabled={busy}>{AGENT_KEY_EXPIRY_DAYS.map(days => <option key={days} value={days}>{days} days</option>)}</select></Field>
  </FormSection>;
}

export function AgentKeyCreated({ value, name, endpoint, onDone }) {
  const panel = useRef(null);
  const id = useId();
  const config = hermesConfig(endpoint, value);
  useEffect(() => {
    const frame = requestAnimationFrame(() => panel.current?.scrollIntoView({ block: 'start', behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, []);
  return <section ref={panel} className="developer-created agent-access-created scroll-mt-4" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}><Check size={16} /> {name} is ready</h3>
    <p>This is the only time the key is shown. Paste the block below into <code>~/.hermes/config.yaml</code> on the computer that runs Hermes, then type <code>/reload-mcp</code> in Hermes.</p>
    <div className="developer-guide-heading"><h4>Hermes setup</h4><CopyValue value={config} label="Copy setup" ariaLabel="Copy Hermes setup" manualLabel="Hermes setup" tone="primary" /></div>
    <pre className="developer-code"><code>{config}</code></pre>
    <div className="developer-guide-heading"><h4>Key only</h4><CopyValue value={value} label="Copy key" ariaLabel="Copy new assistant key" manualLabel="Full assistant key" /></div>
    <p className="developer-key-hint">Anyone with this key can act as you in the areas you chose. Keep it private, and revoke it if it is ever shared.</p>
    <button type="button" className={btnClass('ghost')} onClick={onDone}>Done, hide key <ChevronRight size={15} /></button>
  </section>;
}

export function AgentKeyRow({ item, onRevoke }) {
  const state = developerKeyStatus(item);
  const status = state[0].toUpperCase() + state.slice(1);
  return <article className="developer-key-row">
    <div className="developer-key-title"><div><h3>{item.name}</h3><code>{item.key_prefix}••••••••</code></div><span className="developer-status" data-status={state}>{status}</span></div>
    <div className="developer-key-scopes">{item.scopes.map(scope => <span key={scope}>{scopeLabel(scope)}</span>)}</div>
    <dl className="developer-key-meta"><div><dt>Created</dt><dd>{dateLabel(item.created_at)}</dd></div><div><dt>Expires</dt><dd>{dateLabel(item.expires_at)}</dd></div>
      <div><dt>Last used</dt><dd>{dateLabel(item.last_used_at)}</dd></div></dl>
    {state !== 'revoked' && <div className="developer-key-actions"><button type="button" className={`${btnClass('ghost')} developer-revoke`} onClick={onRevoke}
      aria-label={`Revoke key ${item.name}`}><Trash2 size={14} /> Revoke key</button></div>}
  </article>;
}
