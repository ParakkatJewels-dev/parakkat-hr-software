import React, { useState, useMemo } from 'react';
import {
  ShieldCheck, Clock, Clipboard, X, Plus, Loader2, AlertTriangle, Link2, UserCog, KeyRound, Trash2,
} from 'lucide-react';
import { useAuditLog } from '../data/audit';
import { useOrg } from '../data/org';
import { useEmployees } from '../data/employees';
import {
  useManagedUsers, useRoles, useRolesWithPermissions, useAssignRole, useRevokeRole, useLinkEmployee,
} from '../data/admin';
import { usePermissions } from '../auth/usePermissions';

const BTN = 'inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer transition-opacity bg-black text-white dark:bg-gold-450 dark:text-charcoal-900 hover:opacity-90 disabled:opacity-60';
const ICON_BTN = 'p-1.5 rounded-lg cursor-pointer transition-colors text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-white';
const INPUT = 'w-full text-sm rounded-xl px-3 py-2 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-850 text-neutral-800 dark:text-neutral-200 focus:outline-none focus:border-gold-500 transition-colors';

const SCOPE_TYPES = [
  { key: 'global', label: 'Global — all entities', needsId: false },
  { key: 'entity', label: 'Entity', needsId: true, from: 'entities' },
  { key: 'zone', label: 'Zone', needsId: true, from: 'zones' },
  { key: 'branch', label: 'Branch', needsId: true, from: 'branches' },
  { key: 'department', label: 'Department', needsId: true, from: 'departments' },
  { key: 'self', label: 'Self — own records only', needsId: false },
];

const SUB_TABS = [
  { key: 'users', label: 'Users & Access', icon: UserCog },
  { key: 'roles', label: 'Roles', icon: ShieldCheck },
  { key: 'shifts', label: 'Shift Config', icon: Clock },
  { key: 'logs', label: 'Audit Logs', icon: Clipboard },
];

const prettyRole = (key) => key.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

