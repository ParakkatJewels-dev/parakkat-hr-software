import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Building2, HelpCircle, Loader2, Plus, X } from 'lucide-react';
import { useTickets, useAddTicket, useSetTicketStatus } from '../data/tickets';
import { useTicketAccess, useTicketCategories } from '../data/ticketCategories';
import { useVisibleOrg } from '../data/org';
import { useAuth } from '../auth/AuthContext';
import { usePermissions } from '../auth/usePermissions';
import { ACTIONABLE_TICKET_STATUSES, availableTicketCategories, canManageTicket, filterTickets, ticketQueueCounts, TICKET_STATUSES } from '../lib/ticketRouting';
import { humanDbError } from '../lib/dbErrors';
import { useFocusRow } from '../lib/useFocusRow';
import { btnClass } from './ui/Btn';
import Pagination, { usePagination } from './ui/Pagination';
import { SkeletonRows } from './ui/Skeleton';
import TicketCategories from './TicketCategories';

const INPUT = 'w-full min-h-11 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-800 dark:text-neutral-200';
const initialForm = { categoryId: '', subject: '', description: '', priority: 'Medium' };
const badgeClass = (status) => status === 'Resolved'
  ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
  : status === 'In Progress' ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300'
    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300';
const queueLabel = (label, count) => count === null ? `${label}, checking tickets needing action`
  : `${label}, ${count} ticket${count === 1 ? '' : 's'} needing action`;
function QueueBadge({ count }) {
  if (count === 0) return null;
  return <span aria-hidden="true" className="min-w-5 rounded-full bg-neutral-900/10 px-1.5 py-0.5 text-xs tabular-nums dark:bg-white/15">{count === null ? '?' : count > 99 ? '99+' : count}</span>;
}

