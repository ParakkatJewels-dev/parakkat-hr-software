// Settings screen: password change, the user's own profile, and workspace configuration.
// Replaces the old hardcoded "Profile Configuration" mock. Profile fields the person may edit
// themselves (phone) save through the update_my_profile RPC; identity fields stay read-only and
// are managed by HR. Workspace settings are editable by super admins only — everyone else sees
// them read-only (RLS enforces this server-side too).
import React, { useEffect, useState } from 'react';
import { UserRound, Building2, Check, Loader2, Clock } from 'lucide-react';
import ChangePassword from './ChangePassword';
import { useAuth } from '../auth/AuthContext';
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
      <div className="flex items-center gap-2">
        <UserRound size={15} className="text-[#0ea971]" />
        <h3 className="font-semibold text-base text-neutral-800 dark:text-white">My Profile</h3>
      </div>
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
function DisplayPreferences() {
  const { hour12, setHour12 } = useClockFormat();

  return (
    <div className="premium-card space-y-4">
      <div className="flex items-center gap-2">
        <Clock size={15} className="text-[#0ea971]" />
        <h3 className="font-semibold text-base text-neutral-800 dark:text-white">Display</h3>
      </div>

      <fieldset className="max-w-md">
        <legend className="text-2xs font-bold uppercase tracking-wider text-neutral-450 mb-2">
          Time format
        </legend>
        <div className="flex flex-wrap gap-2">
          {CLOCK_FORMATS.map((f) => {
            const on = f.value === hour12;
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => setHour12(f.value)}
                className={`px-3 py-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                  on
                    ? 'border-[#0ea971] bg-[#0ea971]/10 text-[#0c9765] dark:text-[#10b981]'
                    : 'border-neutral-200 dark:border-neutral-850 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-900'
                }`}
              >
                {f.label}
                <span className="ml-2 font-mono font-normal text-neutral-450">{f.example}</span>
              </button>
            );
          })}
        </div>
        <p className="text-2xs text-neutral-450 mt-2">
          Applies everywhere times are shown, including the exported spreadsheets. Saved on this
          device only. Easy Time Pro prints 24-hour, so that setting matches its reports without
          translating.
        </p>
      </fieldset>
    </div>
  );
}

function WorkspaceCard() {
  const { isSuperAdmin } = useAuth();
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 size={15} className="text-[#0ea971]" />
          <h3 className="font-semibold text-base text-neutral-800 dark:text-white">Workspace</h3>
        </div>
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

export default function SettingsPage() {
  return (
    <div className="space-y-6 animate-fade-in text-xs text-neutral-500">
      <h1 className="text-xl font-bold text-neutral-900 dark:text-white leading-tight font-sans">System Settings</h1>
      <ChangePassword />
      <MyProfileCard />
      <DisplayPreferences />
      <WorkspaceCard />
    </div>
  );
}
