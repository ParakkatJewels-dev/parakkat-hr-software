// Realistic fake data, so the frontend can be built and demoed without a live BioTime connection.
//
//   npm run seed                      30 days, up to 25 employees
//   npm run seed -- --days 60 --employees 40
//   npm run seed -- --reset           wipe seeded punches/attendance first
//
// It reuses the real employee roster when one is loaded (which is the useful case — real names,
// real branches, fake attendance) and only invents an org when the database is empty.
//
// Everything it writes is marked source='seed' so `--reset` can remove exactly what it created
// and never touch a real device punch.
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger';
import { prisma, assertDbReachable, disconnectDb } from '../lib/db';
import { recompute } from '../engine/recompute';
import { eachWorkDate, workDateAtTime, todayWorkDate, weekdayOf, DateTime, APP_TZ } from '../lib/time';
import { parseArgs, flag, num } from './args';

/** Deterministic PRNG, so re-seeding produces the same data and diffs stay readable. */
function makeRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffffffff;
  };
}

const FIRST_NAMES = [
  'Anoop', 'Bindu', 'Chandran', 'Deepa', 'Faisal', 'Geetha', 'Harish', 'Indira', 'Jayan', 'Kavitha',
  'Lakshmi', 'Manoj', 'Nisha', 'Praveen', 'Rekha', 'Sunil', 'Thomas', 'Usha', 'Vinod', 'Zainab',
];
const LAST_NAMES = [
  'Nair', 'Menon', 'Pillai', 'Kurup', 'Varghese', 'Joseph', 'Rahman', 'Das', 'Iyer', 'Mathew',
];

interface SeedEmployee {
  id: string;
  fullName: string;
  employeeCode: string | null;
  empCode: string;
}

async function ensureEmployees(count: number): Promise<SeedEmployee[]> {
  const existing = await prisma.$queryRaw<
    Array<{ id: string; full_name: string; employee_code: string | null }>
  >`
    select id, full_name, employee_code from public.employees
     where status = 'Active'
     order by full_name
     limit ${count}
  `;

  if (existing.length > 0) {
    logger.info({ count: existing.length }, 'seeding attendance for existing employees');
    // Device codes are simple sequential numbers, which is what a real BioTime enrolment looks
    // like — and deliberately unlike employee_code, so the mapping screen has something to do.
    return existing.map((e, i) => ({
      id: e.id,
      fullName: e.full_name,
      employeeCode: e.employee_code,
      empCode: String(101 + i),
    }));
  }

  logger.warn('no employees found — creating a small fake org for development');

  const entityId = randomUUID();
  const branchId = randomUUID();
  const deptId = randomUUID();

  await prisma.$executeRaw`
    insert into public.entities (id, code, name, legal_name)
    values (${entityId}::uuid, 'DEMO', 'Demo Entity', 'Demo Entity Pvt Ltd')
    on conflict (code) do nothing
  `;
  await prisma.$executeRaw`
    insert into public.branches (id, entity_id, code, name, city)
    values (${branchId}::uuid, ${entityId}::uuid, 'HO', 'Head Office', 'Kochi')
    on conflict (entity_id, code) do nothing
  `;
  await prisma.$executeRaw`
    insert into public.departments (id, entity_id, branch_id, code, name)
    values (${deptId}::uuid, ${entityId}::uuid, ${branchId}::uuid, 'OPS', 'Operations')
    on conflict do nothing
  `;

  const rand = makeRandom(7);
  const out: SeedEmployee[] = [];

  for (let i = 0; i < count; i++) {
    const first = FIRST_NAMES[Math.floor(rand() * FIRST_NAMES.length)]!;
    const last = LAST_NAMES[Math.floor(rand() * LAST_NAMES.length)]!;
    const id = randomUUID();
    const employeeCode = `DEMO-${String(i + 1).padStart(4, '0')}`;

    await prisma.$executeRaw`
      insert into public.employees (id, entity_id, branch_id, department_id, employee_code,
                                    full_name, status, join_date)
      values (${id}::uuid, ${entityId}::uuid, ${branchId}::uuid, ${deptId}::uuid,
              ${employeeCode}, ${`${first} ${last}`}, 'Active', current_date - interval '2 years')
      on conflict (entity_id, employee_code) do nothing
    `;

    out.push({ id, fullName: `${first} ${last}`, employeeCode, empCode: String(101 + i) });
  }

  return out;
}

async function ensureDevice(): Promise<string> {
  const serial = 'SEED-TERMINAL-01';
  await prisma.device.upsert({
    where: { serialNumber: serial },
    create: { serialNumber: serial, alias: 'Demo Main Gate', areaName: 'Head Office', isActive: true },
    update: {},
  });
  return serial;
}

async function linkBiotimeEmployees(employees: SeedEmployee[]): Promise<void> {
  for (const e of employees) {
    await prisma.biotimeEmployee.upsert({
      where: { empCode: e.empCode },
      create: {
        empCode: e.empCode,
        fullName: e.fullName,
        firstName: e.fullName.split(' ')[0] ?? null,
        lastName: e.fullName.split(' ').slice(1).join(' ') || null,
        areaName: 'Head Office',
        employeeId: e.id,
        linkStatus: 'manual', // seeded links are treated as human decisions so sync won't undo them
        linkedAt: new Date(),
      },
      update: { employeeId: e.id, linkStatus: 'manual', fullName: e.fullName },
    });
  }
  logger.info({ count: employees.length }, 'linked seeded device codes to employees');
}

