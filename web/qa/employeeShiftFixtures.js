// Explicit local preview data for employee onboarding; no writes or real schedules.
import { fixture, tables } from './fixtures.js';
if (typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('qa-employee-shifts')) {
  tables.shifts = fixture.org.entities.flatMap(entity => [
    { id: `qa-day-${entity.id}`, entity_id: entity.id, entity, code: `DAY-${entity.code}`, name: 'Day shift',
      start_time: '09:00:00', end_time: '17:30:00', crosses_midnight: false, full_day_minutes: 510,
      is_active: true, is_default: true, break_policy: 'excess', break_minutes: 40, break_windows: [], weekly_offs: [0] },
    { id: `qa-night-${entity.id}`, entity_id: entity.id, entity, code: `NIGHT-${entity.code}`, name: 'Night shift',
      start_time: '22:00:00', end_time: '07:00:00', crosses_midnight: true, full_day_minutes: 480,
      is_active: true, is_default: false, break_policy: 'scheduled', break_minutes: 0,
      break_windows: [{ label: 'Meal', start_time: '02:00:00', end_time: '03:00:00', is_paid: false }], weekly_offs: [0] },
  ]);
}
