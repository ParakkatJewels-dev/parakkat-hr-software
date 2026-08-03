import React, { useState, useMemo, useEffect, useRef } from 'react';
import { ShieldCheck, Clipboard, X, Plus, Loader2, AlertTriangle, Link2, KeyRound, Trash2, UserPlus, Pencil, Star, Lock, Search } from 'lucide-react';
import { useAuditLog } from '../data/audit';
import { relativeTime } from '../lib/dates';
import { useOrg, useScopeCoverage } from '../data/org';
import { useEmployees } from '../data/employees';
import {
  useManagedUsers, useRoles, useRolesWithPermissions, useAssignRole, useRevokeRole, useLinkEmployee,
  usePermissionCatalog, useSaveRole, useDeleteRole, useSetSuperAdmin, useCreateUser, useDeleteLogin,
} from '../data/admin';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import GrantAccessPanel from './GrantAccessPanel';
import ConfirmDialog from './ui/ConfirmDialog';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';

const BTN = btnClass('primary');
const BTN_GHOST = btnClass('ghost');
const ICON_BTN = btnClass('subtle', 'md', true);
const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] transition-colors';

const SCOPE_TYPES = [
  { key: 'global', label: 'Global — all entities', needsId: false },
  { key: 'entity', label: 'Entity', needsId: true, from: 'entities' },
  { key: 'zone', label: 'Zone', needsId: true, from: 'zones' },
  { key: 'branch', label: 'Branch', needsId: true, from: 'branches' },
  { key: 'department', label: 'Department', needsId: true, from: 'departments' },
  { key: 'self', label: 'Self — own records only', needsId: false },
];

// Which scope levels each built-in role may be granted at — mirrors the DB guard (0019). A role not
// listed here (i.e. a custom role) may be granted at any scope. Global is additionally gated to
// super admins in the UI below.
const ROLE_SCOPES = {
  super_admin: ['global'],
  entity_admin: ['entity'],
  hr_manager: ['entity', 'zone', 'branch', 'department'],
  zonal_manager: ['zone'],
  branch_manager: ['branch'],
  dept_head: ['department'],
  employee: ['self'],
};


const prettyRole = (key) => key.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// Each view is its own destination, so each gets its own <h1>. "Administration" moves to an
// eyebrow above it: the section is context, the screen you are on is the heading.
const VIEW_META = {
  users: {
    title: 'Users & Access',
    blurb: 'Who can sign in, and what each of them can reach.',
  },
  roles: {
    title: 'Roles',
    blurb: 'What each role is allowed to do. Where they can do it is decided when you grant the role, not here.',
  },
  logs: {
    title: 'Audit Log',
    blurb: 'Every privileged action, newest first.',
  },
};

/**
 * Administration screens. `view` comes from the router, so each is a first-class destination in
 * the sidebar's Administration section rather than a tab inside a tab inside a tab.
 */
export default function Administration({ view = 'users' }) {
  const screen =
    view === 'roles' ? <RolesMatrix /> : view === 'logs' ? <AuditLogs /> : <UsersAccess />;
  return (
    <div className="page-shell space-y-5 animate-fade-in">
      <AdminHeader view={view} />
      {screen}
    </div>
  );
}

function AdminHeader({ view }) {
  const meta = VIEW_META[view] ?? VIEW_META.users;
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-wider text-[#0ea971] flex items-center gap-1.5">
        <ShieldCheck size={12} /> Administration
      </p>
      <h1 className="text-xl font-bold text-neutral-900 dark:text-white font-sans mt-1">{meta.title}</h1>
      <p className="text-base text-neutral-500 dark:text-neutral-400 mt-0.5">{meta.blurb}</p>
    </div>
  );
}

