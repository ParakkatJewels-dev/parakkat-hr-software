// Work Ledger: the one place for work. It runs on Task Management's own records (0173), so every
// task, subtask, comment, file, request and routine is here as it is there. Home and the board are
// the ledger's; Team, Requests, Routines and Deleted are Task Management's own views, mounted inside;
// Reports, Insights, quick add, reminders and the help log are the ledger's tools on those records.
// Who sees what follows Task Management's rules; reminders and the calendar stay private. The
// creative team (departments a super admin chooses) also gets shared Campaigns, Ideas and Library.
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3, BookOpen, CheckSquare, FileText, HandHelping, Home, LifeBuoy, Lightbulb, Megaphone, Plus, Search, Settings, Trash2, Users,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useUrlTab } from '../lib/useUrlTab';
import { focusIdFrom, stripFocus } from '../lib/focusRow';
import { istToday } from '../lib/dates';
import { navigationCountLabel, navigationScreenCount } from '../lib/navigationCounts';
import { useSectionCounts } from '../data/sectionCounts';
import { useHelpRequests } from '../data/helpRequests';
import { useMyDepartments } from '../data/team';
import { pendingCount } from '../lib/helpRequests';
import { syncGoogleCalendar } from '../data/googleCalendar';
import { readSound, useWorkHome } from '../data/work';
import { useCreativeSettings } from '../data/creative';
import CommandBar from './ledger/CommandBar';
import DueBanner from './ledger/DueBanner';
import LedgerCampaigns from './ledger/LedgerCampaigns';
import LedgerHome from './ledger/LedgerHome';
import LedgerIdeas from './ledger/LedgerIdeas';
import LedgerLibrary from './ledger/LedgerLibrary';
import LedgerReports from './ledger/LedgerReports';
import LedgerSettings from './ledger/LedgerSettings';
import { LogHelpDrawer, NewTaskPanel, ReminderDrawer, TaskDrawer } from './ledger/TaskForms';
import { LedgerContext } from './ledger/ui';
import TaskManagement from './TaskManagement';
import { NavigationCountBadge } from './ui/CountBadge';
import { btnClass } from './ui/Btn';
import './ledger/ledger.css';
import PageHeader from './ui/PageHeader';
import { useShellNav } from './shell/shellNavContext';

// Each tab opens with its own title, as on the redesign boards ("Team work", "Requests" …).
export const TAB_META = {
  home: { title: 'Your work, at a glance', subtitle: 'Stay focused on what matters today.' },
  team: { title: 'Team work', subtitle: 'See priorities, ownership and progress.', primary: 'Assign task' },
  requests: { title: 'Requests', subtitle: 'Ask another department and keep every hand-off clear.', hidePrimary: true },
  routines: { title: 'Routines', subtitle: 'Daily, weekly and monthly duties, ticked off as they are done.' },
  reports: { title: 'Work reports', subtitle: 'What was done, written up and ready to share.' },
  insights: { title: 'Insights', subtitle: 'Delivery, on-time work, help given and turnaround.' },
  campaigns: { title: 'Campaigns', subtitle: 'Every campaign from first idea to launch.' },
  ideas: { title: 'Ideas', subtitle: 'Capture now, decide later.' },
  library: { title: 'Library', subtitle: 'Vendors, templates, key dates and brand notes.' },
  deleted: { title: 'Deleted tasks', subtitle: 'Restore anything removed by mistake.' },
  settings: { title: 'Work settings', subtitle: 'Calendar, sound, shortcuts and the Sheet import.' },
};

// Recharts is large; only Insights needs it.
const LedgerInsights = lazy(() => import('./ledger/LedgerInsights'));

