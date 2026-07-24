// Shapes returned by the BioTime REST API.
//
// These are intentionally loose (most fields optional, ids accepted as string | number). BioTime
// builds differ in what they include and how they type it — some return `punch_state: "0"`, others
// `0`; older builds wrap the page in `data`, newer ones in `results`. Being strict here would mean
// the worker crashing on a BioTime upgrade rather than degrading gracefully.

export type Numeric = number | string;

/** Both page envelopes BioTime is known to use. */
export interface BiotimePage<T> {
  count?: number;
  next?: string | null;
  previous?: string | null;
  data?: T[];
  results?: T[];
  msg?: string;
  code?: number;
}

export interface BiotimeTransaction {
  id?: Numeric;
  emp_code?: Numeric;
  first_name?: string | null;
  last_name?: string | null;
  department?: string | null;
  position?: string | null;
  /** Naive local datetime, e.g. "2026-07-23 09:15:32". */
  punch_time?: string;
  /** "0" check in, "1" check out, "2"/"3" break, "4"/"5" overtime. */
  punch_state?: Numeric | null;
  punch_state_display?: string | null;
  verify_type?: Numeric | null;
  verify_type_display?: string | null;
  work_code?: string | null;
  gps_location?: string | null;
  area_alias?: string | null;
  terminal_sn?: string | null;
  terminal_alias?: string | null;
  temperature?: Numeric | null;
  is_mask?: Numeric | null;
  upload_time?: string | null;
}

export interface BiotimeNamed {
  id?: Numeric;
  [key: string]: unknown;
}

export interface BiotimeEmployeeRecord {
  id?: Numeric;
  emp_code?: Numeric;
  first_name?: string | null;
  last_name?: string | null;
  nickname?: string | null;
  /** Object on most builds, a bare string on some. */
  department?: BiotimeNamed | string | null;
  position?: BiotimeNamed | string | null;
  /** Usually an array; occasionally a single object. */
  area?: BiotimeNamed[] | BiotimeNamed | null;
  hire_date?: string | null;
  gender?: string | null;
  mobile?: string | null;
  email?: string | null;
  enable_attendance?: boolean | number | null;
  is_active?: boolean | number | null;
  /** 0 = resigned on some builds. */
  status?: Numeric | null;
}

export interface BiotimeTerminal {
  id?: Numeric;
  sn?: string | null;
  alias?: string | null;
  ip_address?: string | null;
  area?: BiotimeNamed | string | null;
  last_activity?: string | null;
  /** 1 = online. */
  state?: Numeric | null;
  terminal_name?: string | null;
}

/** How the server wanted us to authenticate. Cached after the first successful login. */
export type AuthMode = 'token' | 'jwt';

export interface AuthResult {
  mode: AuthMode;
  token: string;
  obtainedAt: Date;
}

// --- helpers for the loose shapes above -------------------------------------

export function pageItems<T>(page: BiotimePage<T> | undefined | null): T[] {
  if (!page) return [];
  if (Array.isArray(page.data)) return page.data;
  if (Array.isArray(page.results)) return page.results;
  return [];
}

export function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

export function asBigInt(v: unknown): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  try {
    const n = typeof v === 'number' ? Math.trunc(v) : Number(String(v).trim());
    if (!Number.isFinite(n)) return null;
    return BigInt(n);
  } catch {
    return null;
  }
}

/** Pull a display name out of `department` / `position` / `area`, whatever shape it arrived in. */
export function namedValue(v: BiotimeNamed | BiotimeNamed[] | string | null | undefined, ...keys: string[]): string | null {
  if (!v) return null;
  if (typeof v === 'string') return asString(v);
  if (Array.isArray(v)) return v.length ? namedValue(v[0], ...keys) : null;
  for (const key of keys) {
    const hit = asString(v[key]);
    if (hit) return hit;
  }
  return null;
}
