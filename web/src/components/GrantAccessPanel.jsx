// One-step "give app access" — an inline SECTION, not a modal.
//
// Replaces the four-step dance (create login -> link employee -> pick scope type -> pick scope id)
// with a single form: choose the employee, choose the role, done. The access area is DERIVED from
// the employee's own record — a Branch Manager manages the branch they work in — so the admin
// never sees the words "scope type" or a list of UUIDs. Advanced users can still override it.
//
// Layout: one column on phones, two from `lg` up. It lives in the page flow so long content
// scrolls the page normally instead of trapping the form inside an overlay.
import React, { useMemo, useState } from 'react';
import { UserPlus, Loader2, Check, Copy, AlertTriangle, ShieldCheck, X } from 'lucide-react';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import { useOrg } from '../data/org';
import { useGrantAppAccess, useManagedUsers } from '../data/admin';

// What each system role means in plain language, and which field of the employee's own record
// decides the area it applies to. Order = seniority, matching the dashboards and sidebar.
// `rank` mirrors public.roles.rank (migration 0044). You may only grant a role ranked strictly
// below your own, so a Branch Manager (40) sees Dept Head and Employee here and nothing above.
// The database enforces the same rule in app.can_grant — this only keeps the UI honest so nobody
// fills in a form that was always going to be refused.
export const ROLE_PRESETS = [
  {
    key: 'employee',
    rank: 10,
    label: 'Employee (self-service)',
    blurb: 'Sees only their own attendance, leave, payslips and tasks.',
    scopeType: 'self',
    from: null,
  },
  {
    key: 'dept_head',
    rank: 30,
    label: 'Department Head',
    blurb: 'Manages their department: attendance, leave approvals, tasks, performance.',
    scopeType: 'department',
    from: 'department_id',
  },
  {
    key: 'branch_manager',
    rank: 40,
    label: 'Branch Manager (Shop-in-charge)',
    blurb: 'Manages their branch: attendance, approvals, expenses, assets, tickets.',
    scopeType: 'branch',
    from: 'branch_id',
  },
  {
    key: 'zonal_manager',
    rank: 50,
    label: 'Zonal Manager',
    blurb: 'Oversees every branch in their zone: reports and approvals.',
    scopeType: 'zone',
    from: 'zone_id',
  },
  {
    key: 'hr_manager',
    rank: 60,
    label: 'HR Manager',
    blurb: 'People operations across their company: hiring, onboarding, exits, attendance setup.',
    scopeType: 'entity',
    from: 'entity_id',
  },
  {
    key: 'entity_admin',
    rank: 80,
    label: 'Entity Admin',
    blurb: 'Full administrator of their company, including users and roles.',
    scopeType: 'entity',
    from: 'entity_id',
  },
];

/** The presets the signed-in user is actually allowed to hand out. */
export function grantableRoles(myRank) {
  return ROLE_PRESETS.filter((r) => r.rank < myRank);
}

const inputCls =
  'w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl px-3 py-2 text-xs text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971]/60';

const labelCls = 'block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1.5';

export const randomPassword = () => {
  // Ambiguous characters (O/0, l/1) left out — this gets read aloud or written on paper.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
};

