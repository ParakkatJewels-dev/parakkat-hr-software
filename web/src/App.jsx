import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import {
  ESS_NAV, OVERSIGHT_NAV, canSeeTab, visibleSections as navSections,
  mobilePrimarySections as pickMobilePrimary,
} from './lib/navMap';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Clock, Calendar, DollarSign, Receipt, HelpCircle, LogOut, Menu, X, Sun, Moon, FolderOpen, BarChart3, Shield, Settings, Terminal, Search, ChevronLeft, ChevronRight, ListChecks, Download, RefreshCw, WifiOff, Boxes, Target, UserRound, Bell, MessageSquare,
} from 'lucide-react';

// Import components
import Dashboard from './components/Dashboard';
import InstallPrompt from './components/InstallPrompt';
const Directory = lazy(() => import('./components/Directory'));
const EmployeeImport = lazy(() => import('./components/EmployeeImport'));
const EmployeeAttendanceDetail = lazy(() => import('./components/EmployeeAttendanceDetail'));
const Attendance = lazy(() => import('./components/Attendance'));
const AttendanceAdmin = lazy(() => import('./components/AttendanceAdmin'));
const Leave = lazy(() => import('./components/Leave'));
const Payroll = lazy(() => import('./components/Payroll'));
const Expense = lazy(() => import('./components/Expense'));
const Performance = lazy(() => import('./components/Performance'));
const Recruitment = lazy(() => import('./components/Recruitment'));
const Onboarding = lazy(() => import('./components/Onboarding'));
const HelpdeskExit = lazy(() => import('./components/HelpdeskExit'));
const Organization = lazy(() => import('./components/Organization'));
const AssetManagement = lazy(() => import('./components/AssetManagement'));
const MyAssets = lazy(() => import('./components/MyAssets'));
const DocumentManagement = lazy(() => import('./components/DocumentManagement'));
const ReportsAnalytics = lazy(() => import('./components/ReportsAnalytics'));
const Administration = lazy(() => import('./components/Administration'));
const TaskManagement = lazy(() => import('./components/TaskManagement'));
const Messages = lazy(() => import('./components/Messages'));
const ChatMonitor = lazy(() => import('./components/ChatMonitor'));
const Team = lazy(() => import('./components/Team'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
const UserProfile = lazy(() => import('./components/UserProfile'));
const Notifications = lazy(() => import('./components/Notifications'));
import NotificationBell from './components/NotificationBell';
import BrandMark from './components/ui/BrandMark';
import RoleSwitcher from './components/ui/RoleSwitcher';
import LiquidGlassNav from './components/ui/LiquidGlassNav';
import './components/ui/liquidGlassNav.css';
import { useAuth } from './auth/AuthContext';
import { useEmployeeAvatars } from './data/documents';
import './components/profileNavigation.css';
import { usePermissions } from './auth/usePermissions';
import { resolveHeldRoles, resolvePrimaryRole } from './lib/roles';
import { useViewRole } from './lib/viewRole';
import { appNameFor, documentTitleFor } from './lib/appName';
import { useRealtimeSync } from './lib/realtime';
import { useClockFormat } from './lib/timeFormat';
import { useVersionCheck } from './lib/versionCheck';
import { isStandalonePwa } from './lib/pwa';
import { stripFocus } from './lib/focusRow';
import { syncNativeTheme } from './mobile/native';

// Prettify a role key like 'branch_manager' -> 'Branch Manager'.
const prettyRole = (key) =>
  key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Short labels for the phone's five primary destinations. Full menu entries keep their names.
const MOBILE_NAV_LABELS = {
  dashboard: 'Home',
  directory: 'People',
  menu: 'Menu',
  attendance: 'Time',
  leave: 'Leave',
  payroll: 'Pay',
  tasks: 'Tasks',
  messages: 'Chat',
  team: 'My Team',
  performance: 'Goals',
  expense: 'Expenses',
  documents: 'Documents',
  helpdesk: 'Help',
  profile: 'Profile',
  home: 'Home',
  people: 'People',
  time: 'Time',
  pay: 'Pay',
  'asset-management': 'Assets',
  'my-assets': 'Assets',
};

// Shown when a user lands on a section they lack permission for.
function AccessDenied() {
  return (
    <div className="page-shell flex flex-col items-center justify-center py-20 text-center animate-fade-in">
      <Shield size={28} className="text-neutral-400 dark:text-brand-ink mb-3" />
      <h2 className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">Access restricted</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm">
        You don't have permission to view this section. If you believe this is a mistake, contact your
        HR administrator.
      </p>
    </div>
  );
}

export default function App() {
  const { employee, user, isSuperAdmin, signOut, assignments, permissions, hiddenScreens } = useAuth();
  const { canAny, canBeyondSelf } = usePermissions();
  useRealtimeSync(); // live-sync data across devices via Supabase Realtime
  // Subscribed at the root so switching the clock format repaints every screen at once. Times are
  // printed in a dozen places, several through a plain imported helper rather than a hook, and
  // hunting each one down would leave whichever was missed showing the old format until something
  // unrelated re-rendered it. A format change is a once-in-a-while action; one full repaint is the
  // cheaper mistake.
  useClockFormat();
  useVersionCheck(); // auto-reload when a new build is deployed to the hosted web app

  // Real signed-in identity (replaces the old hardcoded "Aditya Parakkat").
  const displayName = employee?.full_name || user?.email || 'User';
  const displaySubtitle = isSuperAdmin ? 'Super Admin' : employee?.employee_code || 'Employee';
  const displayInitials = (
    displayName.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('') || 'U'
  ).toUpperCase();

  // Real role label for the header: the primary (highest) role, plus a count of any other
  // oversight roles. The auto-granted employee@self role is not counted — every manager has it.
  const trueRole = resolvePrimaryRole(assignments, isSuperAdmin);
  const roleNames = [...new Set((assignments || []).map((a) => a.role))];
  // Joined here rather than in the dependency array: a fresh array every render would rebuild the
  // list every time, and the linter cannot check an expression written inline in the deps.
  // Every role held, most senior first, with 'employee' always available: a manager is one too, and
  // 0080 granted them attendance.punch / leave.create / expense.create / payslip.read to prove it.
  const heldRoles = useMemo(
    () => resolveHeldRoles(assignments, isSuperAdmin, permissions, employee),
    [assignments, isSuperAdmin, permissions, employee]
  );

  // The role the app is PRESENTED as. Purely a lens — see lib/viewRole.js. canViewTab below still
  // asks the real permissions, so switching to Employee hides the oversight tree without pretending
  // the person cannot reach it.
  const [primaryRole, setViewRole] = useViewRole(trueRole, heldRoles);
  const extraRoles = roleNames.filter((r) => r !== primaryRole && r !== 'employee').length;
  const roleLabel = isSuperAdmin
    ? 'Super Admin'
    : prettyRole(primaryRole) + (extraRoles ? ` +${extraRoles}` : '');

  // --- which screen is on show -----------------------------------------------------------------
  // It lives in the URL, not in component state.
  //
  // This was useState('dashboard'), which meant every refresh — and every restart of the native
  // app — threw the user back to the dashboard from wherever they had been working. The query
  // cache already survives a reload (see the persister in main.jsx), so the effect was an app that
  // repainted the right data on the wrong screen.
  //
  // Putting it in the route fixes that and two things next to it: the browser's Back button now
  // steps through screens instead of leaving the app, and a screen can be linked to or bookmarked
  // — /#/payroll opens payroll. HashRouter is already the router here because the native webview
  // serves from a local origin, so these URLs work identically on the web and in Capacitor.
  // Only the FIRST segment names the screen. Anything after it belongs to that screen's own tab
  // bar — /#/attendance/exceptions, /#/attendance-admin/sync — read there by useUrlTab. Without
  // this split the whole path was matched against the screen list, so the moment a page put its
  // inner tab in the URL every one of those addresses fell through to the not-found redirect.
  const location = useLocation();
  const navigate = useNavigate();
  const routeStageRef = useRef(null);
  const activeTab = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'dashboard';
  // Deliberately the same shape as the setState it replaces, so every onNavigate / onBack /
  // command-palette caller keeps working untouched. Switching screens drops the inner tab, which
  // is right: the exceptions tab of Attendance means nothing on Payroll.
  const setActiveTab = useCallback((id) => navigate(`/${id}`), [navigate]);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [menuSearch, setMenuSearch] = useState('');
  const menuRef = useRef(null);
  const menuTriggerRef = useRef(null);
  const currentPathRef = useRef(location.pathname);
  currentPathRef.current = location.pathname;
  const openMobileMenu = useCallback((event) => {
    menuTriggerRef.current = { element: event?.currentTarget || document.activeElement, path: currentPathRef.current };
    setMenuSearch('');
    setMobileMenuOpen(true);
  }, []);
  const { data: ownAvatars = {} } = useEmployeeAvatars(employee?.id ? [employee.id] : []);
  const avatarUrl = ownAvatars[employee?.id];

  useEffect(() => {
    if (!mobileMenuOpen) return undefined;
    const panel = menuRef.current;
    const trigger = menuTriggerRef.current;
    const frame = requestAnimationFrame(() => panel?.querySelector('[aria-label="Close navigation menu"]')?.focus());
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setMobileMenuOpen(false); return;
      }
      if (event.key !== 'Tab') return;
      const items = [...(panel?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])]
        .filter(element => element.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onDesktop = () => { if (desktop.matches) setMobileMenuOpen(false); };
    desktop.addEventListener('change', onDesktop);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
      desktop.removeEventListener('change', onDesktop);
      if (trigger?.path === currentPathRef.current) {
        const destination = trigger.element?.isConnected && trigger.element.getClientRects().length
          ? trigger.element : document.getElementById('main-content');
        destination?.focus({ preventScroll: true });
      }
    };
  }, [mobileMenuOpen]);

  // A navigation from the drawer may be triggered by links, browser history, or a dashboard
  // shortcut. Always dismiss the drawer once the route changes so it cannot cover the new page.
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let frame = 0;
    frame = window.requestAnimationFrame(() => {
      const main = document.getElementById('main-content');
      main?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      main?.focus({ preventScroll: true });

      document
        .querySelector('.section-tab-button[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.pathname]);

  // Animate the shared content stage instead of keying/remounting the routed screen. Several
  // screens keep useful local state while their second URL segment changes; remounting would make
  // a pleasant transition cost somebody an open panel or an unfinished form. Replaying one class
  // on the stable wrapper covers screen changes, inner routed tabs, Back and notification links.
  useLayoutEffect(() => {
    const stage = routeStageRef.current;
    if (!stage) return undefined;

    stage.classList.remove('route-stage-enter');
    // Force the browser to commit the class removal before it is added again. Without this, two
    // quick route changes can be coalesced and the second animation never starts.
    void stage.offsetWidth;
    stage.classList.add('route-stage-enter');

    const finish = () => stage.classList.remove('route-stage-enter');
    stage.addEventListener('animationend', finish, { once: true });
    return () => {
      stage.removeEventListener('animationend', finish);
      stage.classList.remove('route-stage-enter');
    };
  }, [location.pathname]);

  // Sidebar collapsed state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  );

  // Theme state: dark or light
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  // Command Palette trigger
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isPwaInstalled, setIsPwaInstalled] = useState(() => isStandalonePwa());
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [pwaUpdateRegistration, setPwaUpdateRegistration] = useState(null);
  const pullStartY = useRef(null);
  const pullActive = useRef(false);
  const pullDistanceRef = useRef(0);
  const [pullRefresh, setPullRefresh] = useState({
    pulling: false,
    ready: false,
    refreshing: false,
    distance: 0,
  });

  useLayoutEffect(() => {
    document.documentElement.classList.add('app-root-lock');
    document.body.classList.add('app-body-lock');
    return () => {
      document.documentElement.classList.remove('app-root-lock');
      document.body.classList.remove('app-body-lock');
    };
  }, []);

  // Persist sidebar collapsed state
  useEffect(() => {
    localStorage.setItem('sidebar-collapsed', isSidebarCollapsed);
  }, [isSidebarCollapsed]);

  useEffect(() => {
    const onBeforeInstallPrompt = (event) => {
      event.preventDefault();
      setInstallPrompt(event);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setIsPwaInstalled(true);
    };
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    const onUpdateReady = (event) => setPwaUpdateRegistration(event.detail?.registration ?? null);

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pwa:update-ready', onUpdateReady);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pwa:update-ready', onUpdateReady);
    };
  }, []);

  // Apply Theme class
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
    syncNativeTheme(theme);
  }, [theme]);

  // Command Palette global key listener (Ctrl + K)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowCommandPalette(prev => !prev);
      }
      if (e.key === 'Escape') {
        setShowCommandPalette(false);
        setMobileMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const toggleTheme = () => {
    setTheme(prev => prev === 'dark' ? 'light' : 'dark');
  };

  const installPwa = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (choice?.outcome === 'accepted') {
      setIsPwaInstalled(true);
    }
  };

  const applyPwaUpdate = () => {
    const waitingWorker = pwaUpdateRegistration?.waiting;
    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      return;
    }
    window.location.reload();
  };

  const finishPullRefresh = useCallback(() => {
    setPullRefresh({ pulling: false, ready: false, refreshing: true, distance: 54 });
    window.setTimeout(() => {
      const waitingWorker = pwaUpdateRegistration?.waiting;
      if (waitingWorker) waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      else window.location.reload();
    }, 220);
  }, [pwaUpdateRegistration]);

  const resetPullRefresh = useCallback(() => {
    pullStartY.current = null;
    pullActive.current = false;
    pullDistanceRef.current = 0;
    setPullRefresh((state) => (
      state.refreshing ? state : { pulling: false, ready: false, refreshing: false, distance: 0 }
    ));
  }, []);

  const handlePullStart = useCallback((event) => {
    if (pullRefresh.refreshing || event.touches.length !== 1) return;
    const main = event.currentTarget;
    if (main.scrollTop > 0) return;
    if (event.target.closest('input, select, textarea, button, a, [role="button"], [contenteditable="true"]')) return;
    pullStartY.current = event.touches[0].clientY;
    pullActive.current = false;
    pullDistanceRef.current = 0;
  }, [pullRefresh.refreshing]);

  const handlePullMove = useCallback((event) => {
    if (pullStartY.current == null || pullRefresh.refreshing) return;
    const main = event.currentTarget;
    const dy = event.touches[0].clientY - pullStartY.current;
    if (dy <= 0) {
      resetPullRefresh();
      return;
    }
    if (main.scrollTop > 0 && !pullActive.current) return;

    const distance = Math.min(96, Math.round(dy * 0.45));
    if (distance < 8) return;
    pullActive.current = true;
    event.preventDefault();
    pullDistanceRef.current = distance;
    setPullRefresh({
      pulling: true,
      ready: distance >= 68,
      refreshing: false,
      distance,
    });
  }, [pullRefresh.refreshing, resetPullRefresh]);

  const handlePullEnd = useCallback(() => {
    if (!pullActive.current) {
      resetPullRefresh();
      return;
    }
    const shouldRefresh = pullDistanceRef.current >= 68;
    if (shouldRefresh) finishPullRefresh();
    else resetPullRefresh();
  }, [finishPullRefresh, resetPullRefresh]);

  // The sidebar tree now lives in lib/navMap.js — one definition, because Administration's access
  // inspector evaluates the same tree against another user's permissions, and a second copy would
  // drift from this one within a release. Icons stay here: navMap is plain data so it can be
  // tested without pulling React in.
  const SECTION_ICONS = {
    home: LayoutDashboard, messages: MessageSquare, people: Users, time: Clock, pay: DollarSign,
    'asset-management': Boxes, work: ListChecks, support: HelpCircle,
    insights: BarChart3, account: UserRound, admin: Shield,
  };
  const ESS_ICONS = {
    dashboard: LayoutDashboard, attendance: Clock, leave: Calendar, payroll: DollarSign,
    tasks: ListChecks, messages: MessageSquare, performance: Target, expense: Receipt, 'my-assets': Boxes,
    documents: FolderOpen, helpdesk: HelpCircle, profile: UserRound, notifications: Bell,
    settings: Settings,
  };

  // Screens an administrator has taken out of this person's sidebar (0109). Narrows only, and a
  // super admin is never narrowed — predicatesFor enforces that, so it holds here too.
  const navPredicates = {
    canAny,
    canBeyondSelf,
    // Carried so navMap can gate the one tab that no permission can buy — see `superOnly`.
    isSuperAdmin,
    // And the one that a permission cannot help with either: messaging needs an employee record to
    // send as, which a system login deliberately does not have.
    hasEmployee: Boolean(employee?.id),
    hidden: new Set(isSuperAdmin ? [] : hiddenScreens ?? []),
  };

  // Sections the user may see at all, with their permitted screens, each carrying its icon.
  const visibleSections = navSections(primaryRole, navPredicates).map((sec) => ({
    ...sec,
    icon: SECTION_ICONS[sec.id] ?? ESS_ICONS[sec.id] ?? LayoutDashboard,
    tabs: sec.tabs.map((t) => ({ ...t, icon: t.icon ?? ESS_ICONS[t.id] })),
  }));

  const allTabs = visibleSections.flatMap((sec) => sec.tabs);
  // Every tab the application defines, in either tree. `allTabs` above is only the tabs in THIS
  // user's nav, which is the wrong set to authorise against.
  const allKnownTabs = [
    ...ESS_NAV.flatMap((g) => g.items),
    ...OVERSIGHT_NAV.flatMap((sec) => sec.tabs),
  ];

  /**
   * May this user open this screen?
   *
   * This used to read `return !t || canSeeTab(t)` — and `t` came from the CURRENT nav tree only.
   * An employee gets essSections, which has no Directory, Administration, Reports, Organization or
   * Assets in it, so those ids were "not found" and the `!t` arm returned TRUE. The router at the
   * bottom of this file asks exactly this question before rendering, so typing /administration as
   * a self-service employee rendered the real Administration screen instead of AccessDenied.
   *
   * A tab missing from your own nav is now still authorised against its real definition — found in
   * the full set — so a screen you legitimately hold the permission for stays reachable by URL,
   * while one you do not is refused. An id belonging to no tab at all is refused outright.
   */
  const canViewTab = (tabId) => {
    const t = allTabs.find((x) => x.id === tabId) ?? allKnownTabs.find((x) => x.id === tabId);
    return Boolean(t) && canSeeTab(t, navPredicates);
  };

  // Which section owns the screen on show? Drives sidebar highlighting and the tab bar, so a
  // shortcut from the dashboard lands in the right place without the caller knowing the tree.
  // `focus` is transient — a notification pointing at one row — and is stripped the moment the
  // screen claims it (useFocusRow). It must not take part in deciding which nav item is current.
  const here = (location.pathname + stripFocus(location.search)).replace(/^\/+/, '').replace(/\/+$/, '');
  const activeSection =
    visibleSections.find((sec) => sec.tabs.some((t) => t.to === here))
    ?? visibleSections.find((sec) => sec.tabs.some((t) => t.id === activeTab))
    ?? visibleSections[0];
  const activeTabMeta = allTabs.find((t) => t.id === activeTab);

  /**
   * What this application calls itself for THIS person.
   *
   * "HR SYSTEM" was shown to everybody. It is accurate for the people who run HR and wrong for the
   * 160-odd employees whose whole use of it is a punch, a payslip and a leave request — it names
   * somebody else's tool. The nav tree already splits on exactly this (an employee gets essSections
   * under "My Workspace"), so the title now agrees with the screen instead of contradicting it.
   */
  const appName = appNameFor(primaryRole);

  // The browser tab, which is the one piece of chrome a person sees without looking at the app.
  // Dashboard is left off deliberately: "Dashboard · My Workspace · Parakkat" says nothing the next
  // two words do not.
  useEffect(() => {
    const screen = activeSection?.id === 'home' || activeTab === 'dashboard' ? null : activeSection?.label;
    document.title = documentTitleFor(primaryRole, screen);
  }, [primaryRole, activeSection, activeTab]);

  const mobilePrimarySections = pickMobilePrimary(visibleSections, primaryRole).map(section => ({
    ...section,
    icon: ESS_ICONS[section.id] ?? (section.id === 'menu' ? Menu : section.icon),
    label: MOBILE_NAV_LABELS[section.id] ?? section.label,
    avatarUrl: section.id === 'profile' ? avatarUrl : undefined,
    initials: displayInitials,
  }));
  const needle = menuSearch.trim().toLowerCase();
  const menuSections = visibleSections.map(section => ({
    ...section,
    tabs: section.tabs.filter(tab => !needle || `${section.label} ${tab.label} ${MOBILE_NAV_LABELS[tab.id] || ''}`.toLowerCase().includes(needle)),
  })).filter(section => section.tabs.length);

  // Open a section from the sidebar: land on the first screen the user may actually see.
  const openSection = (sec) => {
    if (!sec.tabs.some((t) => t.id === activeTab)) setActiveTab(sec.tabs[0].id);
  };

  const commandOptions = [
    { label: 'Go to Dashboard', action: () => setActiveTab('dashboard') },
    { label: 'Open Employee Directory', action: () => setActiveTab('directory') },
    { label: 'Go to Attendance', action: () => setActiveTab('attendance') },
    { label: 'Apply for Time-Off / Leave', action: () => setActiveTab('leave') },
    { label: 'Open Task Management', action: () => setActiveTab('tasks') },
    { label: 'Open Messages', action: () => setActiveTab('messages') },
    { label: 'Submit an Expense Claim', action: () => setActiveTab('expense') },
    { label: 'View Asset Inventory', action: () => setActiveTab('assets') },
    { label: 'Run Payroll', action: () => setActiveTab('payroll') },
    { label: 'Open Reports & Analytics', action: () => setActiveTab('reports') },
    { label: 'Open My Profile', action: () => setActiveTab('profile') },
    { label: 'Toggle Light/Dark Theme', action: () => toggleTheme() },
  ]
    .filter((c) => c.label === 'Toggle Light/Dark Theme' || true)
    .map((c) => ({ ...c, action: () => { c.action(); setShowCommandPalette(false); } }));

  const filteredCommands = commandOptions.filter((cmd) =>
    cmd.label.toLowerCase().includes(commandSearch.toLowerCase())
  );

  // Sidebar: one row per section. No group headings any more — eight destinations do not need
  // sub-titles to be scannable, and removing them buys back vertical space.
  // The desktop sidebar. The phone gets renderMobileNavTree below, which carries a second level
  // the sidebar does not need — a desktop already shows the section's screens on a tab strip.
  const renderNavLinks = () => {
    const isCollapsedDesktop = isSidebarCollapsed;

    return (
      <div className="space-y-0.5">
        {visibleSections.map((sec) => {
          const Icon = sec.icon;
          const isActive = activeSection?.id === sec.id;
          return (
            <button
              key={sec.id}
              onClick={() => {
                openSection(sec);
              }}
              aria-current={isActive ? 'page' : undefined}
              title={isCollapsedDesktop ? sec.label : undefined}
              aria-label={isCollapsedDesktop ? sec.label : undefined}
              className={`w-full flex items-center rounded-xl text-base font-semibold cursor-pointer transition-colors duration-200 group relative border border-transparent ${
                isCollapsedDesktop ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
              } ${
                isActive
                  ? 'nav-item-active'
                  : 'text-neutral-500 dark:text-warm-gray-400 hover:bg-neutral-50 dark:hover:bg-charcoal-800/80 hover:text-neutral-900 dark:hover:text-warm-gray-100'
              }`}
            >
              <Icon
                size={isCollapsedDesktop ? 18 : 16}
                className={`shrink-0 ${
                  isActive
                    ? 'text-black dark:text-brand-ink'
                    : 'text-neutral-400 dark:text-neutral-500 group-hover:text-neutral-850 dark:group-hover:text-warm-gray-100'
                }`}
              />
              {!isCollapsedDesktop && <span className="truncate">{sec.label}</span>}

              {isCollapsedDesktop && (
                <div className="invisible opacity-0 group-hover:visible group-hover:opacity-100 absolute left-full ml-4 px-2.5 py-1.5 bg-neutral-900/95 dark:bg-white text-white dark:text-charcoal-900 text-base font-bold rounded-lg shadow-xl transition-opacity duration-200 whitespace-nowrap z-50 pointer-events-none">
                  {sec.label}
                </div>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  /**
   * The menu opened from Profile contains the complete permitted navigation tree.
   *
   * It used to list sections and stop there, which meant every screen inside a section — Roles,
   * Structure, Shifts & Devices, Hiring — was two taps and a horizontal tab bar away, and the
   * drawer gave no sign the screen existed at all. On a desktop that second level is a tab strip
   * you can see; on a phone it is off the bottom of a menu that looked complete. An administrator
   * with ten sections and twenty-odd screens is exactly who felt that.
   *
   * So sections that hold more than one screen list them. Single-screen sections stay one line —
   * repeating "Assets / Assets" would be noise, not navigation.
   */
  const renderEmployeeMobileNavTree = () => {
    // Headed by the tree's own groups — Work, Me, Support — rather than by "Today" and "More".
    // Those two split the list at whatever the bottom bar happened to seat, so the drawer's
    // headings described the bar instead of the app, and a screen moved on or off the bar changed
    // heading without changing what it is. Work leads here for the same reason it leads the bar.
    const titles = ESS_NAV.map((group) => group.title);
    const groups = [
      ...titles.map((title) => ({
        title,
        sections: menuSections.filter((sec) => sec.group === title),
      })),
      // A section the ESS tree did not group cannot go unlisted just because it is unexpected.
      { title: 'More', sections: menuSections.filter((sec) => !titles.includes(sec.group)) },
    ].filter((group) => group.sections.length > 0);

    return (
      <div className="mobile-nav-tree employee-more-nav">
        {groups.map((group) => (
          <div key={group.title} className="employee-more-group">
            <p>{group.title}</p>
            <div className="employee-more-grid">
              {group.sections.map((sec) => {
                const Icon = sec.icon;
                const sectionActive = activeSection?.id === sec.id;
                const label = sec.label;
                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => { openSection(sec); setMobileMenuOpen(false); }}
                    aria-current={sectionActive ? 'page' : undefined}
                    className="employee-more-tile"
                  >
                    <Icon size={17} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderMobileNavTree = () => {
    if (primaryRole === 'employee') return renderEmployeeMobileNavTree();

    return (
      <div className="mobile-nav-tree">
        {menuSections.map((sec) => {
        const single = sec.tabs.length === 1 ? sec.tabs[0] : null;
        const Icon = single?.icon ?? sec.icon;
        const sectionActive = single ? single.id === activeTab : activeSection?.id === sec.id;
        const screens = sec.tabs.length > 1 ? sec.tabs : [];
        return (
          <div key={sec.id} className="mobile-nav-group">
            <button
              type="button"
              onClick={() => { openSection(sec); setMobileMenuOpen(false); }}
              aria-current={sectionActive && screens.length === 0 ? 'page' : undefined}
              className="mobile-nav-section"
            >
              <Icon size={15} />
              <span className="truncate">{single?.label ?? sec.label}</span>
            </button>

            {screens.length > 0 && (
              <div className="mobile-nav-screens">
                {screens.map((t) => {
                  const id = t.to ?? t.id;
                  const on = activeTab === t.id || activeTab === id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => { setActiveTab(id); setMobileMenuOpen(false); }}
                      aria-current={on ? 'page' : undefined}
                      className={on ? 'is-active' : undefined}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
      </div>
    );
  };

  return (
    <div className="app-shell flex h-dvh w-full overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-charcoal-900 dark:text-warm-gray-100 relative transition-colors duration-250">
      <a href="#main-content" className="skip-link" onClick={(event) => {
        // HashRouter owns the fragment. A normal anchor would navigate to a nonexistent screen.
        event.preventDefault();
        document.getElementById('main-content')?.focus({ preventScroll: true });
      }}>Skip to content</a>

      {/* Sidebar - Desktop */}
      <aside inert={mobileMenuOpen || undefined} aria-hidden={mobileMenuOpen || undefined} className={`hidden lg:flex h-dvh flex-col bg-white dark:bg-charcoal-900 border-r border-neutral-200 dark:border-neutral-800 shrink-0 select-none transition-all duration-300 ease-in-out ${isSidebarCollapsed ? 'w-20' : 'w-64'
        }`}>
        {/* Logo area */}
        <div className={`p-4 flex items-center justify-between border-b border-neutral-100 dark:border-charcoal-800/80 transition-all duration-300 ${isSidebarCollapsed ? 'flex-col space-y-4 px-2' : 'flex-row'
          }`}>
          {!isSidebarCollapsed ? (
            <>
              <div className="flex items-center space-x-2.5 min-w-0">
                <div className="p-2 bg-brand-action text-brand-on rounded-xl shadow-[0_0_18px_rgba(14,169,113,.2)] flex items-center justify-center shrink-0">
                  <BrandMark size={15} />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-extrabold text-xs tracking-wider text-neutral-900 dark:text-warm-gray-100 uppercase truncate">{appName}</span>

                </div>
              </div>
              <button
                onClick={() => setIsSidebarCollapsed(true)}
                className="p-1.5 hover:bg-neutral-100 dark:hover:bg-charcoal-800/80 rounded-lg text-neutral-455 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-warm-gray-200 transition-colors"
                title="Collapse Sidebar" aria-label="Collapse Sidebar"
              >
                <ChevronLeft size={14} />
              </button>
            </>
          ) : (
            <>
              <div className="p-2 bg-brand-action text-brand-on rounded-xl shadow-[0_0_18px_rgba(14,169,113,.2)] flex items-center justify-center">
                <BrandMark size={16} />
              </div>
              <button
                onClick={() => setIsSidebarCollapsed(false)}
                className="p-1.5 hover:bg-neutral-100 dark:hover:bg-charcoal-800/80 rounded-lg text-neutral-455 dark:text-neutral-500 hover:text-neutral-900 dark:hover:text-warm-gray-200 transition-colors"
                title="Expand Sidebar" aria-label="Expand Sidebar"
              >
                <ChevronRight size={14} />
              </button>
            </>
          )}
        </div>

        {/* Grouped Links Navigation */}
        <nav className="flex-1 py-3 px-2.5 space-y-3 overflow-y-auto max-h-[calc(100vh-140px)]">
          {renderNavLinks()}
        </nav>

        {/* Footer profile metadata */}
        <div className={`p-3 border-t border-neutral-200 dark:border-neutral-800 bg-neutral-50/50 dark:bg-charcoal-900 flex transition-colors duration-300 ${isSidebarCollapsed ? 'flex-col items-center space-y-3 px-2' : 'items-center justify-between'
          }`}>
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className="flex items-center space-x-2.5 min-w-0 text-left rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
            title="Open my profile"
            aria-label="Open my profile"
          >
            <div className="w-9 h-9 rounded-xl bg-brand-action text-brand-on flex items-center justify-center font-bold text-xs shrink-0 font-mono shadow-sm">
              {displayInitials}
            </div>
            {!isSidebarCollapsed && (
              <div className="min-w-0">
                <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">{displayName}</span>
                <span className="block text-2xs text-neutral-455 dark:text-neutral-500 truncate">{displaySubtitle}</span>
              </div>
            )}
          </button>
          <button
            onClick={signOut}
            className={`p-1.5 bg-neutral-105 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-505 dark:text-neutral-455 hover:text-neutral-900 dark:hover:text-neutral-200 rounded-lg cursor-pointer transition-colors ${isSidebarCollapsed ? 'w-8 h-8 flex items-center justify-center' : ''
              }`}
            title="Sign Out" aria-label="Sign Out"
          >
            <LogOut size={13} />
          </button>
        </div>
      </aside>

      {/* Main Panel Content Area */}
      <div inert={mobileMenuOpen || undefined} aria-hidden={mobileMenuOpen || undefined} className="app-content flex-1 flex min-h-0 flex-col min-w-0">

        {/* Header toolbar */}
        <header data-profile-page={activeTab === 'profile' && canViewTab('profile') ? 'true' : undefined} className="app-header border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-charcoal-900/85 backdrop-blur-md flex justify-between items-center px-4 sm:px-6 sticky top-0 z-35 transition-colors duration-200">
          {/* Mobile menu toggle & Title */}
          <div className="app-header-title flex items-center gap-3.5">
            <span className="app-header-title-label font-semibold text-xs sm:text-sm text-neutral-800 dark:text-neutral-200 truncate max-w-[145px] sm:max-w-none">
              {activeSection?.label || ''}
              {activeSection && activeSection.tabs.length > 1 && activeTabMeta && (
                <span className="hidden sm:inline text-neutral-400 dark:text-neutral-500 font-normal">
                  {' · '}{activeTabMeta.label}
                </span>
              )}
            </span>
          </div>

          {/* Quick options */}
          <div className="app-header-actions flex items-center gap-1.5 sm:gap-4">

            {/* Ctrl + K search bar */}
            <button
              onClick={() => setShowCommandPalette(true)}
              className="hidden md:flex items-center gap-2 w-56 lg:w-72 px-3 py-2 bg-neutral-100 dark:bg-charcoal-800/60 border border-neutral-200/85 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-brand/25 text-neutral-500 dark:text-neutral-400 rounded-xl text-xs cursor-pointer transition-all"
            >
              <Search size={14} className="shrink-0" />
              <span className="truncate">Search anything…</span>
              <span className="ml-auto shrink-0 text-2xs font-mono px-1.5 py-0.5 bg-white dark:bg-charcoal-900 text-neutral-500 dark:text-neutral-400 rounded-md border border-neutral-200 dark:border-neutral-800">⌘K</span>
            </button>

            {/* Mobile search icon */}
            <button
              onClick={() => setShowCommandPalette(true)}
              className="mobile-search-trigger md:hidden p-2 hover:bg-neutral-100 dark:hover:bg-charcoal-800/80 rounded-xl text-neutral-550 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
            >
              <Search size={16} />
            </button>

            {/* Which role you are working as — and, when you hold more than one, the way to change
                it. It was a card near the bottom of Settings, which is a long walk for something
                done several times a day and left the chip in this corner stating a fact you could
                not act on. Same chip, now the control. */}
            <RoleSwitcher
              viewRole={primaryRole}
              trueRole={trueRole}
              heldRoles={heldRoles}
              roleLabel={roleLabel}
              onChange={setViewRole}
            />

            {/* Appearance toggle */}
            {pwaUpdateRegistration && (
              <button
                onClick={applyPwaUpdate}
                className="header-update-action inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-2 bg-brand-action hover:bg-brand-action-hover text-brand-on rounded-xl text-2xs font-bold transition-colors cursor-pointer"
                title="Update app"
                aria-label="Update app"
              >
                <RefreshCw size={15} />
                <span className="hidden sm:inline">Update</span>
              </button>
            )}

            {installPrompt && !isPwaInstalled && (
              <button
                onClick={installPwa}
                className="header-install-action inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-2 bg-neutral-100 dark:bg-charcoal-800/60 hover:bg-neutral-200 dark:hover:bg-charcoal-800 border border-neutral-200/85 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-xl text-2xs font-bold transition-colors cursor-pointer"
                title="Install app"
                aria-label="Install app"
              >
                <Download size={15} />
                <span className="hidden sm:inline">Install</span>
              </button>
            )}

            {!isOnline && (
              <div
                className="header-offline-status inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-2 bg-amber-100 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 text-amber-700 dark:text-amber-300 rounded-xl text-2xs font-bold"
                role="status"
                aria-live="polite"
              >
                <WifiOff size={15} />
                <span className="hidden sm:inline">Offline</span>
              </div>
            )}

            <button
              type="button"
              onClick={toggleTheme}
              aria-pressed={theme === 'dark'}
              className="header-theme-toggle inline-flex items-center justify-center min-h-11 min-w-11 p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-xl text-neutral-550 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Notification trigger */}
            <NotificationBell onNavigate={setActiveTab} />

            {/* User chip */}
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              className="header-profile-trigger flex min-h-11 min-w-11 sm:min-w-0 items-center justify-center gap-2.5 pl-0 sm:pl-3 ml-0.5 sm:border-l border-neutral-200 dark:border-neutral-800 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
              title="Open my profile"
              aria-label="Open my profile"
            >
              <div className="w-8 h-8 rounded-xl bg-brand-action text-brand-on flex items-center justify-center font-bold text-xs shrink-0 font-mono shadow-sm">
                {displayInitials}
              </div>
              <div className="hidden lg:flex flex-col leading-none min-w-0 max-w-[130px]">
                <span className="text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">{displayName}</span>
                <span className="text-2xs text-neutral-455 dark:text-neutral-500 truncate mt-0.5">{roleLabel}</span>
              </div>
            </button>

          </div>
        </header>

        {/* Command Palette (Ctrl + K) Inline Tray */}
        {showCommandPalette && (
          <div className="bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-900 p-4 space-y-3 animate-fade-in transition-all">
            <div className="command-palette-input max-w-2xl mx-auto flex items-center space-x-3 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-1.5">
              <Search size={14} className="text-neutral-450 shrink-0" />
              <input
                type="text"
                autoFocus
                placeholder="Search action or type command (e.g. Apply for Leave)..."
                value={commandSearch}
                onChange={(e) => setCommandSearch(e.target.value)}
                className="w-full bg-transparent border-none text-xs text-neutral-800 dark:text-neutral-250 placeholder-neutral-450 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50 rounded-md"
              />
              <button
                onClick={() => setShowCommandPalette(false)}
                className="text-2xs font-mono px-2 py-0.5 bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-750 text-neutral-500 hover:text-black dark:hover:text-white rounded border border-neutral-200 dark:border-neutral-700 cursor-pointer"
              >
                Close (ESC)
              </button>
            </div>

            <div className="max-w-2xl mx-auto grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
              {filteredCommands.map((cmd, idx) => (
                <button
                  key={idx}
                  onClick={cmd.action}
                  className="text-left px-3 py-2 bg-neutral-50 dark:bg-neutral-900/40 hover:bg-neutral-100/50 dark:hover:bg-neutral-900 border border-neutral-150 dark:border-neutral-900 rounded-xl text-xs font-medium flex items-center justify-between cursor-pointer transition-colors"
                >
                  <span>{cmd.label}</span>
                  <Terminal size={11} className="text-neutral-400 opacity-60" />
                </button>
              ))}
              {filteredCommands.length === 0 && (
                <div className="col-span-full py-4 text-center text-xs text-neutral-450">
                  No actions match your search query.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Content main body */}
        {/* Second level: only shown when a section actually holds more than one screen, so
            single-screen sections stay one click deep. */}
        {activeSection && activeSection.tabs.length > 1 && (
          <nav
            aria-label={`${activeSection.label} sections`}
            data-profile-page={activeTab === 'profile' && canViewTab('profile') ? 'true' : undefined}
            className="section-tabbar shrink-0 border-b border-neutral-200 dark:border-neutral-850 bg-white/70 dark:bg-charcoal-900/60 backdrop-blur-sm px-4 sm:px-6"
          >
            <div className="section-tab-scroll tab-scroll flex gap-5 -mb-px">
              {activeSection.tabs.map((t) => {
                const on = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.to ?? t.id)}
                    aria-current={on ? 'page' : undefined}
                    className={`section-tab-button shrink-0 whitespace-nowrap py-2.5 text-base font-semibold border-b-2 cursor-pointer transition-colors ${
                      on
                        ? 'border-brand text-brand-ink'
                        : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </nav>
        )}

        <main
          id="main-content"
          data-profile-page={activeTab === 'profile' && canViewTab('profile') ? 'true' : undefined}
          tabIndex={-1}
          className={`app-main flex-1 min-h-0 overflow-y-auto px-2 py-4 ${pullRefresh.pulling || pullRefresh.refreshing ? 'is-pulling-refresh' : ''}`}
          onTouchStart={handlePullStart}
          onTouchMove={handlePullMove}
          onTouchEnd={handlePullEnd}
          onTouchCancel={resetPullRefresh}
        >
          <div
            className="pull-refresh-indicator"
            data-visible={pullRefresh.pulling || pullRefresh.refreshing ? 'true' : 'false'}
            data-ready={pullRefresh.ready ? 'true' : 'false'}
            data-refreshing={pullRefresh.refreshing ? 'true' : 'false'}
            style={{ '--pull-distance': `${pullRefresh.distance}px` }}
            aria-live="polite"
            role="status"
          >
            <span>
              <RefreshCw size={15} />
            </span>
            <strong>
              {pullRefresh.refreshing ? 'Refreshing' : pullRefresh.ready ? 'Release to refresh' : 'Pull to refresh'}
            </strong>
          </div>
          <div ref={routeStageRef} className="route-stage" data-route={location.pathname}>
            <Suspense fallback={<div className="page-shell py-24 flex justify-center text-neutral-400 text-xs">Loading…</div>}>
            {(() => {
              if (!canViewTab(activeTab)) {
                return <AccessDenied />;
              }
              switch (activeTab) {
              case 'dashboard':
                return <Dashboard onNavigate={setActiveTab} viewRole={primaryRole} />;
              case 'employee-import':
                return <EmployeeImport onDone={() => setActiveTab('directory')} />;
              case 'directory':
                return <Directory />;
              case 'organization':
                return <Organization />;
              case 'attendance-person':
                return <EmployeeAttendanceDetail onBack={() => setActiveTab('attendance')} />;
              case 'attendance':
                return <Attendance />;
              case 'attendance-admin':
                return <AttendanceAdmin />;
              case 'leave':
                return <Leave />;
              case 'tasks':
                return <TaskManagement />;
              case 'messages':
                return <Messages />;
              case 'admin-chats':
                return <ChatMonitor />;
              case 'team':
                return <Team />;
              case 'payroll':
                return <Payroll />;
              case 'expense':
                return <Expense />;
              case 'performance':
                return <Performance />;
              case 'assets':
                return <AssetManagement />;
              case 'my-assets':
                return <MyAssets />;
              case 'documents':
                return <DocumentManagement />;
              case 'recruitment':
                return <Recruitment />;
              case 'onboarding':
                return <Onboarding />;
              case 'helpdesk':
                return <HelpdeskExit />;
              case 'reports':
                return <ReportsAnalytics />;
              case 'administration':
                return <Administration view="users" />;
              case 'admin-roles':
                return <Administration view="roles" />;
              case 'admin-audit':
                return <Administration view="logs" />;
              case 'settings':
                // The role switch used to live here. It is on the header chip now — the thing it
                // changes — so Settings is preferences and nothing else. See ui/RoleSwitcher.
                return (
                  <SettingsPage
                    theme={theme}
                    onToggleTheme={toggleTheme}
                    installAvailable={Boolean(installPrompt)}
                    installed={isPwaInstalled}
                    updateAvailable={Boolean(pwaUpdateRegistration)}
                    online={isOnline}
                    onInstall={installPwa}
                    onUpdate={applyPwaUpdate}
                  />
                );
              case 'notifications':
                return <Notifications onNavigate={setActiveTab} />;
              case 'profile':
                return <UserProfile roleLabel={roleLabel} onOpenSettings={canViewTab('settings') ? () => setActiveTab('settings') : undefined} onOpenMenu={openMobileMenu} menuOpen={mobileMenuOpen} />;
                default:
                  // A screen name in the URL that this build does not have: a stale bookmark, a
                  // typo, a link from an older version. Now that the address bar can name a screen,
                  // this is reachable — send them home rather than painting a blank page they have
                  // no way out of.
                  return <Navigate to="/" replace />;
              }
            })()}
            </Suspense>
          </div>
        </main>

        <InstallPrompt
          deferredPrompt={installPrompt}
          standalone={isPwaInstalled}
          onInstall={installPwa}
        />

        <LiquidGlassNav
          items={mobilePrimarySections}
          activeId={activeTab}
          menuOpen={mobileMenuOpen}
          isPwaInstalled={isPwaInstalled}
          onSelect={(item, event) => {
            if (item.id === 'menu') openMobileMenu(event);
            else setActiveTab(item.tabs[0].id);
          }}
        />

      </div>




      {mobileMenuOpen && (
        <div className="profile-navigation-sheet lg:hidden" role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) setMobileMenuOpen(false); }}>
          <div ref={menuRef} id="mobile-navigation" role="dialog" aria-modal="true" aria-labelledby="profile-menu-title"
            className="profile-navigation-panel">
            <header className="profile-navigation-heading">
              <h2 id="profile-menu-title">Menu & settings</h2>
              <button type="button" onClick={() => setMobileMenuOpen(false)} aria-label="Close navigation menu"><X size={22} /></button>
            </header>
            <div className="profile-navigation-scroll">
              <div className="profile-navigation-identity">
                <span className="profile-navigation-avatar" aria-hidden="true">{displayInitials}</span>
                <div><strong>{displayName}</strong><span>{displaySubtitle}</span></div>
              </div>
              <div className="profile-navigation-shortcuts">
                {canViewTab('settings') && <button type="button" onClick={() => { setActiveTab('settings'); setMobileMenuOpen(false); }}><Settings size={18} /><span>Settings</span><ChevronRight size={16} /></button>}
                <button type="button" onClick={toggleTheme} aria-pressed={theme === 'dark'}>
                  {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}<span>{theme === 'dark' ? 'Light appearance' : 'Dark appearance'}</span>
                </button>
              </div>
              {heldRoles.length > 1 && <div className="profile-navigation-role"><span>Workspace view</span>
                <RoleSwitcher viewRole={primaryRole} trueRole={trueRole} heldRoles={heldRoles} roleLabel={roleLabel} onChange={setViewRole} />
              </div>}
              <label className="profile-navigation-search"><Search size={18} aria-hidden="true" />
                <input type="search" aria-label="Search menu" placeholder="Search menu" value={menuSearch} onChange={event => setMenuSearch(event.target.value)} />
              </label>
              <nav aria-label="All sections">{menuSections.length ? renderMobileNavTree() : <p className="profile-navigation-empty" role="status">No sections match “{menuSearch}”.</p>}</nav>
              <button type="button" className="profile-navigation-signout" onClick={signOut}><LogOut size={18} />Sign out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
