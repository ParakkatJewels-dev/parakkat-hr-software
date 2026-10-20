// Work Ledger: the one place for work. It runs on Task Management's own records (0173), so every
// task, subtask, comment, file, request and routine is here as it is there. Home and the board are
// the ledger's; Team, Requests, Routines and Deleted are Task Management's own views, mounted inside;
// Reports, Insights, quick add, reminders and the help log are the ledger's tools on those records.
// Who sees what follows Task Management's rules; reminders and the calendar stay private.
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, CheckSquare, FileText, HandHelping, Home, NotebookPen, Plus, Search, Settings, Trash2, Users,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';
import { istToday } from '../lib/dates';
import { navigationCountLabel, navigationScreenCount } from '../lib/navigationCounts';
import { useSectionCounts } from '../data/sectionCounts';
import { syncGoogleCalendar } from '../data/workLedger';
import { readSound, useWorkHome } from '../data/work';
import CommandBar from './ledger/CommandBar';
import DueBanner from './ledger/DueBanner';
import LedgerHome from './ledger/LedgerHome';
import LedgerReports from './ledger/LedgerReports';
import LedgerSettings from './ledger/LedgerSettings';
import { LogHelpDrawer, NewTaskPanel, ReminderDrawer, TaskDrawer } from './ledger/TaskForms';
import { LedgerContext } from './ledger/ui';
import TaskManagement from './TaskManagement';
import { NavigationCountBadge } from './ui/CountBadge';
import { btnClass } from './ui/Btn';
import './ledger/ledger.css';

// Recharts is large; only Insights needs it.
const LedgerInsights = lazy(() => import('./ledger/LedgerInsights'));

export const LEDGER_TABS = [
  { id: 'home', label: 'Home', icon: Home, count: 'tasks/todo' },
  { id: 'team', label: 'Team', icon: Users, need: 'team' },
  { id: 'requests', label: 'Requests', icon: HandHelping, need: 'requests', count: 'tasks/requests' },
  { id: 'routines', label: 'Routines', icon: CheckSquare, count: 'tasks/routine' },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'insights', label: 'Insights', icon: BarChart3 },
  { id: 'deleted', label: 'Deleted', icon: Trash2, need: 'deleted' },
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
  if (/^[1-9]$/.test(event.key)) return `tab:${Number(event.key) - 1}`;
  return null;
}

/** The tabs this person gets. */
export function visibleTabs({ canTeam, canRequests, canDeleted }) {
  return LEDGER_TABS.filter((item) => !item.need
    || (item.need === 'team' && canTeam) || (item.need === 'requests' && canRequests) || (item.need === 'deleted' && canDeleted));
}