export default function GrantAccessPanel({ employee: fixedEmployee, onClose, onDone }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useOrg();
  const { data: managedUsers = [] } = useManagedUsers();
  const grantAccess = useGrantAppAccess();
  const { rank: myRank } = useAuth();

  // Only offer what this admin may actually grant (see grantableRoles / migration 0044).
  const roleOptions = useMemo(() => grantableRoles(myRank), [myRank]);

  const [employeeId, setEmployeeId] = useState(fixedEmployee?.id ?? '');
  const [roleKey, setRoleKey] = useState('employee');
  const [email, setEmail] = useState(fixedEmployee?.email ?? '');
  const [touchedEmail, setTouchedEmail] = useState(Boolean(fixedEmployee?.email));
  const [password, setPassword] = useState(randomPassword);
  const [overrideScopeId, setOverrideScopeId] = useState('');
  const [showOverride, setShowOverride] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  const employee = employees.find((e) => e.id === employeeId) ?? null;
  const preset = roleOptions.find((r) => r.key === roleKey) ?? roleOptions[0] ?? ROLE_PRESETS[0];

  // Follow the employee's email unless the admin has typed their own.
  const pickEmployee = (id) => {
    setEmployeeId(id);
    const emp = employees.find((e) => e.id === id);
    if (!touchedEmail) setEmail(emp?.email ?? '');
    setOverrideScopeId('');
  };

  // The area this role will apply to, read straight off the employee record.
  const derived = useMemo(() => {
    if (!employee || !preset.from) {
      return { id: null, label: null, noun: null };
    }
    const id = employee[preset.from] ?? null;
    const [list, fmt, noun] = {
      department_id: [org?.departments, (d) => d.name, 'department'],
      branch_id: [org?.branches, (b) => `${b.code} — ${b.name}`, 'branch'],
      zone_id: [org?.zones, (z) => z.name, 'zone'],
      entity_id: [org?.entities, (e) => e.name, 'company'],
    }[preset.from];
    if (!id) return { id: null, label: null, noun };
    const row = (list ?? []).find((x) => x.id === id);
    return { id, label: row ? `${noun}: ${fmt(row)}` : null, noun };
  }, [employee, preset, org]);

  const scopeId = preset.scopeType === 'self' ? null : overrideScopeId || derived.id;
  const missingArea = preset.scopeType !== 'self' && !scopeId;

  // Options for the manual override, matching the role's level.
  const overrideOptions = useMemo(() => {
    const map = {
      department: (org?.departments ?? []).map((d) => ({ id: d.id, label: d.name })),
      branch: (org?.branches ?? []).map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` })),
      zone: (org?.zones ?? []).map((z) => ({ id: z.id, label: z.name })),
      entity: (org?.entities ?? []).map((e) => ({ id: e.id, label: e.name })),
    };
    return map[preset.scopeType] ?? [];
  }, [org, preset.scopeType]);

  // Does this person already have a login? Then we are ADDING a role, not creating an account —
  // the wording, the password field and the result screen all change accordingly.
  const existingUser = useMemo(() => {
    if (!employee) return null;
    return managedUsers.find((u) => u.employee_id === employee.id) ?? null;
  }, [employee, managedUsers]);
  const hasLogin = Boolean(existingUser || employee?.user_id);

  const busy = grantAccess.isPending;
  const canSubmit =
    employeeId && email.trim() && (hasLogin || password.length >= 6) && !missingArea && !busy;

  const submit = async () => {
    setError(null);
    try {
      // One transactional call: creates the login if needed, links the employee, grants the role.
      // A manager role also auto-adds the self-service role via a DB trigger (migration 0025).
      const res = await grantAccess.mutateAsync({
        employee_id: employeeId,
        email: String(effectiveEmail || '').trim().toLowerCase(),
        password,
        role_key: roleKey,
        scope_type: preset.scopeType,
        scope_id: scopeId,
      });
      setResult({ ...res, password });
      onDone?.();
    } catch (err) {
      setError(err.message);
    }
  };

  // Follow the existing login's email when the employee already has one — you cannot give the
  // same person a second account, and typing a different address would be silently ignored.
  // Lock the field whenever the employee already has a login, even when list_managed_users did
  // not return it (it only lists logins inside the caller's rbac.manage scope). Leaving it
  // editable let an edited address create a SECOND login and re-point the employee at it,
  // orphaning the original.
  const emailLocked = hasLogin;
  const effectiveEmail = existingUser?.email ?? (hasLogin ? employee?.email ?? email : email);

  const copy = () => {
    navigator.clipboard?.writeText(`Email: ${result.email}\nPassword: ${result.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className="premium-card space-y-4 animate-fade-in">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <UserPlus size={15} className="text-[#0ea971] shrink-0" />
          <h3 className="font-bold text-sm sm:text-base text-neutral-900 dark:text-white truncate">
            Give app access
            {fixedEmployee && (
              <span className="ml-2 font-normal text-xs text-neutral-500">{fixedEmployee.full_name}</span>
            )}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer shrink-0"
          title="Close" aria-label="Close"
        >
          <X size={16} />
        </button>
      </div>

      {result ? (
        // ---- success --------------------------------------------------------
        <div className="space-y-3 max-w-xl">
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <Check size={14} className="text-emerald-500 shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              {result.created ? (
                <>
                  Access granted. Give these details to {employee?.full_name || 'the employee'} — they can sign
                  in right away and should change the password from Settings.
                </>
              ) : result.role_added ? (
                <>Role added to the existing login <b>{result.email}</b>. Their password is unchanged.</>
              ) : (
                <>{employee?.full_name || 'This employee'} already had this exact access — nothing changed.</>
              )}
            </p>
          </div>
          {result.created && (
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-3 font-mono text-xs space-y-1 break-all">
              <div><span className="text-neutral-400">Email:</span> {result.email}</div>
              <div><span className="text-neutral-400">Password:</span> {result.password}</div>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {result.created && (
              <button
                onClick={copy}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-base font-bold text-neutral-700 dark:text-neutral-300 hover:border-[#0ea971]/40 cursor-pointer"
              >
                {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy details'}
              </button>
            )}
            <button
              onClick={onClose}
              className="rounded-lg bg-[#0ea971] hover:bg-[#0c9765] px-4 py-1.5 text-base font-bold text-white cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:gap-5">
            {/* ---- left: who + which role ------------------------------------- */}
            <div className="space-y-4 min-w-0">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1.5">
                  Employee
                </label>
                {fixedEmployee ? (
                  <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2 text-xs font-semibold text-neutral-800 dark:text-neutral-200 truncate">
                    {fixedEmployee.full_name}
                    <span className="ml-2 font-mono text-2xs text-neutral-400">{fixedEmployee.employee_code}</span>
                  </div>
                ) : (
                  <select value={employeeId} onChange={(e) => pickEmployee(e.target.value)} className={inputCls + ' cursor-pointer'}>
                    <option value="">Choose an employee…</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.full_name} {e.employee_code ? `(${e.employee_code})` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div>
                <label className={labelCls}>Role</label>
                <div className="space-y-1.5">
                  {roleOptions.map((r) => (
                    <label
                      key={r.key}
                      className={`flex items-start gap-2.5 rounded-xl border p-2.5 cursor-pointer transition-colors ${
                        roleKey === r.key
                          ? 'border-[#0ea971]/50 bg-[#0ea971]/5'
                          : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="grant-role"
                        checked={roleKey === r.key}
                        onChange={() => { setRoleKey(r.key); setOverrideScopeId(''); setShowOverride(false); }}
                        className="mt-0.5 accent-[#0ea971] shrink-0"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-neutral-800 dark:text-neutral-100">{r.label}</span>
                        <span className="block text-2xs text-neutral-500 dark:text-neutral-400 mt-0.5">{r.blurb}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* ---- right: area + login ---------------------------------------- */}
            <div className="space-y-4 min-w-0">
              <div>
                <label className={labelCls}>Access area</label>
                <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex items-start gap-1.5 text-xs text-neutral-600 dark:text-neutral-300 min-w-0">
                      <ShieldCheck size={12} className="text-[#0ea971] shrink-0 mt-0.5" />
                      {!employeeId ? (
                        <span className="text-neutral-400">Pick an employee to see the access area.</span>
                      ) : preset.scopeType === 'self' ? (
                        <span>Access: <b>their own records only</b></span>
                      ) : overrideScopeId ? (
                        <span className="break-words">Manages: <b>{overrideOptions.find((o) => o.id === overrideScopeId)?.label}</b></span>
                      ) : derived.label ? (
                        <span className="break-words">Manages: <b>{derived.label}</b></span>
                      ) : (
                        <span className="text-amber-600 dark:text-amber-400">
                          This employee has no {derived.noun || preset.scopeType} set — choose one below.
                        </span>
                      )}
                    </span>
                    {preset.scopeType !== 'self' && employeeId && derived.id && (
                      <button
                        onClick={() => setShowOverride((v) => !v)}
                        className="text-2xs font-bold text-neutral-400 hover:text-neutral-800 dark:hover:text-white shrink-0 cursor-pointer"
                      >
                        {showOverride ? 'Use theirs' : 'Change'}
                      </button>
                    )}
                  </div>
                  {(showOverride || (missingArea && employeeId)) && (
                    <select
                      value={overrideScopeId}
                      onChange={(e) => setOverrideScopeId(e.target.value)}
                      className={inputCls + ' cursor-pointer mt-2'}
                    >
                      <option value="">{derived.id ? "Use the employee's own" : 'Choose…'}</option>
                      {overrideOptions.map((o) => (
                        <option key={o.id} value={o.id}>{o.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>

              <div>
                <label className={labelCls}>Login email</label>
                <input
                  type="email"
                  value={effectiveEmail}
                  disabled={emailLocked}
                  onChange={(e) => { setEmail(e.target.value); setTouchedEmail(true); }}
                  placeholder="name@parakkatjewels.com"
                  className={inputCls + (emailLocked ? ' opacity-70 cursor-not-allowed' : '')}
                />
              </div>

              {hasLogin ? (
                <div className="flex items-start gap-2 rounded-xl border border-blue-500/25 bg-blue-500/5 p-2.5">
                  <ShieldCheck size={12} className="text-blue-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-700 dark:text-blue-300">
                    This employee already has a login, so no new account is created and their password
                    stays as it is — the role above is simply added to it.
                  </p>
                </div>
              ) : (
                <div>
                  <label className={labelCls}>Temporary password</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={inputCls + ' font-mono'}
                    />
                    <button
                      onClick={() => setPassword(randomPassword())}
                      className="shrink-0 rounded-xl border border-neutral-200 dark:border-neutral-800 px-2.5 text-2xs font-bold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer"
                      title="Generate a new password" aria-label="Generate a new password"
                    >
                      New
                    </button>
                  </div>
                  <p className="text-2xs text-neutral-400 mt-1.5">
                    No email is sent — you'll get these details to pass on. Managers automatically also get
                    self-service access to their own records. If this email already exists as an unused
                    login, it is reused instead of creating a duplicate.
                  </p>
                </div>
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5">
              <AlertTriangle size={13} className="text-rose-500 shrink-0 mt-0.5" />
              <p className="text-xs text-rose-600 dark:text-rose-300 break-words">{error}</p>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row gap-2 pt-1 border-t border-neutral-200/70 dark:border-neutral-850">
            <button
              onClick={onClose}
              className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-base font-bold text-neutral-600 dark:text-neutral-300 cursor-pointer mt-2 sm:mt-2"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={!canSubmit}
              className="flex-1 sm:flex-none sm:min-w-56 flex items-center justify-center gap-1.5 rounded-lg bg-[#0ea971] hover:bg-[#0c9765] px-4 py-2 text-base font-bold text-white cursor-pointer disabled:opacity-50 disabled:cursor-default mt-2"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
              {hasLogin ? 'Add this role' : 'Create login & grant access'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
