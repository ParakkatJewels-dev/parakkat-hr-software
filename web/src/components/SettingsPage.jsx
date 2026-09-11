// Settings screen: password change, the user's own profile, and workspace configuration.
// Replaces the old hardcoded "Profile Configuration" mock. Profile fields the person may edit
// themselves (phone) save through the update_my_profile RPC; identity fields stay read-only and
// are managed by HR. Workspace settings are editable by super admins only — everyone else sees
// them read-only (RLS enforces this server-side too).
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  UserRound,
  Building2,
  Check,
  Loader2,
  Clock,
  Moon,
  Sun,
  Smartphone,
  Download,
  RefreshCw,
  Wifi,
  WifiOff,
  ShieldCheck,
  Palette,
  ChevronRight,
} from 'lucide-react';
import ChangePassword from './ChangePassword';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useEmployee } from '../data/employees';
import { useWorkspaceSettings, useSaveWorkspaceSettings, useUpdateMyProfile } from '../data/settings';
import { useClockFormat } from '../lib/timeFormat';
import { CLOCK_FORMATS } from '../lib/clock';
import './settings.css';

const inputClass =
  'w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 px-3 py-1.5 rounded-xl text-neutral-805 dark:text-neutral-200 text-xs focus:outline-none focus:border-brand/50 disabled:bg-neutral-100 dark:disabled:bg-neutral-905 disabled:text-neutral-500 dark:disabled:text-neutral-400';

function Field({ label, children, hint }) {
  const generatedId = useId();
  const id = children.props.id || generatedId;
  return (
    <div className="settings-field">
      <label htmlFor={id} className="block text-neutral-500 dark:text-slate-400 font-semibold mb-1 text-xs">
        {label}
        {hint && <span className="ml-1.5 font-normal text-2xs text-neutral-400">{hint}</span>}
      </label>
      {React.cloneElement(children, { id })}
    </div>
  );
}

function SaveButton({ onClick, pending, saved, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || pending}
      className="flex items-center gap-1.5 rounded-lg bg-brand-action hover:bg-brand-action-hover px-3.5 py-1.5 text-base font-bold text-brand-on transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
    >
      {pending ? <Loader2 size={11} className="animate-spin" /> : saved ? <Check size={11} /> : null}
      {saved ? 'Saved' : 'Save changes'}
    </button>
  );
}

