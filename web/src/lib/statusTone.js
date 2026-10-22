// One colour language for statuses across the app (2026 redesign): green for done and fine, amber
// for waiting, red for a problem, blue for under way, grey for not started or no longer current.
// Screens map their own status words through toneForStatus; anything unknown is neutral.

export const STATUS_TONES = ['success', 'warning', 'danger', 'info', 'neutral', 'coral'];

const WORDS = {
  success: ['present', 'active', 'approved', 'done', 'completed', 'complete', 'paid', 'published', 'resolved',
    'closed', 'cleared', 'ready', 'accepted', 'available', 'healthy', 'online', 'hired', 'verified', 'sanctioned'],
  warning: ['late', 'pending', 'on leave', 'leave', 'draft', 'submitted', 'in review', 'internal review', 'waiting',
    'awaiting approval', 'needs review', 'half day', 'revisions', 'changes needed', 'early exit', 'notice period',
    'in repair', 'under repair', 'maintenance', 'partial'],
  danger: ['absent', 'missing', 'missing punch', 'overdue', 'rejected', 'declined', 'failed', 'blocked', 'lost',
    'lop', 'offline', 'expired', 'terminated', 'error', 'damaged', 'urgent', 'critical'],
  info: ['probation', 'in progress', 'open', 'on hold', 'assigned', 'allocated', 'new', 'scheduled', 'processing',
    'interview', 'screening', 'offer', 'onboarding', 'running', 'holiday', 'week off', 'weekly off'],
  neutral: ['to do', 'todo', 'inactive', 'exited', 'archived', 'cancelled', 'canceled', 'retired', 'disposed',
    'not started', 'unknown', 'none'],
};

const LOOKUP = new Map(Object.entries(WORDS).flatMap(([tone, words]) => words.map((word) => [word, tone])));

/** The tone for a status word, case-insensitive. Unknown words are neutral. */
export function toneForStatus(status) {
  const key = String(status ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  return LOOKUP.get(key) ?? 'neutral';
}