export default function WorkLedger() {
  const { employee } = useAuth();
  const { canAny, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const canTeam = canBeyondSelf('task.read');
  const tabs = visibleTabs({ canTeam, canRequests: canAny('task.request'), canDeleted: canAny('task.manage') || Boolean(employee?.id) });
  const [urlTab, setTab] = useUrlTab('home', LEDGER_TABS.map((item) => item.id));
  const tab = tabs.some((item) => item.id === urlTab) ? urlTab : 'home';
  const home = useWorkHome();
  const counts = useSectionCounts({ selfOnly: viewingAsEmployee });
  const [drawer, setDrawer] = useState(null);
  const [command, setCommand] = useState(null);
  const [newTask, setNewTask] = useState(false);
  const lastSync = useRef(0);
  const connected = Boolean(home.data?.google?.connected);

  const open = useCallback((kind, payload) => {
    if (kind === 'command') setCommand(payload ?? '');
    else if (kind === 'tab') setTab(payload);
    else if (kind === 'new-task') setNewTask(true);
    else setDrawer({ kind, payload });
  }, [setTab]);

  const context = useMemo(() => ({ employeeId: employee?.id ?? null, today: home.data?.today ?? istToday(), canTeam, creative: false, open }),
    [employee?.id, home.data?.today, canTeam, open]);

  useEffect(() => {
    const onKey = (event) => {
      if (drawer || command !== null || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const action = shortcutFor(event);
      if (!action) return;
      event.preventDefault();
      if (action === 'command') setCommand('');
      else if (action === 'remind') setCommand('remind: ');
      else if (action === 'task') setNewTask(true);
      else if (action.startsWith('tab:')) { const next = tabs[Number(action.slice(4))]; if (next) setTab(next.id); }
      else setDrawer({ kind: action });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, command, tabs, setTab]);

  // The calendar catches up when the Ledger opens and whenever the window comes back into focus.
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
    case 'team': return <TaskManagement embedded embeddedView="board" />;
    case 'requests': return <TaskManagement embedded embeddedView="requests" />;
    case 'routines': return <TaskManagement embedded embeddedView="routine" />;
    case 'deleted': return <TaskManagement embedded embeddedView="deleted" />;
    case 'reports': return <LedgerReports />;
    case 'insights': return <Suspense fallback={<p className="ledger-quiet">Loading charts…</p>}><LedgerInsights /></Suspense>;
    case 'settings': return <LedgerSettings />;
    default: return <LedgerHome />;
    }
  };

  return (
    <LedgerContext.Provider value={context}>
      <div className="page-shell space-y-5 animate-fade-in ledger-page">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans flex items-center gap-2">
              <NotebookPen size={20} className="text-brand-ink" /> Work Ledger
            </h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
              {[employee?.full_name, canTeam ? 'your work and your team’s' : 'your tasks, notes, help given and reports'].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnClass('ghost')} onClick={() => setCommand('')} aria-keyshortcuts="/">
              <Search size={14} /> Search or add <kbd className="ledger-kbd">/</kbd></button>
            <button type="button" className={btnClass('ghost')} onClick={() => setDrawer({ kind: 'help' })} aria-keyshortcuts="H">Log help</button>
            <button type="button" className={btnClass('primary')} onClick={() => setNewTask(true)} aria-keyshortcuts="N"><Plus size={16} /> New task</button>
          </div>
        </div>
        <nav role="tablist" aria-label="Work Ledger sections"
          className="mobile-segmented mobile-segmented-dense tab-scroll flex border-b border-neutral-200 dark:border-neutral-900 space-x-5 text-xs">
          {tabs.map((item, index) => {
            const badge = item.count ? navigationScreenCount(item.count, counts.data) : null;
            return (
              <button key={item.id} type="button" role="tab" id={`ledger-tab-${item.id}`} aria-controls={`ledger-panel-${item.id}`}
                aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} aria-keyshortcuts={String(index + 1)}
                aria-label={badge ? navigationCountLabel(item.label, badge) : undefined}
                className={`pb-2.5 shrink-0 whitespace-nowrap flex items-center gap-1.5 font-semibold cursor-pointer border-b-2 transition-all ${
                  tab === item.id ? 'border-brand text-brand-ink' : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'}`}
                onClick={() => setTab(item.id)}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                  const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                  setTab(next.id); document.getElementById(`ledger-tab-${next.id}`)?.focus();
                }}>
                <item.icon size={13} aria-hidden="true" /> {item.label}
                {badge && <NavigationCountBadge badge={badge} />}
              </button>
            );
          })}
        </nav>
        {newTask && <NewTaskPanel onClose={() => setNewTask(false)} onCreated={(id) => setDrawer({ kind: 'task', payload: id })} />}
        <section className="ledger-panel" role="tabpanel" id={`ledger-panel-${tab}`} aria-labelledby={`ledger-tab-${tab}`} hidden={newTask}>
          {panel()}
        </section>
      </div>
      <div className="ledger-overlays">
        {home.data && <DueBanner home={home.data} sound={readSound()} />}
        {drawer?.kind === 'task' && <TaskDrawer taskId={drawer.payload} onClose={close}
          onRemind={(task) => setDrawer({ kind: 'reminder', payload: { task_id: task.id, task_title: task.title, text: `Follow up: ${task.title}` } })} />}
        {drawer?.kind === 'help' && <LogHelpDrawer initial={drawer.payload} onClose={close} />}
        {drawer?.kind === 'reminder' && <ReminderDrawer initial={drawer.payload} onClose={close} />}
        {command !== null && <CommandBar initial={command} onClose={() => setCommand(null)} />}
      </div>
    </LedgerContext.Provider>
  );
}
