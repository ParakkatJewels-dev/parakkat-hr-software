import { useId, useState } from 'react';
import { Target } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { useEmployees } from '../data/employees';
import { useSaveGoal } from '../data/goals';
import FormSection, { Field } from './ui/FormSection';
import GoalEmployeePicker from './GoalEmployeePicker';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';

export default function GoalForm({ onClose, onCreated }) {
  const { employee } = useAuth();
  const { can, canAny, viewingAsEmployee } = usePermissions();
  const allowed = !viewingAsEmployee && canAny('performance.manage');
  const people = useEmployees({ enabled: allowed });
  const save = useSaveGoal();
  const id = useId();
  const [employeeId, setEmployeeId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const eligible = (people.data ?? []).filter(person => can('performance.manage', {
    employeeId: person.id, entityId: person.entity_id, zoneId: person.zone_id,
    branchId: person.branch_id, deptId: person.department_id,
  }));
  const selected = eligible.find(person => person.id === employeeId);
  const valid = Boolean(selected && title.trim() && !people.isLoading && !people.error);
  if (!allowed) return null;
  return <FormSection title="Set a goal" icon={Target}
    subtitle="Choose an employee and describe the outcome they should achieve."
    onClose={save.isPending ? undefined : onClose} submitLabel="Assign goal" busy={save.isPending}
    disabled={!valid} error={save.error?.message} onSubmit={async event => {
      event.preventDefault();
      if (!valid || save.isPending) return;
      try {
        const result = await save.mutateAsync({ employee_id: selected.id, title: title.trim(),
          description: description.trim() || null, target_date: targetDate || null,
          created_by: employee?.id ?? null });
        onCreated({ id: result.id, employeeId: selected.id, employeeName: selected.full_name });
      } catch { /* Preserve the selected employee and goal details for a retry. */ }
    }}>
    <GoalEmployeePicker employees={eligible} value={employeeId} onChange={setEmployeeId}
      isLoading={people.isLoading} error={people.error} onRetry={people.refetch} disabled={save.isPending} />
    <fieldset disabled={save.isPending} className="space-y-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <legend className="px-1 text-sm font-bold">Goal details</legend>
      <Field label="Goal title" htmlFor={`${id}-title`} required>
        <input id={`${id}-title`} required className={INPUT} value={title} onChange={event => setTitle(event.target.value)}
          placeholder="For example, reduce stock variance to under 1%" />
      </Field>
      <Field label="Details (optional)" htmlFor={`${id}-description`}>
        <textarea id={`${id}-description`} rows={3} className={INPUT} value={description}
          onChange={event => setDescription(event.target.value)} placeholder="Explain what success looks like and how progress will be measured." />
      </Field>
      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Target date (optional)" htmlFor={`${id}-date`}>
          <input id={`${id}-date`} type="date" className={INPUT} value={targetDate} onChange={event => setTargetDate(event.target.value)} />
        </Field>
        <p className="pb-2 text-xs text-neutral-500 dark:text-neutral-400">The employee can record progress toward this goal.</p>
      </div>
    </fieldset>
  </FormSection>;
}
