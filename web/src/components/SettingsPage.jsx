// Settings screen: password change, the user's own profile, and workspace configuration.
// Replaces the old hardcoded "Profile Configuration" mock. Profile fields the person may edit
// themselves (phone) save through the update_my_profile RPC; identity fields stay read-only and
// are managed by HR. Workspace settings are editable by super admins only — everyone else sees
// them read-only (RLS enforces this server-side too).
import React, { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import ChangePassword from './ChangePassword';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useEmployees } from '../data/employees';
import { useWorkspaceSettings, useSaveWorkspaceSettings, useUpdateMyProfile } from '../data/settings';
import { useClockFormat } from '../lib/timeFormat';
import { CLOCK_FORMATS } from '../lib/clock';

const inputClass =
  'w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 px-3 py-1.5 rounded-xl text-neutral-805 dark:text-neutral-200 text-xs focus:outline-none focus:border-[#0ea971]/50 disabled:bg-neutral-100 dark:disabled:bg-neutral-905 disabled:text-neutral-500 dark:disabled:text-neutral-400';

function Field({ label, children, hint }) {
  return (
    <div>
      <label className="block text-neutral-500 dark:text-slate-400 font-semibold mb-1 text-xs">
        {label}
        {hint && <span className="ml-1.5 font-normal text-2xs text-neutral-400">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

function SaveButton({ onClick, pending, saved, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || pending}
      className="flex items-center gap-1.5 rounded-lg bg-[#0ea971] hover:bg-[#0c9765] px-3.5 py-1.5 text-base font-bold text-white transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
    >
      {pending ? <Loader2 size={11} className="animate-spin" /> : saved ? <Check size={11} /> : null}
      {saved ? 'Saved' : 'Save changes'}
    </button>
  );
}

function CardTitle({ icon: Icon, title, subtitle }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#0ea971]/10 text-[#0ea971] dark:bg-[#0ea971]/15">
        <Icon size={15} />
      </span>
      <div className="min-w-0">
        <h3 className="font-semibold text-base text-neutral-800 dark:text-white">{title}</h3>
        {subtitle ? (
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            {subtitle}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SettingRow({ icon: Icon, title, detail, children }) {
  return (
    <div className="settings-row">
      <div className="flex min-w-0 items-start gap-2.5">
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

function ToggleSwitch({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors cursor-pointer ${
        checked
          ? 'border-[#0ea971] bg-[#0ea971]'
          : 'border-neutral-300 bg-neutral-200 dark:border-neutral-700 dark:bg-neutral-800'
      }`}
    >
      <span
        className={`absolute top-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white text-neutral-600 shadow-sm transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      >
        {checked ? <Moon size={11} /> : <Sun size={11} />}
      </span>
    </button>
  );
}

function ActionButton({ children, onClick, disabled, variant = 'secondary' }) {
  const variantClass =
    variant === 'primary'
      ? 'border-[#0ea971] bg-[#0ea971] text-white hover:bg-[#0c9765]'
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
  const { data: employees = [] } = useEmployees();
  const me = employees.find((e) => e.id === employee?.id);
  const updateProfile = useUpdateMyProfile();

  const [phone, setPhone] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => setPhone(me?.phone || ''), [me?.phone]);

  const save = () =>
    updateProfile.mutate(
      { phone },
      { onSuccess: () => { setSaved(true); setTimeout(() => setSaved(false), 2000); } }
    );

  return (
    <div className="premium-card space-y-4">
      <CardTitle
        icon={UserRound}
        title="My Profile"
        subtitle="Your linked employee record and self-service contact details."
      />
      {!employee ? (
        <p className="text-xs text-neutral-500">
          No employee record is linked to this login, so there is no profile to edit here. Profiles
          are linked in Administration → Users &amp; Access.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl">
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
          <div className="flex items-center gap-3 pt-2 border-t border-neutral-200 dark:border-neutral-850">
            <SaveButton
              onClick={save}
              pending={updateProfile.isPending}
              saved={saved}
              disabled={(me?.phone || '') === phone.trim()}
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
    <div className="premium-card space-y-4">
      <CardTitle
        icon={Palette}
        title="Appearance & Device"
        subtitle="Preferences saved on this device, so your phone and desktop can each feel right."
      />

      <div className="settings-stack">
        <SettingRow
          icon={dark ? Moon : Sun}
          title="Theme mode"
          detail={dark ? 'Dark mode is active on this device.' : 'Light mode is active on this device.'}
        >
          <div className="flex items-center gap-2">
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
  );
}

function WorkspaceCard() {
  // usePermissions, NOT useAuth: applyViewLens drops the super-admin bypass when you choose to work
  // as an employee, and useAuth hands back the raw flag. Settings has `perm: null`, so it is one of
  // the few screens still open in that view — which made this the one place a super admin kept a
  // live, editable Workspace card while the rest of the app treated them as an employee.
  const { isSuperAdmin } = usePermissions();
  const { data: settings = {} } = useWorkspaceSettings();
  const saveSettings = useSaveWorkspaceSettings();

  const [form, setForm] = useState({ company_name: '', domain: '', locale: '' });
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
    <div className="premium-card space-y-4">
      <div className="mobile-list-row flex items-center justify-between">
        <CardTitle
          icon={Building2}
          title="Workspace"
          subtitle="Company defaults shared across the HR workspace."
        />
        {!isSuperAdmin && (
          <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">
            managed by your administrator
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl">
        <Field label="Company Name">
          <input type="text" disabled={!isSuperAdmin} value={form.company_name} onChange={set('company_name')} className={inputClass} />
        </Field>
        <Field label="Company Domain">
          <input type="text" disabled={!isSuperAdmin} value={form.domain} onChange={set('domain')} className={inputClass} />
        </Field>
        <Field label="Default Locale">
          <input type="text" disabled={!isSuperAdmin} value={form.locale} onChange={set('locale')} className={inputClass} />
        </Field>
      </div>
      {isSuperAdmin && (
        <div className="flex items-center gap-3 pt-2 border-t border-neutral-200 dark:border-neutral-850">
          <SaveButton onClick={save} pending={saveSettings.isPending} saved={saved} disabled={!dirty} />
          {saveSettings.isError && (
            <span className="text-xs text-rose-500">{saveSettings.error?.message}</span>
          )}
        </div>
      )}
    </div>
  );
}


export default function SettingsPage({
  theme,
  onToggleTheme,
  installAvailable,
  installed,
  updateAvailable,
  online,
  onInstall,
  onUpdate,
}) {
  return (
    <div className="page-shell settings-page space-y-5 animate-fade-in text-xs text-neutral-500">
      <div className="settings-hero">
        <div className="min-w-0">
          <p className="text-2xs font-bold uppercase tracking-wider text-[#0c9765] dark:text-[#10b981]">
            Preferences
          </p>
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans">
            Settings
          </h1>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
          Theme, app behavior, password, profile, and workspace defaults.
        </p>
      </div>
      <div className="settings-layout">
        <div className="settings-main-column">
          <PreferencesCard
            theme={theme}
            onToggleTheme={onToggleTheme}
            installAvailable={installAvailable}
            installed={installed}
            updateAvailable={updateAvailable}
            online={online}
            onInstall={onInstall}
            onUpdate={onUpdate}
          />
          <ChangePassword />
        </div>
        <div className="settings-main-column">
          <MyProfileCard />
          <WorkspaceCard />
          <div className="premium-card space-y-3">
            <CardTitle
              icon={ShieldCheck}
              title="Security Notes"
              subtitle="Access, roles, and employee data are controlled by Administration and database policies."
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <span className="settings-status-pill justify-center">Role based access</span>
              <span className="settings-status-pill justify-center">Scoped employee data</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
