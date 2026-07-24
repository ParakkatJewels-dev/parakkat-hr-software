// Recruitment: jobs + candidates. Scoped by recruitment.manage over the job's entity/branch/dept.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('jobs')
        .select('id, title, type, location, status, openings, created_at, entity:entities(code), branch:branches(code), department:departments(name)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useCandidates() {
  return useQuery({
    queryKey: ['candidates'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('candidates')
        .select('id, name, email, stage, match_score, created_at, job:jobs(title)')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useAddJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { error } = await supabase.from('jobs').insert({ ...payload, status: 'Open' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

export function useSetCandidateStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, stage }) => {
      const { error } = await supabase.from('candidates').update({ stage }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
  });
}