// ---------------------------------------------------------------- Users & Access
function UsersAccess() {
  const { data: users = [], isLoading, error } = useManagedUsers();
  const { data: roles = [] } = useRoles();
  const { data: org } = useOrg();
  const { data: employees = [] } = useEmployees();
  const { isSuperAdmin } = usePermissions();
  const assign = useAssignRole();
  const revoke = useRevokeRole();
  const link = useLinkEmployee();
  const createUser = useCreateUser();
  const setSuper = useSetSuperAdmin();
  const deleteLogin = useDeleteLogin();
  const { user: me } = useAuth();

  const [assignFor, setAssignFor] = useState(null);
  const [linkFor, setLinkFor] = useState(null);
  const [showInvite, setShowInvite] = useState(false);
  const [showGrant, setShowGrant] = useState(false);
  const [grantForUser, setGrantForUser] = useState(null); // employee whose login gains a role
  const [confirmDeleteUser, setConfirmDeleteUser] = useState(null);
  // 500+ staff means 500+ logins. This list had no way to find one.
  const [q, setQ] = useState('');

  const entities = org?.entities ?? [];
  const ecode = (id) => entities.find((e) => e.id === id)?.code ?? '?';
  const orgList = {
    entities,
    zones: org?.zones ?? [],
    branches: org?.branches ?? [],
    departments: org?.departments ?? [],
  };

  // One handler for every row's dropdown — `assignFor` already identifies which row is open.
  const submitAssign = async (payload) => {
    if (!assignFor) return;
    try {
      await assign.mutateAsync({ user_id: assignFor.user_id, ...payload });
      setAssignFor(null);
    } catch { /* surfaced inside the dropdown */ }
  };

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return users;
    return users.filter((u) =>
      [u.employee_name, u.email, u.employee_code, ...(u.roles ?? []).map((r) => r.role_key)]
        .filter(Boolean).some((v) => String(v).toLowerCase().includes(t))
    );
  }, [users, q]);

  // One login per person eventually — 242 rows.
  const pager = usePagination(shown);

  const scopeLabel = (t, id) => {
    if (t === 'global') return 'Global';
    if (t === 'self') return 'Self';
    if (t === 'entity') return entities.find((e) => e.id === id)?.name ?? 'entity';
    if (t === 'zone') {
      const z = orgList.zones.find((x) => x.id === id);
      return z ? `${ecode(z.entity_id)} · ${z.name}` : 'zone';
    }
    if (t === 'branch') {
      const b = orgList.branches.find((x) => x.id === id);
      return b ? `${ecode(b.entity_id)} · ${b.code}` : 'branch';
    }
    if (t === 'department') {
      const d = orgList.departments.find((x) => x.id === id);
      return d ? `${ecode(d.entity_id)} · ${d.name}` : 'department';
    }
    return t;
  };

  if (isLoading) {
    return <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>;
  }
  if (error) {
    return (
      <div className="premium-card flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold">Couldn't load users.</p>
          <p className="text-neutral-500 dark:text-neutral-400 mt-1">
            {error.message}. If it mentions <code>list_managed_users</code>, run migration
            <code> 0009_admin_rpcs.sql</code> in the Supabase SQL editor.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* One primary action, one escape hatch. The long explanation that used to live here was
          mostly restating what the button does; the part that isn't obvious — that the area a
          person manages comes from their employee record — is kept. */}
      <div className="premium-card flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-sm text-neutral-500 dark:text-neutral-400">
          <KeyRound size={14} className="shrink-0 mt-0.5 text-[#0ea971]" />
          <span>
            Creates a login and grants the role in one step. The area they manage — branch, department,
            zone or company — comes from their employee record.
          </span>
        </div>
        <div className="flex flex-col items-start sm:items-end gap-1.5 shrink-0">
          <button onClick={() => setShowGrant(true)} className={BTN}>
            <UserPlus size={12} /> Give app access
          </button>
          <button
            onClick={() => setShowInvite(true)}
            className="text-xs font-semibold text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-pointer"
            title="For system accounts that do not belong to an employee"
          >
            Login without an employee
          </button>
        </div>
      </div>

      {/* Inline section — appears above the user list rather than as an overlay. */}
      {showGrant && <GrantAccessPanel onClose={() => setShowGrant(false)} />}
      {grantForUser && (
        <GrantAccessPanel
          key={grantForUser.id}
          employee={grantForUser}
          onClose={() => setGrantForUser(null)}
        />
      )}

      {setSuper.error && <ErrorLine msg={setSuper.error.message} />}

      {users.length > 8 && (
        <div className="flex items-center gap-3">
          <div className="relative flex-1 min-w-0">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search logins"
              placeholder="Search by name, email, employee code or role…"
              className="w-full text-base rounded-xl pl-9 pr-9 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-[#0ea971] focus:ring-2 focus:ring-[#0ea971]/20 transition-colors"
            />
            {q && (
              <button onClick={() => setQ('')} aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded text-neutral-400 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
                <X size={13} />
              </button>
            )}
          </div>
          <span className="text-xs text-neutral-450 tabular-nums shrink-0">
            {shown.length === users.length ? `${users.length} logins` : `${shown.length} of ${users.length}`}
          </span>
        </div>
      )}

      {pager.slice.map((u) => {
        const displayName = u.employee_name || u.email;
        const initials = (displayName || '?')
          .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
        const noRole = !u.is_super_admin && (u.roles || []).length === 0;

        return (
          <article key={u.user_id} className="premium-card">
            {/* Identity first: a person's NAME is what you scan for. The email is a credential,
                so it drops to the secondary line with the employee code. */}
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-neutral-100 dark:bg-charcoal-800 text-neutral-700 dark:text-[#10b981] flex items-center justify-center font-bold text-base font-mono shrink-0 select-none">
                {initials}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-lg font-bold text-neutral-900 dark:text-white truncate">
                    {displayName}
                  </h3>
                  {u.is_super_admin && (
                    <span className="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-[#0ea971]/15 text-[#0c9765] dark:text-[#10b981]">
                      Super Admin
                    </span>
                  )}
                  {noRole && (
                    <span className="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      No role — sees nothing
                    </span>
                  )}
                </div>

                <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5 truncate">
                  {u.email}
                  {u.employee_code ? ` · ${u.employee_code}` : ''}
                  {!u.employee_id && (
                    <span className="text-amber-600 dark:text-amber-400"> · not linked to an employee</span>
                  )}
                </p>

                {/* Roles read as "what they can do", the reason you opened this screen. */}
                <div className="flex flex-wrap gap-1.5 mt-2.5">
                  {u.roles.map((r) => (
                    <span
                      key={r.assignment_id}
                      className="inline-flex items-center gap-1.5 text-xs pl-2.5 pr-1 py-1 rounded-lg bg-neutral-50 dark:bg-charcoal-800/60 border border-neutral-200 dark:border-neutral-800"
                    >
                      <span className="font-semibold text-neutral-700 dark:text-neutral-200">{prettyRole(r.role_key)}</span>
                      <span className="text-neutral-400 dark:text-neutral-500">{scopeLabel(r.scope_type, r.scope_id)}</span>
                      <button
                        onClick={() => revoke.mutate(r.assignment_id)}
                        disabled={revoke.isPending}
                        className="ml-0.5 p-1 rounded-md text-neutral-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40 focus:outline-none focus:ring-2 focus:ring-red-500/40 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title={`Revoke ${prettyRole(r.role_key)}`}
                        aria-label={`Revoke ${prettyRole(r.role_key)}`}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  {u.roles.length === 0 && !u.is_super_admin && (
                    <span className="text-sm text-neutral-400">No roles assigned yet.</span>
                  )}
                  {u.is_super_admin && u.roles.length === 0 && (
                    <span className="text-sm text-neutral-400">Full access via Super Admin.</span>
                  )}
                </div>
              </div>
            </div>

            {/* Actions sit on their own line so the identity block stays readable on a phone. */}
            <div className="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-850">
              {u.employee_id ? (
                <button
                  onClick={() => setGrantForUser(employees.find((e) => e.id === u.employee_id) ?? null)}
                  className={BTN}
                >
                  <Plus size={12} /> Add role
                </button>
              ) : (
                <AssignRoleDropdown
                  user={u}
                  triggerLabel={<><Plus size={12} /> Assign role</>}
                  triggerClass={BTN}
                  open={assignFor?.user_id === u.user_id}
                  onToggle={() => { assign.reset(); setAssignFor(assignFor?.user_id === u.user_id ? null : u); }}
                  roles={roles}
                  orgList={orgList}
                  ecode={ecode}
                  isSuperAdmin={isSuperAdmin}
                  busy={assign.isPending}
                  error={assign.error?.message}
                  onSubmit={submitAssign}
                />
              )}

              {!u.employee_id && (
                <button onClick={() => setLinkFor(u)} className={BTN_GHOST}>
                  <Link2 size={13} /> Link employee
                </button>
              )}
              {u.employee_id && (
                <AssignRoleDropdown
                  user={u}
                  triggerLabel="Advanced"
                  triggerClass={BTN_GHOST}
                  triggerTitle="Custom roles and unusual scopes"
                  open={assignFor?.user_id === u.user_id}
                  onToggle={() => { assign.reset(); setAssignFor(assignFor?.user_id === u.user_id ? null : u); }}
                  roles={roles}
                  orgList={orgList}
                  ecode={ecode}
                  isSuperAdmin={isSuperAdmin}
                  busy={assign.isPending}
                  error={assign.error?.message}
                  onSubmit={submitAssign}
                />
              )}

              <div className="ml-auto flex items-center gap-2">
                {isSuperAdmin && (
                  <button
                    onClick={() => setSuper.mutate({ user_id: u.user_id, flag: !u.is_super_admin })}
                    disabled={setSuper.isPending}
                    className={`inline-flex items-center gap-1.5 text-sm font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer transition-colors border disabled:opacity-60 ${
                      u.is_super_admin
                        ? 'border-[#0ea971]/40 bg-[#0ea971]/10 text-[#0c9765] dark:text-[#10b981] hover:bg-[#0ea971]/20'
                        : 'border-neutral-200 dark:border-neutral-800 text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'
                    }`}
                    title={u.is_super_admin ? 'Remove Super Admin access' : 'Grant Super Admin access'}
                    aria-label={u.is_super_admin ? 'Remove Super Admin access' : 'Grant Super Admin access'}
                  >
                    <Star size={12} className={u.is_super_admin ? 'fill-[#0ea971]' : ''} />
                    {u.is_super_admin ? 'Super Admin' : 'Make Super Admin'}
                  </button>
                )}
                {u.user_id !== me?.id && (
                  <button
                    onClick={() => { deleteLogin.reset(); setConfirmDeleteUser(u); }}
                    className="p-2 rounded-lg cursor-pointer text-neutral-400 hover:bg-red-100 hover:text-red-600 dark:hover:bg-red-950/40 focus:outline-none focus:ring-2 focus:ring-red-500/40 transition-colors"
                    title="Delete this login"
                    aria-label={`Delete the login for ${displayName}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          </article>
        );
      })}
      <Pagination {...pager} noun="logins" />

      {users.length > 0 && shown.length === 0 && (
        <div className="premium-card p-8 text-center text-sm text-neutral-500">
          No login matches “{q}”.
        </div>
      )}

      {users.length === 0 && (
        <div className="premium-card p-8 text-center text-xs text-neutral-500">
          No logins yet. Use <b>Give app access</b> above to create the first one for an employee.
        </div>
      )}

      {linkFor && (
        <LinkEmployeePanel
          user={linkFor}
          employees={employees}
          busy={link.isPending}
          error={link.error?.message}
          onClose={() => { link.reset(); setLinkFor(null); }}
          onSubmit={async (employee_id) => {
            try {
              await link.mutateAsync({ user_id: linkFor.user_id, employee_id });
              setLinkFor(null);
            } catch { /* shown */ }
          }}
        />
      )}

      {confirmDeleteUser && (
        <ConfirmDialog
          title="Delete this login?"
          confirmLabel="Delete login"
          busy={deleteLogin.isPending}
          error={deleteLogin.error?.message}
          onCancel={() => { deleteLogin.reset(); setConfirmDeleteUser(null); }}
          onConfirm={async () => {
            try {
              await deleteLogin.mutateAsync(confirmDeleteUser.user_id);
              setConfirmDeleteUser(null);
            } catch { /* shown in the dialog */ }
          }}
        >
          <p>
            <span className="font-semibold">{confirmDeleteUser.email}</span> will no longer be able to sign in.
          </p>
          <p className="text-neutral-500 dark:text-neutral-400">
            {confirmDeleteUser.employee_name ? (
              <>
                The employee record for <b>{confirmDeleteUser.employee_name}</b> and all their attendance,
                leave and payroll history are kept — only app access is removed.
              </>
            ) : (
              'This login is not linked to an employee, so nothing else is affected.'
            )}
          </p>
        </ConfirmDialog>
      )}

      {showInvite && (
        <CreateUserPanel
          employees={employees}
          busy={createUser.isPending}
          error={createUser.error?.message}
          result={createUser.data}
          onClose={() => { createUser.reset(); setShowInvite(false); }}
          onSubmit={async (payload) => {
            try { await createUser.mutateAsync(payload); } catch { /* shown in modal */ }
          }}
        />
      )}

    </div>
  );
}

function CreateUserPanel({ employees, busy, error, result, onClose, onSubmit }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [q, setQ] = useState('');
  const [employeeId, setEmployeeId] = useState('');

  const results = useMemo(() => {
    const s = q.toLowerCase();
    if (!s) return [];
    return employees
      .filter((e) => (e.full_name || '').toLowerCase().includes(s) || (e.employee_code || '').toLowerCase().includes(s))
      .slice(0, 8);
  }, [employees, q]);
  const chosen = employees.find((e) => e.id === employeeId);

  // Once the login is created, show the outcome and the exact credentials to hand over.
  if (result?.user_id) {
    return (
      <Panel title="User created" onClose={onClose}>
        <div className="space-y-3 text-xs">
          <p className="text-neutral-700 dark:text-neutral-200">
            Login <span className="font-semibold">{result.email}</span> is ready — they can sign in now with the
            email and password you set. No email was sent.
          </p>
          <p className="text-neutral-500 dark:text-neutral-400">
            Next: grant them a role at a scope (and link an employee, if you didn’t above), or they’ll sign in
            but see nothing.
          </p>
          <div className="flex justify-end"><button onClick={onClose} className={BTN}>Done</button></div>
        </div>
      </Panel>
    );
  }

  const submit = (e) => {
    e.preventDefault();
    onSubmit({ email: email.trim(), password, employee_id: employeeId || null });
  };
  const canSubmit = email.trim() && password.length >= 6;

  return (
    <Panel title="Create user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Email">
          <input type="email" autoFocus className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="someone@parakkatjewels.com" required />
        </Field>
        <Field label="Password">
          <div className="relative">
            <input type={showPw ? 'text' : 'password'} className={INPUT + ' pr-16'} value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
            <button type="button" onClick={() => setShowPw((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-2xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
              {showPw ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="text-2xs text-neutral-400 mt-1">You set this — share it with the user securely; they can change it after signing in.</p>
        </Field>
        <Field label="Link to employee (optional)">
          {chosen ? (
            <div className="flex items-center justify-between rounded-xl bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 px-3 py-2 text-xs">
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">{chosen.full_name} <span className="font-mono text-2xs text-neutral-500">· {chosen.employee_code}</span></span>
              <button type="button" onClick={() => { setEmployeeId(''); setQ(''); }} className="text-neutral-400 hover:text-red-500"><X size={14} /></button>
            </div>
          ) : (
            <>
              <input className={INPUT} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or code…" />
              {results.length > 0 && (
                <div className="mt-1 max-h-40 overflow-y-auto border border-neutral-200 dark:border-neutral-850 rounded-xl divide-y divide-neutral-150 dark:divide-neutral-850/60">
                  {results.map((e) => (
                    <button key={e.id} type="button" onClick={() => setEmployeeId(e.id)}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex justify-between items-center cursor-pointer">
                      <span className="font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
                      <span className="font-mono text-2xs text-neutral-500">{e.employee_code}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </Field>
        {/* Super admin is granted from the user row after creation — one path only, so it is
            always a deliberate, visible act rather than a checkbox on a busy form. */}
        {error && <ErrorLine msg={error} />}
        <PanelActions busy={busy} disabled={!canSubmit} onClose={onClose} submitLabel="Create user" />
      </form>
    </Panel>
  );
}

/**
 * Assign a role, anchored to the row it belongs to.
 *
 * This was a panel rendered after the whole user list, so picking "Assign role" on the first of
 * forty people opened a form far below the fold with nothing on screen to say who it applied to.
 * As a dropdown it stays beside the person, and the choices are short enough to suit one.
 *
 * The trigger lives here rather than in the caller so that one wrapper covers both, and a click on
 * the trigger while it is open reads as a toggle instead of racing the click-outside handler.
 */
function AssignRoleDropdown({
  user, roles, orgList, ecode, isSuperAdmin, busy, error, onSubmit,
  open, onToggle, triggerLabel, triggerClass, triggerTitle,
}) {
  const wrapRef = useRef(null);

  // Escape or a click anywhere else closes it, the way any menu behaves.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onToggle(); };
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) onToggle(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, onToggle]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={onToggle}
        className={triggerClass}
        title={triggerTitle}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        {triggerLabel}
      </button>
      {open && (
        <AssignRoleForm
          user={user}
          roles={roles}
          orgList={orgList}
          ecode={ecode}
          isSuperAdmin={isSuperAdmin}
          busy={busy}
          error={error}
          onClose={onToggle}
          onSubmit={onSubmit}
        />
      )}
    </div>
  );
}

function AssignRoleForm({ user, roles, orgList, ecode, isSuperAdmin, busy, error, onClose, onSubmit }) {
  const popRef = useRef(null);

  // Opened on the last row, the dropdown would otherwise hang below the scroll container's fold.
  useEffect(() => {
    popRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  // Super admin is granted via the star toggle, not here — keep it out of the role list.
  // Only what this admin may actually hand out. app.can_grant refuses any role ranked at or above
  // the granter's own (migration 0044), so offering the rest produced a dropdown where five of six
  // choices failed with the raw "not authorized to grant this role at this scope" — a dept_head was
  // shown Entity Admin. GrantAccessPanel already filtered correctly; this list did not, so the two
  // grant paths disagreed about the same rule.
  const { rank: myRank } = useAuth();
  const assignableRoles = useMemo(
    () => roles.filter((r) => r.key !== 'super_admin' && (r.rank ?? 0) < myRank),
    [roles, myRank]
  );

  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState('');
  const [scopeId, setScopeId] = useState('');
  // How many people each scope level actually reaches — see the warning below the scope picker.
  const { data: coverage } = useScopeCoverage();

  const role = assignableRoles.find((r) => r.id === roleId) || null;

  // Scopes valid for the chosen role. Built-in roles are constrained to their level; custom roles
  // may use any scope. Global stays super-admin-only.
  const allowedScopes = useMemo(() => {
    if (!role) return [];
    const base = ROLE_SCOPES[role.key] ?? SCOPE_TYPES.map((s) => s.key);
    return base.filter((k) => k !== 'global' || isSuperAdmin);
  }, [role, isSuperAdmin]);

  // Keep scopeType valid whenever the allowed set changes (i.e. the role changed).
  useEffect(() => {
    if (!allowedScopes.length) {
      if (scopeType) { setScopeType(''); setScopeId(''); }
    } else if (!allowedScopes.includes(scopeType)) {
      setScopeType(allowedScopes[0]);
      setScopeId('');
    }
  }, [allowedScopes, scopeType]);

  const scopeDef = SCOPE_TYPES.find((s) => s.key === scopeType);
  const items = scopeDef?.needsId ? orgList[scopeDef.from] ?? [] : [];
  const itemLabel = (it) => {
    if (scopeType === 'entity') return `${it.code} — ${it.name}`;
    if (scopeType === 'zone') return `${ecode(it.entity_id)} · ${it.name}`;
    if (scopeType === 'branch') return `${ecode(it.entity_id)} · ${it.code}${it.name ? ' ' + it.name : ''}`;
    if (scopeType === 'department') return `${ecode(it.entity_id)} · ${it.name}`;
    return it.id;
  };

  const submit = (e) => {
    e.preventDefault();
    onSubmit({ role_id: roleId, scope_type: scopeType, scope_id: scopeDef?.needsId ? scopeId : null });
  };
  const canSubmit = roleId && scopeType && (!scopeDef?.needsId || scopeId);

  return (
    // Anchored under the trigger. z-20 keeps it above sibling cards but below the sticky header
    // (z-30) and confirmation dialogs (z-50). Width shrinks rather than overflowing a phone.
    <div
      ref={popRef}
      role="dialog"
      aria-label={`Assign a role to ${user.employee_name || user.email}`}
      className="absolute left-0 top-full mt-1.5 z-20 w-[min(20rem,calc(100vw-3rem))] rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-charcoal-900 shadow-2xl p-3.5 animate-fade-in"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <p className="text-base font-bold text-neutral-900 dark:text-white">Assign a role</p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
            {user.employee_name || user.email}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className={ICON_BTN + ' shrink-0 focus:outline-none focus:ring-2 focus:ring-[#0ea971]/40'}
        >
          <X size={14} />
        </button>
      </div>

      <form onSubmit={submit} className="space-y-2.5">
        <Field label="Role">
          <select autoFocus value={roleId} onChange={(e) => setRoleId(e.target.value)} className={INPUT} required>
            <option value="">Select a role…</option>
            {assignableRoles.map((r) => (
              <option key={r.id} value={r.id}>{prettyRole(r.key)}</option>
            ))}
          </select>
        </Field>

        {role && (allowedScopes.length > 1 ? (
          <Field label="Scope">
            <select value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(''); }} className={INPUT}>
              {allowedScopes.map((k) => {
                const def = SCOPE_TYPES.find((s) => s.key === k);
                return <option key={k} value={k}>{def?.label ?? k}</option>;
              })}
            </select>
          </Field>
        ) : (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-850 rounded-xl px-2.5 py-1.5">
            Scope <span className="font-semibold text-neutral-700 dark:text-neutral-300">{scopeDef?.label ?? scopeType}</span> — fixed for this role.
          </p>
        ))}

        {/* A scope level nobody is assigned to grants access to nobody, and the failure is silent:
            the person you granted it to just sees a short list. Said here, at the moment of the
            decision, rather than reported somewhere nobody looks. */}
        {role && scopeDef?.needsId && coverage?.[scopeType]?.missing > 0 && (
          <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 rounded-xl px-2.5 py-2">
            {coverage[scopeType].placed === 0 ? (
              <>No employee has a {scopeType} yet, so a role granted at this level will reach nobody.
                Assign people to a {scopeType} first.</>
            ) : (
              <><span className="font-semibold">{coverage[scopeType].missing} of {coverage.total} employees</span>{' '}
                have no {scopeType}. They stay invisible to anyone granted at this level — only
                entity-wide and global roles can see them.</>
            )}
          </p>
        )}

        {role && scopeDef?.needsId && (
          <Field label={`Which ${scopeType}?`}>
            <select value={scopeId} onChange={(e) => setScopeId(e.target.value)} className={INPUT} required>
              <option value="">Select…</option>
              {[...items].sort((a, b) => itemLabel(a).localeCompare(itemLabel(b))).map((it) => (
                <option key={it.id} value={it.id}>{itemLabel(it)}</option>
              ))}
            </select>
          </Field>
        )}

        {error && <ErrorLine msg={error} />}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-2.5 py-1.5 text-sm font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">
            Cancel
          </button>
          <button type="submit" disabled={busy || !canSubmit} className={BTN}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Assign
          </button>
        </div>
      </form>
    </div>
  );
}

// Attach a login to an employee record. Creating the employee itself belongs in the Directory —
// having a second employee form here produced records that skipped the Directory's own flow.
function LinkEmployeePanel({ user, employees, busy, error, onClose, onSubmit }) {
  const [q, setQ] = useState('');

  const results = useMemo(() => {
    const s = q.toLowerCase();
    return employees
      .filter((e) => !s || (e.full_name || '').toLowerCase().includes(s) || (e.employee_code || '').toLowerCase().includes(s))
      .slice(0, 25);
  }, [employees, q]);

  return (
    <Panel title={`Link employee — ${user.email}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Connect this login to the person it belongs to. Employees are added in the Directory.
        </p>
        <input autoFocus className={INPUT} placeholder="Search employee by name or code…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-64 overflow-y-auto border border-neutral-200 dark:border-neutral-850 rounded-xl divide-y divide-neutral-150 dark:divide-neutral-850/60">
          {results.map((e) => (
            <button
              key={e.id}
              onClick={() => onSubmit(e.id)}
              disabled={busy}
              className="w-full text-left px-3 py-2 text-xs hover:bg-neutral-100 dark:hover:bg-neutral-900 flex justify-between items-center cursor-pointer disabled:opacity-60"
            >
              <span className="font-semibold text-neutral-800 dark:text-neutral-200">{e.full_name}</span>
              <span className="font-mono text-2xs text-neutral-500">{e.employee_code} · {e.entity?.code}{e.branch ? ' · ' + e.branch.code : ''}</span>
            </button>
          ))}
          {results.length === 0 && <p className="px-3 py-4 text-xs text-neutral-400 text-center">No matches.</p>}
        </div>
        {user.employee_id && (
          <button onClick={() => onSubmit(null)} disabled={busy} className="text-xs text-red-500 hover:underline cursor-pointer">
            Unlink current employee
          </button>
        )}
        {error && <ErrorLine msg={error} />}
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Done</button>
        </div>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- Roles manager
function RolesMatrix() {
  const { data: roles = [], isLoading, error } = useRolesWithPermissions();
  const { data: catalog = [] } = usePermissionCatalog();
  const { isSuperAdmin } = usePermissions();
  const saveRole = useSaveRole();
  const deleteRole = useDeleteRole();
  const [editing, setEditing] = useState(null); // role object, or {} for a new role
  const [confirmDelete, setConfirmDelete] = useState(null);

  if (isLoading) return <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>;
  if (error) return <p className="text-xs text-amber-600">{error.message}</p>;

  return (
    <div className="space-y-3">
      {isSuperAdmin ? (
        <div className="flex justify-end">
          <button onClick={() => setEditing({})} className={BTN}>
            <Plus size={12} /> New role
          </button>
        </div>
      ) : (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          Only a super admin can create or change roles.
        </p>
      )}

      {roles.map((r) => (
        <RoleCard
          key={r.id}
          role={r}
          canEdit={isSuperAdmin}
          onEdit={() => setEditing(r)}
          onDelete={() => setConfirmDelete(r)}
        />
      ))}

      {editing && (
        <RoleEditorPanel
          role={editing.id ? editing : null}
          catalog={catalog}
          busy={saveRole.isPending}
          error={saveRole.error?.message}
          onClose={() => { saveRole.reset(); setEditing(null); }}
          onSubmit={async (payload) => {
            try {
              await saveRole.mutateAsync(payload);
              setEditing(null);
            } catch { /* shown in modal */ }
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`Delete the ${prettyRole(confirmDelete.key)} role?`}
          confirmLabel="Delete role"
          busy={deleteRole.isPending}
          error={deleteRole.error?.message}
          onCancel={() => { deleteRole.reset(); setConfirmDelete(null); }}
          onConfirm={async () => {
            try { await deleteRole.mutateAsync(confirmDelete.id); setConfirmDelete(null); } catch { /* shown */ }
          }}
        >
          <p>
            This permanently removes the role. It can only be deleted while nobody holds it — revoke
            its grants first if anyone does.
          </p>
          {confirmDelete.is_system && (
            <p className="text-amber-700 dark:text-amber-300">
              This is a built-in role. It will not come back on its own — you would have to recreate
              it as a custom role.
            </p>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * One role. The question this screen answers is "what can this role do?", so the permissions are
 * summarised by area — `Employees 4 · Payroll 3` — instead of listing thirty raw `resource.action`
 * keys. The keys are still one click away for anyone auditing a specific grant.
 */
function RoleCard({ role: r, canEdit, onEdit, onDelete }) {
  const [showKeys, setShowKeys] = useState(false);
  const locked = r.key === 'super_admin';

  // `employees.read` → grouped under `employees`.
  const areas = useMemo(() => {
    const m = new Map();
    for (const k of r.permissionKeys) {
      const area = k.includes('.') ? k.slice(0, k.indexOf('.')) : k;
      m.set(area, (m.get(area) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [r.permissionKeys]);

  return (
    <article className="premium-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-bold text-neutral-900 dark:text-white">{prettyRole(r.key)}</h3>
            <span
              className={`text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                r.is_system
                  ? 'bg-neutral-100 dark:bg-neutral-900 text-neutral-500 border border-neutral-200 dark:border-neutral-800'
                  : 'bg-[#0ea971]/15 text-[#0c9765] dark:text-[#10b981]'
              }`}
            >
              {r.is_system ? 'Built-in' : 'Custom'}
            </span>
            {locked && (
              <span className="inline-flex items-center gap-1 text-2xs font-semibold text-neutral-400">
                <Lock size={11} /> Managed automatically
              </span>
            )}
          </div>
          {r.description && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-0.5">{r.description}</p>
          )}
        </div>

        {canEdit && !locked && (
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={onEdit} className={ICON_BTN} title="Edit permissions" aria-label={`Edit permissions for ${prettyRole(r.key)}`}>
              <Pencil size={14} />
            </button>
            <button
              onClick={onDelete}
              className={ICON_BTN + ' hover:text-red-500!'}
              title="Delete role"
              aria-label={`Delete the ${prettyRole(r.key)} role`}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>

      <div className="mt-3 pt-3 border-t border-neutral-100 dark:border-neutral-850">
        {r.permissionKeys.length === 0 ? (
          <p className="text-sm text-neutral-400">
            {locked ? 'Full access to everything, by definition.' : 'No permissions yet — anyone holding this role sees nothing.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5">
              {areas.map(([area, n]) => (
                <span
                  key={area}
                  className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-lg bg-neutral-50 dark:bg-charcoal-800/60 border border-neutral-200 dark:border-neutral-800"
                >
                  <span className="font-semibold text-neutral-700 dark:text-neutral-200 capitalize">
                    {area.replace(/_/g, ' ')}
                  </span>
                  <span className="tabular-nums text-neutral-400">{n}</span>
                </span>
              ))}
            </div>
            <button
              onClick={() => setShowKeys((v) => !v)}
              aria-expanded={showKeys}
              className="mt-2 text-xs font-semibold text-neutral-500 hover:text-[#0ea971] cursor-pointer transition-colors"
            >
              {showKeys ? 'Hide permission keys' : `Show all ${r.permissionKeys.length} permission keys`}
            </button>
            {showKeys && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {r.permissionKeys.map((k) => (
                  <span
                    key={k}
                    className="text-2xs font-mono px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-850"
                  >
                    {k}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </article>
  );
}

function RoleEditorPanel({ role, catalog, busy, error, onClose, onSubmit }) {
  const isNew = !role;
  const isSystem = Boolean(role?.is_system);
  const [key, setKey] = useState(role?.key ?? '');
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState(() => new Set(role?.permissionKeys ?? []));

  // Group the permission catalog by resource for a readable grid.
  const groups = useMemo(() => {
    const m = new Map();
    for (const p of catalog) {
      if (!m.has(p.resource)) m.set(p.resource, []);
      m.get(p.resource).push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  const toggle = (k) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const submit = (e) => {
    e.preventDefault();
    onSubmit({
      roleId: role?.id ?? null,
      key: isNew ? key : role.key,
      name: isNew ? name : role.name,
      description: isSystem ? role.description : description,
      permissionKeys: [...selected],
    });
  };
  const canSubmit = isNew ? (key.trim() && name.trim()) : true;

  const title = isNew ? 'New role' : `Edit role — ${prettyRole(role.key)}`;

  return (
    <Panel title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {isNew ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Key (identifier)">
              <input className={INPUT} value={key} onChange={(e) => setKey(e.target.value)}
                placeholder="e.g. regional_auditor" required />
            </Field>
            <Field label="Display name">
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Regional Auditor" required />
            </Field>
            <div className="sm:col-span-2">
              <Field label="Description (optional)">
                <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)}
                  placeholder="What this role is for" />
              </Field>
            </div>
          </div>
        ) : isSystem ? (
          <p className="text-xs text-neutral-500 dark:text-neutral-400 flex items-center gap-1.5">
            <Lock size={12} /> System role — its name is fixed, but you can tune which permissions it grants.
          </p>
        ) : (
          <Field label="Description (optional)">
            <input className={INPUT} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300">
              Permissions ({selected.size})
            </label>
          </div>
          <div className="max-h-[46vh] overflow-y-auto space-y-3 pr-1">
            {groups.map(([resource, perms]) => (
              <div key={resource} className="border border-neutral-200 dark:border-neutral-850 rounded-xl p-3">
                <p className="text-xs font-bold uppercase tracking-wider text-neutral-500 mb-2">{resource}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {perms.map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-xs cursor-pointer text-neutral-700 dark:text-neutral-300 hover:text-neutral-900 dark:hover:text-white">
                      <input
                        type="checkbox"
                        checked={selected.has(p.key)}
                        onChange={() => toggle(p.key)}
                        className="accent-[#0ea971] cursor-pointer"
                      />
                      <span className="font-mono text-xs">{p.action}</span>
                      {p.description && <span className="text-neutral-400 truncate">— {p.description}</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && <ErrorLine msg={error} />}
        <PanelActions busy={busy} disabled={!canSubmit} onClose={onClose} submitLabel={isNew ? 'Create role' : 'Save'} />
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------- Audit log
// The raw row says INSERT / employees / <uuid>. Read as a sentence — "Priya added an employee
// record" — it is scannable by someone who does not know the schema, which is the point of an
// audit trail. The colour of the marker carries the severity so a delete stands out while scrolling.
const AUDIT_VERBS = { INSERT: 'added', UPDATE: 'changed', DELETE: 'deleted' };
const AUDIT_TONES = {
  INSERT: 'bg-[#0ea971]',
  UPDATE: 'bg-amber-500',
  DELETE: 'bg-red-500',
};
const prettyTable = (t) => (t || 'record').replace(/_/g, ' ');

function AuditLogs() {
  const { data: logs = [], isLoading, error } = useAuditLog();
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return logs;
    return logs.filter((l) =>
      `${l.actor_email ?? ''} ${l.action ?? ''} ${l.table_name ?? ''}`.toLowerCase().includes(s)
    );
  }, [logs, q]);

  if (isLoading) {
    return <div className="flex justify-center py-16 text-[#0ea971]"><Loader2 size={24} className="animate-spin" /></div>;
  }
  if (error) {
    return (
      <div className="premium-card flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        <span>{error.message}. If it mentions <code>audit_log</code>, run migration <code>0011_audit.sql</code>.</span>
      </div>
    );
  }
  if (logs.length === 0) {
    return (
      <div className="premium-card p-8 text-center">
        <Clipboard size={20} className="mx-auto text-neutral-300 dark:text-neutral-700" />
        <p className="text-base text-neutral-500 mt-2">No audit entries visible to you yet.</p>
        <p className="text-xs text-neutral-400 mt-1">Privileged actions are recorded here as they happen.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={INPUT + ' max-w-xs'}
          placeholder="Filter by person, action or table…"
          aria-label="Filter the audit log"
        />
        <span className="text-xs text-neutral-400 tabular-nums shrink-0">
          {shown.length === logs.length ? `${logs.length} entries` : `${shown.length} of ${logs.length}`}
        </span>
      </div>

      <div className="premium-card px-4">
        {shown.length === 0 ? (
          <p className="text-base text-neutral-500 py-10 text-center">Nothing matches “{q}”.</p>
        ) : (
          <ul className="divide-y divide-neutral-100 dark:divide-neutral-850/60">
            {shown.map((log) => {
              const actor = log.actor_email || 'System';
              const verb = AUDIT_VERBS[log.action] ?? (log.action || '').toLowerCase();
              return (
                <li key={log.id} className="flex items-start gap-3 py-3">
                  <span
                    className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${AUDIT_TONES[log.action] ?? 'bg-neutral-400'}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-base text-neutral-700 dark:text-neutral-300">
                      <span className="font-bold text-neutral-900 dark:text-white">{actor}</span>{' '}
                      {verb}{' '}
                      <span className="font-semibold text-neutral-800 dark:text-neutral-200">{prettyTable(log.table_name)}</span>
                    </p>
                    {log.row_id && (
                      <p className="text-2xs font-mono text-neutral-400 mt-0.5 truncate">{log.row_id}</p>
                    )}
                  </div>
                  <time
                    dateTime={log.created_at}
                    title={new Date(log.created_at).toLocaleString()}
                    className="text-xs text-neutral-400 shrink-0 tabular-nums"
                  >
                    {relativeTime(log.created_at)}
                  </time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- small shared bits
const Field = ({ label, children }) => (
  <div>
    <label className="block text-base font-semibold text-neutral-600 dark:text-neutral-300 mb-1">{label}</label>
    {children}
  </div>
);
const ErrorLine = ({ msg }) => (
  <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">{msg}</p>
);
/**
 * Inline panel, not an overlay. These are working forms — creating a login, assigning a role,
 * editing a role's permissions — and they read better with the user list still on screen. The
 * one thing that stays a true modal is a destructive confirmation (see ConfirmDialog).
 */
function Panel({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <section className="premium-card space-y-4 animate-fade-in">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-neutral-900 dark:text-white truncate">{title}</h3>
        <button
          onClick={onClose}
          aria-label={`Close ${title}`}
          className={ICON_BTN + ' focus:outline-none focus:ring-2 focus:ring-[#0ea971]/40'}
        >
          <X size={15} />
        </button>
      </div>
      {children}
    </section>
  );
}
function PanelActions({ busy, disabled, onClose, submitLabel }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
      <button type="submit" disabled={busy || disabled} className={BTN}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {submitLabel}
      </button>
    </div>
  );
}
