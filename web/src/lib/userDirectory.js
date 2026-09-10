const normal = (value) => String(value ?? '').replace(/_/g, ' ').toLocaleLowerCase();
const compare = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });

export function buildUserDirectory(users, employees, org = {}, roles = []) {
  const people = new Map(employees.map((e) => [e.id, e]));
  const companies = new Map((org.entities ?? []).map((e) => [e.id, e]));
  const branches = new Map((org.branches ?? []).map((b) => [b.id, b]));
  const zones = new Map((org.zones ?? []).map((z) => [z.id, z]));
  const departments = new Map((org.departments ?? []).map((d) => [d.id, d]));
  const roleNames = new Map(roles.map((r) => [r.key, r.name]));
  return users.map((user) => {
    const grants = user.roles ?? [];
    const employee = people.get(user.employee_id);
    const global = user.is_super_admin || grants.some((r) => r.role_key === 'super_admin' && r.scope_type === 'global');
    const allCompanies = global || grants.some((r) => r.scope_type === 'global');
    const companyIds = new Set();
    // Company means the linked employee's placement. For standalone logins, derive it from grants.
    if (employee?.entity_id) companyIds.add(employee.entity_id);
    else if (allCompanies) companies.forEach((_, id) => companyIds.add(id));
    else for (const grant of grants) {
      const id = grant.scope_type === 'entity' ? grant.scope_id
        : grant.scope_type === 'branch' ? branches.get(grant.scope_id)?.entity_id
        : grant.scope_type === 'zone' ? zones.get(grant.scope_id)?.entity_id
        : grant.scope_type === 'department' ? departments.get(grant.scope_id)?.entity_id : null;
      if (id) companyIds.add(id);
    }
    const companyNames = [...companyIds].map((id) => companies.get(id)?.name || employee?.entity?.name || 'Company unavailable');
    const companyCodes = [...companyIds].map((id) => companies.get(id)?.code || employee?.entity?.code || '—');
    const branch = branches.get(employee?.branch_id) ?? employee?.branch;
    const displayName = user.employee_name || employee?.full_name || user.email || 'Unnamed account';
    const roleLabels = [...new Set(grants.map((r) => roleNames.get(r.role_key) || r.role_key.replace(/_/g, ' ')))];
    const row = { ...user, roles: grants, employee, displayName, companyIds: [...companyIds], companyNames,
      companyCodes, companyLabel: !employee && allCompanies ? 'All companies' : companyNames.join(', ') || (user.employee_id ? 'Placement unavailable' : 'No company linked'),
      branchLabel: branch?.name || branch?.code || '', branchId: employee?.branch_id || '',
      global, hasRole: Boolean(global || grants.length), roleLabels };
    row.searchText = normal([displayName, user.email, user.employee_code, employee?.employee_code,
      ...companyNames, ...companyCodes, branch?.name, branch?.code, ...roleLabels].filter(Boolean).join(' '));
    return row;
  });
}

export function filterUserDirectory(rows, { search = '', company = '', branch = '', role = '', status = '', sort = 'name' } = {}) {
  const terms = normal(search).trim().split(/\s+/).filter(Boolean);
  return rows.filter((u) =>
    terms.every((term) => u.searchText.includes(term))
    && (!company || (company === 'unassigned' ? !u.companyIds.length : u.companyIds.includes(company)))
    && (!branch || u.branchId === branch)
    && (!role || (role === 'super_admin' && u.global) || u.roles.some((r) => r.role_key === role))
    && (!status || (status === 'ready' && u.hasRole) || (status === 'no_role' && !u.hasRole)
      || (status === 'unlinked' && !u.employee_id))
  ).sort((a, b) => (sort === 'company' ? compare(a.companyLabel, b.companyLabel) : 0)
    || (sort === 'name_desc' ? -1 : 1) * compare(a.displayName, b.displayName)
    || compare(a.user_id, b.user_id));
}
