import React, { useState, useEffect } from 'react';
import { 
  LayoutDashboard, Users, Clock, Calendar, DollarSign, 
  Receipt, Target, Briefcase, UserCheck, HelpCircle, 
  Bell, ChevronDown, Sparkles, LogOut, Menu, X, Bot,
  Sun, Moon, Network, Laptop, FolderOpen, BarChart3,
  Share2, Shield, Settings, Terminal, Search, Command
} from 'lucide-react';

// Import components
import Dashboard from './components/Dashboard';
import Directory from './components/Directory';
import Attendance from './components/Attendance';
import Leave from './components/Leave';
import Payroll from './components/Payroll';
import Expense from './components/Expense';
import Performance from './components/Performance';
import Recruitment from './components/Recruitment';
import Onboarding from './components/Onboarding';
import HelpdeskExit from './components/HelpdeskExit';
import NavosAI from './components/NavosAI';
import Organization from './components/Organization';
import AssetManagement from './components/AssetManagement';
import DocumentManagement from './components/DocumentManagement';
import ReportsAnalytics from './components/ReportsAnalytics';
import Integrations from './components/Integrations';
import Administration from './components/Administration';
import ChangePassword from './components/ChangePassword';
import { useAuth } from './auth/AuthContext';
import { usePermissions } from './auth/usePermissions';

// Prettify a role key like 'branch_manager' -> 'Branch Manager'.
const prettyRole = (key) =>
  key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

