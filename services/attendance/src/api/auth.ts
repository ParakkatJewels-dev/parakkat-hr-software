// API authentication.
//
// This service does NOT invent its own identity system. The web app already authenticates with
// Supabase Auth and its permissions come from the Role x Scope model in the database, so the API
// verifies the caller's Supabase access token and asks the database what that user may do, via the
// same get_my_access() RPC the frontend uses. One source of truth for permissions, not two.
//
// Note the asymmetry that makes this safe: the token is verified by Supabase, but the work itself
// runs on the privileged Prisma connection that bypasses RLS. So every route MUST declare a
// required permission — there is no RLS backstop here.
import type { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { env, canVerifyTokens } from '../config/env';
import { logger } from '../lib/logger';
import { prisma } from '../lib/db';

export interface Grant {
  permission: string;
  scope_type: string;
  scope_id: string | null;
}

export interface AuthContext {
  userId: string;
  email: string | null;
  isSuperAdmin: boolean;
  permissions: Grant[];
  employee: { id: string; full_name: string; employee_code: string | null } | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Short-lived cache so a burst of calls from one screen is not N round trips to Supabase. */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { context: AuthContext; expiresAt: number }>();

function cacheKey(token: string): string {
  // Never key on the raw token — this map would become a credential store in a heap dump.
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = (hash * 31 + token.charCodeAt(i)) | 0;
  }
  return `${token.length}:${hash}`;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return value.trim() || null;
}

async function resolveContext(token: string): Promise<AuthContext | null> {
  const key = cacheKey(token);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.context;

  const supabase = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) return null;

  // Runs as the caller, so it returns exactly the grants RLS would honour for them.
  const { data: access, error: accessError } = await supabase.rpc('get_my_access');
  if (accessError) {
    logger.warn({ err: accessError.message }, 'get_my_access failed');
    return null;
  }

  const payload = (access ?? {}) as {
    is_super_admin?: boolean;
    permissions?: Grant[];
    employee?: { id: string; full_name: string; employee_code: string | null } | null;
  };

  const context: AuthContext = {
    userId: userData.user.id,
    email: userData.user.email ?? null,
    isSuperAdmin: Boolean(payload.is_super_admin),
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    employee: payload.employee ?? null,
  };

  cache.set(key, { context, expiresAt: Date.now() + CACHE_TTL_MS });
  return context;
}

/** Populate req.auth, rejecting anything without a valid token. */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!canVerifyTokens) {
    res.status(503).json({
      error: 'auth_unavailable',
      message: 'SUPABASE_URL and SUPABASE_ANON_KEY must be set for the API to verify callers.',
    });
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: 'unauthenticated', message: 'Missing bearer token.' });
    return;
  }

  try {
    const context = await resolveContext(token);
    if (!context) {
      res.status(401).json({ error: 'unauthenticated', message: 'Invalid or expired session.' });
      return;
    }
    req.auth = context;
    next();
  } catch (err) {
    logger.error({ err }, 'authentication failed');
    res.status(500).json({ error: 'auth_error', message: 'Could not verify the session.' });
  }
}

export function hasPermission(auth: AuthContext | undefined, permission: string): boolean {
  if (!auth) return false;
  if (auth.isSuperAdmin) return true;
  return auth.permissions.some((p) => p.permission === permission);
}

/**
 * Gate a route on a permission held at ANY scope.
 *
 * Scope-level filtering of the *rows* a caller sees is applied inside each handler (reports filter
 * by branch), because this service reads through a connection that bypasses RLS.
 */
export function requirePermission(...permissions: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ok = permissions.some((p) => hasPermission(req.auth, p));
    if (!ok) {
      res.status(403).json({
        error: 'forbidden',
        message: `Requires one of: ${permissions.join(', ')}`,
      });
      return;
    }
    next();
  };
}

/**
 * What the caller may see, resolved FAIL-CLOSED.
 *
 * `all: true` only for super admins and global grants. Zone grants are widened to that zone's
 * branches (DB lookup — this service bypasses RLS, so scope must be exact here). Department and
 * self grants deliberately contribute NOTHING: they exist for in-app views where RLS narrows the
 * rows, and a whole-branch export would silently over-grant them. A caller whose grants resolve
 * to nothing gets empty lists — routes must treat that as 403, never as "everything".
 */
export interface VisibleScope {
  all: boolean;
  branchIds: string[];
  entityIds: string[];
}

export async function resolveVisibleScope(
  auth: AuthContext | undefined,
  permissions: string[]
): Promise<VisibleScope> {
  if (!auth) return { all: false, branchIds: [], entityIds: [] };
  if (auth.isSuperAdmin) return { all: true, branchIds: [], entityIds: [] };

  const grants = auth.permissions.filter((p) => permissions.includes(p.permission));
  if (grants.some((g) => g.scope_type === 'global')) return { all: true, branchIds: [], entityIds: [] };

  const branchIds = new Set(
    grants.filter((g) => g.scope_type === 'branch' && g.scope_id).map((g) => g.scope_id!)
  );
  const entityIds = new Set(
    grants.filter((g) => g.scope_type === 'entity' && g.scope_id).map((g) => g.scope_id!)
  );

  const zoneIds = [
    ...new Set(grants.filter((g) => g.scope_type === 'zone' && g.scope_id).map((g) => g.scope_id!)),
  ];
  if (zoneIds.length) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      select id from public.branches where zone_id = any(${zoneIds}::uuid[])`;
    for (const row of rows) branchIds.add(row.id);
  }

  return { all: false, branchIds: [...branchIds], entityIds: [...entityIds] };
}

/** Branches that fall under a set of entities — used to intersect a requested branch filter. */
export async function branchesOfEntities(entityIds: string[]): Promise<string[]> {
  if (!entityIds.length) return [];
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    select id from public.branches where entity_id = any(${entityIds}::uuid[])`;
  return rows.map((r) => r.id);
}

export function clearAuthCache(): void {
  cache.clear();
}
