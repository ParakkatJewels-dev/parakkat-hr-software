import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Code2, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { usePermissions } from '../auth/usePermissions';
import { useAuth } from '../auth/AuthContext';
import { useDeveloperSettings, useDeveloperKeys } from '../data/developerSettings';
import { useVisibleOrg } from '../data/org';
import { supabase } from '../lib/supabaseClient';
import { API_KEY_SCOPES, API_KEY_EXPIRY_DAYS, developerSettingsKey, developerKeysKey, developerKeyStatus, createDeveloperKey, revokeDeveloperKey, saveDeveloperSettings } from '../lib/developerSettings';
import FormSection, { Field, FormError } from './ui/FormSection';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import { Skeleton, SkeletonRows } from './ui/Skeleton';
import Pagination, { usePagination } from './ui/Pagination';
import './developerSettings.css';

const dateLabel = value => {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export default function DeveloperSettings() {
  const { isSuperAdmin } = usePermissions();
  if (!isSuperAdmin) return <div className="page-shell developer-settings"><section className="premium-card developer-restricted"><ShieldCheck size={24} /><h1>Access restricted</h1><p>Developer Settings is available to super admins.</p></section></div>;
  return <DeveloperWorkspace />;
}

function DeveloperWorkspace() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const settings = useDeveloperSettings();
  const keys = useDeveloperKeys();
  const org = useVisibleOrg();
  const [showCreate, setShowCreate] = useState(false);
  const [replacement, setReplacement] = useState(null);
  const [created, setCreated] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const keyPager = usePagination(keys.data ?? [], 10, created?.key.id, user?.id);
  const createPanel = useRef(null);
  useEffect(() => {
    if (!showCreate) return undefined;
    const frame = requestAnimationFrame(() => {
      createPanel.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      createPanel.current?.querySelector('input')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [showCreate, replacement?.id]);
  const enabled = settings.data?.enabled === true;
  const changeEnabled = async next => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const saved = await saveDeveloperSettings(supabase, next);
      queryClient.setQueryData(developerSettingsKey(user?.id), saved);
      await settings.refetch();
      setConfirm(null);
      setNotice(next ? 'API access enabled.' : 'API access disabled. Your keys are still saved.');
    } catch (err) { setError(err.message || 'Could not update API access. Please try again.'); }
    finally { setBusy(false); }
  };
  const revoke = async () => {
    if (busy || !confirm?.key) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await revokeDeveloperKey(supabase, confirm.key.id);
      if (created?.key.id === confirm.key.id) setCreated(null);
      queryClient.setQueryData(developerKeysKey(user?.id), current => current?.map(key => key.id === confirm.key.id ? { ...key, revoked_at: new Date().toISOString() } : key));
      await keys.refetch();
      setConfirm(null); setNotice('API key revoked. It can no longer access your data.');
    } catch (err) { setError(err.message || 'Could not revoke this key. Please try again.'); }
    finally { setBusy(false); }
  };
  const openConfirm = value => { setError(''); setNotice(''); setConfirm(value); };
  const confirmation = confirm && <ConfirmDialog title={confirm.type === 'disable' ? 'Disable API access?' : 'Revoke API key?'} confirmLabel={confirm.type === 'disable' ? 'Disable access' : 'Revoke key'} busy={busy} error={error} onCancel={() => { if (!busy) { setConfirm(null); setError(''); } }} onConfirm={confirm.type === 'disable' ? () => changeEnabled(false) : revoke}>
    {confirm.type === 'disable' ? <p>All integrations will stop reading HR data immediately. Your saved keys will work again when you enable access, if they have not expired or been revoked.</p> : <p><strong>{confirm.key.name}</strong> will stop working immediately. This cannot be undone; create a new key if this integration needs access again.</p>}
  </ConfirmDialog>;
  return <div className="page-shell developer-settings animate-fade-in">
    <header className="developer-heading">
      <p className="developer-eyebrow"><ShieldCheck size={13} /> Administration</p>
      <h1>Developer Settings</h1>
      <p>Connect your tools to HR data with scoped, read-only API keys.</p>
    </header>

    <section className="premium-card developer-access" aria-labelledby="developer-access-title">
      <div className="developer-access-icon"><Code2 size={23} /></div>
      <div className="developer-access-copy"><div className="developer-title-line"><h2 id="developer-access-title">API access</h2>{settings.data && <span className="developer-status" data-status={enabled ? 'active' : 'disabled'}>{enabled ? 'Enabled' : 'Disabled'}</span>}</div>
        <p>{enabled ? 'Your active keys can read the data you have allowed.' : 'Enable access when you are ready to connect an integration.'}</p>
      </div>
      {settings.isLoading ? <Skeleton className="h-7 w-12 rounded-full" /> : <button type="button" className="developer-switch" role="switch" aria-checked={enabled} aria-label="Enable API access" disabled={busy || Boolean(settings.error) || !settings.data}
        onClick={() => enabled ? openConfirm({ type: 'disable' }) : changeEnabled(true)}><span /></button>}
      {settings.error && <div className="developer-access-error"><FormError message="API settings could not be loaded." /><button type="button" className={btnClass('ghost')} onClick={() => settings.refetch()}>Try again</button></div>}
    </section>

    {notice && <p role="status" className="developer-notice"><Check size={16} />{notice}</p>}
    {error && !confirm && <FormError message={error} />}

    <div className="developer-layout">
      <div className="developer-main">
        {created && <CreatedKey value={created.api_key} name={created.key.name} onDone={() => setCreated(null)} />}

        <section className="premium-card developer-key-section" aria-labelledby="developer-keys-title">
          <div className="developer-section-heading"><div><h2 id="developer-keys-title"><KeyRound size={18} /> API keys</h2><p>Give each integration its own key and access level.</p></div>
            <button type="button" className={btnClass('primary')} disabled={showCreate || Boolean(created) || Boolean(keys.error) || keys.isLoading} onClick={() => { setReplacement(null); setShowCreate(true); setNotice(''); setError(''); }}><Plus size={16} /> Create key</button>
          </div>
          <p className="developer-copy-note">Full keys are shown only once, immediately after creation. If you did not save a key, create a replacement to get a new one you can copy.</p>
          {showCreate && <div ref={createPanel} className="scroll-mt-4"><CreateKeyForm key={replacement?.id ?? 'new'} initialKey={replacement} entities={org.data?.entities ?? []} orgError={org.error} orgLoading={org.isLoading} onClose={() => setShowCreate(false)} onCreated={result => {
            setCreated(result); setShowCreate(false);
            queryClient.setQueryData(developerKeysKey(user?.id), current => [result.key, ...(current ?? []).filter(key => key.id !== result.key.id)]);
            keys.refetch();
          }} /></div>}
          {keys.isLoading ? <SkeletonRows rows={3} avatar={false} label="Loading API keys" /> : keys.error ? <div className="developer-empty"><FormError message="API keys could not be loaded." /><button type="button" className={btnClass('ghost')} onClick={() => keys.refetch()}>Try again</button></div> : keys.data?.length ? <><div className="developer-key-list">{keyPager.slice.map(key => <KeyRow key={key.id} item={key} entity={org.data?.entities?.find(entity => entity.id === key.entity_id)} secret={created?.key.id === key.id ? created.api_key : null}
            replacementDisabled={showCreate || Boolean(created)} onReplace={() => { setReplacement(key); setShowCreate(true); setNotice(''); setError(''); }} onRevoke={() => openConfirm({ type: 'revoke', key })} />)}</div><Pagination {...keyPager} noun="API keys" sizes={[10, 25, 50]} disabled={busy || showCreate} /></> : <div className="developer-empty"><span className="developer-empty-icon"><KeyRound size={25} /></span><h3>No API keys yet</h3><p>Create a key for your first integration. Choose what it can read and when it expires.</p></div>}
        </section>
      </div>
      <GettingStarted />
    </div>
    {confirmation && (typeof document === 'undefined' ? confirmation : createPortal(confirmation, document.body))}
  </div>;
}

