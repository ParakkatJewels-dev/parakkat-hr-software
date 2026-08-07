// A person's name, as a way to get to them.
//
// Half the screens in the app name somebody in passing — who is holding this laptop, who was late
// on Tuesday, who filed this expense — and none of those names went anywhere. Reading one meant
// going to People and searching for it by hand, which is the same lookup done twice: the app
// already knows exactly which record it just printed.
//
// Renders plain text, not a dead link, when the reader cannot open the directory: the People
// screen needs employee.read beyond your own record (App.jsx gates it that way), so offering a
// self-scoped employee a link into it would only take them to a refusal.
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../../auth/usePermissions';

export default function EmployeeLink({ employee, id, name, className = '', children }) {
  const navigate = useNavigate();
  const { canBeyondSelf } = usePermissions();

  const employeeId = id ?? employee?.id ?? null;
  const label = children ?? name ?? employee?.full_name ?? null;

  if (!employeeId || !label || !canBeyondSelf('employee.read')) {
    return <span className={className}>{label ?? '—'}</span>;
  }

  return (
    <button
      type="button"
      // Rows are often clickable themselves (a shift, an asset). Without this the row's handler
      // fires as well and you arrive somewhere neither click asked for.
      onClick={(e) => { e.stopPropagation(); navigate(`/directory/${employeeId}`); }}
      title={`Open ${label}'s profile`}
      className={`employee-link ${className}`.trim()}
    >
      {label}
    </button>
  );
}
