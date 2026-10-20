// Work Ledger: a personal creative-operations ledger (tasks through review, daily progress, help
// given, ideas, campaigns) whose output is a report the owner edits and shares with management.
// Private to its owner and their line managers (read-only) — see migration 0169. With `owner` set
// it is that person's ledger, read-only, opened from Team ledgers.
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BarChart3, FileText, Home, Library, Lightbulb, Megaphone, NotebookPen, Plus, Search, Settings } from 'lucide-react';
import { useUrlTab } from '../lib/useUrlTab';
import { istToday } from '../lib/dates';
import { syncGoogleCalendar, useLedgerBootstrap, useLedgerHome } from '../data/workLedger';
import { humanDbError } from '../lib/dbErrors';
import CommandBar from './ledger/CommandBar';
import Drawer from './ledger/Drawer';
import DueBanner from './ledger/DueBanner';
import LedgerCampaigns from './ledger/LedgerCampaigns';
import LedgerHome from './ledger/LedgerHome';
import LedgerIdeas from './ledger/LedgerIdeas';
import LedgerLibrary from './ledger/LedgerLibrary';
import LedgerReports from './ledger/LedgerReports';
import LedgerSettings from './ledger/LedgerSettings';
import { LogHelpDrawer, NewTaskDrawer, ReminderDrawer, TaskEditor } from './ledger/TaskForms';
import { LedgerContext } from './ledger/ui';
import { btnClass } from './ui/Btn';
import './ledger/ledger.css';

// Recharts is large; only Insights needs it.
const LedgerInsights = lazy(() => import('./ledger/LedgerInsights'));

export const LEDGER_TABS = [
  { id: 'home', label: 'Home', icon: Home }, { id: 'campaigns', label: 'Campaigns', icon: Megaphone }, { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'insights', label: 'Insights', icon: BarChart3 }, { id: 'ideas', label: 'Ideas', icon: Lightbulb }, { id: 'library', label: 'Library', icon: Library },
  { id: 'settings', label: 'Settings', icon: Settings },
];
const SYNC_GAP = 60_000;

/** Shortcuts never fire while someone is typing, or with a modifier other than Ctrl/⌘ K. */
export function shortcutFor(event) {
  const target = event.target;
  const typing = Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName));
  if (event.defaultPrevented) return null;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') return 'command';
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return null;
  if (event.key === '/') return 'command';
  const key = event.key.toLowerCase();
  if (key === 'n') return 'task';
  if (key === 'h') return 'help';
  if (key === 'r') return 'remind';
  if (/^[1-7]$/.test(event.key)) return `tab:${Number(event.key) - 1}`;
  return null;
}

