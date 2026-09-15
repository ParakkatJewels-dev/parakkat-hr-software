export const TICKET_STATUSES = ['Open', 'In Progress', 'On Hold', 'Resolved'];

export function filterTickets(tickets, { search = '', status = '', categoryId = '', departmentId = '', hrOnly = false } = {}) {
  const needle = search.trim().toLocaleLowerCase();
  return (tickets ?? []).filter((ticket) => (!status || ticket.status === status)
    && (!categoryId || ticket.category_id === categoryId)
    && (!departmentId || ticket.routed_department_id === departmentId)
    && (!hrOnly || ticket.is_hr_queue === true)
    && (!needle || [ticket.subject, ticket.description, ticket.category, ticket.routed_department?.name,
      ticket.employee?.full_name, ticket.employee?.employee_code].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle))));
}

export function canManageTicket(ticket, { viewingAsEmployee = false } = {}) {
  return !viewingAsEmployee && ticket?.can_manage === true;
}

export function availableTicketCategories(categories) {
  return (categories ?? []).filter((category) => category.is_active !== false
    && category.department_id && category.department?.is_active !== false);
}
