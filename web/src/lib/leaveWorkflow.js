const WAITING = new Set(['Pending', 'On Hold']);

export function leaveStage(request) {
  return request?.effective_stage ?? request?.approval_stage ?? null;
}

export function leaveStageLabel(request) {
  if (!WAITING.has(request?.status)) return request?.status || 'Pending';
  const stage = leaveStage(request);
  const label = stage === 'department' ? 'Department head review' : stage === 'hr' ? 'HR sanction' : 'Review';
  return request.status === 'On Hold' ? `On hold · ${label}` : `Awaiting ${label === 'Review' ? 'review' : label}`;
}

/** The server owns stage/role authorization. Missing capability fields fail closed. */
export function canReviewLeave(request, employeeId, viewingAsEmployee = false) {
  return !viewingAsEmployee && request?.employee_id !== employeeId
    && WAITING.has(request?.status) && request?.can_decide === true;
}

export function leaveDecisionsFor(request, employeeId, viewingAsEmployee = false) {
  if (canReviewLeave(request, employeeId, viewingAsEmployee)) {
    return [
      { value: 'Approved', label: leaveStage(request) === 'department' ? 'Approve & forward to HR' : 'Sanction leave' },
      { value: 'Rejected', label: 'Reject leave' },
      ...(request.status === 'On Hold' ? [{ value: 'Pending', label: 'Resume review' }] : [{ value: 'On Hold', label: 'Put on hold' }]),
    ];
  }
  if (!viewingAsEmployee && request?.employee_id !== employeeId && request?.can_reopen === true) {
    return [{ value: 'Pending', label: 'Reopen for review' },
      ...(request.status === 'Approved' ? [{ value: 'Cancelled', label: 'Cancel sanctioned leave' }] : [])];
  }
  return [];
}

export function matchesLeaveFilter(request, filter, employeeId, viewingAsEmployee = false) {
  if (filter === 'All') return true;
  if (filter === 'My review queue') return canReviewLeave(request, employeeId, viewingAsEmployee);
  if (filter === 'Department review') return WAITING.has(request.status) && leaveStage(request) === 'department';
  if (filter === 'HR sanction') return WAITING.has(request.status) && leaveStage(request) === 'hr';
  return request.status === filter;
}

export function leaveDecisionLabel(entry) {
  const who = entry.stage === 'department' ? 'Department head' : 'HR';
  if (entry.decision === 'Approved') return entry.stage === 'department' ? 'Department approved · forwarded to HR' : 'HR sanctioned leave';
  if (entry.decision === 'Rejected') return `${who} rejected leave`;
  if (entry.decision === 'On Hold') return `${who} put leave on hold`;
  if (entry.decision === 'Pending') return entry.from_stage === 'completed' ? 'Leave reopened for review' : `${who} resumed review`;
  if (entry.decision === 'Cancelled') return 'Sanctioned leave cancelled';
  return entry.decision;
}
