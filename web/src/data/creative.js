// Creative extras (0174): campaigns, ideas and the library, shared by the creative team. A super
// admin chooses which departments are the creative team; the database decides who is a member and
// enforces it on every table, so these hooks simply read and write. Deletes are soft.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { importBatches, IMPORT_ORDER } from '../lib/ledger/importWorkbook.js';

export const creativeKeys = {
  root: ['creative'],
  settings: () => ['creative', 'settings'],
  home: () => ['creative', 'home'],
  campaigns: () => ['creative', 'campaigns'],
  campaign: (id) => ['creative', 'campaign', id],
  ideas: () => ['creative', 'ideas'],
  library: () => ['creative', 'library'],
};
// A campaign or vendor change can show on task cards and reports too.
const AFFECTED = [['creative'], ['work']];

export const newId = () => globalThis.crypto.randomUUID();
export const CAMPAIGN_STAGES = ['Captured', 'Developing', 'Decision', 'Approved', 'Production', 'Live', 'Reviewed'];
export const OFF_STAGES = ['Parked', 'Cancelled'];

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  return data;
}

function useCreativeQuery(key, name, args, { enabled = true, persist = true } = {}) {
  const { user } = useAuth();
  return useQuery({ queryKey: key, enabled: Boolean(user?.id && enabled), ...(persist ? {} : { meta: { persist: false } }),
    queryFn: () => rpc(name, args) });
}

/** Whether I am on the creative team, whether I may choose it, and which departments it is. */
export const useCreativeSettings = () => useCreativeQuery(creativeKeys.settings(), 'creative_settings', undefined);
export const useCreativeHome = ({ enabled = true } = {}) => useCreativeQuery(creativeKeys.home(), 'creative_home', undefined, { enabled });
export const useCreativeCampaigns = () => useCreativeQuery(creativeKeys.campaigns(), 'creative_campaigns', undefined);
export const useCreativeCampaign = (id) => useCreativeQuery(creativeKeys.campaign(id), 'creative_campaign', { _id: id }, { enabled: Boolean(id), persist: false });
export const useCreativeIdeas = () => useCreativeQuery(creativeKeys.ideas(), 'creative_ideas', undefined);
export const useCreativeLibrary = ({ enabled = true } = {}) => useCreativeQuery(creativeKeys.library(), 'creative_library', undefined, { enabled });
export const fetchCampaignDetails = () => rpc('creative_campaign_details');
export const fetchCampaigns = () => rpc('creative_campaigns');

// Library rows as the screens name them → the table's own columns.
const LIBRARY = {
  vendor: { table: 'creative_vendors', columns: { name: 'name', role: 'role', phone: 'phone', email: 'email', rate: 'rate', rating: 'rating', notes: 'notes', last_worked: 'last_worked' } },
  template: { table: 'creative_templates', columns: { name: 'name', type: 'work_type', subtasks: 'subtasks' } },
  key_date: { table: 'creative_key_dates', columns: { name: 'name', date: 'on_date', brand: 'brand', lead_days: 'lead_days', notes: 'notes' } },
};
const CAMPAIGN_FIELDS = ['name', 'brand', 'launch_date', 'brief_link', 'notes', 'stage', 'priority', 'objective', 'next_action', 'milestone',
  'milestone_date', 'blocker', 'decision', 'budget', 'brief', 'measure', 'results'];