export default function Administration() {
  const [tab, setTab] = useState('users');
  return (
    <div className="page-shell space-y-6 animate-fade-in">
      <div>
        <h2 className="text-xl font-bold text-neutral-900 dark:text-slate-100 font-sans flex items-center gap-2">
          <ShieldCheck size={20} className="text-gold-500" /> Administration
        </h2>
        <p className="text-xs text-neutral-500 dark:text-slate-400">
          Provision users, delegate scoped roles to your branch and department HRs, and review access.
        </p>
      </div>

      <div className="flex border-b border-neutral-200 dark:border-neutral-900 space-x-5 text-xs">
        {SUB_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`pb-2.5 flex items-center gap-1.5 font-semibold cursor-pointer border-b-2 transition-all ${
                tab === t.key
                  ? 'border-black dark:border-gold-500 text-black dark:text-gold-400'
                  : 'border-transparent text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'users' && <UsersAccess />}
      {tab === 'roles' && <RolesMatrix />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'logs' && <AuditLogs />}
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

  const [assignFor, setAssignFor] = useState(null);
  const [linkFor, setLinkFor] = useState(null);

  const entities = org?.entities ?? [];
  const ecode = (id) => entities.find((e) => e.id === id)?.code ?? '?';
  const orgList = {
    entities,
    zones: org?.zones ?? [],
    branches: org?.branches ?? [],
    departments: org?.departments ?? [],
  };

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
    return <div className="flex justify-center py-16 text-gold-500"><Loader2 size={24} className="animate-spin" /></div>;
  }
  if (error) {
    return (
      <div className="glass-panel p-5 rounded-2xl flex items-start gap-3 text-xs text-amber-700 dark:text-amber-300">
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
      <div className="glass-panel p-4 rounded-2xl text-[11px] text-neutral-500 dark:text-neutral-400 flex items-start gap-2">
        <KeyRound size={14} className="shrink-0 mt-0.5 text-gold-500" />
        <span>
          New logins are provisioned with <code>python backend/scripts/create_user.py &lt;email&gt;</code> (or the
          Supabase dashboard). Then link them to an employee and grant a role at a scope below.
        </span>
      </div>

      {users.map((u) => (
        <div key={u.user_id} className="premium-card p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold text-sm text-neutral-800 dark:text-slate-100 truncate">{u.email}</span>
                {u.is_super_admin && (
                  <span className="text-[9px] font-bold uppercase font-mono px-1.5 py-0.5 rounded bg-gold-500/15 text-gold-600 dark:text-gold-400">
                    Super Admin
                  </span>
                )}
              </div>
              <p className="text-[11px] text-neutral-500 dark:text-neutral-400 mt-0.5">
                {u.employee_id ? (
                  <>Linked to <span className="font-semibold">{u.employee_name}</span> ({u.employee_code})</>
                ) : (
                  <span className="text-amber-600 dark:text-amber-400">Not linked to an employee</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setLinkFor(u)} className={ICON_BTN} title="Link to employee">
                <Link2 size={15} />
              </button>
              <button onClick={() => setAssignFor(u)} className={BTN}>
                <Plus size={12} /> Assign role
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {u.is_super_admin && u.roles.length === 0 && (
              <span className="text-[11px] text-neutral-400">Full access via Super Admin.</span>
            )}
            {u.roles.length === 0 && !u.is_super_admin && (
              <span className="text-[11px] text-neutral-400">No roles yet — this user can sign in but sees nothing.</span>
            )}
            {u.roles.map((r) => (
              <span
                key={r.assignment_id}
                className="inline-flex items-center gap-1.5 text-[10.5px] pl-2.5 pr-1.5 py-1 rounded-lg bg-neutral-100 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800"
              >
                <span className="font-semibold text-neutral-700 dark:text-neutral-200">{prettyRole(r.role_key)}</span>
                <span className="text-neutral-400">@</span>
                <span className="font-mono text-neutral-500 dark:text-neutral-400">{scopeLabel(r.scope_type, r.scope_id)}</span>
                <button
                  onClick={() => revoke.mutate(r.assignment_id)}
                  className="ml-0.5 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950/40 text-neutral-400 hover:text-red-500"
                  title="Revoke"
                >
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}

      {users.length === 0 && (
        <div className="premium-card p-8 text-center text-xs text-neutral-500">
          No manageable users yet. Create one with the backend script, then refresh.
        </div>
      )}

      {assignFor && (
        <AssignRoleModal
          user={assignFor}
          roles={roles}
          orgList={orgList}
          ecode={ecode}
          isSuperAdmin={isSuperAdmin}
          busy={assign.isPending}
          error={assign.error?.message}
          onClose={() => { assign.reset(); setAssignFor(null); }}
          onSubmit={async (payload) => {
            try {
              await assign.mutateAsync({ user_id: assignFor.user_id, ...payload });
              setAssignFor(null);
            } catch { /* shown in modal */ }
          }}
        />
      )}

      {linkFor && (
        <LinkEmployeeModal
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
    </div>
  );
}

function AssignRoleModal({ user, roles, orgList, ecode, isSuperAdmin, busy, error, onClose, onSubmit }) {
  const [roleId, setRoleId] = useState('');
  const [scopeType, setScopeType] = useState('branch');
  const [scopeId, setScopeId] = useState('');

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
    onSubmit({ role_id: roleId, scope_type: scopeType, scope_id: scopeDef.needsId ? scopeId : null });
  };
  const canSubmit = roleId && (!scopeDef.needsId || scopeId);

  return (
    <Modal title={`Assign role — ${user.email}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Role">
          <select value={roleId} onChange={(e) => setRoleId(e.target.value)} className={INPUT} required>
            <option value="">Select a role…</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{prettyRole(r.key)}</option>
            ))}
          </select>
        </Field>

        <Field label="Scope">
          <select value={scopeType} onChange={(e) => { setScopeType(e.target.value); setScopeId(''); }} className={INPUT}>
            {SCOPE_TYPES.filter((s) => s.key !== 'global' || isSuperAdmin).map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </Field>

        {scopeDef?.needsId && (
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
        <ModalActions busy={busy} disabled={!canSubmit} onClose={onClose} submitLabel="Assign" />
      </form>
    </Modal>
  );
}

function LinkEmployeeModal({ user, employees, busy, error, onClose, onSubmit }) {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const s = q.toLowerCase();
    return employees
      .filter((e) => !s || (e.full_name || '').toLowerCase().includes(s) || (e.employee_code || '').toLowerCase().includes(s))
      .slice(0, 25);
  }, [employees, q]);

  return (
    <Modal title={`Link employee — ${user.email}`} onClose={onClose}>
      <div className="space-y-3">
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
              <span className="font-mono text-[10px] text-neutral-500">{e.employee_code} · {e.entity?.code}{e.branch ? ' · ' + e.branch.code : ''}</span>
            </button>
          ))}
          {results.length === 0 && <p className="px-3 py-4 text-xs text-neutral-400 text-center">No matches.</p>}
        </div>
        {user.employee_id && (
          <button onClick={() => onSubmit(null)} disabled={busy} className="text-[11px] text-red-500 hover:underline cursor-pointer">
            Unlink current employee
          </button>
        )}
        {error && <ErrorLine msg={error} />}
        <div className="flex justify-end">
          <button onClick={onClose} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Done</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- Roles matrix
