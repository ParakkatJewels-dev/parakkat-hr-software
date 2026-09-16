// Recruitment: jobs + candidates. Scoped by recruitment.manage over the job's entity/branch/dept.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';
import { fetchCollection } from '../lib/fetchCollection';

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => fetchCollection(() => supabase
        .from('jobs')
        .select('id, title, type, location, status, openings, created_at, entity_id, entity:entities(code), branch:branches(code), department:departments(name)')
        .order('created_at', { ascending: false }).order('id')),
  });
}

export function useCandidates() {
  return useQuery({
    queryKey: ['candidates'],
    queryFn: () => fetchCollection(() => supabase
        .from('candidates')
        .select('id, name, email, stage, match_score, created_at, job:jobs(title, entity_id, entity:entities(code))')
        .order('created_at', { ascending: false }).order('id')),
  });
}

export function useAddJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const title = String(payload.title ?? '').trim();
      if (!title) throw new Error('Enter a job title.');
      const { error } = await supabase.from('jobs').insert({ ...payload, title, status: 'Open' });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

export function useSetCandidateStage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, stage }) => {
      const { data, error } = await supabase.from('candidates').update({ stage }).eq('id', id).select('id');
      if (error) throw error;
      // A stale permission or deleted candidate can make RLS update zero rows without an error.
      if (!data?.length) throw new Error('This candidate is no longer available to update. Refresh the list and check your access.');
      return data[0];
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['candidates'] }),
  });
}
