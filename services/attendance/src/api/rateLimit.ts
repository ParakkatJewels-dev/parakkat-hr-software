import type { RequestHandler } from 'express';

declare global {
  namespace Express {
    interface Request { releaseApiWork?: () => void; }
  }
}

/** Process-local admission control, before auth/database work. No timers or unbounded key map. */
export class RequestBudget {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly capacity = 2_000, private readonly now = Date.now) {}

  take(key: string, limit: number, windowMs = 60_000): number {
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && entry.resetAt <= now) { this.entries.delete(key); entry = undefined; }
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        for (const [id, candidate] of this.entries) if (candidate.resetAt <= now) this.entries.delete(id);
      }
      // Refuse new identities while full instead of evicting an active caller's quota.
      if (this.entries.size >= this.capacity) return Math.max(1, Math.ceil((Math.min(...Array.from(this.entries.values(), item => item.resetAt)) - now) / 1000));
      entry = { count: 0, resetAt: now + windowMs };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    entry.count++;
    return 0;
  }

  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }
}

export const apiRequestBudget = new RequestBudget();
const reject = (res: Parameters<RequestHandler>[1], seconds: number): void => {
  res.setHeader('Retry-After', String(seconds));
  res.status(429).json({ error: 'rate_limited', message: `Too many requests. Try again in ${seconds} seconds.`, retryAfter: seconds });
};

// The process cap still applies if an attacker rotates addresses or bearer tokens.
export const limitIncomingRequests: RequestHandler = (req, res, next) => {
  const retry = apiRequestBudget.take('incoming:all', 1800)
    || apiRequestBudget.take(`incoming:ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`, 600);
  if (retry) { reject(res, retry); return; }
  next();
};

let expensiveInFlight = 0;
export const limitApiWork: RequestHandler = (req, res, next) => {
  if (!req.auth) { res.status(401).json({ error: 'unauthenticated', message: 'Sign in to continue.' }); return; }
  // Express's default router is case-insensitive; classification must match the same routes.
  const exportWork = /^\/api\/exports\/(register|payroll)\/?$/i.test(req.path);
  const jobWork = req.method === 'POST' && /^\/api\/(sync(?:\/|$)|backfill\/?$|recompute(?:\/|$)|mapping\/suggest\/?$)/i.test(req.path);
  const costly = exportWork || jobWork;
  const kind = costly ? 'expensive' : req.method === 'GET' ? 'read' : 'write';
  const retry = apiRequestBudget.take(`user:${req.auth.userId}:${kind}`, costly ? 20 : kind === 'read' ? 120 : 30);
  if (retry) { reject(res, retry); return; }
  if (costly) {
    if (expensiveInFlight >= 4) { reject(res, 5); return; }
    expensiveInFlight++;
    let released = false;
    // asyncRoute releases this only after the actual operation settles. A caller closing its
    // socket must not free a slot while its database query or workbook generation keeps running.
    req.releaseApiWork = () => { if (!released) { released = true; expensiveInFlight--; } };
  }
  next();
};
