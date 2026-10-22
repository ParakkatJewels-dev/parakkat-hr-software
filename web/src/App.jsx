import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, Suspense, lazy } from 'react';
import {
  ESS_NAV, OVERSIGHT_NAV, OVERSIGHT_GROUPS, canSeeTab, visibleSections as navSections,
  mobilePrimarySections as pickMobilePrimary, mobileLitId, groupSections,
} from './lib/navMap';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  House, Users, CalendarDays, Calendar, Wallet, Receipt, Headset, LogOut, X, Sun, Moon, FolderOpen, ChartColumn, Shield, Settings, Terminal, Search, ChevronRight, ClipboardList, Download, RefreshCw, WifiOff, Laptop, Target, UserRound, Bell, MessageSquare, Ellipsis,
} from 'lucide-react';

// Import components
import Dashboard from './components/Dashboard';
import NotFound from './pages/NotFound';
import InstallPrompt from './components/InstallPrompt';
import { SkeletonPage } from './components/ui/Skeleton';
const Directory = lazy(() => import('./components/Directory'));
const Approvals = lazy(() => import('./components/Approvals'));
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
const DeveloperSettings = lazy(() => import('./components/DeveloperSettings'));
const WorkLedger = lazy(() => import('./components/WorkLedger'));
const Messages = lazy(() => import('./components/Messages'));
const ChatMonitor = lazy(() => import('./components/ChatMonitor'));
const Team = lazy(() => import('./components/Team'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
const UserProfile = lazy(() => import('./components/UserProfile'));
const Notifications = lazy(() => import('./components/Notifications'));
import NotificationBell from './components/NotificationBell';
import BrandMark from './components/ui/BrandMark';
import RoleSwitcher from './components/ui/RoleSwitcher';
import MobileTabBar from './components/shell/MobileTabBar';
import { NavigationCountBadge, NavigationCountStatus } from './components/ui/CountBadge';
import Sidebar from './components/shell/Sidebar';
import { ShellNavContext } from './components/shell/shellNavContext';
import './components/shell/shell.css';
import { useAuth } from './auth/AuthContext';
import { useEmployeeAvatars } from './data/documents';
import './components/profileNavigation.css';
import { usePermissions } from './auth/usePermissions';
import { resolveHeldRoles, resolvePrimaryRole } from './lib/roles';
import { useViewRole } from './lib/viewRole';
import { appIdentityFor, appNameFor, appRoleFor, documentTitleFor } from './lib/appName';
import { useRealtimeSync } from './lib/realtime';
import { useIncomingMessageDelivery } from './data/messages';
import { useSectionCounts } from './data/sectionCounts';
import { unreadTotal } from './lib/conversations';
import { NAVIGATION_COUNT_LABELS, navigationScreenCount, navigationSectionCount, navigationCountLabel, navigationCountTarget } from './lib/navigationCounts';
import { useClockFormat } from './lib/timeFormat';
import { useVersionCheck } from './lib/versionCheck';
import { isStandalonePwa } from './lib/pwa';
import { watchPwaIdentity } from './lib/pwaIdentity';
import { stripFocus } from './lib/focusRow';
import { appRouteDisposition, resolveAppRoute, tasksToLedger } from './lib/appRoutes';
import { syncNativeTheme } from './mobile/native';

// Prettify a role key like 'branch_manager' -> 'Branch Manager'.
const prettyRole = (key) =>
  key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Short labels for the phone's five primary destinations. Full menu entries keep their names.
const MOBILE_NAV_LABELS = {
  dashboard: 'Home',
  directory: 'People',
  menu: 'More',
  attendance: 'Attendance',
  leave: 'Leave',
  payroll: 'Pay',
  tasks: 'Tasks',
  ledger: 'Work',
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
      <h1 className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">Access restricted</h1>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm">
        You don't have permission to view this section. If you believe this is a mistake, contact your
        HR administrator.
      </p>
    </div>
  );
}

export default function App() {
  const { employee, user, isSuperAdmin, signOut, assignments, permissions, hiddenScreens } = useAuth();
  const { canAny, canBeyondSelf, viewingAsEmployee } = usePermissions();
  useRealtimeSync(); // live-sync data across devices via Supabase Realtime
  const incomingMessages = useIncomingMessageDelivery();
  const unreadMessageCount = unreadTotal(incomingMessages.data);
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
  const namingRole = appRoleFor(assignments, isSuperAdmin);
  const installIdentity = appIdentityFor(namingRole);
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
  // The FIRST segment names the screen. Known tab and record segments belong to that screen —
  // /#/attendance/exceptions, /#/attendance-admin/sync, /#/directory/<employeeId>. Validate the
  // full path before loading a screen, then let its existing tab and permission checks take over.
  const location = useLocation();
  const navigate = useNavigate();
  const routeStageRef = useRef(null);
  const appRoute = resolveAppRoute(location.pathname);
  const activeTab = appRoute.screen;
  // Deliberately the same shape as the setState it replaces, so every onNavigate / onBack /
  // command-palette caller keeps working untouched. Switching screens drops the inner tab, which
  // is right: the exceptions tab of Attendance means nothing on Payroll.
  const setActiveTab = useCallback((id) => navigate(`/${id}`), [navigate]);
  // Task Management now lives inside the Work Ledger: its old addresses open the matching tab.
  const ledgerTarget = tasksToLedger(location.pathname, location.search, { canTeam: canBeyondSelf('task.read') });
  useEffect(() => { if (ledgerTarget) navigate(ledgerTarget, { replace: true }); }, [ledgerTarget, navigate]);

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
  // 'light', 'dark' or 'system' (follow the device). `theme` is what is actually shown.
  const [themeMode, setThemeMode] = useState(() => localStorage.getItem('theme') || 'light');
  const [systemDark, setSystemDark] = useState(() => typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    if (themeMode !== 'system' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(query.matches);
    onChange();
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, [themeMode]);
  const theme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode;

  // Command Palette trigger
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [installError, setInstallError] = useState(null);
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

  // App only mounts after authenticated access resolves. No generic install prompt is offered
  // while logging in, and changing workspace view leaves the actual account's install name alone.
  useLayoutEffect(() => {
    setInstallError(null);
    return watchPwaIdentity({
      identity: installIdentity, document, window,
      onPrompt: setInstallPrompt,
      onInstalled: () => setIsPwaInstalled(true),
    });
  }, [installIdentity, user?.id]);

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
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    const onUpdateReady = (event) => setPwaUpdateRegistration(event.detail?.registration ?? null);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pwa:update-ready', onUpdateReady);

    return () => {
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
    localStorage.setItem('theme', themeMode);
    syncNativeTheme(theme);
  }, [theme, themeMode]);

  // Command Palette global key listener (Ctrl + K). The Work Ledger has its own command bar on the
  // same shortcut, so the app palette stands aside there.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k' && activeTabRef.current !== 'ledger') {
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
    setThemeMode(theme === 'dark' ? 'light' : 'dark');
  };

  const installPwa = async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    setInstallPrompt(null);
    setInstallError(null);
    try {
      await prompt.prompt();
      await prompt.userChoice;
      // appinstalled confirms completion; accepting the dialog alone is not installation.
    } catch {
      setInstallError('Could not open installation. Reload the app and try again.');
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
    home: House, messages: MessageSquare, people: Users, time: CalendarDays, pay: Wallet,
    'asset-management': Laptop, work: ClipboardList, support: Headset,
    insights: ChartColumn, account: UserRound, admin: Settings,
  };
  const ESS_ICONS = {
    dashboard: House, attendance: CalendarDays, leave: Calendar, payroll: Wallet,
    tasks: ClipboardList, messages: MessageSquare, performance: Target, ledger: ClipboardList, expense: Receipt, 'my-assets': Laptop,
    documents: FolderOpen, helpdesk: Headset, profile: UserRound, notifications: Bell,
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
    icon: SECTION_ICONS[sec.id] ?? ESS_ICONS[sec.id] ?? House,
    tabs: sec.tabs.map((t) => ({ ...t, icon: t.icon ?? ESS_ICONS[t.id] })),
  }));

  const countsEnabled = visibleSections.some(section => section.tabs.some(tab => tab.id in NAVIGATION_COUNT_LABELS));
  const sectionCounts = useSectionCounts({ enabled: countsEnabled, selfOnly: viewingAsEmployee });
  const screenBadge = (id) => navigationScreenCount(id, sectionCounts.data, unreadMessageCount);
  const sectionBadge = (section) => navigationSectionCount(section, sectionCounts.data, unreadMessageCount);
  const navTarget = (tab) => navigationCountTarget(tab, sectionCounts.data);
  const countStatus = countsEnabled && sectionCounts.isError ? {
    message: sectionCounts.data
      ? 'Section counts could not be refreshed. Showing the last available counts.'
      : 'Section counts are unavailable. Open a section to review its items.',
    label: sectionCounts.data ? 'Counts may be outdated' : 'Counts unavailable',
  } : null;

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
  const routeDisposition = appRouteDisposition(appRoute, canViewTab(activeTab));
  const isNotFound = routeDisposition === 'not-found';

  // Which section owns the screen on show? Drives sidebar highlighting and the tab bar, so a
  // shortcut from the dashboard lands in the right place without the caller knowing the tree.
  // `focus` is transient — a notification pointing at one row — and is stripped the moment the
  // screen claims it (useFocusRow). It must not take part in deciding which nav item is current.
  const here = (location.pathname + stripFocus(location.search)).replace(/^\/+/, '').replace(/\/+$/, '');
  const activeSection = isNotFound ? null : (
    visibleSections.find((sec) => sec.tabs.some((t) => t.to === here))
    ?? visibleSections.find((sec) => sec.tabs.some((t) => t.id === activeTab))
    ?? visibleSections[0]);

  const displayRole = namingRole === null ? null : primaryRole;
  const appName = appNameFor(displayRole);

  // The browser tab, which is the one piece of chrome a person sees without looking at the app.
  // The dashboard uses the app name; other screens prefix it with the current section.
  useEffect(() => {
    const screen = isNotFound ? 'Page not found' : activeSection?.id === 'home' || activeTab === 'dashboard' ? null : activeSection?.label;
    document.title = documentTitleFor(displayRole, screen);
  }, [displayRole, activeSection, activeTab, isNotFound]);

  const mobilePrimarySections = pickMobilePrimary(visibleSections, primaryRole).map(section => ({
    ...section,
    icon: ESS_ICONS[section.id] ?? (section.id === 'menu' ? Ellipsis : section.icon),
    label: MOBILE_NAV_LABELS[section.id] ?? section.label,
    avatarUrl: section.id === 'profile' ? avatarUrl : undefined,
    initials: displayInitials,
    badge: screenBadge(section.id),
  }));
  const needle = menuSearch.trim().toLowerCase();
  const menuSections = visibleSections.map(section => ({
    ...section,
    tabs: section.tabs.filter(tab => !needle || `${section.label} ${tab.label} ${MOBILE_NAV_LABELS[tab.id] || ''}`.toLowerCase().includes(needle)),
  })).filter(section => section.tabs.length);

  // Where you are, for the page header's breadcrumb and section tabs (see ui/PageHeader).
  const shellNav = {
    section: activeSection, activeTab, screenBadge, navTarget, select: setActiveTab,
  };

  // Open a section from the sidebar: land on the first screen the user may actually see.
  const openSection = (sec) => {
    const target = navTarget(sec.tabs[0]);
    if (isNotFound || !sec.tabs.some((t) => t.id === activeTab) || target.includes('ticketQueue=needs-action')) setActiveTab(target);
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
  // The phone More page (round 2, after the reference phone kit): one plain list per group —
  // icon, label, count, arrow. Sections already on the bottom bar are left out unless searching;
  // their other screens are one tap away in the pills under each page title.
  const barSectionIds = new Set(visibleSections
    .filter((sec) => sec.tabs.some((tab) => mobilePrimarySections.some((item) => item.id === tab.id)))
    .map((sec) => sec.id));
  const renderMoreList = () => {
    const titles = primaryRole === 'employee' ? ESS_NAV.map((group) => group.title) : OVERSIGHT_GROUPS;
    const listed = needle ? menuSections : menuSections.filter((sec) => !barSectionIds.has(sec.id));
    return groupSections(listed, titles).map((group) => (
      <section key={group.title ?? 'more'} className="more-group">
        {group.title && <h3 className="more-group-title">{group.title}</h3>}
        <div className="more-list">
          {group.sections.map((sec) => {
            const single = sec.tabs.length === 1 ? sec.tabs[0] : null;
            const Icon = single?.icon ?? sec.icon;
            const label = single?.label ?? sec.label;
            const badge = sectionBadge(sec);
            const current = !isNotFound && (single ? single.id === activeTab : activeSection?.id === sec.id);
            return (
              <button key={sec.id} type="button" className="more-row"
                onClick={() => { openSection(sec); setMobileMenuOpen(false); }}
                aria-current={current ? 'page' : undefined} aria-label={navigationCountLabel(label, badge)}>
                <span className="more-row-icon" aria-hidden="true">{Icon && <Icon size={19} />}</span>
                <span className="more-row-label">{label}</span>
                <NavigationCountBadge badge={badge} />
                <ChevronRight size={17} className="more-row-chevron" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>
    ));
  };

  return (
    <div className="app-shell flex h-dvh w-full overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-charcoal-900 dark:text-warm-gray-100 relative transition-colors duration-250">
      <a href="#main-content" className="skip-link" onClick={(event) => {
        // HashRouter owns the fragment. A normal anchor would navigate to a nonexistent screen.
        event.preventDefault();
        document.getElementById('main-content')?.focus({ preventScroll: true });
      }}>Skip to content</a>

      <Sidebar
        groups={groupSections(visibleSections, primaryRole === 'employee' ? ESS_NAV.map((group) => group.title) : OVERSIGHT_GROUPS)}
        activeSectionId={activeSection?.id}
        collapsed={isSidebarCollapsed}
        onCollapsedChange={setIsSidebarCollapsed}
        sectionBadge={sectionBadge}
        onOpenSection={openSection}
        countStatus={countStatus}
        identity={{ name: displayName, subtitle: roleLabel, initials: displayInitials, avatarUrl }}
        onOpenProfile={() => setActiveTab('profile')}
        onSignOut={signOut}
        hidden={mobileMenuOpen}
      />

      {/* Main Panel Content Area */}
      <div inert={mobileMenuOpen || undefined} aria-hidden={mobileMenuOpen || undefined} className="app-content flex-1 flex min-h-0 flex-col min-w-0">

        {/* Top bar: brand on phones, search on larger screens, then the account controls. */}
        <header data-profile-page={!isNotFound && activeTab === 'profile' && canViewTab('profile') ? 'true' : undefined} className="app-header">
          <div className="app-header-start">
            <span className="app-header-brand lg:hidden">
              <span className="app-header-logo" aria-hidden="true"><BrandMark size={20} /></span>
              <span className="app-header-wordmark"><strong>PARAKKAT</strong><span>HRMS</span></span>
            </span>
            <button type="button" onClick={() => setShowCommandPalette(true)} className="app-header-search hidden md:flex">
              <Search size={17} className="shrink-0" aria-hidden="true" />
              <span className="truncate">Search screens and actions…</span>
              <kbd>⌘K</kbd>
            </button>
          </div>

          <div className="app-header-actions">
            <button type="button" onClick={() => setShowCommandPalette(true)} aria-label="Search"
              className="mobile-search-trigger app-header-icon md:hidden">
              <Search size={18} />
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
              className="header-theme-toggle app-header-icon"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Notification trigger */}
            <NotificationBell onNavigate={setActiveTab} />

            {/* Account */}
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              className="header-profile-trigger"
              title={`${displayName} · ${roleLabel}`}
              aria-label="Open my profile"
            >
              <span className="header-profile-avatar" aria-hidden="true">
                {avatarUrl ? <img src={avatarUrl} alt="" /> : displayInitials}
              </span>
            </button>
          </div>
        </header>

        {/* Command Palette (Ctrl + K) Inline Tray */}
        {showCommandPalette && (
          <div className="bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-900 p-4 space-y-3 animate-fade-in transition-all">
            <div className="input-shell command-palette-input max-w-2xl mx-auto flex items-center space-x-3 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-1.5">
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

        <main
          id="main-content"
          data-profile-page={!isNotFound && activeTab === 'profile' && canViewTab('profile') ? 'true' : undefined}
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
            <ShellNavContext.Provider value={shellNav}>
            <Suspense fallback={<SkeletonPage />}>
            {(() => {
              if (ledgerTarget) return <SkeletonPage />;
              if (routeDisposition === 'not-found') return <NotFound appName={appName} />;
              if (routeDisposition === 'access-denied') {
                return <AccessDenied />;
              }
              switch (activeTab) {
              case 'dashboard':
                return <Dashboard onNavigate={setActiveTab} viewRole={primaryRole} />;
              case 'approvals':
                return <Approvals />;
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
              case 'ledger':
                return <WorkLedger />;
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
              case 'admin-developer':
                return <DeveloperSettings />;
              case 'settings':
                // The role switch used to live here. It is on the header chip now — the thing it
                // changes — so Settings is preferences and nothing else. See ui/RoleSwitcher.
                return (
                  <SettingsPage
                    appName={installIdentity.name}
                    theme={theme}
                    themeMode={themeMode}
                    onThemeMode={setThemeMode}
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
                  return <NotFound appName={appName} />;
              }
            })()}
            </Suspense>
            </ShellNavContext.Provider>
          </div>
        </main>

        {installError && <div role="alert" className="px-4 py-2 text-xs text-rose-700 dark:text-rose-300">{installError}</div>}
        <InstallPrompt
          appName={installIdentity.name}
          deferredPrompt={installPrompt}
          standalone={isPwaInstalled}
          onInstall={installPwa}
        />

        <MobileTabBar
          items={mobilePrimarySections}
          activeId={isNotFound ? '' : mobileLitId(mobilePrimarySections, activeTab)}
          currentId={isNotFound ? '' : activeTab}
          menuOpen={mobileMenuOpen}
          isPwaInstalled={isPwaInstalled}
          countStatus={countStatus}
          onSelect={(item, event) => {
            if (item.id === 'menu') openMobileMenu(event);
            else setActiveTab(navTarget(item.tabs[0]));
          }}
        />

      </div>




      {mobileMenuOpen && (
        <div className="profile-navigation-sheet lg:hidden" role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) setMobileMenuOpen(false); }}>
          <div ref={menuRef} id="mobile-navigation" role="dialog" aria-modal="true" aria-labelledby="profile-menu-title"
            className="profile-navigation-panel">
            <header className="profile-navigation-heading">
              <span className="app-header-brand">
                <span className="app-header-logo" aria-hidden="true"><BrandMark size={20} /></span>
                <span className="app-header-wordmark"><strong>PARAKKAT</strong><span>HRMS</span></span>
              </span>
              <h2 id="profile-menu-title" className="sr-only">More</h2>
              <button type="button" onClick={() => setMobileMenuOpen(false)} aria-label="Close navigation menu"><X size={20} /></button>
            </header>
            <div className="profile-navigation-scroll">
              <button type="button" className="profile-navigation-identity" disabled={!canViewTab('profile')}
                onClick={() => { setActiveTab('profile'); setMobileMenuOpen(false); }}>
                <span className="profile-navigation-avatar" aria-hidden="true">{displayInitials}</span>
                <span className="profile-navigation-identity-copy"><strong>{displayName}</strong><span>{displaySubtitle}</span></span>
                {canViewTab('profile') && <ChevronRight size={17} className="more-row-chevron" aria-hidden="true" />}
              </button>
              <label className="input-shell profile-navigation-search"><Search size={17} aria-hidden="true" />
                <input type="search" aria-label="Search menu" placeholder="Search menu" value={menuSearch} onChange={event => setMenuSearch(event.target.value)} />
              </label>
              <nav aria-label="All sections">{menuSections.length ? renderMoreList() : <p className="profile-navigation-empty" role="status">No sections match “{menuSearch}”.</p>}
                <NavigationCountStatus {...countStatus} />
              </nav>
              <section className="more-group">
                <h3 className="more-group-title">Preferences</h3>
                <div className="more-list">
                  {canViewTab('settings') && (
                    <button type="button" className="more-row" onClick={() => { setActiveTab('settings'); setMobileMenuOpen(false); }}>
                      <span className="more-row-icon" aria-hidden="true"><Settings size={19} /></span>
                      <span className="more-row-label">Settings</span>
                      <ChevronRight size={17} className="more-row-chevron" aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="more-row" onClick={toggleTheme} aria-pressed={theme === 'dark'}>
                    <span className="more-row-icon" aria-hidden="true">{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</span>
                    <span className="more-row-label">Dark appearance</span>
                    <span className={`more-switch ${theme === 'dark' ? 'is-on' : ''}`} aria-hidden="true"><span /></span>
                  </button>
                  {heldRoles.length > 1 && (
                    <div className="more-row profile-navigation-role">
                      <span className="more-row-label">Workspace view</span>
                      <RoleSwitcher viewRole={primaryRole} trueRole={trueRole} heldRoles={heldRoles} roleLabel={roleLabel} onChange={setViewRole} />
                    </div>
                  )}
                </div>
              </section>
              <button type="button" className="profile-navigation-signout" onClick={signOut}><LogOut size={18} aria-hidden="true" />Sign out</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
