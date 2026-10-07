import { blankGrossComponent, grossComponentsFromNotes, normalizeGrossComponentsDraft, parseMoneyDraft, salaryNotesFromGrossComponents, totalGrossFromParts } from './salaryDraft.js';

export function currentSalaryMap(structures, today) {
  const result = new Map();
  for (const salary of structures) {
    if (salary.effective_from && salary.effective_from > today) continue;
    const previous = result.get(salary.employee_id);
    if (!previous || (salary.effective_from || '') > (previous.effective_from || '')) result.set(salary.employee_id, salary);
  }
  return result;
}

export function filterSalaryEmployees(employees, current, { search = '', company = '', branch = '', status = '' } = {}) {
  const term = search.trim().toLocaleLowerCase();
  return employees.filter(person => (!company || person.entity_id === company)
    && (!branch || person.branch_id === branch)
    && (status !== 'missing' || !current.has(person.id))
    && (status !== 'ready' || current.has(person.id))
    && (!term || `${person.full_name || ''} ${person.employee_code || ''}`.toLocaleLowerCase().includes(term)));
}

export function salarySetupDraft(employee, salary, effectiveFrom) {
  const form = {
    employee_id: employee.id,
    effective_from: salary?.effective_from || effectiveFrom,
    basic: salary?.basic == null ? '' : String(salary.basic),
    gross_components: salary ? grossComponentsFromNotes(salary.notes, salary.basic, salary.gross) : [blankGrossComponent()],
  };
  return { employeeId: employee.id, entityId: employee.entity_id, form, initialForm: form };
}

export function salarySetupPayload(form, structures) {
  if (!form.employee_id) throw new Error('Choose an employee.');
  if (!form.effective_from) throw new Error('Choose an effective-from date.');
  const basic = parseMoneyDraft(form.basic);
  const components = normalizeGrossComponentsDraft(form.gross_components);
  const gross = parseMoneyDraft(totalGrossFromParts(form.basic, form.gross_components));
  if (components.error) throw new Error(components.error);
  if (basic == null || gross == null) throw new Error('Monthly basic and gross component amounts have to be valid amounts.');
  if (basic < 0 || components.total < 0 || gross < 0) throw new Error('Pay cannot be negative.');
  const existing = structures.find(row => row.employee_id === form.employee_id && row.effective_from === form.effective_from);
  return {
    id: existing?.id, employee_id: form.employee_id, effective_from: form.effective_from, basic, gross,
    notes: salaryNotesFromGrossComponents(form.gross_components, existing?.notes),
  };
}