function RolesMatrix() {
  const { data: roles = [], isLoading, error } = useRolesWithPermissions();
  if (isLoading) return <div className="flex justify-center py-16 text-gold-500"><Loader2 size={24} className="animate-spin" /></div>;
  if (error) return <p className="text-xs text-amber-600">{error.message}</p>;
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
        System roles and the permissions they carry. A role becomes branch- or department-specific by the
        <span className="font-semibold"> scope</span> you grant it at (in Users &amp; Access), not by a separate role.
      </p>
      {roles.map((r) => (
        <div key={r.id} className="premium-card p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-bold text-sm text-neutral-800 dark:text-slate-100">{prettyRole(r.key)}</span>
            <span className="text-[10px] font-mono text-neutral-400">{r.permissionKeys.length} permissions</span>
          </div>
          {r.description && <p className="text-[11px] text-neutral-500 dark:text-neutral-400">{r.description}</p>}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {r.permissionKeys.map((k) => (
              <span key={k} className="text-[9.5px] font-mono px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-900 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-850">
                {k}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Shifts (static for now)
function Shifts() {
  const shiftSchedules = [
    { name: 'General Day Shift (GDS)', hours: '09:00 AM - 06:00 PM', grace: '15 Mins', weeklyOff: 'Sunday' },
    { name: 'Retail Shift (RS)', hours: '10:30 AM - 08:30 PM', grace: '10 Mins', weeklyOff: 'Rotational' },
    { name: 'Night Operations (NOS)', hours: '09:00 PM - 06:00 AM', grace: '30 Mins', weeklyOff: 'Sunday, Monday' },
  ];
  return (
    <div className="glass-panel p-5 rounded-2xl space-y-4">
      <h3 className="font-semibold text-base flex items-center"><Clock size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Shift Timings</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {shiftSchedules.map((sh, i) => (
          <div key={i} className="p-4 bg-neutral-100/50 dark:bg-neutral-950/20 border border-neutral-200 dark:border-neutral-850 rounded-xl space-y-3">
            <span className="font-bold text-xs text-neutral-800 dark:text-slate-250 block">{sh.name}</span>
            <div className="space-y-1.5 text-xs text-neutral-500 dark:text-neutral-400 font-mono">
              <Line k="Timings" v={sh.hours} />
              <Line k="Grace" v={sh.grace} />
              <Line k="Weekly Off" v={sh.weeklyOff} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-neutral-400">Editable shift management arrives with the Attendance module.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Audit logs (live)
function AuditLogs() {
  const { data: logs = [], isLoading, error } = useAuditLog();
  return (
    <div className="glass-panel p-5 rounded-2xl space-y-4">
      <h3 className="font-semibold text-base flex items-center"><Clipboard size={18} className="mr-2 text-neutral-600 dark:text-neutral-400" /> Activity Audit Logs</h3>
      {isLoading ? (
        <div className="flex justify-center py-10 text-gold-500"><Loader2 size={22} className="animate-spin" /></div>
      ) : error ? (
        <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300 py-2">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span>{error.message}. If it mentions <code>audit_log</code>, run migration <code>0011_audit.sql</code>.</span>
        </div>
      ) : logs.length === 0 ? (
        <p className="text-xs text-neutral-500 py-8 text-center">No audit entries visible to you yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-855 text-neutral-550 text-[10px] font-bold uppercase tracking-wider">
                <th className="py-2.5">Actor</th><th className="py-2.5">Action</th><th className="py-2.5">Table</th><th className="py-2.5 text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-150 dark:divide-neutral-850/60 text-neutral-700 dark:text-neutral-400">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-neutral-100/10">
                  <td className="py-2.5 font-bold text-neutral-800 dark:text-slate-200">{log.actor_email || 'system'}</td>
                  <td className="py-2.5 font-mono">{log.action}</td>
                  <td className="py-2.5 font-mono text-[10.5px]">{log.table_name}</td>
                  <td className="py-2.5 text-right font-mono text-neutral-450">{new Date(log.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- small shared bits
const Line = ({ k, v }) => (
  <div className="flex justify-between"><span>{k}:</span><span className="text-neutral-800 dark:text-slate-200">{v}</span></div>
);
const Field = ({ label, children }) => (
  <div>
    <label className="block text-[11px] font-semibold text-neutral-600 dark:text-neutral-300 mb-1">{label}</label>
    {children}
  </div>
);
const ErrorLine = ({ msg }) => (
  <p className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-lg px-3 py-2">{msg}</p>
);
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 animate-fade-in" onClick={onClose}>
      <div className="w-full max-w-md bg-white dark:bg-charcoal-900 border border-neutral-200 dark:border-gold-500/15 rounded-2xl shadow-2xl p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold">{title}</h3>
          <button onClick={onClose} className={ICON_BTN}><X size={15} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function ModalActions({ busy, disabled, onClose, submitLabel }) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <button type="button" onClick={onClose} className="px-3 py-2 text-xs font-semibold text-neutral-500 hover:text-neutral-900 dark:hover:text-white cursor-pointer">Cancel</button>
      <button type="submit" disabled={busy || disabled} className={BTN}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} {submitLabel}
      </button>
    </div>
  );
}