export const LEDGER_TABS = [
  { id: 'home', label: 'Home', icon: Home, count: 'tasks/todo' },
  { id: 'team', label: 'Team', icon: Users, need: 'team' },
  { id: 'requests', label: 'Requests', icon: HandHelping, need: 'requests', count: 'tasks/requests' },
  { id: 'routines', label: 'Routines', icon: CheckSquare, count: 'tasks/routine' },
  { id: 'reports', label: 'Reports', icon: FileText },
  { id: 'insights', label: 'Insights', icon: BarChart3 },
  { id: 'campaigns', label: 'Campaigns', icon: Megaphone, need: 'creative' },
  { id: 'ideas', label: 'Ideas', icon: Lightbulb, need: 'creative' },
  { id: 'library', label: 'Library', icon: BookOpen, need: 'creative' },
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
export function visibleTabs({ canTeam, canRequests, canDeleted, creative = false }) {
  const allowed = { team: canTeam, requests: canRequests, deleted: canDeleted, creative };
  return LEDGER_TABS.filter((item) => !item.need || allowed[item.need]);
}

export default function WorkLedger() {
  const { employee } = useAuth();
  const { canAny, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const canTeam = canBeyondSelf('task.read');
  const creative = Boolean(useCreativeSettings().data?.member);
  const canRequests = canAny('task.request');
  const tabs = visibleTabs({ canTeam, canRequests, canDeleted: canAny('task.manage') || Boolean(employee?.id), creative });
  const [urlTab, setTab] = useUrlTab('home', LEDGER_TABS.map((item) => item.id));
  const tab = tabs.some((item) => item.id === urlTab) ? urlTab : 'home';
  const home = useWorkHome();
  const counts = useSectionCounts({ selfOnly: viewingAsEmployee });
  // Only requests waiting on you. During a staged backend rollout the old summary has no request
  // field; fall back only to fully loaded lists — a missing or failed query is not an empty queue.
  const departmentsQuery = useMyDepartments({ enabled: canRequests });
  const helpRequestsQuery = useHelpRequests({ enabled: canRequests });
  const badgeFor = (item) => {
    if (!item.count) return null;
    const badge = navigationScreenCount(item.count, counts.data);
    if (badge && item.id === 'requests' && !Object.hasOwn(counts.data ?? {}, 'task_requests')
        && departmentsQuery.data !== undefined && helpRequestsQuery.data !== undefined) {
      badge.count = pendingCount(helpRequestsQuery.data, departmentsQuery.data.map((d) => d.id));
    }
    return badge;
  };
  const [drawer, setDrawer] = useState(null);
  const [command, setCommand] = useState(null);
  // null, or the new-task form's starting values (a campaign, an idea, a template).
  const [newTask, setNewTask] = useState(null);
  const [picked, setPicked] = useState({ campaigns: null, ideas: null });
  const lastSync = useRef(0);
  const connected = Boolean(home.data?.google?.connected);
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  // The Work section's other screen (Goals) joins the end of this tab row, so the page shows one
  // row of tabs rather than two.
  const shellNav = useShellNav();
  const goals = shellNav?.section?.tabs.find((item) => item.id === 'performance');
  const meta = TAB_META[tab] ?? TAB_META.home;

  // A notification or old Task Management link to one task opens it here. Team keeps its own
  // highlight-the-row behaviour (Task Management's board reads ?focus= itself).
  const linked = tab === 'team' ? null : focusIdFrom(search);
  useEffect(() => {
    if (!linked) return;
    setDrawer({ kind: 'task', payload: linked });
    navigate({ pathname, search: stripFocus(search) }, { replace: true });
  }, [linked, pathname, search, navigate]);

  const open = useCallback((kind, payload) => {
    if (kind === 'command') setCommand(payload ?? '');
    else if (kind === 'tab') setTab(payload);
    else if (kind === 'new-task') setNewTask(payload ?? {});
    else if (kind === 'campaign' || kind === 'idea') {
      const list = `${kind}s`;
      setPicked((current) => ({ ...current, [list]: payload ?? null }));
      setTab(list);
    } else setDrawer({ kind, payload });
  }, [setTab]);

  const context = useMemo(() => ({ employeeId: employee?.id ?? null, today: home.data?.today ?? istToday(), canTeam, creative, open }),
    [employee?.id, home.data?.today, canTeam, creative, open]);

  useEffect(() => {
    const onKey = (event) => {
      if (drawer || command !== null || newTask || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const action = shortcutFor(event);
      if (!action) return;
      event.preventDefault();
      if (action === 'command') setCommand('');
      else if (action === 'remind') setCommand('remind: ');
      else if (action === 'task') setNewTask({});
      else if (action.startsWith('tab:')) { const next = tabs[Number(action.slice(4))]; if (next) setTab(next.id); }
      else setDrawer({ kind: action });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer, command, newTask, tabs, setTab]);

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
    case 'team': return <TaskManagement view="board" />;
    case 'requests': return <TaskManagement view="requests" />;
    case 'routines': return <TaskManagement view="routine" />;
    case 'deleted': return <TaskManagement view="deleted" />;
    case 'reports': return <LedgerReports />;
    case 'insights': return <Suspense fallback={<p className="ledger-quiet">Loading charts…</p>}><LedgerInsights /></Suspense>;
    case 'campaigns': return <LedgerCampaigns selected={picked.campaigns} onSelect={(id) => setPicked((current) => ({ ...current, campaigns: id }))} />;
    case 'ideas': return <LedgerIdeas selected={picked.ideas} onSelect={(id) => setPicked((current) => ({ ...current, ideas: id }))}
      onCampaign={(id) => open('campaign', id)} />;
    case 'library': return <LedgerLibrary />;
    case 'settings': return <LedgerSettings />;
    default: return <LedgerHome />;
    }
  };

  return (
    <LedgerContext.Provider value={context}>
      <div className="page-shell space-y-5 animate-fade-in ledger-page">
        <PageHeader
          title={meta.title}
          subtitle={meta.subtitle}
          tabs={false}
          actions={<>
            <button type="button" className={btnClass('ghost')} onClick={() => setCommand('')} aria-keyshortcuts="/">
              <Search size={15} /> Search or add <kbd className="ledger-kbd">/</kbd></button>
            <button type="button" className={btnClass('ghost')} onClick={() => setDrawer({ kind: 'help' })} aria-keyshortcuts="H">
              <LifeBuoy size={15} /> Log help</button>
            {!meta.hidePrimary && <button type="button" className={btnClass('primary')} onClick={() => setNewTask({})} aria-keyshortcuts="N"><Plus size={16} /> {meta.primary ?? 'New task'}</button>}
          </>}
        />
        <div className="section-tabbar ledger-tabbar">
          <nav role="tablist" aria-label="Work Ledger sections" className="section-tab-scroll">
            {tabs.map((item, index) => {
              const badge = badgeFor(item);
              return (
                <button key={item.id} type="button" role="tab" id={`ledger-tab-${item.id}`} aria-controls={`ledger-panel-${item.id}`}
                  aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} aria-keyshortcuts={String(index + 1)}
                  aria-label={badge ? navigationCountLabel(item.label, badge) : undefined}
                  className={`section-tab-button ${tab === item.id ? 'is-active' : ''}`}
                  onClick={() => setTab(item.id)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
                    setTab(next.id); document.getElementById(`ledger-tab-${next.id}`)?.focus();
                  }}>
                  {item.label}
                  {badge && <NavigationCountBadge badge={badge} />}
                </button>
              );
            })}
            {goals && (
              <button type="button" className="section-tab-button" onClick={() => shellNav.select(shellNav.navTarget(goals))}>{goals.label}</button>
            )}
          </nav>
        </div>
        {newTask && <NewTaskPanel preset={newTask} onClose={() => setNewTask(null)} onCreated={(id) => setDrawer({ kind: 'task', payload: id })} />}
        <section className="ledger-panel" role="tabpanel" id={`ledger-panel-${tab}`} aria-labelledby={`ledger-tab-${tab}`} hidden={Boolean(newTask)}>
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