export function CreateKeyForm({ entities, orgError, orgLoading, initialKey = null, onClose, onCreated }) {
  const id = useId();
  const [name, setName] = useState(initialKey ? `${[...initialKey.name].slice(0, 66).join('')} (replacement)` : '');
  const [scopes, setScopes] = useState(initialKey ? [...initialKey.scopes] : ['employees:read']);
  const [entityId, setEntityId] = useState(initialKey?.entity_id ?? '');
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const missingCompany = Boolean(entityId && !orgLoading && !entities.some(entity => entity.id === entityId));
  const submit = async event => {
    event.preventDefault();
    if (busy || orgError || orgLoading || missingCompany) return;
    if (!name.trim()) { setError('Give this key a name.'); return; }
    if (!scopes.length) { setError('Choose at least one type of data this key can read.'); return; }
    setError(''); setBusy(true);
    try { onCreated(await createDeveloperKey(supabase, { name: name.trim(), scopes, entityId: entityId || null, expiresInDays })); }
    catch (err) { setError(err.message || 'Could not create this key. Please try again.'); }
    finally { setBusy(false); }
  };
  return <FormSection title={initialKey ? 'Create replacement key' : 'Create API key'} subtitle={initialKey ? 'Copy the new key into your integration, then revoke the old key when you are ready.' : 'Creating a key does not enable API access.'} icon={KeyRound} onClose={busy ? undefined : onClose} onSubmit={submit} submitLabel={busy ? 'Creating…' : initialKey ? 'Create replacement key' : 'Create API key'} busy={busy} error={error} disabled={Boolean(orgError) || orgLoading || missingCompany}>
    {initialKey && <p className="developer-replacement-note">This creates a separate key. It does not revoke <strong>{initialKey.name}</strong> or enable API access.</p>}
    <Field label="Key name" htmlFor={`${id}-name`} required><input id={`${id}-name`} className="developer-input" autoComplete="off" placeholder="e.g. Reporting dashboard" required maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></Field>
    <fieldset className="developer-scopes" disabled={busy}><legend>Data access</legend><p>Each permission allows reading only.</p>{API_KEY_SCOPES.map(scope => <label key={scope.key} className="developer-scope-choice"><input type="checkbox" checked={scopes.includes(scope.key)} onChange={event => setScopes(current => event.target.checked ? [...current, scope.key] : current.filter(key => key !== scope.key))} /><span><strong>{scope.label}</strong><small>{scope.description}</small></span></label>)}</fieldset>
    <div className="developer-form-grid"><Field label="Company" htmlFor={`${id}-company`}><select id={`${id}-company`} className="developer-input" value={entityId} onChange={event => setEntityId(event.target.value)} disabled={busy || orgLoading || Boolean(orgError)}><option value="">All companies</option>{missingCompany && <option value={entityId} disabled>Original company unavailable</option>}{entities.map(entity => <option key={entity.id} value={entity.id}>{entity.name || entity.code}</option>)}</select></Field>
      <Field label="Expires after" htmlFor={`${id}-expiry`}><select id={`${id}-expiry`} className="developer-input" value={expiresInDays} onChange={event => setExpiresInDays(Number(event.target.value))} disabled={busy}>{API_KEY_EXPIRY_DAYS.map(days => <option key={days} value={days}>{days} days</option>)}</select></Field></div>
    {orgError && <FormError message="Company choices could not be loaded. Reload the page before creating a key." />}
    {missingCompany && !orgError && <FormError message="The original company is no longer available. Choose a company before creating this replacement." />}
  </FormSection>;
}

