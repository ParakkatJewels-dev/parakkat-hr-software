import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import {
  LayoutDashboard, Users, Clock, Calendar, DollarSign, Receipt, HelpCircle, Sparkles, LogOut, Menu, X, Sun, Moon, FolderOpen, BarChart3, Shield, Settings, Terminal, Search, ChevronLeft, ChevronRight, ListChecks, Download, RefreshCw, WifiOff, Boxes, Target,
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
const DocumentManagement = lazy(() => import('./components/DocumentManagement'));
const ReportsAnalytics = lazy(() => import('./components/ReportsAnalytics'));
const Administration = lazy(() => import('./components/Administration'));
const TaskManagement = lazy(() => import('./components/TaskManagement'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
import NotificationBell from './components/NotificationBell';
import { useAuth } from './auth/AuthContext';
import { usePermissions } from './auth/usePermissions';
import { resolvePrimaryRole } from './lib/roles';
import { useRealtimeSync } from './lib/realtime';
import { useClockFormat } from './lib/timeFormat';
import { useVersionCheck } from './lib/versionCheck';
import { isStandalonePwa } from './lib/pwa';
import { syncNativeTheme } from './mobile/native';

// Prettify a role key like 'branch_manager' -> 'Branch Manager'.
const prettyRole = (key) =>
  key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Shown when a user lands on a section they lack permission for.
function AccessDenied() {
  return (
    <div className="page-shell flex flex-col items-center justify-center py-20 text-center animate-fade-in">
      <Shield size={28} className="text-neutral-400 dark:text-[#0c9765] mb-3" />
      <h2 className="text-base font-bold text-neutral-800 dark:text-warm-gray-100">Access restricted</h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-sm">
        You don't have permission to view this section. If you believe this is a mistake, contact your
        HR administrator.
      </p>
    </div>
  );
}

export default function App() {
  const { employee, user, isSuperAdmin, signOut, assignments } = useAuth();
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
  const primaryRole = resolvePrimaryRole(assignments, isSuperAdmin);
  const roleNames = [...new Set((assignments || []).map((a) => a.role))];
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
  const activeTab = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || 'dashboard';
  // Deliberately the same shape as the setState it replaces, so every onNavigate / onBack /
  // command-palette caller keeps working untouched. Switching screens drops the inner tab, which
  // is right: the exceptions tab of Attendance means nothing on Payroll.
  const setActiveTab = useCallback((id) => navigate(`/${id}`), [navigate]);

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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

  // Sidebar collapsed state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() =>
    localStorage.getItem('sidebar-collapsed') === 'true'
  );

  // Theme state: dark or light
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  // Command Palette trigger
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  const [isPwaInstalled, setIsPwaInstalled] = useState(() => isStandalonePwa());
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [pwaUpdateRegistration, setPwaUpdateRegistration] = useState(null);

  useEffect(() => {
    document.body.classList.add('app-body-lock');
    return () => document.body.classList.remove('app-body-lock');
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

  // Grouped Sidebar Sections (Miller's Law / Law of Proximity)
  // Each item names the permission required to SEE it (held at any scope). null = always visible.
  // RLS still scopes what data appears inside each screen. This mapping is a sensible default and
  // is easy to tune per your policy.
  //
  // The sidebar is role-aware: a pure ESS employee gets a compact "My Workspace" layout with
  // self-service labels; anyone holding an oversight role gets the full grouped structure below.
  // Item ids are identical in both, so routing and permission guards are shared.
  const essNavSections = [
    {
      title: 'My Workspace',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: null },
        { id: 'attendance', label: 'My Attendance', icon: Clock, perm: 'attendance.read' },
        { id: 'leave', label: 'My Leave', icon: Calendar, perm: 'leave.read' },
        { id: 'tasks', label: 'My Tasks', icon: ListChecks, perm: 'task.read' },
        // The employee role holds goal.read AND goal.update — goals are something they are meant to
        // keep up to date, not just something managers set. Without this the screen existed only at
        // /performance, reachable by typing the URL, so in practice nobody used it.
        { id: 'performance', label: 'My Goals', icon: Target, perm: 'goal.read' },
        { id: 'payroll', label: 'My Payslips', icon: DollarSign, perm: 'payslip.read' },
        { id: 'expense', label: 'My Expenses', icon: Receipt, perm: 'expense.read' },
        { id: 'documents', label: 'My Documents', icon: FolderOpen, perm: 'document.read' }
      ]
    },
    {
      title: 'Support',
      items: [
        { id: 'helpdesk', label: 'Help & Support', icon: HelpCircle, perm: 'ticket.read' },
        { id: 'settings', label: 'Settings', icon: Settings, perm: null }
      ]
    }
  ];

  // Oversight navigation: eight destinations, each grouping the screens that belong to one job.
  //
  // The previous shape put 19 flat items in front of an entity admin and split things that are
  // one task — attendance logs sat apart from attendance setup, hiring was two entries, and
  // Administration was a catch-all. Now the sidebar answers "what am I doing?" and the tab bar
  // answers "which part of it?", reusing the section->tabs pattern the Payroll and Administration
  // screens already use. Screen ids are unchanged, so every existing link and dashboard shortcut
  // still resolves.
  const oversightSections = [
    {
      id: 'home',
      label: 'Home',
      icon: LayoutDashboard,
      tabs: [{ id: 'dashboard', label: 'Dashboard', perm: null }],
    },
    {
      id: 'people',
      label: 'People',
      icon: Users,
      tabs: [
        // `scoped` = oversight module: needs the permission beyond self scope, so a pure ESS
        // employee (self-scoped employee.read) never sees the company directory.
        { id: 'directory', label: 'Directory', perm: 'employee.read', scoped: true },
        { id: 'employee-import', label: 'Import', perm: 'employee.create' },
        { id: 'organization', label: 'Structure', perm: 'org.manage' },
        { id: 'recruitment', label: 'Hiring', perm: 'recruitment.manage' },
        { id: 'onboarding', label: 'Onboarding', perm: 'onboarding.manage' },
        { id: 'documents', label: 'Documents', perm: 'document.read' },
      ],
    },
    {
      id: 'time',
      label: 'Time & Attendance',
      icon: Clock,
      tabs: [
        { id: 'attendance', label: 'Attendance', perm: 'attendance.read' },
        { id: 'attendance-person', label: 'By person', perm: 'attendance.read', scoped: true },
        { id: 'leave', label: 'Leave', perm: 'leave.read' },
        { id: 'attendance-admin', label: 'Shifts & Devices', perm: 'device.manage' },
      ],
    },
    {
      id: 'pay',
      label: 'Pay & Expenses',
      icon: DollarSign,
      tabs: [
        { id: 'payroll', label: 'Payroll', perm: 'payslip.read' },
        { id: 'expense', label: 'Expenses', perm: 'expense.read' },
      ],
    },
    // Its own destination rather than a tab inside Work. What the company owns and who has it is
    // a job of its own — it was sitting third behind Tasks and Goals, which is where people went
    // looking for it and did not find it.
    {
      id: 'asset-management',
      label: 'Asset Management',
      icon: Boxes,
      tabs: [
        { id: 'assets', label: 'Assets', perm: 'asset.read' },
      ],
    },
    {
      id: 'work',
      label: 'Work',
      icon: ListChecks,
      tabs: [
        { id: 'tasks', label: 'Tasks', perm: 'task.read' },
        { id: 'performance', label: 'Goals', perm: 'goal.read' },
      ],
    },
    {
      id: 'support',
      label: 'Support',
      icon: HelpCircle,
      tabs: [{ id: 'helpdesk', label: 'Helpdesk & Exits', perm: 'ticket.read' }],
    },
    {
      id: 'insights',
      label: 'Reports',
      icon: BarChart3,
      tabs: [{ id: 'reports', label: 'Reports', perm: 'report.read' }],
    },
    {
      id: 'admin',
      label: 'Administration',
      icon: Shield,
      tabs: [
        { id: 'administration', label: 'Users & Access', perm: 'rbac.manage' },
        { id: 'admin-roles', label: 'Roles', perm: 'rbac.manage' },
        // audit.read, not rbac.manage. The audit_log policy requires audit.read, which only
          // entity_admin and super_admin hold — gating the tab on rbac.manage handed it to
          // dept_head, branch_manager, zonal_manager and hr_manager, all of whom then saw a
          // permanently empty screen.
          { id: 'admin-audit', label: 'Audit Log', perm: 'audit.read' },
        { id: 'settings', label: 'Settings', perm: null },
      ],
    },
  ];

  // ESS keeps a flat list: with nine items, adding a second level would be friction, not order.
  const essSections = essNavSections.flatMap((g) =>
    g.items.map((it) => ({ id: it.id, label: it.label, icon: it.icon, tabs: [{ ...it }] }))
  );

  const sections = primaryRole === 'employee' ? essSections : oversightSections;

  // Can the current user see a screen? `scoped` items need the permission beyond self scope.
  const canSeeTab = (t) =>
    !t.perm || (t.scoped ? canBeyondSelf(t.perm) : canAny(t.perm));

  // Sections the user may see at all, with their permitted screens.
  const visibleSections = sections
    .map((sec) => ({ ...sec, tabs: sec.tabs.filter(canSeeTab) }))
    .filter((sec) => sec.tabs.length > 0);

  const allTabs = sections.flatMap((sec) => sec.tabs);
  // Every tab the application defines, in either tree. `allTabs` above is only the tabs in THIS
  // user's nav, which is the wrong set to authorise against.
  const allKnownTabs = [...essSections, ...oversightSections].flatMap((sec) => sec.tabs);

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
    return Boolean(t) && canSeeTab(t);
  };

  // Which section owns the screen on show? Drives sidebar highlighting and the tab bar, so a
  // shortcut from the dashboard lands in the right place without the caller knowing the tree.
  const activeSection =
    visibleSections.find((sec) => sec.tabs.some((t) => t.id === activeTab)) ?? visibleSections[0];
  const activeTabMeta = allTabs.find((t) => t.id === activeTab);
  // Five, not four. The bar is icon-only, so five plus the More button still leaves ~60px a
  // target on a 390px screen — and at four, Asset Management fell off the end of the bar and into
  // the More drawer, which is exactly where nobody looked for it.
  const mobilePrimarySections = visibleSections.slice(0, 5);

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
    { label: 'Submit an Expense Claim', action: () => setActiveTab('expense') },
    { label: 'View Asset Inventory', action: () => setActiveTab('assets') },
    { label: 'Run Payroll', action: () => setActiveTab('payroll') },
    { label: 'Open Reports & Analytics', action: () => setActiveTab('reports') },
    { label: 'Toggle Light/Dark Theme', action: () => toggleTheme() },
  ]
    .filter((c) => c.label === 'Toggle Light/Dark Theme' || true)
    .map((c) => ({ ...c, action: () => { c.action(); setShowCommandPalette(false); } }));

  const filteredCommands = commandOptions.filter((cmd) =>
    cmd.label.toLowerCase().includes(commandSearch.toLowerCase())
  );

  // Sidebar: one row per section. No group headings any more — eight destinations do not need
  // sub-titles to be scannable, and removing them buys back vertical space.
  const renderNavLinks = (isMobile = false) => {
    const isCollapsedDesktop = !isMobile && isSidebarCollapsed;

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
                if (isMobile) setMobileMenuOpen(false);
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
                    ? 'text-black dark:text-[#10b981]'
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

  return (
    <div className="app-shell flex h-dvh w-full overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-charcoal-900 dark:text-warm-gray-100 relative transition-colors duration-250">
      <a href="#main-content" className="skip-link">Skip to content</a>

      {/* Sidebar - Desktop */}
      <aside className={`hidden lg:flex h-dvh flex-col bg-white dark:bg-charcoal-900 border-r border-neutral-200 dark:border-neutral-800 shrink-0 select-none transition-all duration-300 ease-in-out ${isSidebarCollapsed ? 'w-20' : 'w-64'
        }`}>
        {/* Logo area */}
        <div className={`p-4 flex items-center justify-between border-b border-neutral-100 dark:border-charcoal-800/80 transition-all duration-300 ${isSidebarCollapsed ? 'flex-col space-y-4 px-2' : 'flex-row'
          }`}>
          {!isSidebarCollapsed ? (
            <>
              <div className="flex items-center space-x-2.5 min-w-0">
                <div className="p-2 bg-[#0ea971] text-white rounded-xl shadow-[0_0_18px_rgba(14,169,113,.2)] flex items-center justify-center shrink-0">
                  <Sparkles size={15} />
                </div>
                <div className="flex flex-col min-w-0">
                  <span className="font-extrabold text-xs tracking-wider text-neutral-900 dark:text-warm-gray-100 uppercase truncate">HR SYSTEM</span>

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
              <div className="p-2 bg-[#0ea971] text-white rounded-xl shadow-[0_0_18px_rgba(14,169,113,.2)] flex items-center justify-center">
                <Sparkles size={16} />
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
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-black dark:bg-[#0ea971] text-white dark:text-white flex items-center justify-center font-bold text-xs shrink-0 font-mono shadow-sm">
              {displayInitials}
            </div>
            {!isSidebarCollapsed && (
              <div className="min-w-0">
                <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">{displayName}</span>
                <span className="block text-2xs text-neutral-455 dark:text-neutral-500 truncate">{displaySubtitle}</span>
              </div>
            )}
          </div>
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
      <div className="app-content flex-1 flex min-h-0 flex-col min-w-0">

        {/* Header toolbar */}
        <header className="app-header border-b border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-charcoal-900/85 backdrop-blur-md flex justify-between items-center px-4 sm:px-6 sticky top-0 z-35 transition-colors duration-200">
          {/* Mobile menu toggle & Title */}
          <div className="flex items-center space-x-3.5">
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-navigation"
              className="mobile-menu-trigger lg:hidden p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer"
            >
              <Menu size={18} />
            </button>
            <span className="font-semibold text-xs sm:text-sm text-neutral-800 dark:text-neutral-200 truncate max-w-[145px] sm:max-w-none">
              {activeSection?.label || ''}
              {activeSection && activeSection.tabs.length > 1 && activeTabMeta && (
                <span className="hidden sm:inline text-neutral-400 dark:text-neutral-500 font-normal">
                  {' · '}{activeTabMeta.label}
                </span>
              )}
            </span>
          </div>

          {/* Quick options */}
          <div className="app-header-actions flex items-center space-x-1.5 sm:space-x-4">

            {/* Ctrl + K search bar */}
            <button
              onClick={() => setShowCommandPalette(true)}
              className="hidden md:flex items-center gap-2 w-56 lg:w-72 px-3 py-2 bg-neutral-100 dark:bg-charcoal-800/60 border border-neutral-200/85 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-[#0ea971]/25 text-neutral-500 dark:text-neutral-400 rounded-xl text-xs cursor-pointer transition-all"
            >
              <Search size={14} className="shrink-0" />
              <span className="truncate">Search anything…</span>
              <span className="ml-auto shrink-0 text-2xs font-mono px-1.5 py-0.5 bg-white dark:bg-charcoal-900 text-neutral-500 dark:text-neutral-400 rounded-md border border-neutral-200 dark:border-neutral-800">⌘K</span>
            </button>

            {/* Mobile search icon */}
            <button
              onClick={() => setShowCommandPalette(true)}
              className="md:hidden p-2 hover:bg-neutral-100 dark:hover:bg-charcoal-800/80 rounded-xl text-neutral-550 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
            >
              <Search size={16} />
            </button>

            {/* Real role / scope indicator (replaces the old cosmetic ESS/Admin toggle) */}
            <div className="hidden sm:flex items-center space-x-1.5 px-2.5 py-1 bg-neutral-100 dark:bg-neutral-905 border border-neutral-200/80 dark:border-neutral-800 rounded-xl text-2xs font-mono text-neutral-600 dark:text-[#10b981]">
              <Shield size={11} />
              <span>{roleLabel}</span>
            </div>

            {/* Appearance toggle */}
            {pwaUpdateRegistration && (
              <button
                onClick={applyPwaUpdate}
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-2 bg-[#0ea971] hover:bg-[#0c9765] text-white rounded-xl text-2xs font-bold transition-colors cursor-pointer"
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
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-2 bg-neutral-100 dark:bg-charcoal-800/60 hover:bg-neutral-200 dark:hover:bg-charcoal-800 border border-neutral-200/85 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 rounded-xl text-2xs font-bold transition-colors cursor-pointer"
                title="Install app"
                aria-label="Install app"
              >
                <Download size={15} />
                <span className="hidden sm:inline">Install</span>
              </button>
            )}

            {!isOnline && (
              <div
                className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-2 bg-amber-100 dark:bg-amber-950/40 border border-amber-200/80 dark:border-amber-900/60 text-amber-700 dark:text-amber-300 rounded-xl text-2xs font-bold"
                role="status"
                aria-live="polite"
              >
                <WifiOff size={15} />
                <span className="hidden sm:inline">Offline</span>
              </div>
            )}

            <button
              onClick={toggleTheme}
              className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-xl text-neutral-550 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Notification trigger */}
            <NotificationBell onNavigate={setActiveTab} />

            {/* User chip */}
            <div className="hidden sm:flex items-center gap-2.5 pl-2 sm:pl-3 ml-0.5 border-l border-neutral-200 dark:border-neutral-800">
              <div className="w-8 h-8 rounded-xl bg-black dark:bg-[#0ea971] text-white dark:text-white flex items-center justify-center font-bold text-xs shrink-0 font-mono shadow-sm">
                {displayInitials}
              </div>
              <div className="hidden lg:flex flex-col leading-none min-w-0 max-w-[130px]">
                <span className="text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">{displayName}</span>
                <span className="text-2xs text-neutral-455 dark:text-neutral-500 truncate mt-0.5">{roleLabel}</span>
              </div>
            </div>

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
                className="w-full bg-transparent border-none text-xs text-neutral-800 dark:text-neutral-250 placeholder-neutral-450 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea971]/50 rounded-md"
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
            className="section-tabbar shrink-0 border-b border-neutral-200 dark:border-neutral-850 bg-white/70 dark:bg-charcoal-900/60 backdrop-blur-sm px-4 sm:px-6"
          >
            <div className="section-tab-scroll tab-scroll flex gap-5 -mb-px">
              {activeSection.tabs.map((t) => {
                const on = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    aria-current={on ? 'page' : undefined}
                    className={`section-tab-button shrink-0 whitespace-nowrap py-2.5 text-base font-semibold border-b-2 cursor-pointer transition-colors ${
                      on
                        ? 'border-[#0ea971] text-[#0ea971]'
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

        <main id="main-content" tabIndex={-1} className="app-main flex-1 min-h-0 overflow-y-auto py-4">
          <Suspense fallback={<div className="page-shell py-24 flex justify-center text-neutral-400 text-xs">Loading…</div>}>
          {(() => {
            if (!canViewTab(activeTab)) {
              return <AccessDenied />;
            }
            switch (activeTab) {
              case 'dashboard':
                return <Dashboard onNavigate={setActiveTab} />;
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
              case 'payroll':
                return <Payroll />;
              case 'expense':
                return <Expense />;
              case 'performance':
                return <Performance />;
              case 'assets':
                return <AssetManagement />;
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
                return <SettingsPage />;
              default:
                // A screen name in the URL that this build does not have: a stale bookmark, a
                // typo, a link from an older version. Now that the address bar can name a screen,
                // this is reachable — send them home rather than painting a blank page they have
                // no way out of.
                return <Navigate to="/" replace />;
            }
          })()}
          </Suspense>
        </main>

        <InstallPrompt
          deferredPrompt={installPrompt}
          standalone={isPwaInstalled}
          onInstall={installPwa}
        />

        <nav
          aria-label="Primary mobile navigation"
          className="mobile-bottom-nav  lg:hidden"
        >
          {mobilePrimarySections.map((sec) => {
            const Icon = sec.icon;
            const on = activeSection?.id === sec.id;
            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => openSection(sec)}
                aria-current={on ? 'page' : undefined}
                aria-label={sec.label}
                title={sec.label}
                className={`mobile-bottom-nav-item ${on ? 'mobile-bottom-nav-item-active' : ''}`}
              >
                <Icon size={18} />
                <span className="sr-only">{sec.label}</span>
              </button>
            );
          })}
          {visibleSections.length > mobilePrimarySections.length && (
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open all sections"
              aria-expanded={mobileMenuOpen}
              aria-controls="mobile-navigation"
              title="More"
              className="mobile-bottom-nav-item"
            >
              <Menu size={18} />
              <span className="sr-only">More</span>
            </button>
          )}
        </nav>

      </div>




      {/* Mobile Drawer Sidebar Navigation */}
      {mobileMenuOpen && (
        <div
          className="mobile-drawer fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex animate-fade-in lg:hidden"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMobileMenuOpen(false);
          }}
        >
          <div
            id="mobile-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Main navigation"
            className="mobile-drawer-panel w-[min(20rem,88vw)] bg-white dark:bg-neutral-950 h-full p-4 flex flex-col justify-between relative border-r border-neutral-200 dark:border-neutral-900 shadow-2xl transition-colors"
          >
            <button
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Close navigation menu"
              className="absolute top-4 right-4 p-2 bg-neutral-150 dark:bg-slate-800 hover:bg-neutral-200 dark:hover:bg-slate-700 rounded-xl text-neutral-500 dark:text-slate-400 hover:text-black dark:hover:text-white transition-all cursor-pointer"
            >
              <X size={16} />
            </button>

            <div className="flex flex-col flex-1 min-h-0 gap-4">
              <div className="flex items-center space-x-2 dark:border-neutral-900 pb-3">
                <div className="p-1.5  text-black  dark:text-white rounded-lg">
                  HR System
                </div>
              </div>
              <nav className="space-y-4 flex-1 min-h-0 overflow-y-auto overscroll-contain">
                {renderNavLinks(true)}
              </nav>
            </div>

            <div className="p-2.5 border-t border-neutral-200 dark:border-neutral-900 bg-neutral-50/50 dark:bg-neutral-950/20 flex items-center justify-between transition-colors">
              <div className="flex items-center space-x-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-black dark:bg-[#0ea971] text-white dark:text-charcoal-900 flex items-center justify-center font-bold text-xs shrink-0 font-mono">
                  {displayInitials}
                </div>
                <div className="min-w-0">
                  <span className="block text-xs font-bold text-neutral-800 dark:text-slate-200 truncate">{displayName}</span>
                  <span className="block text-2xs text-neutral-450 dark:text-neutral-500 truncate">{displaySubtitle}</span>
                </div>
                <button
                  onClick={signOut}
                  className="p-1.5 ml-auto bg-neutral-150 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-450 rounded-lg cursor-pointer transition-colors"
                  title="Sign Out" aria-label="Sign Out"
                >
                  <LogOut size={13} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