export default function TicketDesk() {
  const { employee } = useAuth();
  const { can, canBeyondSelf, viewingAsEmployee } = usePermissions();
  const query = useTickets();
  const access = useTicketAccess();
  const categories = useTicketCategories();
  const org = useVisibleOrg();
  const add = useAddTicket();
  const submitting = useRef(false);
  const update = useSetTicketStatus();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const requestedQueue = params.get('ticketQueue');
  const setQueue = useCallback((value) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (value === 'all') next.delete('ticketQueue'); else next.set('ticketQueue', value);
    return next;
  }, { replace: true }), [setParams]);
  const [section, setSection] = useState('tickets');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [created, setCreated] = useState(false);
  const { focusId, rowProps } = useFocusRow();
  useEffect(() => {
    if (!focusId) return;
    setSection('tickets'); setQueue('all'); setSearch(''); setStatus(''); setCategoryId(''); setDepartmentId('');
  }, [focusId, setQueue]);
  const canManageCategories = !viewingAsEmployee && access.data?.can_manage_categories === true;
  const canRaise = Boolean(employee?.id) && can('ticket.create', { employeeId: employee.id });
  const isHr = !viewingAsEmployee && access.data?.is_hr === true;
  const canViewQueue = !viewingAsEmployee && access.data?.can_view_queue === true;
  const hrOnly = isHr && (requestedQueue === 'hr' || requestedQueue === 'hr-needs-action');
  const needsAction = canViewQueue && (requestedQueue === 'needs-action' || requestedQueue === 'hr-needs-action');
  const queue = hrOnly ? 'hr' : 'all';
  const mineOnly = viewingAsEmployee || (access.data ? !access.data.can_view_queue : !canBeyondSelf('ticket.read'));
  const ticketRows = useMemo(() => (query.data ?? []).filter((ticket) => !mineOnly || ticket.employee_id === employee?.id),
    [query.data, mineOnly, employee?.id]);
  const matches = useMemo(() => filterTickets(ticketRows, { search, status, categoryId, departmentId, hrOnly, needsAction, viewingAsEmployee }),
    [ticketRows, search, status, categoryId, departmentId, hrOnly, needsAction, viewingAsEmployee]);
  const counts = useMemo(() => ticketQueueCounts(ticketRows, { canViewQueue, viewingAsEmployee }), [ticketRows, canViewQueue, viewingAsEmployee]);
  const hasTickets = Array.isArray(query.data);
  const allCount = hasTickets ? counts.all : null;
  const hrCount = hasTickets ? counts.hr : null;
  const actionCount = hrOnly ? hrCount : allCount;
  const pager = usePagination(matches, 25, focusId, `${location.key}:${mineOnly}:${queue}:${needsAction}:${search}:${status}:${categoryId}:${departmentId}`);
  const chooseQueue = (value) => {
    setQueue(value); setSearch(''); setStatus(''); setCategoryId(''); setDepartmentId(''); pager.setPage(1);
  };
  useEffect(() => {
    if (requestedQueue !== 'needs-action' && requestedQueue !== 'hr-needs-action') return;
    setSection('tickets'); setSearch(''); setStatus(''); setCategoryId(''); setDepartmentId('');
  }, [requestedQueue, location.key]);
  const activeCategories = availableTicketCategories(categories.data);
  const departmentRows = (org.data?.departments ?? []).map((department) => ({ ...department,
    branch: org.data?.branches?.find((branch) => branch.id === department.branch_id),
    entity: org.data?.entities?.find((entity) => entity.id === department.entity_id),
  }));
  const selectedCategory = activeCategories.find((category) => category.id === form.categoryId);
  const categoryOptions = new Map((categories.data ?? []).map((category) => [category.id, category.name]));
  const departmentOptions = new Map();
  for (const ticket of ticketRows) {
    if (ticket.category_id && !categoryOptions.has(ticket.category_id)) categoryOptions.set(ticket.category_id, ticket.category ?? 'Category unavailable');
    if (ticket.routed_department_id) departmentOptions.set(ticket.routed_department_id, ticket.routed_department?.name ?? 'Department unavailable');
  }
  const submit = async (event) => {
    event.preventDefault();
    if (add.isPending || submitting.current || categories.isLoading || categories.error || !employee?.id || !selectedCategory || !form.subject.trim()) return;
    submitting.current = true;
    try {
      await add.mutateAsync({ categoryId: selectedCategory.id, subject: form.subject.trim(), description: form.description.trim(), priority: form.priority });
      setShowForm(false); setForm(initialForm); setCreated(true); setQueue('all');
      setSearch(''); setStatus(''); setCategoryId(''); setDepartmentId(''); pager.setPage(1);
    } catch { /* Keep the form visible with its error. */ }
    finally { submitting.current = false; }
  };
  const closeForm = () => { if (!add.isPending && !submitting.current) setShowForm(false); };
  return <section className="space-y-4" aria-label="Helpdesk tickets">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-2" aria-label="Helpdesk sections">
        <button type="button" className={btnClass(section === 'tickets' || !canManageCategories ? 'primary' : 'ghost')}
          aria-label={canViewQueue ? queueLabel('Tickets', allCount) : undefined}
          aria-pressed={section === 'tickets' || !canManageCategories} onClick={() => setSection('tickets')}>Tickets{canViewQueue && <QueueBadge count={allCount} />}</button>
        {canManageCategories && <button type="button" className={btnClass(section === 'categories' ? 'primary' : 'ghost')}
          aria-pressed={section === 'categories'} onClick={() => setSection('categories')}>Categories</button>}
      </div>
      {canRaise && !showForm && (section !== 'categories' || !canManageCategories) && <button type="button" className={btnClass('primary')}
        onClick={() => { add.reset(); setCreated(false); setShowForm(true); }}><Plus size={16} />Raise Ticket</button>}
    </div>
    {access.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">Could not load ticket queue settings. <button type="button" className="underline" onClick={() => access.refetch()}>Retry queue settings</button></p>}
    {section === 'categories' && canManageCategories ? <TicketCategories categories={categories.data ?? []} departments={departmentRows}
      isLoading={categories.isLoading} error={categories.error} onRetry={categories.refetch}
      departmentsLoading={org.isLoading} departmentsError={org.error} onRetryDepartments={org.refetch} /> : <>
      {created && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">Ticket submitted to the category’s department.</p>}
      {showForm && canRaise && <form onSubmit={submit} className="premium-card space-y-4" aria-label="Raise support ticket" aria-busy={add.isPending}>
        <fieldset disabled={add.isPending} className="min-w-0 space-y-4">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-bold">Raise support ticket</h2>
          <button type="button" className={btnClass('ghost')} disabled={add.isPending} aria-label="Close ticket form" onClick={closeForm}><X size={18} /></button></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm font-medium"><span>Category</span><select required className={INPUT} value={form.categoryId}
            disabled={categories.isLoading || Boolean(categories.error)} onChange={(event) => setForm({ ...form, categoryId: event.target.value })}>
            <option value="">{categories.isLoading ? 'Loading categories…' : 'Choose a category'}</option>
            {form.categoryId && !selectedCategory && <option value={form.categoryId} disabled>Category unavailable — choose another</option>}
            {activeCategories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <label className="space-y-1 text-sm font-medium"><span>Priority</span><select className={INPUT} value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value })}>{['Low', 'Medium', 'High'].map((value) => <option key={value}>{value}</option>)}</select></label>
        </div>
        {selectedCategory && <p className="flex items-start gap-2 rounded-xl bg-brand-soft p-3 text-sm text-brand-ink" role="status">
          <Building2 size={17} className="mt-0.5 shrink-0" /><span>Sent to <strong>{selectedCategory.department?.name ?? 'the assigned department'}</strong></span></p>}
        {categories.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{humanDbError(categories.error)} <button type="button" className="underline" onClick={() => categories.refetch()}>Retry categories</button></p>}
        {!categories.isLoading && !categories.error && !activeCategories.length && <p className="text-sm text-amber-700 dark:text-amber-300">No active ticket categories are available. An administrator can add a category and assign its department in Helpdesk → Categories.</p>}
        <label className="block space-y-1 text-sm font-medium"><span>Subject</span><input required maxLength={500} className={INPUT} value={form.subject}
          onChange={(event) => setForm({ ...form, subject: event.target.value })} placeholder="Briefly describe the issue" /></label>
        <label className="block space-y-1 text-sm font-medium"><span>Details (optional)</span><textarea rows={3} maxLength={10000} className={`${INPUT} resize-y`}
          value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} placeholder="Add any details that will help the department resolve it" /></label>
        {add.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{humanDbError(add.error)}</p>}
        <div className="flex justify-end gap-2"><button type="button" className={btnClass('ghost')} disabled={add.isPending} onClick={closeForm}>Cancel</button>
          <button type="submit" className={btnClass('primary')} disabled={add.isPending || categories.isLoading || Boolean(categories.error) || !selectedCategory || !form.subject.trim()}>
            {add.isPending && <Loader2 size={16} className="animate-spin" />}Submit ticket</button></div>
        </fieldset><p role="status" className="sr-only">{add.isPending ? 'Submitting ticket…' : ''}</p>
      </form>}
      <div className="premium-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="flex items-center gap-2 text-base font-bold"><HelpCircle size={18} />Support Tickets</h2>
          <span className="text-sm text-neutral-500">{hasTickets ? `${matches.length} ticket${matches.length === 1 ? '' : 's'}` : query.error ? 'Tickets unavailable' : 'Loading tickets…'}</span></div>
        {canViewQueue && <div className="flex flex-wrap gap-2" aria-label="Ticket queue">
          <button type="button" className={btnClass(!hrOnly && !needsAction ? 'primary' : 'ghost')} aria-pressed={!hrOnly && !needsAction}
            aria-label={queueLabel('All tickets', allCount)} onClick={() => chooseQueue('all')}>All tickets<QueueBadge count={allCount} /></button>
          <button type="button" className={btnClass(needsAction ? 'primary' : 'ghost')} aria-pressed={needsAction}
            aria-label={queueLabel('Needs action', actionCount)} onClick={() => chooseQueue(needsAction ? queue : hrOnly ? 'hr-needs-action' : 'needs-action')}>Needs action<QueueBadge count={actionCount} /></button>
          {isHr && <button type="button" className={btnClass(hrOnly ? 'primary' : 'ghost')} aria-pressed={hrOnly}
            aria-label={queueLabel('Tickets to HR', hrCount)} onClick={() => chooseQueue(needsAction ? 'hr-needs-action' : 'hr')}>Tickets to HR<QueueBadge count={hrCount} /></button>}
        </div>}
        {canViewQueue && <p className="text-xs text-neutral-500">Counts show unresolved tickets you can update, including tickets on hold.{needsAction ? ' Showing tickets that need action.' : ''}</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1 text-sm"><span>Search tickets</span><input type="search" className={INPUT} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Subject, employee or category" /></label>
          <label className="space-y-1 text-sm"><span>Ticket status</span><select className={INPUT} value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{(needsAction ? ACTIONABLE_TICKET_STATUSES : TICKET_STATUSES).map((value) => <option key={value}>{value}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>Ticket category</span><select className={INPUT} value={categoryId} onChange={(event) => setCategoryId(event.target.value)}><option value="">All categories</option>
            {[...categoryOptions].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label className="space-y-1 text-sm"><span>Assigned department</span><select className={INPUT} value={departmentId} onChange={(event) => setDepartmentId(event.target.value)}><option value="">All departments</option>
            {[...departmentOptions].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        </div>
        {update.error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{humanDbError(update.error)}</p>}
        {query.error && <div role="alert" className="flex items-start gap-2 text-sm text-rose-700 dark:text-rose-300"><AlertTriangle size={16} className="shrink-0" /><span>{humanDbError(query.error)} {hasTickets && 'Showing the last available tickets and counts. They may be out of date. '}<button type="button" className="underline" onClick={() => query.refetch()}>Retry tickets</button></span></div>}
        {!hasTickets ? !query.error && <SkeletonRows rows={4} avatar={false} label="Loading support tickets" />
            : matches.length === 0 ? <p className="py-8 text-center text-sm text-neutral-500">{ticketRows.length ? 'No tickets match these filters.' : 'No tickets visible to you yet.'}</p>
              : <div className="divide-y divide-neutral-200 dark:divide-neutral-800">{pager.slice.map((ticket) => <article key={ticket.id} {...rowProps(ticket.id)} className="py-4" aria-label={`Ticket: ${ticket.subject}`}>
                <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs"><span className="font-semibold text-neutral-600 dark:text-neutral-300">{ticket.category ?? 'Uncategorised'}</span><span className={ticket.priority === 'High' ? 'text-rose-700 dark:text-rose-300' : 'text-neutral-500'}>{ticket.priority}</span></div>
                  <h3 className="mt-1 break-words text-sm font-semibold text-neutral-900 dark:text-neutral-100">{ticket.subject}</h3>
                  {ticket.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-neutral-600 dark:text-neutral-400">{ticket.description}</p>}
                  <p className="mt-2 text-xs text-neutral-500">{ticket.employee?.full_name ?? 'Unknown employee'}{ticket.employee?.branch?.code ? ` · ${ticket.employee.branch.code}` : ''}</p>
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-neutral-500"><Building2 size={13} />Assigned to {ticket.routed_department?.name ?? 'Unassigned department'}</p>
                </div><div className="flex flex-wrap items-center justify-end gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClass(ticket.status)}`}>{ticket.status}</span>
                  {canManageTicket(ticket, { viewingAsEmployee }) && <select className={`${INPUT} !w-auto`} aria-label={`Update status for ${ticket.subject}`} value={ticket.status}
                    disabled={update.isPending} onChange={(event) => update.mutate({ id: ticket.id, status: event.target.value })}>{TICKET_STATUSES.map((value) => <option key={value}>{value}</option>)}</select>}
                </div></div>
              </article>)}</div>}
        <div className="paged-collection"><Pagination {...pager} noun="tickets" sizes={[25, 50, 100]} /></div>
      </div>
    </>}
  </section>;
}