export function CreatedKey({ value, name, onDone }) {
  const input = useRef(null);
  const panel = useRef(null);
  const id = useId();
  useEffect(() => {
    // The form can be below the fold on a phone. Its replacement must reveal the one-time key.
    // Schedule on each effect setup so React StrictMode's cleanup cannot cancel the only reveal.
    const frame = requestAnimationFrame(() => {
      panel.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      input.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return <section ref={panel} className="premium-card developer-created scroll-mt-4" aria-labelledby={`${id}-title`}>
    <div className="developer-section-heading"><div><h2 id={`${id}-title`}><Check size={18} /> Key created</h2><p><strong>{name}</strong> is ready. Copy this key now; you will not be able to see it again.</p></div></div>
    <label className="sr-only" htmlFor={`${id}-secret`}>Your new API key</label>
    <div className="developer-secret-row"><input ref={input} id={`${id}-secret`} readOnly value={value} autoComplete="off" spellCheck="false" className="developer-input developer-secret" /><CopyValue value={value} label="Copy key" ariaLabel="Copy new API key" manualLabel="Full API key" tone="primary" /></div>
    <p className="developer-key-hint">Keep it in your integration’s secret storage. Anyone with this key can read its allowed data.</p>
    <button type="button" className={btnClass('ghost')} onClick={onDone}>Done, hide key <ChevronRight size={15} /></button>
  </section>;
}

export function KeyRow({ item, entity, secret = null, onRevoke, onReplace, replacementDisabled = false }) {
  const state = developerKeyStatus(item);
  const status = state[0].toUpperCase() + state.slice(1);
  return <article className="developer-key-row">
    <div className="developer-key-title"><div><h3>{item.name}</h3><code>{item.key_prefix}••••••••</code></div><span className="developer-status" data-status={status.toLowerCase()}>{status}</span></div>
    <div className="developer-key-scopes">{item.scopes.map(scope => <span key={scope}>{API_KEY_SCOPES.find(option => option.key === scope)?.label || scope}</span>)}</div>
    <dl className="developer-key-meta"><div><dt>Company</dt><dd>{item.entity_id ? entity?.name || entity?.code || 'Selected company' : 'All companies'}</dd></div><div><dt>Created</dt><dd>{dateLabel(item.created_at)}</dd></div><div><dt>Expires</dt><dd>{dateLabel(item.expires_at)}</dd></div><div><dt>Last used</dt><dd>{dateLabel(item.last_used_at)}</dd></div></dl>
    <>
      {!secret && <p className="developer-saved-key-note">The full key was shown only when it was created.</p>}
      <div className="developer-key-actions">{secret ? <CopyValue value={secret} label="Copy key" ariaLabel={`Copy key for ${item.name}`} manualLabel={`Full API key for ${item.name}`} tone="primary" /> : <button type="button" className={btnClass('ghost')} disabled={replacementDisabled} onClick={onReplace} aria-label={`Create replacement for ${item.name}`}><Plus size={14} /> Create replacement</button>}
        {status !== 'Revoked' && <button type="button" className={`${btnClass('ghost')} developer-revoke`} onClick={onRevoke} aria-label={`Revoke key ${item.name}`}><Trash2 size={14} /> Revoke key</button>}</div>
    </>
  </article>;
}

export function CopyValue({ value, label, ariaLabel = label, manualLabel = label, tone = 'ghost' }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const selection = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!manual) return;
    selection.current?.focus(); selection.current?.select();
  }, [manual]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true); setManual(false);
    } catch {
      setCopied(false); setManual(true);
      selection.current?.focus(); selection.current?.select();
    }
  };
  return <div className="developer-copy-control"><button type="button" className={btnClass(tone)} aria-label={ariaLabel} onClick={copy}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : label}</button>
    {copied && <span role="status" className="sr-only">Copied to clipboard.</span>}
    {manual && <div className="developer-copy-fallback"><p role="status">Clipboard access is unavailable. The full value is selected below; copy it manually.</p><label htmlFor={id} className="sr-only">{manualLabel}</label><textarea ref={selection} id={id} className="developer-input developer-secret" readOnly value={value} autoComplete="off" spellCheck="false" rows={3} /></div>}
  </div>;
}