export default function WorkLedger({ owner = null, onBack }) {
  const readOnly = Boolean(owner);
  const tabs = readOnly ? LEDGER_TABS.filter((item) => item.id !== 'settings') : LEDGER_TABS;
  const [urlTab, setUrlTab] = useUrlTab('home', LEDGER_TABS.map((item) => item.id));
  const [localTab, setLocalTab] = useState('home');
  const tab = readOnly ? localTab : urlTab;
  const setTab = readOnly ? setLocalTab : setUrlTab;
  const boot = useLedgerBootstrap(owner);
  const home = useLedgerHome(owner);
  const [drawer, setDrawer] = useState(null);
  const [command, setCommand] = useState(null);
  const [campaign, setCampaign] = useState(null);
  const [idea, setIdea] = useState(null);
  const lastSync = useRef(0);
  const person = boot.data?.owner;
  const connected = !readOnly && Boolean(home.data?.google?.connected);

  const open = useCallback((kind, payload) => {
    if (readOnly && ['task', 'help', 'reminder'].includes(kind)) return;
    if (kind === 'command') setCommand(payload ?? '');
    else if (kind === 'campaign') { setCampaign(payload ?? null); setTab('campaigns'); }
    else if (kind === 'idea') { setIdea(payload ?? null); setTab('ideas'); }
    else if (kind === 'tab') setTab(payload);
    else setDrawer({ kind, payload });
  }, [readOnly, setTab]);

  const context = useMemo(() => ({ owner, readOnly, boot: boot.data ?? null, today: home.data?.today ?? istToday(), open }),
    [owner, readOnly, boot.data, home.data?.today, open]);

  useEffect(() => {
    const onKey = (event) => {
      if (drawer || command !== null || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const action = shortcutFor(event);
      if (!action) return;
      if (readOnly && ['task', 'help', 'remind'].includes(action)) return;
      event.preventDefault();
      if (action === 'command') setCommand('');
      else if (action === 'remind') setCommand('remind: ');
      else if (action.startsWith('tab:')) { const next = tabs[Number(action.slice(4))]; if (next) setTab(next.id); }
      else setDrawer({ kind: action });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, command, readOnly, tabs, setTab]);

  // Calendar catches up when the ledger opens and whenever the window comes back into focus.
  useEffect(() => {
    if (!connected) return undefined;
    const sync = () => {
      if (Date.now() - lastSync.current < SYNC_GAP) return;
      lastSync.current = Date.now();
      syncGoogleCalendar().catch(() => {});
    };
    sync();
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, [connected]);

  const close = () => setDrawer(null);
  const panel = () => {
    switch (tab) {
    case 'campaigns': return <LedgerCampaigns selected={campaign} onSelect={setCampaign} />;
    case 'reports': return <LedgerReports owner={owner} />;
    case 'insights': return <Suspense fallback={<p className="ledger-quiet">Loading charts…</p>}><LedgerInsights /></Suspense>;
    case 'ideas': return <LedgerIdeas selected={idea} onSelect={setIdea} onCampaign={(id) => open('campaign', id)} />;
    case 'library': return <LedgerLibrary />;
    case 'settings': return readOnly ? null : <LedgerSettings boot={boot.data} loading={boot.isLoading} />;
    default: return <LedgerHome />;
    }
  };

  return (
    <LedgerContext.Provider value={context}>
      <div className="page-shell space-y-5 animate-fade-in ledger-page" data-readonly={readOnly || undefined}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
              <NotebookPen size={20} className="text-brand-ink" /> {readOnly ? `${person?.name ?? 'Team member'}’s ledger` : 'Work Ledger'}
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {readOnly ? `Read only${person?.designation ? ` · ${person.designation}` : ''}. Only its owner can change it.`
                : [person?.name, person?.designation].filter(Boolean).join(' · ') || 'Your tasks, help given, ideas, campaigns and reports.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {readOnly && onBack && <button type="button" className={btnClass('ghost')} onClick={onBack}><ArrowLeft size={14} /> Team ledgers</button>}
            <button type="button" className={btnClass('ghost')} onClick={() => setCommand('')} aria-keyshortcuts="/ Control+K">
              <Search size={14} /> {readOnly ? 'Search' : 'Search or add'} <kbd className="ledger-kbd">/</kbd></button>
            {!readOnly && <button type="button" className={btnClass('primary')} onClick={() => setDrawer({ kind: 'task' })} aria-keyshortcuts="N"><Plus size={16} /> New task</button>}
          </div>
        </div>
        <nav role="tablist" aria-label="Work Ledger sections"
          className="mobile-segmented mobile-segmented-dense tab-scroll flex border-b border-neutral-200 dark:border-neutral-900 space-x-5 text-xs">
          {tabs.map((item, index) => (
            <button key={item.id} type="button" role="tab" id={`ledger-tab-${item.id}`} aria-controls={`ledger-panel-${item.id}`}
              aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} aria-keyshortcuts={String(index + 1)}
              className={`pb-2.5 shrink-0 whitespace-nowrap flex items-center gap-1.5 font-semibold cursor-pointer border-b-2 transition-all ${
                tab === item.id ? 'border-brand text-brand-ink' : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'}`}
              onClick={() => { setTab(item.id); if (item.id === 'campaigns') setCampaign(null); }}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                setTab(next.id); document.getElementById(`ledger-tab-${next.id}`)?.focus();
              }}>
              <item.icon size={13} aria-hidden="true" /> {item.label}
            </button>
          ))}
        </nav>
        {boot.error ? (
          <p className="ledger-alert" role="alert">{humanDbError(boot.error) || 'This ledger could not be opened.'}</p>
        ) : (
          <section className="ledger-panel" role="tabpanel" id={`ledger-panel-${tab}`} aria-labelledby={`ledger-tab-${tab}`}>{panel()}</section>
        )}
      </div>
      <div className="ledger-overlays">
        {!readOnly && home.data && <DueBanner home={home.data} sound={Boolean(boot.data?.settings?.sound)} />}
        {drawer?.kind === 'task' && <NewTaskDrawer initial={drawer.payload} onClose={close} />}
        {drawer?.kind === 'help' && <LogHelpDrawer initial={drawer.payload} onClose={close} />}
        {drawer?.kind === 'reminder' && <ReminderDrawer initial={drawer.payload} onClose={close} />}
        {drawer?.kind === 'edit' && (
          <Drawer title={readOnly ? 'Task' : 'Edit task'} onClose={close}>
            <TaskEditor taskId={drawer.payload} pending={home.data?.pending ?? []} onClose={close} />
          </Drawer>
        )}
        {command !== null && <CommandBar initial={command} onClose={() => setCommand(null)} />}
      </div>
    </LedgerContext.Provider>
  );
}
