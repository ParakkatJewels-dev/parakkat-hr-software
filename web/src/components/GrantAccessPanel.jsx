// "Give access" — one panel, four plain steps, opened from Users & Access, from a person's row and
// from the Directory:
//   1 Who          — the employee (fixed when opened from their row)
//   2 What         — the role: what they will be able to do. Roles you may not hand out are shown
//                    greyed with the reason, instead of quietly missing.
//   3 Where        — the area the role covers, read off the employee's own record (their branch for
//                    a Branch Manager…). "Change" picks another level or place you may grant at.
//   4 Login        — only when they have no login yet: email and a temporary password.
// It ends in one sentence saying exactly what will happen. The database checks every rule again
// (grant_app_access / app.can_grant); nothing here is a security boundary.
import React, { useMemo, useState } from 'react';
import { UserPlus, Loader2, Check, Copy, AlertTriangle, ShieldCheck, X, Lock, MapPin } from 'lucide-react';
import { useEmployees } from '../data/employees';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useVisibleOrg } from '../data/org';
import { useGrantAppAccess, useManagedUsers, useRoles } from '../data/admin';
// Presets and the grant rules live in lib/ so they can be tested without pulling Supabase in
// through useAuth. Re-exported here because call sites have always imported them from this file.
import { ROLE_PRESETS, areaLevel, areaLevelsFor, grantableRoles, lockedRoles, placeName } from '../lib/roleGrants';
import Pagination, { usePagination } from './ui/Pagination';
import ListSearch from './ui/ListSearch';

export { ROLE_PRESETS, grantableRoles };

const inputCls =
  'w-full bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl px-3 py-2 text-xs text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-brand/60';

const stepCls = 'block text-xs font-bold uppercase tracking-wider text-neutral-500 mb-1.5';

export const randomPassword = () => {
  // Ambiguous characters (O/0, l/1) left out — this gets read aloud or written on paper.
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
};

