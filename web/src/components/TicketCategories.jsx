import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Plus, Pencil, X } from 'lucide-react';
import { useSaveTicketCategory } from '../data/ticketCategories';
import { humanDbError } from '../lib/dbErrors';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const emptyForm = { id: null, name: '', department_id: '', is_active: true, is_hr_queue: false };

/** Category changes affect the destination offered for new tickets; history stays readable. */
export default function TicketCategories({ categories = [], departments = [], isLoading, error, onRetry,
  departmentsLoading, departmentsError, onRetryDepartments }) {
  const save = useSaveTicketCategory();
  const submitting = useRef(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [saved, setSaved] = useState('');
  const matches = useMemo(() => categories.filter((row) => {
    const needle = search.trim().toLocaleLowerCase();
    return (status === 'all' || row.is_active === (status === 'active'))
      && (!needle || `${row.name} ${row.department?.name ?? ''}`.toLocaleLowerCase().includes(needle));
  }), [categories, search, status]);
  const pager = usePagination(matches, 25, null, `${search}:${status}`);
  const activeDepartments = departments.filter((row) => row.is_active !== false);
  const selectedDepartment = activeDepartments.find((row) => row.id === form.department_id);
  const begin = (category = emptyForm) => {
    save.reset(); setSaved(''); setForm({ ...emptyForm, ...category }); setEditing(true);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (save.isPending || submitting.current || departmentsLoading || departmentsError || !form.name.trim() || !selectedDepartment) return;
    submitting.current = true;
    try {
      await save.mutateAsync({ id: form.id, name: form.name.trim(), departmentId: form.department_id, isActive: form.is_active, isHrQueue: form.is_hr_queue });
      setSaved(form.id ? 'Category updated.' : 'Category added.');
      setEditing(false); setForm(emptyForm);
    } catch { /* Display the server's refusal with the form. */ }
    finally { submitting.current = false; }
  };
  const closeForm = () => { if (!save.isPending && !submitting.current) setEditing(false); };
  return <section className="space-y-4" aria-label="Ticket categories">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-base font-bold text-neutral-900 dark:text-white">Ticket categories</h2>
        <p className="mt-1 text-sm text-neutral-500">Choose the department that handles each category.</p></div>
      {!editing && <button type="button" className={btnClass('primary')} onClick={() => begin()}><Plus size={16} />Add category</button>}
    </div>
    {saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{saved}</p>}
    {editing && <form onSubmit={submit} className="premium-card space-y-4" aria-busy={save.isPending}>
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
      <div className="flex items-center justify-between gap-3"><h3 className="font-bold">{form.id ? 'Edit category' : 'Add category'}</h3>
        <button type="button" className={btnClass('ghost')} disabled={save.isPending} aria-label="Close category form" onClick={closeForm}><X size={18} /></button></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1 text-sm font-medium"><span>Category name</span><input required maxLength={80} className={INPUT}
          value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="For example, IT support" /></label>
        <label className="space-y-1 text-sm font-medium"><span>Assigned department</span><select required className={INPUT}
          value={form.department_id} disabled={departmentsLoading || Boolean(departmentsError)}
          onChange={(event) => setForm({ ...form, department_id: event.target.value })}>
          <option value="">{departmentsLoading ? 'Loading departments…' : 'Select a department'}</option>
          {form.department_id && !selectedDepartment && <option value={form.department_id} disabled>Department unavailable — choose another</option>}
          {activeDepartments.map((department) => <option key={department.id} value={department.id}>{[department.name, department.branch?.code, department.entity?.name].filter(Boolean).join(' · ')}</option>)}
        </select></label>
      </div>
      {departmentsError && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{humanDbError(departmentsError)} <button type="button" onClick={onRetryDepartments} className="underline">Retry departments</button></p>}
      {!departmentsLoading && !departmentsError && activeDepartments.length === 0 && <p className="text-sm text-amber-700 dark:text-amber-300">Add an active department in Organization before creating a ticket category.</p>}
      <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.is_active}
        onChange={(event) => setForm({ ...form, is_active: event.target.checked })} />Available for new tickets</label>
      <div><label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={form.is_hr_queue}
        onChange={(event) => setForm({ ...form, is_hr_queue: event.target.checked })} />HR queue</label>
        <p className="text-xs text-neutral-500">Include this category in HR’s ticket queue.</p></div>
      <p className="text-xs text-neutral-500">Deactivating a category keeps its existing tickets and removes it from new ticket forms.</p>
      {save.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{humanDbError(save.error)}</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className={btnClass('ghost')} disabled={save.isPending} onClick={closeForm}>Cancel</button>
        <button type="submit" className={btnClass('primary')} disabled={save.isPending || !form.name.trim() || !selectedDepartment || departmentsLoading || Boolean(departmentsError)}>
          {save.isPending && <Loader2 size={16} className="animate-spin" />}Save category</button></div>
      </fieldset><p role="status" className="sr-only">{save.isPending ? 'Saving category…' : ''}</p>
    </form>}
    <div className="premium-card space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <label className="space-y-1 text-sm"><span>Search categories</span><input type="search" className={INPUT} value={search}
          onChange={(event) => setSearch(event.target.value)} placeholder="Category or department" /></label>
        <label className="space-y-1 text-sm"><span>Category availability</span><select className={INPUT} value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">All categories</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      </div>
      {isLoading ? <SkeletonRows rows={4} avatar={false} label="Loading ticket categories" />
        : error ? <div role="alert" className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300"><AlertTriangle size={16} className="shrink-0" />
          <span>{humanDbError(error)} <button type="button" onClick={onRetry} className="underline">Retry categories</button></span></div>
        : matches.length === 0 ? <p className="py-8 text-center text-sm text-neutral-500">{categories.length ? 'No categories match these filters.' : 'No categories yet. Add one and assign its department to start routing tickets.'}</p>
        : <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">{pager.slice.map((category) => <li key={category.id}
          className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{category.name}</p>
            <p className="mt-1 text-xs text-neutral-500">{category.department?.name ?? 'Department unavailable'}{category.department?.branch?.code ? ` · ${category.department.branch.code}` : ''}</p></div>
          <span className="text-xs text-neutral-500">{category.is_active ? 'Active' : 'Inactive'}{category.is_hr_queue ? ' · HR queue' : ''}</span>
          {category.can_manage === true && <button type="button" className={btnClass('ghost')} aria-label={`Edit category ${category.name}`} onClick={() => begin(category)}><Pencil size={15} />Edit</button>}
        </li>)}</ul>}
      <div className="paged-collection"><Pagination {...pager} noun="categories" sizes={[25, 50, 100]} /></div>
    </div>
  </section>;
}