// Shown when a user lands on a section they lack permission for.
function AccessDenied() {
  return (
    <div className="page-shell flex flex-col items-center justify-center py-20 text-center animate-fade-in">
      <Shield size={28} className="text-neutral-400 dark:text-gold-600 mb-3" />
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
  const { canAny } = usePermissions();

  // Real signed-in identity (replaces the old hardcoded "Aditya Parakkat").
  const displayName = employee?.full_name || user?.email || 'User';
  const displaySubtitle = isSuperAdmin ? 'Super Admin' : employee?.employee_code || 'Employee';
  const displayInitials = (
    displayName.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('') || 'U'
  ).toUpperCase();

  // Real role label for the header (replaces the fake Admin/Employee toggle).
  const roleNames = [...new Set((assignments || []).map((a) => a.role))];
  const roleLabel = isSuperAdmin
    ? 'Super Admin'
    : roleNames.length
    ? prettyRole(roleNames[0]) + (roleNames.length > 1 ? ` +${roleNames.length - 1}` : '')
    : 'Employee';

  const [activeTab, setActiveTab] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  // Theme state: dark or light
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  
  // Command Palette trigger
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [commandSearch, setCommandSearch] = useState('');

  // Apply Theme class
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
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

  // Grouped Sidebar Sections (Miller's Law / Law of Proximity)
  // Each item names the permission required to SEE it (held at any scope). null = always visible.
  // RLS still scopes what data appears inside each screen. This mapping is a sensible default and
  // is easy to tune per your policy.
  const navSections = [
    {
      title: 'Overview',
      items: [
        { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, perm: null }
      ]
    },
    {
      title: 'People Operations',
      items: [
        { id: 'directory', label: 'Employee Directory', icon: Users, perm: 'employee.read' },
        { id: 'organization', label: 'Org Hierarchy', icon: Network, perm: 'org.manage' }
      ]
    },
    {
      title: 'Time & Targets',
      items: [
        { id: 'attendance', label: 'Attendance logs', icon: Clock, perm: 'attendance.read' },
        { id: 'leave', label: 'Leave Management', icon: Calendar, perm: 'leave.read' },
        { id: 'performance', label: 'PMS Performance', icon: Target, perm: 'performance.manage' }
      ]
    },
    {
      title: 'Finance & Assets',
      items: [
        { id: 'payroll', label: 'Payroll Console', icon: DollarSign, perm: 'payslip.read' },
        { id: 'expense', label: 'Expense Claims', icon: Receipt, perm: 'expense.read' },
        { id: 'assets', label: 'Asset Management', icon: Laptop, perm: 'asset.read' }
      ]
    },
    {
      title: 'Talent Acquisition',
      items: [
        { id: 'recruitment', label: 'Recruit Hub', icon: Briefcase, perm: 'recruitment.manage' },
        { id: 'onboarding', label: 'Onboarding Board', icon: UserCheck, perm: 'onboarding.manage' }
      ]
    },
    {
      title: 'Support & Security',
      items: [
        { id: 'documents', label: 'Document Vault', icon: FolderOpen, perm: 'document.read' },
        { id: 'helpdesk', label: 'Support & Exit', icon: HelpCircle, perm: 'ticket.read' },
        { id: 'reports', label: 'Reports & Analytics', icon: BarChart3, perm: 'report.read' },
        { id: 'integrations', label: 'REST Integrations', icon: Share2, perm: 'rbac.manage' },
        { id: 'administration', label: 'Administration', icon: Shield, perm: 'rbac.manage' },
        { id: 'settings', label: 'Settings', icon: Settings, perm: null }
      ]
    }
  ];

  // Flat lookup + guard: can the current user view a given tab?
  const allNavItems = navSections.flatMap((s) => s.items);
  const canViewTab = (tabId) => {
    const item = allNavItems.find((i) => i.id === tabId);
    return !item || !item.perm || canAny(item.perm);
  };

  // Command palette options
  const commandOptions = [
    { label: 'Go to Dashboard', action: () => { setActiveTab('dashboard'); setShowCommandPalette(false); } },
    { label: 'Open Employee Directory', action: () => { setActiveTab('directory'); setShowCommandPalette(false); } },
    { label: 'Go to Attendance', action: () => { setActiveTab('attendance'); setShowCommandPalette(false); } },
    { label: 'Apply for Time-Off / Leave', action: () => { setActiveTab('leave'); setShowCommandPalette(false); } },
    { label: 'Submit Conveyance Expense Claim', action: () => { setActiveTab('expense'); setShowCommandPalette(false); } },
    { label: 'View Asset Inventory Management', action: () => { setActiveTab('assets'); setShowCommandPalette(false); } },
    { label: 'Configure REST Integrations', action: () => { setActiveTab('integrations'); setShowCommandPalette(false); } },
    { label: 'Toggle Light/Dark Theme', action: () => { toggleTheme(); setShowCommandPalette(false); } }
  ];

  const filteredCommands = commandOptions.filter(cmd => 
    cmd.label.toLowerCase().includes(commandSearch.toLowerCase())
  );

  // Helper function to render grouped navigation items
  const renderNavLinks = (isMobile = false) => {
    return navSections.map((section, idx) => {
      // Show only items whose required permission the user holds (at any scope).
      const visibleItems = section.items.filter(item => !item.perm || canAny(item.perm));

      if (visibleItems.length === 0) return null;

      return (
        <div key={idx} className="space-y-1 mt-4 first:mt-0">
          <span className="px-3 text-[10px] font-bold uppercase tracking-[0.12em] text-neutral-400 dark:text-gold-600 block select-none">
            {section.title}
          </span>
          <div className="space-y-0.5 mt-1.5">
            {visibleItems.map(item => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    if (isMobile) setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center space-x-3 px-3 py-2.5 rounded-xl text-xs font-semibold cursor-pointer transition-all ${
                    isActive 
                      ? 'nav-item-active' 
                      : 'text-neutral-500 dark:text-warm-gray-400 hover:bg-neutral-50 dark:hover:bg-charcoal-800/80 hover:text-neutral-900 dark:hover:text-warm-gray-100'
                  }`}
                >
                  <Icon size={14} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      );
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-neutral-50 text-neutral-900 dark:bg-charcoal-900 dark:text-warm-gray-100 relative transition-colors duration-250">
      
      {/* Sidebar - Desktop */}
      <aside className="hidden lg:flex h-screen flex-col w-64 bg-white dark:bg-charcoal-900 border-r border-neutral-200 dark:border-gold-500/15 shrink-0 select-none transition-colors duration-200">
        {/* Logo area */}
        <div className="p-4  flex items-center space-x-2">
          <div className="p-1.5 bg-black dark:bg-gold-450 text-white dark:text-charcoal-900 rounded-lg shadow-[0_0_18px_rgba(223,189,98,.12)]">
            {/* <Sparkles size={16} /> */}
            PARAKKAT HR CRM
          </div>
          {/* <div>
            <h1 className="font-bold text-sm tracking-wide text-neutral-900 dark:text-warm-gray-100">hrflow.io</h1>
            <span className="text-[9px] text-neutral-400 dark:text-neutral-500 font-mono">ENTERPRISE CLOUD</span>
          </div> */}
        </div>

        {/* Grouped Links Navigation */}
        <nav className="flex-1 py-3 px-2.5 space-y-3 overflow-y-auto max-h-[calc(100vh-140px)]">
          {renderNavLinks()}
        </nav>

        {/* Footer profile metadata */}
        <div className="p-3 border-t border-neutral-200 dark:border-gold-500/15 bg-neutral-50/50 dark:bg-charcoal-900 flex items-center justify-between transition-colors">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-black dark:bg-gold-450 text-white dark:text-charcoal-900 flex items-center justify-center font-bold text-xs shrink-0 font-mono">
              {displayInitials}
            </div>
            <div className="min-w-0">
              <span className="block text-xs font-bold text-neutral-800 dark:text-warm-gray-100 truncate">{displayName}</span>
              <span className="block text-[9.5px] text-neutral-455 dark:text-neutral-500 truncate">{displaySubtitle}</span>
            </div>
          </div>
          <button
            onClick={signOut}
            className="p-1.5 bg-neutral-105 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-505 dark:text-neutral-450 hover:text-neutral-900 dark:hover:text-neutral-200 rounded-lg cursor-pointer transition-colors"
            title="Sign Out"
          >
            <LogOut size={13} />
          </button>
        </div>
      </aside>

      {/* Main Panel Content Area */}
      <div className="flex-1 flex min-h-0 flex-col min-w-0">
        
        {/* Header toolbar */}
        <header className="h-16 border-b border-neutral-200 dark:border-gold-500/15 bg-white/80 dark:bg-charcoal-900/85 backdrop-blur-md flex justify-between items-center px-4 sm:px-6 sticky top-0 z-35 transition-colors duration-200">
          {/* Mobile menu toggle & Title */}
          <div className="flex items-center space-x-3.5">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer"
            >
              <Menu size={18} />
            </button>
            <span className="font-semibold text-xs sm:text-sm tracking-tight text-neutral-800 dark:text-neutral-200 truncate max-w-[145px] sm:max-w-none">
              {navSections.flatMap(s => s.items).find(n => n.id === activeTab)?.label || ''}
            </span>
          </div>

          {/* Quick options */}
          <div className="flex items-center space-x-1.5 sm:space-x-4">
            
            {/* Ctrl + K Search trigger button */}
            <button 
              onClick={() => setShowCommandPalette(true)}
              className="hidden md:flex items-center space-x-2 px-3 py-1.5 bg-neutral-100 dark:bg-neutral-900 border border-neutral-200/85 dark:border-neutral-850 hover:border-neutral-300 dark:hover:border-neutral-805 text-neutral-500 dark:text-neutral-400 rounded-xl text-xs cursor-pointer transition-all"
            >
              <Search size={13} />
              <span>Search Action...</span>
              <span className="text-[9px] font-mono px-1.5 py-0.2 bg-neutral-200 dark:bg-neutral-800 rounded-md border border-neutral-300 dark:border-neutral-700">Ctrl + K</span>
            </button>

            {/* Real role / scope indicator (replaces the old cosmetic ESS/Admin toggle) */}
            <div className="hidden sm:flex items-center space-x-1.5 px-2.5 py-1 bg-neutral-100 dark:bg-neutral-905 border border-neutral-200/80 dark:border-gold-500/15 rounded-xl text-[10px] font-mono text-neutral-600 dark:text-gold-300">
              <Shield size={11} />
              <span>{roleLabel}</span>
            </div>

            {/* Appearance toggle */}
            <button 
              onClick={toggleTheme}
              className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-xl text-neutral-550 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            </button>

            {/* Notification trigger */}
            <button className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-900 rounded-xl text-slate-400 hover:text-neutral-900 dark:hover:text-white transition-colors cursor-pointer relative">
              <Bell size={16} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-black dark:bg-gold-450 rounded-full border border-white dark:border-charcoal-900"></span>
            </button>

          </div>
        </header>

        {/* Command Palette (Ctrl + K) Inline Tray */}
        {showCommandPalette && (
          <div className="bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-900 p-4 space-y-3 animate-fade-in transition-all">
            <div className="max-w-2xl mx-auto flex items-center space-x-3 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 rounded-xl px-3 py-1.5">
              <Search size={14} className="text-neutral-450 shrink-0" />
              <input
                type="text"
                autoFocus
                placeholder="Search action or type command (e.g. Apply for Leave)..."
                value={commandSearch}
                onChange={(e) => setCommandSearch(e.target.value)}
                className="w-full bg-transparent border-none text-xs text-neutral-800 dark:text-neutral-250 placeholder-neutral-450 focus:outline-none"
              />
              <button 
                onClick={() => setShowCommandPalette(false)}
                className="text-[9px] font-mono px-2 py-0.5 bg-neutral-100 hover:bg-neutral-200 dark:bg-neutral-800 dark:hover:bg-neutral-750 text-neutral-500 hover:text-black dark:hover:text-white rounded border border-neutral-200 dark:border-neutral-700 cursor-pointer"
              >
                Close (ESC)
              </button>
            </div>
            
            <div className="max-w-2xl mx-auto grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 pt-1">
              {filteredCommands.map((cmd, idx) => (
                <button
                  key={idx}
                  onClick={cmd.action}
                  className="text-left px-3 py-2 bg-neutral-50 dark:bg-neutral-900/40 hover:bg-neutral-100/50 dark:hover:bg-neutral-900 border border-neutral-150 dark:border-neutral-900 rounded-xl text-[10.5px] font-medium flex items-center justify-between cursor-pointer transition-colors"
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
        <main className="flex-1 min-h-0 p-4 sm:p-6 overflow-y-auto">
          {(() => {
            if (!canViewTab(activeTab)) {
              return <AccessDenied />;
            }
            switch (activeTab) {
              case 'dashboard':
                return <Dashboard onNavigate={setActiveTab} />;
              case 'directory':
                return <Directory />;
              case 'organization':
                return <Organization />;
              case 'attendance':
                return <Attendance />;
              case 'leave':
                return <Leave />;
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
              case 'integrations':
                return <Integrations />;
              case 'administration':
                return <Administration />;
              case 'settings':
                return (
                  <div className="space-y-6 animate-fade-in text-xs text-neutral-500">
                    <h2 className="text-xl font-bold text-slate-100 font-sans">System Settings</h2>
                    <ChangePassword />
                    <div className="premium-card p-5 space-y-4">
                      <h3 className="font-semibold text-base text-neutral-800 dark:text-white">Profile Configuration</h3>
                      <div className="grid grid-cols-2 gap-4 max-w-md">
                        <div>
                          <label className="block text-slate-400 font-semibold mb-1">Company Domain</label>
                          <input type="text" disabled value="hrflow.io" className="w-full bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 px-3 py-1.5 rounded-xl text-neutral-805 dark:text-neutral-200" />
                        </div>
                        <div>
                          <label className="block text-slate-400 font-semibold mb-1">Default Locale</label>
                          <input type="text" disabled value="en-IN (India)" className="w-full bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 px-3 py-1.5 rounded-xl text-neutral-805 dark:text-neutral-200" />
                        </div>
                      </div>
                      <div className="pt-3 border-t border-neutral-200 dark:border-neutral-850">
                        <label className="flex items-center space-x-2 text-neutral-700 dark:text-neutral-300 font-semibold cursor-pointer">
                          <input type="checkbox" defaultChecked className="rounded border-neutral-400" />
                          <span>Enable real-time push email alerts for approvals</span>
                        </label>
                      </div>
                    </div>
                  </div>
                );
              default:
                return null;
            }
          })()}
        </main>

      </div>

      {/* Floating conversational bot widget (NAVOS AI Assistant) */}
      <NavosAI onNavigate={setActiveTab} />



      {/* Mobile Drawer Sidebar Navigation */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm z-50 flex animate-fade-in lg:hidden">
          <div className="w-64 bg-white dark:bg-neutral-950 h-full p-4 flex flex-col justify-between relative border-r border-neutral-200 dark:border-neutral-900 shadow-2xl transition-colors">
            <button 
              onClick={() => setMobileMenuOpen(false)}
              className="absolute top-4 right-4 p-2 bg-neutral-150 dark:bg-slate-800 hover:bg-neutral-200 dark:hover:bg-slate-700 rounded-xl text-neutral-500 dark:text-slate-400 hover:text-black dark:hover:text-white transition-all cursor-pointer"
            >
              <X size={16} />
            </button>

            <div className="space-y-4">
              <div className="flex items-center space-x-2 border-b border-neutral-200 dark:border-neutral-900 pb-3">
                <div className="p-1.5 bg-black dark:bg-gold-450 text-white dark:text-charcoal-900 rounded-lg">
                  Parakkat HR System
                </div>
                
              </div>

              <nav className="space-y-4 max-h-[70vh] overflow-y-auto">
                {renderNavLinks(true)}
              </nav>
            </div>

            <div className="p-2.5 border-t border-neutral-200 dark:border-neutral-900 bg-neutral-50/50 dark:bg-neutral-950/20 flex items-center justify-between transition-colors">
              <div className="flex items-center space-x-2.5 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-black dark:bg-gold-450 text-white dark:text-charcoal-900 flex items-center justify-center font-bold text-xs shrink-0 font-mono">
                  {displayInitials}
                </div>
                <div className="min-w-0">
                  <span className="block text-xs font-bold text-neutral-800 dark:text-slate-200 truncate">{displayName}</span>
                  <span className="block text-[9px] text-neutral-450 dark:text-neutral-500 truncate">{displaySubtitle}</span>
                </div>
                <button
                  onClick={signOut}
                  className="p-1.5 ml-auto bg-neutral-150 dark:bg-neutral-900 hover:bg-neutral-200 dark:hover:bg-neutral-800 text-neutral-500 dark:text-neutral-450 rounded-lg cursor-pointer transition-colors"
                  title="Sign Out"
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