function CardTitle({ icon: Icon, title, subtitle }) {
  return (
    <div className="settings-card-heading flex items-start gap-2.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand-ink dark:bg-brand/15">
        <Icon size={15} />
      </span>
      <div className="min-w-0">
        <h2 className="font-semibold text-base text-neutral-800 dark:text-white">{title}</h2>
        {subtitle ? (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SettingRow({ icon: Icon, title, detail, children, className = '' }) {
  return (
    <div className={`settings-row ${className}`}>
      <div className="settings-row-copy flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          <Icon size={14} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold text-neutral-800 dark:text-neutral-100">{title}</p>
          {detail ? (
            <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      <div className="settings-row-action">{children}</div>
    </div>
  );
}

export function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="settings-theme-switch"
    >
      <span className="settings-theme-track" aria-hidden="true">
        <span className="settings-theme-thumb">
          {checked ? <Moon size={12} /> : <Sun size={12} />}
        </span>
      </span>
    </button>
  );
}

function ActionButton({ children, onClick, disabled, variant = 'secondary' }) {
  const variantClass =
    variant === 'primary'
      ? 'border-brand bg-brand-action text-brand-on hover:bg-brand-action-hover'
      : 'border-neutral-200 bg-white text-neutral-700 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-bold transition-colors cursor-pointer disabled:cursor-default disabled:opacity-50 ${variantClass}`}
    >
      {children}
    </button>
  );
}

/** The signed-in person's own employee record; phone is self-service, the rest is HR-managed. */
function MyProfileCard() {
  const { employee, user } = useAuth();
  const employeeQuery = useEmployee(employee?.id);
  const me = employeeQuery.data || employee;
  const unavailable = employeeQuery.isLoading || employeeQuery.isError || !employeeQuery.data;
  const updateProfile = useUpdateMyProfile();

  const [phone, setPhone] = useState(() => me?.phone || '');
  const [saved, setSaved] = useState(false);
  useEffect(() => setPhone(me?.phone || ''), [me?.phone]);

  const save = () =>
    updateProfile.mutate(
      { phone },
      { onSuccess: () => { employeeQuery.refetch(); setSaved(true); setTimeout(() => setSaved(false), 2000); } }
    );

  return (
    <div className="premium-card settings-card space-y-4">
      <CardTitle
        icon={UserRound}
        title="My account"
        subtitle="Update your phone number. Your identity and placement are managed by HR."
      />
      {!employee?.id ? (
        <p className="text-xs text-neutral-500">
          No employee record is linked to this login, so there is no profile to edit here. Profiles
          are linked in Administration → Users &amp; Access.
        </p>
      ) : (
        <>
          {employeeQuery.isLoading && <p className="settings-card-notice" role="status">Loading your account details…</p>}
          {employeeQuery.isError && <div className="settings-card-notice" role="alert">
            <p>Your account details could not be loaded.</p>
            <ActionButton onClick={() => employeeQuery.refetch()}>Try again</ActionButton>
          </div>}
          <div className="settings-form-grid">
            <Field label="Full Name" hint="managed by HR">
              <input type="text" disabled value={me?.full_name || employee.full_name || ''} className={inputClass} />
            </Field>
            <Field label="Employee Code" hint="managed by HR">
              <input type="text" disabled value={me?.employee_code || employee.employee_code || '—'} className={inputClass} />
            </Field>
            <Field label="Login Email" hint="used to sign in">
              <input type="text" disabled value={user?.email || me?.email || ''} className={inputClass} />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                disabled={unavailable || updateProfile.isPending}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+91 …"
                className={inputClass}
              />
            </Field>
            <Field label="Branch" hint="managed by HR">
              <input type="text" disabled value={me?.branch?.name || '—'} className={inputClass} />
            </Field>
            <Field label="Designation" hint="managed by HR">
              <input type="text" disabled value={me?.designation?.title || '—'} className={inputClass} />
            </Field>
          </div>
          <div className="settings-card-actions flex items-center gap-3 pt-2 border-t border-neutral-200 dark:border-neutral-850">
            <SaveButton
              onClick={save}
              pending={updateProfile.isPending}
              saved={saved}
              disabled={unavailable || (me?.phone || '') === phone.trim()}
            />
            {updateProfile.isError && (
              <span className="text-xs text-rose-500">{updateProfile.error?.message}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Workspace-level settings from org_settings; editable only by super admins. */
/**
 * The reader's own display preferences.
 *
 * Kept apart from Workspace, which is company configuration an administrator owns. This is one
 * person's choice on one device, stored beside the theme rather than in the database — nobody should
 * need permission to read a clock the way they prefer.
 */
function PreferencesCard({
  theme = 'light',
  onToggleTheme,
  installAvailable = false,
  installed = false,
  updateAvailable = false,
  online = true,
  onInstall,
  onUpdate,
}) {
  const { hour12, setHour12 } = useClockFormat();
  const dark = theme === 'dark';
  const deviceStatus = useMemo(() => {
    if (!online) return { label: 'Offline', tone: 'text-amber-600 dark:text-amber-300', Icon: WifiOff };
    return { label: 'Online', tone: 'text-emerald-600 dark:text-emerald-400', Icon: Wifi };
  }, [online]);
  const DeviceIcon = deviceStatus.Icon;

  return (
    <>
    <div className="premium-card settings-card space-y-4">
      <CardTitle
        icon={Palette}
        title="Appearance"
        subtitle="Choose how this device looks and displays time."
      />

      <div className="settings-stack">
        <SettingRow
          icon={dark ? Moon : Sun}
          className="settings-theme-row"
          title="Theme mode"
          detail={dark ? 'Dark mode is active on this device.' : 'Light mode is active on this device.'}
        >
          <div className="settings-theme-control flex items-center gap-2">
            <span className="text-xs font-bold text-neutral-500 dark:text-neutral-400">
              {dark ? 'Dark' : 'Light'}
            </span>
            <ToggleSwitch
              checked={dark}
              onChange={onToggleTheme}
              label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            />
          </div>
        </SettingRow>

        <SettingRow
          icon={Clock}
          className="settings-time-row"
          title="Time format"
          detail="Used across attendance screens, timelines, and spreadsheet exports."
        >
          <div className="settings-segmented" role="group" aria-label="Time format">
            {CLOCK_FORMATS.map((f) => {
              const on = f.value === hour12;
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setHour12(f.value)}
                  className={on ? 'is-active' : ''}
                >
                  <span>{f.label}</span>
                  <span className="font-mono font-normal text-neutral-450">{f.example}</span>
                </button>
              );
            })}
          </div>
        </SettingRow>

      </div>
    </div>
    <div className="premium-card settings-card space-y-4">
      <CardTitle icon={Smartphone} title="App & device" subtitle="Installation, updates and connection status." />
      <div className="settings-stack">
        <SettingRow
          icon={Smartphone}
          title="Installed app"
          detail={installed ? 'This browser is already running as an installed app.' : 'Install for full-screen access from the home screen.'}
        >
          {installAvailable && !installed ? (
            <ActionButton onClick={onInstall} variant="primary">
              <Download size={13} /> Install
            </ActionButton>
          ) : (
            <span className="settings-status-pill">
              <Check size={12} /> {installed ? 'Installed' : 'Browser'}
            </span>
          )}
        </SettingRow>

        <SettingRow
          icon={RefreshCw}
          title="App version"
          detail={updateAvailable ? 'A newer app version is ready.' : 'The app checks for updates automatically.'}
        >
          <ActionButton onClick={onUpdate || (() => window.location.reload())} variant={updateAvailable ? 'primary' : 'secondary'}>
            <RefreshCw size={13} /> {updateAvailable ? 'Update' : 'Reload'}
          </ActionButton>
        </SettingRow>

        <SettingRow
          icon={DeviceIcon}
          title="Connection"
          detail={online ? 'Live sync and background refresh are available.' : 'Cached pages may still open until the network returns.'}
        >
          <span className={`settings-status-pill ${deviceStatus.tone}`}>
            <DeviceIcon size={12} /> {deviceStatus.label}
          </span>
        </SettingRow>
      </div>
    </div>
    </>
  );
}

function WorkspaceCard() {
  // usePermissions, NOT useAuth: applyViewLens drops the super-admin bypass when you choose to work
  // as an employee, and useAuth hands back the raw flag. Settings has `perm: null`, so it is one of
  // the few screens still open in that view — which made this the one place a super admin kept a
  // live, editable Workspace card while the rest of the app treated them as an employee.
  const { isSuperAdmin } = usePermissions();
  const settingsQuery = useWorkspaceSettings();
  const settings = settingsQuery.data || {};
  const unavailable = settingsQuery.isLoading || settingsQuery.isError || settingsQuery.data === undefined;
  const saveSettings = useSaveWorkspaceSettings();

  const [form, setForm] = useState(() => ({ company_name: settings.company_name || '', domain: settings.domain || '', locale: settings.locale || '' }));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setForm({
      company_name: settings.company_name || '',
      domain: settings.domain || '',
      locale: settings.locale || '',
    });
  }, [settings.company_name, settings.domain, settings.locale]);

  const dirty =
    form.company_name !== (settings.company_name || '') ||
    form.domain !== (settings.domain || '') ||
    form.locale !== (settings.locale || '');

  const save = () =>
    saveSettings.mutate(form, {
      onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); },
    });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));


  return (
    <div className="premium-card settings-card space-y-4">
      <div className="settings-workspace-heading">
        <CardTitle
          icon={Building2}
          title="Workspace"
          subtitle="Company defaults shared across the HR workspace."
        />
        {!isSuperAdmin && (
          <span className="settings-managed-note">
            managed by your administrator
          </span>
        )}
      </div>
      {settingsQuery.isLoading && <p className="settings-card-notice" role="status">Loading workspace settings…</p>}
      {settingsQuery.isError && <div className="settings-card-notice" role="alert">
        <p>Workspace settings could not be loaded.</p>
        <ActionButton onClick={() => settingsQuery.refetch()}>Try again</ActionButton>
      </div>}
      <div className="settings-form-grid settings-workspace-fields">
        <Field label="Company Name">
          <input type="text" disabled={!isSuperAdmin || unavailable} value={form.company_name} onChange={set('company_name')} className={inputClass} />
        </Field>
        <Field label="Company Domain">
          <input type="text" disabled={!isSuperAdmin || unavailable} value={form.domain} onChange={set('domain')} className={inputClass} />
        </Field>
        <Field label="Default Locale">
          <input type="text" disabled={!isSuperAdmin || unavailable} value={form.locale} onChange={set('locale')} className={inputClass} />
        </Field>
      </div>
      {isSuperAdmin && (
        <div className="settings-card-actions flex items-center gap-3 pt-2 border-t border-neutral-200 dark:border-neutral-850">
          <SaveButton onClick={save} pending={saveSettings.isPending} saved={saved} disabled={unavailable || !dirty} />
          {saveSettings.isError && (
            <span className="text-xs text-rose-500">{saveSettings.error?.message}</span>
          )}
        </div>
      )}
    </div>
  );
}


const SETTINGS_SECTIONS = [
  { id: 'general', label: 'General', description: 'Appearance & app', icon: Palette },
  { id: 'account', label: 'Account', description: 'Your contact details', icon: UserRound },
  { id: 'security', label: 'Security', description: 'Password & access', icon: ShieldCheck },
  { id: 'workspace', label: 'Workspace', description: 'Company defaults', icon: Building2 },
];

export default function SettingsPage({
  theme, onToggleTheme, installAvailable, installed, updateAvailable, online, onInstall, onUpdate,
}) {
  const [section, setSection] = useState('general');
  const [verticalTabs, setVerticalTabs] = useState(false);
  const tabs = useRef([]);
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 1100px)');
    const update = () => setVerticalTabs(wide.matches);
    update();
    wide.addEventListener('change', update);
    return () => wide.removeEventListener('change', update);
  }, []);
  const selectSection = (id) => {
    setSection(id);
    document.getElementById('main-content')?.scrollTo({ top: 0 });
  };
  const moveTab = (event, index) => {
    let next;
    if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % SETTINGS_SECTIONS.length;
    else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index + SETTINGS_SECTIONS.length - 1) % SETTINGS_SECTIONS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = SETTINGS_SECTIONS.length - 1;
    else return;
    event.preventDefault();
    tabs.current[next]?.focus({ preventScroll: true });
    selectSection(SETTINGS_SECTIONS[next].id);
  };

  return (
    <div className="page-shell settings-page settings-organized">
      <header className="settings-heading">
        <h1>Settings</h1>
        <p>Manage your account and make the app work for you.</p>
      </header>
      <div className="settings-workspace">
        <nav className="settings-categories" role="tablist" aria-label="Settings sections" aria-orientation={verticalTabs ? 'vertical' : 'horizontal'}>
          {SETTINGS_SECTIONS.map(({ id, label, description, icon: Icon }, index) => (
            <button key={id} type="button" role="tab" className="settings-category"
              aria-label={label}
              id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`}
              aria-selected={section === id} tabIndex={section === id ? 0 : -1}
              ref={node => { tabs.current[index] = node; }}
              onClick={() => selectSection(id)} onKeyDown={event => moveTab(event, index)}>
              <Icon size={20} aria-hidden="true" />
              <span className="settings-category-copy"><strong>{label}</strong><small>{description}</small></span>
              <ChevronRight size={16} className="settings-category-arrow" aria-hidden="true" />
            </button>
          ))}
        </nav>
        <div className="settings-panels">
          {/* Keep panels mounted so switching sections preserves unsaved form drafts. */}
          <section className="settings-panel" role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general" hidden={section !== 'general'} tabIndex={0}>
            <PreferencesCard theme={theme} onToggleTheme={onToggleTheme} installAvailable={installAvailable}
              installed={installed} updateAvailable={updateAvailable} online={online} onInstall={onInstall} onUpdate={onUpdate} />
          </section>
          <section className="settings-panel" role="tabpanel" id="settings-panel-account" aria-labelledby="settings-tab-account" hidden={section !== 'account'} tabIndex={0}>
            <MyProfileCard />
          </section>
          <section className="settings-panel" role="tabpanel" id="settings-panel-security" aria-labelledby="settings-tab-security" hidden={section !== 'security'} tabIndex={0}>
            <div className="settings-security"><ChangePassword /></div>
            <div className="premium-card settings-card settings-security-note">
              <CardTitle icon={ShieldCheck} title="Account access" subtitle="Your administrator manages roles and access to employee information." />
              <p>Contact your HR administrator if you need to change your access or report an account issue.</p>
            </div>
          </section>
          <section className="settings-panel" role="tabpanel" id="settings-panel-workspace" aria-labelledby="settings-tab-workspace" hidden={section !== 'workspace'} tabIndex={0}>
            <WorkspaceCard />
          </section>
        </div>
      </div>
    </div>
  );
}