const IDEA_FIELDS = ['text', 'brand', 'tags', 'links', 'status', 'revisit_date', 'revisit_when', 'concept', 'task_id'];
const pick = (source, fields) => Object.fromEntries(fields.filter((field) => field in source).map((field) => [field, source[field]]));
export const tagList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(/[,#]/)).map((tag) => tag.trim()).filter(Boolean);

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}
async function changeOne(table, id, patch) {
  const rows = await run(supabase.from(table).update(patch).eq('id', id).select('id'));
  if (!rows?.length) throw new Error('This could not be changed. It may have been removed, or you are no longer on the creative team.');
  return rows[0];
}

/** Every creative write: one mutation, one refresh. */
export function useCreativeWrite() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ op, id, ...input }) => {
      const now = new Date().toISOString();
      switch (op) {
        case 'add-campaign':
          return run(supabase.from('creative_campaigns').insert({ id: id ?? newId(), ...pick(input, CAMPAIGN_FIELDS) }).select('id').single());
        case 'campaign':
          return changeOne('creative_campaigns', id, pick(input, CAMPAIGN_FIELDS));
        case 'remove-campaign':
          return changeOne('creative_campaigns', id, { deleted_at: now });
        case 'campaign-note':
          return rpc('creative_campaign_note', { _campaign: id, _text: input.text });
        case 'add-idea':
          return run(supabase.from('creative_ideas').insert({ id: id ?? newId(), text: input.text, brand: input.brand || null,
            tags: tagList(input.tags) }).select('id').single());
        case 'idea':
          return changeOne('creative_ideas', id, { ...pick(input, IDEA_FIELDS), ...('tags' in input ? { tags: tagList(input.tags) } : {}) });
        case 'remove-idea':
          return changeOne('creative_ideas', id, { deleted_at: now });
        case 'idea-to-campaign':
          return rpc('creative_idea_to_campaign', { _idea: id, _campaign: newId() });
        case 'library': {
          const spec = LIBRARY[input.kind];
          const row = Object.fromEntries(Object.entries(input.values).filter(([key]) => key in spec.columns).map(([key, value]) => [spec.columns[key], value]));
          return id ? changeOne(spec.table, id, row) : run(supabase.from(spec.table).insert({ id: newId(), ...row }).select('id').single());
        }
        case 'remove-library':
          return changeOne(LIBRARY[input.kind].table, id, { deleted_at: now });
        case 'brand':
          return changeOne('creative_brands', id, pick(input, ['short_label', 'foundation']));
        case 'refresh-dates':
          return rpc('creative_refresh_key_dates');
        case 'departments':
          return rpc('set_creative_departments', { _departments: input.departments });
        default:
          throw new Error(`Unknown change: ${op}`);
      }
    },
    onSettled: () => Promise.all(AFFECTED.map((queryKey) => client.invalidateQueries({ queryKey }))),
  });
}

/** Before importing the old Sheet: how many of these rows are already here, and which were changed here since. */
export const previewWorkImport = (kind, legacyRows) => rpc('work_import_preview', { _kind: kind, _legacy_rows: legacyRows });

/**
 * Sends the parsed Sheet in dependency order and small batches (0175), calling onProgress after each.
 * Stops on the first server error; running it again continues safely, because every row is matched
 * on its Sheet row and rows changed here since are left alone.
 */
export async function runWorkImport(kinds, { onProgress } = {}) {
  const plan = IMPORT_ORDER.flatMap((kind) => importBatches(kinds[kind] ?? []).map((rows) => ({ kind, rows })));
  const total = plan.reduce((sum, step) => sum + step.rows.length, 0);
  const totals = {};
  let sent = 0;
  for (const step of plan) {
    const result = await rpc('work_import_batch', { _kind: step.kind, _rows: step.rows });
    const current = totals[step.kind] ?? { received: 0, inserted: 0, updated: 0, kept: [], unresolved: [] };
    current.received += result?.received ?? step.rows.length;
    current.inserted += result?.inserted ?? 0;
    current.updated += result?.updated ?? 0;
    current.kept.push(...(result?.kept_rows ?? []));
    current.unresolved.push(...(result?.unresolved_rows ?? []));
    totals[step.kind] = current;
    sent += step.rows.length;
    onProgress?.({ sent, total, kind: step.kind });
  }
  return totals;
}

/** After an import everything may have changed: tasks, counts, Home, the creative screens. */
export function useRefreshAfterImport() {
  const client = useQueryClient();
  return () => Promise.all([['work'], ['creative'], ['tasks'], ['section-counts']].map((queryKey) => client.invalidateQueries({ queryKey })));
}
