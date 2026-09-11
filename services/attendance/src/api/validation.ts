import { z } from 'zod';
import { DateTime } from 'luxon';

/** Shape alone accepts impossible dates such as February 31 and silently schedules no work. */
export const dateString = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => DateTime.fromISO(value, { zone: 'utc' }).isValid, 'expected a valid calendar date');

export const branchFilter = z.string().refine(
  (value) => value.split(',').map((id) => id.trim()).filter(Boolean)
    .every((id) => z.string().uuid().safeParse(id).success),
  'expected comma-separated branch UUIDs'
);

export const catchupSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(3) });