export default function GrantAccessPanel({ employee: fixedEmployee, onClose, onDone }) {
  const { data: employees = [] } = useEmployees();
  const { data: org } = useVisibleOrg();
  const { data: managedUsers = [] } = useManagedUsers();
  const { data: catalogue = [] } = useRoles();
  const grantAccess = useGrantAppAccess();
  const { rank: myRank, assignments, isSuperAdmin } = useAuth();
  const { can } = usePermissions();

  const roleOptions = useMemo(() => grantableRoles(myRank, assignments, catalogue), [myRank, assignments, catalogue]);
  const locked = useMemo(() => lockedRoles(myRank, assignments, catalogue), [myRank, assignments, catalogue]);

  const [employeeId, setEmployeeId] = useState(fixedEmployee?.id ?? '');
  const [roleKey, setRoleKey] = useState('employee');
  const [areaScope, setAreaScope] = useState(null); // null = the role's usual level
  const [placeId, setPlaceId] = useState('');       // '' = the place on their own record
  const [changingArea, setChangingArea] = useState(false);
  const [email, setEmail] = useState(fixedEmployee?.email ?? '');
  const [touchedEmail, setTouchedEmail] = useState(Boolean(fixedEmployee?.email));
  const [password, setPassword] = useState(randomPassword);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const matchingEmployees = useMemo(() => {
    const term = employeeSearch.trim().toLowerCase();
    return term ? employees.filter((e) => [e.full_name, e.employee_code, e.entity?.code, e.branch?.code]
      .join(' ').toLowerCase().includes(term)) : [];
  }, [employees, employeeSearch]);
  const employeePager = usePagination(matchingEmployees, 8, null, employeeSearch);

  const employee = employees.find((e) => e.id === employeeId) ?? fixedEmployee ?? null;
  const role = roleOptions.find((r) => r.key === roleKey) ?? roleOptions[0] ?? ROLE_PRESETS[0];
  const levels = areaLevelsFor(role.key, { isSuperAdmin });
  const level = levels.find((l) => l.scopeType === areaScope) ?? levels[0] ?? areaLevel('self');
  const needsPlace = Boolean(level.from);

  const pickEmployee = (id) => {
    setEmployeeId(id);
    const emp = employees.find((e) => e.id === id);
    if (!touchedEmail) setEmail(emp?.email ?? '');
    setPlaceId('');
  };
  const pickRole = (key) => { setRoleKey(key); setAreaScope(null); setPlaceId(''); setChangingArea(false); };

  // May THIS admin grant at that place? Mirrors app.can_grant's has_perm('rbac.manage', ancestry).
  const canGrantAt = useMemo(() => {
    const branchById = new Map((org?.branches ?? []).map((b) => [b.id, b]));
    return (scopeType, id) => {
      if (!id) return false;
      if (scopeType === 'entity') return can('rbac.manage', { entityId: id });
      if (scopeType === 'zone') {
        const zone = (org?.zones ?? []).find((z) => z.id === id);
        return can('rbac.manage', { entityId: zone?.entity_id ?? null, zoneId: id });
      }
      if (scopeType === 'branch') {
        const branch = branchById.get(id);
        return can('rbac.manage', { entityId: branch?.entity_id ?? null, zoneId: branch?.zone_id ?? null, branchId: id });
      }
      if (scopeType === 'department') {
        const dept = (org?.departments ?? []).find((d) => d.id === id);
        return can('rbac.manage', {
          entityId: dept?.entity_id ?? null, zoneId: branchById.get(dept?.branch_id)?.zone_id ?? null,
          branchId: dept?.branch_id ?? null, deptId: id,
        });
      }
      return false;
    };
  }, [org, can]);

  const employeeGrantAllowed = !employee || can('rbac.manage', {
    entityId: employee.entity_id, zoneId: employee.zone_id, branchId: employee.branch_id,
    deptId: employee.department_id, employeeId: employee.id,
  });

  // The area: their own place for this level, unless the admin chose another one.
  const theirPlaceId = needsPlace ? employee?.[level.from] ?? null : null;
  const theirPlaceAllowed = !theirPlaceId || canGrantAt(level.scopeType, theirPlaceId);
  const scopeId = needsPlace ? placeId || (theirPlaceAllowed ? theirPlaceId : null) : null;
  const missingArea = needsPlace && !scopeId;
  const places = useMemo(() => {
    if (!needsPlace) return [];
    const list = { department: org?.departments, branch: org?.branches, zone: org?.zones, entity: org?.entities }[level.scopeType] ?? [];
    return list.filter((x) => canGrantAt(level.scopeType, x.id))
      .map((x) => ({ id: x.id, label: placeName(level.scopeType, x.id, org) }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)));
  }, [needsPlace, level.scopeType, org, canGrantAt]);
  const areaText = level.scopeType === 'self' ? 'Their own records'
    : level.scopeType === 'global' ? 'The whole group'
    : scopeId ? placeName(level.scopeType, scopeId, org) : null;
  const canChangeArea = levels.length > 1 || places.length > 1 || (needsPlace && !theirPlaceAllowed);

  // Does this person already have a login? Then we are ADDING a role, not creating an account.
  const existingUser = useMemo(() => {
    if (!employee) return null;
    return managedUsers.find((u) => u.employee_id === employee.id) ?? null;
  }, [employee, managedUsers]);
  const hasLogin = Boolean(existingUser || employee?.user_id);
  // Locked whenever the employee already has a login, even when list_managed_users did not return
  // it (it only lists logins inside the caller's rbac.manage scope): an edited address would create
  // a SECOND login and re-point the employee at it.
  const effectiveEmail = existingUser?.email ?? (hasLogin ? employee?.email ?? email : email);
  const busy = grantAccess.isPending;
  const canSubmit = employeeId && employeeGrantAllowed && String(effectiveEmail || '').trim()
    && (hasLogin || password.length >= 6) && !missingArea && !busy;

  const submit = async () => {
    setError(null);
    try {
      // One transactional call: creates the login if needed, links the employee, grants the role.
      // A manager role also auto-adds the self-service role via a DB trigger (migration 0025).
      const res = await grantAccess.mutateAsync({
        employee_id: employeeId,
        email: String(effectiveEmail || '').trim().toLowerCase(),
        password,
        role_key: role.key,
        scope_type: level.scopeType,
        scope_id: scopeId,
      });
      setResult({ ...res, password });
      onDone?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const copy = () => {
    navigator.clipboard?.writeText(`Email: ${result.email}\nPassword: ${result.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const summary = employee && !missingArea
    ? `${employee.full_name} ${hasLogin ? 'gets' : 'gets a login as'} ${role.label}${areaText ? ` · ${areaText}` : ''}`
    : null;

  return (
    <section className="premium-card space-y-4 animate-fade-in" aria-label="Give access">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <UserPlus size={15} className="text-brand-ink shrink-0" />
          <h3 className="font-bold text-sm sm:text-base text-neutral-900 dark:text-white truncate">Give access</h3>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer shrink-0"
          title="Close" aria-label="Close">
          <X size={16} />
        </button>
      </div>

      {result ? (
        <div className="space-y-3 max-w-xl">
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
            <Check size={14} className="text-emerald-500 shrink-0 mt-0.5" />
            <p className="text-xs text-emerald-700 dark:text-emerald-300">
              {result.created ? (
                <>Access given. Pass these details to {employee?.full_name || 'the employee'} — they can sign in right away
                  and should change the password from Settings.</>
              ) : result.role_added ? (
                <>{summary ?? 'Role added'}. Their password is unchanged.</>
              ) : (
                <>{employee?.full_name || 'This employee'} already had exactly this access — nothing changed.</>
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
              <button onClick={copy}
                className="flex items-center gap-1.5 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-base font-bold text-neutral-700 dark:text-neutral-300 hover:border-brand/40 cursor-pointer">
                {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy details'}
              </button>
            )}
            <button onClick={onClose}
              className="rounded-lg bg-brand-action hover:bg-brand-action-hover px-4 py-1.5 text-base font-bold text-brand-on cursor-pointer">
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 max-w-2xl">
          {/* 1 · Who */}
          <div>
            <p className={stepCls}>1 · Who</p>
            {employee ? (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 dark:border-neutral-800 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <strong className="block truncate">{employee.full_name}</strong>
                  <span className="text-xs text-neutral-500">
                    {[employee.employee_code, placeName('branch', employee.branch_id, org), placeName('department', employee.department_id, org)].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {!fixedEmployee && (
                  <button type="button" disabled={busy} className="text-xs font-semibold text-brand-ink"
                    onClick={() => { pickEmployee(''); setEmployeeSearch(''); }}>Change</button>
                )}
              </div>
            ) : (
              <div className="space-y-2 paged-collection">
                <ListSearch value={employeeSearch} onChange={setEmployeeSearch} label="Find the employee to give access to" placeholder="Search name, code, company or branch…" />
                {!employeeSearch.trim() && <p className="text-xs text-neutral-500">Search {employees.length.toLocaleString()} employees within your access.</p>}
                {employeeSearch.trim() && !matchingEmployees.length && <p className="text-xs text-neutral-500">No matching employees.</p>}
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {employeePager.slice.map((e) => (
                    <button type="button" key={e.id} disabled={busy} onClick={() => pickEmployee(e.id)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-900">
                      <span className="text-sm font-semibold truncate">{e.full_name}</span>
                      <span className="text-xs text-neutral-500 shrink-0">{e.employee_code} · {e.entity?.code}</span>
                    </button>
                  ))}
                </div>
                <Pagination {...employeePager} noun="matching employees" sizes={[8, 25, 50]} disabled={busy} />
              </div>
            )}
            {employee && !employeeGrantAllowed && (
              <p className="text-2xs text-amber-600 dark:text-amber-400 mt-1.5">You can't give access to people in this employee's part of the company.</p>
            )}
          </div>

          {/* 2 · What will they do? */}
          <div>
            <p className={stepCls}>2 · What will they do?</p>
            <div className="space-y-1.5" role="radiogroup" aria-label="Role">
              {roleOptions.map((r) => (
                <label key={r.key}
                  className={`flex items-start gap-2.5 rounded-xl border p-2.5 cursor-pointer transition-colors ${
                    role.key === r.key ? 'border-brand/50 bg-brand/5' : 'border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700'}`}>
                  <input type="radio" name="grant-role" checked={role.key === r.key} onChange={() => pickRole(r.key)} className="mt-0.5 accent-brand shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-neutral-800 dark:text-neutral-100">
                      {r.label}
                      {r.custom && <span className="ml-1.5 align-middle text-2xs font-semibold uppercase tracking-wide text-neutral-400">Custom</span>}
                      {r.key === 'employee' && <span className="ml-1.5 align-middle text-2xs font-semibold text-emerald-600 dark:text-emerald-400">Everyone with a login has this</span>}
                    </span>
                    <span className="block text-2xs text-neutral-500 dark:text-neutral-400 mt-0.5">{r.blurb}</span>
                  </span>
                </label>
              ))}
              {locked.map((r) => (
                <div key={r.key} className="flex items-start gap-2.5 rounded-xl border border-dashed border-neutral-200 dark:border-neutral-800 p-2.5 text-neutral-400"
                  aria-label={`${r.label}: ${r.reason}`}>
                  <Lock size={13} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 text-2xs"><span className="font-bold">{r.label}</span> · {r.reason}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 3 · For which area? */}
          <div>
            <p className={stepCls}>3 · For which area?</p>
            <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 p-2.5 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <span className="flex items-start gap-1.5 text-xs text-neutral-700 dark:text-neutral-200 min-w-0">
                  <MapPin size={12} className="text-brand-ink shrink-0 mt-0.5" />
                  {!employee ? (
                    <span className="text-neutral-400">Pick the employee first.</span>
                  ) : areaText ? (
                    <span className="break-words"><b>{areaText}</b>
                      {needsPlace && scopeId === theirPlaceId && <span className="text-neutral-500"> · where they work</span>}</span>
                  ) : theirPlaceId && !theirPlaceAllowed ? (
                    <span className="text-amber-600 dark:text-amber-400">You can't give access for their {level.noun}. Choose another below.</span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400">Their record has no {level.noun} yet. Choose one below.</span>
                  )}
                </span>
                {employee && canChangeArea && (
                  <button type="button" onClick={() => setChangingArea((v) => !v)}
                    className="text-2xs font-bold text-brand-ink shrink-0 cursor-pointer">{changingArea ? 'Done' : 'Change'}</button>
                )}
              </div>
              {employee && (changingArea || missingArea) && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {levels.length > 1 && (
                    <label className="block">
                      <span className="sr-only">Area level</span>
                      <select value={level.scopeType} className={inputCls + ' cursor-pointer'} aria-label="Area level"
                        onChange={(e) => { setAreaScope(e.target.value); setPlaceId(''); }}>
                        {levels.map((l) => <option key={l.scopeType} value={l.scopeType}>{l.label}</option>)}
                      </select>
                    </label>
                  )}
                  {needsPlace && (
                    <label className="block">
                      <span className="sr-only">Which {level.noun}</span>
                      <select value={placeId} className={inputCls + ' cursor-pointer'} aria-label={`Which ${level.noun}`}
                        onChange={(e) => setPlaceId(e.target.value)}>
                        <option value="">{theirPlaceId && theirPlaceAllowed ? 'Where they work' : `Choose a ${level.noun}…`}</option>
                        {places.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 4 · Login */}
          <div>
            <p className={stepCls}>4 · Login</p>
            {hasLogin ? (
              String(effectiveEmail || '').trim() ? (
                <p className="flex items-start gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                  <ShieldCheck size={12} className="text-emerald-500 shrink-0 mt-0.5" />
                  <span>Already has a login (<b>{effectiveEmail}</b>). Nothing to set — their password stays as it is.</span>
                </p>
              ) : (
                // A login can exist while its address is visible nowhere this panel looks.
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5" role="alert">
                  <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    This person already has a login, but its email is not visible from here and their employee record has none.
                    Add their office email in the Directory first, then come back.
                  </p>
                </div>
              )
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-2xs text-neutral-500">Login email</span>
                  <input type="email" value={effectiveEmail} placeholder="name@parakkatjewels.com" className={inputCls}
                    onChange={(e) => { setEmail(e.target.value); setTouchedEmail(true); }} />
                </label>
                <label className="block">
                  <span className="text-2xs text-neutral-500">Temporary password</span>
                  <span className="flex gap-1.5">
                    <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls + ' font-mono'} />
                    <button type="button" onClick={() => setPassword(randomPassword())}
                      className="shrink-0 rounded-xl border border-neutral-200 dark:border-neutral-800 px-2.5 text-2xs font-bold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer"
                      title="Generate a new password" aria-label="Generate a new password">New</button>
                  </span>
                </label>
                <p className="sm:col-span-2 text-2xs text-neutral-400">No email is sent — you'll get these details to pass on.</p>
              </div>
            )}
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 p-2.5" role="alert">
              <AlertTriangle size={13} className="text-rose-500 shrink-0 mt-0.5" />
              <p className="text-xs text-rose-600 dark:text-rose-300 break-words">{error}</p>
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center gap-2 pt-3 border-t border-neutral-200/70 dark:border-neutral-850">
            <p className="flex-1 text-xs text-neutral-600 dark:text-neutral-300" role="status">
              {summary ?? 'Pick who and the area to see what will happen.'}
            </p>
            <button onClick={onClose}
              className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-base font-bold text-neutral-600 dark:text-neutral-300 cursor-pointer">
              Cancel
            </button>
            <button onClick={submit} disabled={!canSubmit}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-brand-action hover:bg-brand-action-hover px-4 py-2 text-base font-bold text-brand-on cursor-pointer disabled:opacity-50 disabled:cursor-default">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <UserPlus size={12} />}
              Give access
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