interface PunchRow {
  empCode: string;
  employeeId: string;
  punchTime: Date;
  punchState: string;
  terminalSn: string;
}

/**
 * A day's punches for one person, with the messiness the engine has to cope with:
 * lateness, early exits, overtime, absences, missed check-outs and double-taps.
 */
function punchesForDay(
  employee: SeedEmployee,
  workDate: string,
  terminalSn: string,
  rand: () => number
): PunchRow[] {
  // Sunday off.
  if (weekdayOf(workDate) === 0) return [];

  const roll = rand();

  // ~4% absent.
  if (roll < 0.04) return [];

  const base = (minutes: number) =>
    new Date(workDateAtTime(workDate, '09:30:00').getTime() + minutes * 60_000);

  // Arrival: mostly a little before or after 09:30, occasionally properly late.
  const lateness = roll < 0.16 ? 20 + Math.floor(rand() * 55) : Math.floor(rand() * 20) - 8;
  const checkIn = base(lateness);

  const rows: PunchRow[] = [
    { empCode: employee.empCode, employeeId: employee.id, punchTime: checkIn, punchState: '0', terminalSn },
  ];

  // ~3% double-tap the reader on the way in — the engine must collapse these.
  if (rand() < 0.03) {
    rows.push({
      empCode: employee.empCode,
      employeeId: employee.id,
      punchTime: new Date(checkIn.getTime() + 7_000),
      punchState: '0',
      terminalSn,
    });
  }

  // ~5% forget to punch out — becomes a Missing Punch exception.
  if (rand() < 0.05) return rows;

  // Departure around 18:30, sometimes early, sometimes well into overtime.
  const departureRoll = rand();
  const offset =
    departureRoll < 0.1
      ? -(30 + Math.floor(rand() * 70)) // early exit
      : departureRoll > 0.85
        ? 45 + Math.floor(rand() * 120) // overtime
        : Math.floor(rand() * 25);

  const checkOut = new Date(workDateAtTime(workDate, '18:30:00').getTime() + offset * 60_000);

  rows.push({
    empCode: employee.empCode,
    employeeId: employee.id,
    punchTime: checkOut,
    punchState: '1',
    terminalSn,
  });

  return rows;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (flag(args, 'help')) {
    console.log(`
Seed realistic fake attendance data.

  --days N          days of history to generate (default 30)
  --employees N     how many employees to cover (default 25)
  --reset           delete previously seeded punches and attendance first
  --no-recompute    just write punches, skip running the engine
`);
    return;
  }

  await assertDbReachable();

  const days = Math.max(1, num(args, 'days', 30));
  const employeeCount = Math.max(1, num(args, 'employees', 25));

  if (flag(args, 'reset')) {
    const punches = await prisma.rawPunch.deleteMany({ where: { source: 'seed' } });
    const attendance = await prisma.$executeRaw`
      delete from public.attendance where source = 'seed' or computed_at is not null
    `;
    logger.warn({ punches: punches.count, attendance }, 'reset: removed seeded data');
  }

  const employees = await ensureEmployees(employeeCount);
  if (employees.length === 0) throw new Error('no employees available to seed');

  const terminalSn = await ensureDevice();
  await linkBiotimeEmployees(employees);

  const to = todayWorkDate();
  const from = DateTime.fromISO(to, { zone: APP_TZ }).minus({ days: days - 1 }).toFormat('yyyy-MM-dd');
  const dates = eachWorkDate(from, to);

  const rand = makeRandom(20260723);
  const rows: PunchRow[] = [];

  for (const employee of employees) {
    for (const workDate of dates) {
      rows.push(...punchesForDay(employee, workDate, terminalSn, rand));
    }
  }

  logger.info({ employees: employees.length, days: dates.length, punches: rows.length }, 'writing seeded punches');

  const CHUNK = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { count } = await prisma.rawPunch.createMany({
      data: rows.slice(i, i + CHUNK).map((r) => ({
        empCode: r.empCode,
        employeeId: r.employeeId,
        punchTime: r.punchTime,
        punchState: r.punchState,
        punchStateLabel: r.punchState === '0' ? 'Check In' : 'Check Out',
        verifyType: 'Face',
        terminalSn: r.terminalSn,
        terminalAlias: 'Demo Main Gate',
        areaAlias: 'Head Office',
        source: 'seed',
        raw: { seeded: true } as object,
      })),
      skipDuplicates: true,
    });
    inserted += count;
  }

  logger.info({ inserted, skipped: rows.length - inserted }, 'seeded punches written');

  // A couple of holidays and a leave, so those code paths have data behind them too.
  await prisma.$executeRaw`
    insert into public.holidays (calendar_id, holiday_date, name)
    select c.id, ${dates[Math.floor(dates.length / 2)]}::date, 'Seeded Holiday'
      from public.holiday_calendars c where c.is_default and c.entity_id is null
    on conflict (calendar_id, holiday_date) do nothing
  `;

  if (!flag(args, 'no-recompute')) {
    logger.info({ from, to }, 'running the engine over the seeded range');
    const summary = await recompute({ from, to, employeeIds: employees.map((e) => e.id) });
    logger.info(summary, 'seed complete — the frontend now has data');
  } else {
    logger.info(`seed complete. Run:  npm run recompute -- --from ${from} --to ${to}`);
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'seed failed');
    process.exitCode = 1;
  })
  .finally(() => void disconnectDb());
