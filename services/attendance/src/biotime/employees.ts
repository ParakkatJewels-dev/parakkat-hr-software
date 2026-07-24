// Personnel and terminal retrieval from BioTime.
//
// Remember what this data is for: BioTime is the DEVICE layer. These records populate
// biotime_employees and devices — they never create or modify public.employees, whose org data
// (entity/zone/branch/department/designation) comes from the HR rosters and is authoritative.
import { biotime } from './client';
import { parseBiotimeDateTime } from '../lib/time';
import { asBigInt, asString, namedValue, type BiotimeEmployeeRecord, type BiotimeTerminal } from './types';

export const EMPLOYEES_PATH = '/personnel/api/employees/';
export const TERMINALS_PATH = '/iclock/api/terminals/';

export interface NormalizedBiotimeEmployee {
  empCode: string;
  biotimeId: bigint | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  departmentName: string | null;
  areaName: string | null;
  positionName: string | null;
  hireDate: Date | null;
  isActive: boolean;
  raw: Record<string, unknown>;
}

export interface NormalizedDevice {
  serialNumber: string;
  alias: string | null;
  ipAddress: string | null;
  areaName: string | null;
  lastSeenAt: Date | null;
  isActive: boolean;
  raw: Record<string, unknown>;
}

function composeName(first: string | null, last: string | null): string | null {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name || null;
}

export function normalizeEmployee(record: BiotimeEmployeeRecord): NormalizedBiotimeEmployee | null {
  const empCode = asString(record.emp_code);
  if (!empCode) return null;

  const firstName = asString(record.first_name);
  const lastName = asString(record.last_name);

  // BioTime signals "no longer employed" inconsistently across builds; treat any explicit
  // negative as inactive and default to active otherwise.
  const isActive =
    record.is_active === false || record.is_active === 0 || String(record.status ?? '') === '0'
      ? false
      : true;

  const hireDateRaw = asString(record.hire_date);

  return {
    empCode,
    biotimeId: asBigInt(record.id),
    firstName,
    lastName,
    fullName: composeName(firstName, lastName) ?? asString(record.nickname),
    departmentName: namedValue(record.department, 'dept_name', 'name'),
    areaName: namedValue(record.area, 'area_name', 'name'),
    positionName: namedValue(record.position, 'position_name', 'name'),
    // hire_date is a plain date, not a timestamp — parse at local midnight.
    hireDate: hireDateRaw ? parseBiotimeDateTime(`${hireDateRaw} 00:00:00`) : null,
    isActive,
    raw: record as unknown as Record<string, unknown>,
  };
}

export function normalizeTerminal(record: BiotimeTerminal): NormalizedDevice | null {
  const serialNumber = asString(record.sn);
  if (!serialNumber) return null;

  return {
    serialNumber,
    alias: asString(record.alias) ?? asString(record.terminal_name),
    ipAddress: asString(record.ip_address),
    areaName: namedValue(record.area, 'area_name', 'name'),
    lastSeenAt: parseBiotimeDateTime(record.last_activity),
    isActive: String(record.state ?? '1') !== '0',
    raw: record as unknown as Record<string, unknown>,
  };
}

export async function fetchAllEmployees(signal?: AbortSignal): Promise<NormalizedBiotimeEmployee[]> {
  const raw = await biotime.getAll<BiotimeEmployeeRecord>(EMPLOYEES_PATH, {}, { signal });
  return raw.map(normalizeEmployee).filter((e): e is NormalizedBiotimeEmployee => e !== null);
}

export async function fetchAllTerminals(signal?: AbortSignal): Promise<NormalizedDevice[]> {
  // Terminals live at a different path on some builds; a missing endpoint is not fatal because
  // device rows are also created lazily from the terminal_sn on incoming punches.
  try {
    const raw = await biotime.getAll<BiotimeTerminal>(TERMINALS_PATH, {}, { signal });
    return raw.map(normalizeTerminal).filter((d): d is NormalizedDevice => d !== null);
  } catch {
    return [];
  }
}
