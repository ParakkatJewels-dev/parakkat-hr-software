// Holiday calendars and the holidays inside them.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useHolidayCalendars() {
  return useQuery({
    queryKey: ['holiday-calendars'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('holiday_calendars')
        .select('id, entity_id, code, name, is_default, is_active, entity:entities(id, code, name)')
        .order('name');
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useHolidays(calendarId, year) {
  return useQuery({
    queryKey: ['holidays', calendarId ?? 'all', year],
    queryFn: async () => {
      let query = supabase
        .from('holidays')
        .select('id, calendar_id, holiday_date, name, is_optional, calendar:holiday_calendars(id, name)')
        .order('holiday_date');

      if (calendarId) query = query.eq('calendar_id', calendarId);
      if (year) query = query.gte('holiday_date', `${year}-01-01`).lte('holiday_date', `${year}-12-31`);

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useSaveHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (holiday) => {
      const payload = {
        calendar_id: holiday.calendar_id,
        holiday_date: holiday.holiday_date,
        name: holiday.name,
        is_optional: Boolean(holiday.is_optional),
      };

      const query = holiday.id
        ? supabase.from('holidays').update(payload).eq('id', holiday.id)
        : supabase.from('holidays').insert(payload);

      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holidays'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id) => {
      const { error } = await supabase.from('holidays').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['holidays'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
  });
}

export function useSaveCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (calendar) => {
      const payload = {
        entity_id: calendar.entity_id || null,
        code: calendar.code,
        name: calendar.name,
        is_default: Boolean(calendar.is_default),
        is_active: calendar.is_active !== false,
      };

      const query = calendar.id
        ? supabase.from('holiday_calendars').update(payload).eq('id', calendar.id)
        : supabase.from('holiday_calendars').insert(payload);

      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holiday-calendars'] }),
  });
}
