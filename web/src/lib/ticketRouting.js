export const TICKET_STATUSES = ['Open', 'In Progress', 'On Hold', 'Resolved'];
export const ACTIONABLE_TICKET_STATUSES = ['Open', 'In Progress', 'On Hold'];

export function filterTickets(tickets, { search = '', status = '', categoryId = '', departmentId = '', hrOnly = false,
  needsAction = false, viewingAsEmployee = false } = {}) {
  const needle = search.trim().toLocaleLowerCase();
  return (tickets ?? []).filter((ticket) => (!status || ticket.status === status)
    && (!categoryId || ticket.category_id === categoryId)
    && (!departmentId || ticket.routed_department_id === departmentId)
    && (!hrOnly || ticket.is_hr_queue === true)
    && (!needsAction || ticketNeedsAction(ticket, { viewingAsEmployee }))
    && (!needle || [ticket.subject, ticket.description, ticket.category, ticket.routed_department?.name,
      ticket.employee?.full_name, ticket.employee?.employee_code].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle))));
}

export function canManageTicket(ticket, { viewingAsEmployee = false } = {}) {
  return !viewingAsEmployee && ticket?.can_manage === true;
}

export function ticketNeedsAction(ticket, options) {
  return canManageTicket(ticket, options) && ACTIONABLE_TICKET_STATUSES.includes(ticket?.status);
}

/** Count the complete visible queue, before search filters and pagination narrow its rows. */
export function ticketQueueCounts(tickets, { canViewQueue = false, viewingAsEmployee = false } = {}) {
  const counts = { all: 0, hr: 0 };
  if (!canViewQueue || viewingAsEmployee) return counts;
  for (const ticket of tickets ?? []) {
    if (!ticketNeedsAction(ticket)) continue;
    counts.all++;
    if (ticket.is_hr_queue === true) counts.hr++;
  }
  return counts;
}

export function availableTicketCategories(categories) {
  return (categories ?? []).filter((category) => category.is_active !== false
    && category.department_id && category.department?.is_active !== false);
}
