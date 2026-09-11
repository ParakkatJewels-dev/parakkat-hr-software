import { downloadCsv } from '../lib/csv.js';
import { istToday } from '../lib/dates.js';

export function exportEmployeeDirectory(employees) {
  downloadCsv(`Employee_Directory_${istToday()}.csv`,
    ['Employee Code', 'Full Name', 'Email', 'Phone', 'Entity', 'Branch', 'Department', 'Designation', 'Status', 'Join Date'],
    employees.map((employee) => [
      employee.employee_code ?? '', employee.full_name ?? '', employee.email ?? '', employee.phone ?? '',
      employee.entity?.name ?? '', employee.branch?.name || employee.branch?.code || '',
      employee.department?.name ?? '', employee.designation?.title ?? '', employee.status ?? '', employee.join_date ?? '',
    ]));
}