export function GettingStarted() {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL;
  const origin = typeof window !== 'undefined' && /^https?:$/.test(window.location?.protocol) ? window.location.origin : '';
  let base = origin ? `${origin}/api/v1` : 'https://YOUR_HR_APP/api/v1';
  try {
    const url = new URL(configured);
    if (/^https?:$/.test(url.protocol)) base = `${url.origin}/api/v1`;
  } catch { /* A missing canonical URL falls back to the current web app. */ }
  const example = `curl '${base}/employees?limit=50&offset=0' \\\n  -H 'Authorization: Bearer YOUR_API_KEY'`;
  return <aside className="premium-card developer-guide" aria-labelledby="developer-guide-title"><h2 id="developer-guide-title"><Code2 size={18} /> Getting started</h2>
    <p>Send requests from your server or integration using an active API key.</p>
    <div className="developer-guide-heading"><h3>Base URL</h3><CopyValue value={base} label="Copy" ariaLabel="Copy base URL" manualLabel="Base URL" /></div><code className="developer-code">{base}</code>
    <div className="developer-guide-heading"><h3>Authentication</h3><CopyValue value="Authorization: Bearer YOUR_API_KEY" label="Copy" ariaLabel="Copy authentication header" manualLabel="Authentication header" /></div><p>Add this request header:</p><code className="developer-code">Authorization: Bearer YOUR_API_KEY</code>
    <div className="developer-guide-heading"><h3>Example request</h3><CopyValue value={example} label="Copy" ariaLabel="Copy example request" manualLabel="Example request" /></div><pre className="developer-code"><code>{example}</code></pre>
    <h3>Read endpoints</h3><dl className="developer-endpoints"><div><dt><code>GET /employees</code></dt><dd>Work directory</dd></div><div><dt><code>GET /organization</code></dt><dd>Companies, locations and departments</dd></div><div><dt><code>GET /attendance</code></dt><dd>Include <code>from=YYYY-MM-DD</code> and <code>to=YYYY-MM-DD</code>, up to 31 days per request.</dd></div></dl>
    <h3>Pages and limits</h3><p>Use <code>limit</code> and <code>offset</code> to page through results. The default page has 50 records; the maximum is 100.</p><p>Each key allows up to 60 requests per minute. Revoking a key stops its access immediately.</p>
  </aside>;
}
