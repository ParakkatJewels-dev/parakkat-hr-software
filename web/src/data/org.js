// Data-access hooks for the org hierarchy (entities -> zones -> branches -> departments -> designations).
// The hierarchy is small, so we load all five tables in one query and shape the tree client-side.
// RLS enforces who can read/write; these hooks just talk to Supabase.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { supabase } from '../lib/supabaseClient';

const ORG_TABLES = ['entities', 'zones', 'branches', 'departments', 'designations'];

/**
 * The whole hierarchy, including anything switched off.
 *
 * Only the Structure screen wants this — it is where an inactive branch is edited or switched back
 * on, so hiding them there would make them unreachable.
 */
export function useOrgAll() {
  return useQuery({
    queryKey: ['org', 'all'],
    queryFn: async () => {
      // 50+ branches today; the limit is explicit so a silent PostgREST truncation at 1000 can
      // never quietly drop branches out of every placement dropdown in the app.
      const results = await Promise.all(ORG_TABLES.map((t) => supabase.from(t).select('*').limit(2000)));
      const out = {};
      results.forEach((res, i) => {
        if (res.error) throw res.error;
        out[ORG_TABLES[i]] = res.data ?? [];
      });
      return out; // { entities, zones, branches, departments, designations }
    },
  });
}

/**
 * The hierarchy as everything else should see it: active rows only.
 *
 * The roster was imported from a spreadsheet covering the whole group — 48 branches across four
 * companies — while exactly one terminal is connected, at one site. So every placement dropdown and
 * every filter offered 48 choices of which 46 hold nobody, and a branch filter that can only ever
 * return an empty list is worse than no filter.
 *
 * Switching a branch off hides it from those lists without destroying it. The codes are real shops
 * — ALP, ALU, BLR, KNR, KTM, PKD, TCR — and Easy Time Pro has no branch concept at all, so nothing
 * could ever rebuild them. When a terminal is installed at one of those sites, switch it back on.
 *
 * Filtered here rather than in the query because not every table in the hierarchy carries the
 * column, and `is_active === undefined` must mean "keep" rather than "drop".
 */
export function useOrg() {
  const all = useOrgAll();
  const data = useMemo(() => {
    if (!all.data) return all.data;
    const out = {};
    for (const [table, rows] of Object.entries(all.data)) {
      out[table] = rows.filter((r) => r.is_active !== false);
    }
    return out;
  }, [all.data]);

  return { ...all, data };
}

// Single mutation covering insert / update / toggle-active for any org table.
// Usage: mutate({ table: 'branches', op: 'update', row: { id, zone_id } })
/**
 * Create a company together with its branches and departments in one action.
 *
 * The database forces the order — branches.entity_id is NOT NULL, so a branch cannot exist before
 * its company — which made first-time setup a scavenger hunt: create the company, find it, add a
 * branch, add another, then start on departments. This collapses that into one submit.
 *
 * PostgREST gives us no transaction across separate calls, so a later step can fail after an
 * earlier one succeeded. Rather than pretend otherwise, the error says exactly what did get
 * created so nobody re-runs the whole thing and ends up with a duplicate company.
 */
export function useQuickSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ company, branches = [], departments = [] }) => {
      const { data: entity, error: entityErr } = await supabase
        .from('entities').insert(company).select().single();
      if (entityErr) throw entityErr;

      const made = { entity, branches: [], departments: [] };

      if (branches.length) {
        const { data, error } = await supabase
          .from('branches')
          .insert(branches.map((b) => ({ ...b, entity_id: entity.id })))
          .select();
        if (error) {
          throw new Error(
            `“${entity.name}” was created, but its branches were not: ${error.message}. ` +
            `Add them from the Branches section rather than starting over.`
          );
        }
        made.branches = data ?? [];
      }

      if (departments.length) {
        // A department can name a branch from the same form. The branches did not exist when the
        // form was filled in, so they are referenced by their (unique) code and resolved to real
        // ids here — otherwise every department created during setup landed with no branch.
        const branchIdByCode = new Map(made.branches.map((b) => [b.code, b.id]));
        const { data, error } = await supabase
          .from('departments')
          .insert(
            departments.map(({ branchCode, ...d }) => ({
              ...d,
              entity_id: entity.id,
              branch_id: branchCode ? branchIdByCode.get(branchCode) ?? null : null,
            }))
          )
          .select();
        if (error) {
          throw new Error(
            `“${entity.name}” and its branches were created, but the departments were not: ` +
            `${error.message}. Add them from the Departments section.`
          );
        }
        made.departments = data ?? [];
      }

      return made;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });
}

/**
 * Postgres refusals, said in words somebody can act on.
 *
 * employees.branch_id is ON DELETE NO ACTION, so deleting a branch that still has people in it
 * fails — correctly, since the alternative would be losing employee records. But the raw message
 * is 'update or delete on table "branches" violates foreign key constraint
 * "employees_branch_id_fkey" on table "employees"', which tells an HR manager nothing about what
 * to do next.
 */
function friendlyOrgError(error, table, op) {
  const raw = error.message || String(error);
  const noun = { branches: 'branch', departments: 'department', designations: 'designation', zones: 'zone', entities: 'company' }[table] ?? 'record';

  if (op === 'delete' && /foreign key constraint/i.test(raw)) {
    // The message names TWO tables — 'update or delete on table "branches" violates ... on table
    // "employees"'. The one that matters is the second: the table still pointing at this row.
    const mentioned = [...raw.matchAll(/on table "(\w+)"/g)].map((m) => m[1]);
    const child = mentioned[mentioned.length - 1];
    const who = {
      employees: 'people', salary_structures: 'salary structures', goals: 'goals',
      devices: 'attendance devices', payslips: 'payslips',
    }[child] ?? `${child ?? 'other'} records`;
    if (noun === 'company') {
      return `This company still has ${who} assigned to it, so it cannot be deleted. ` +
        `Move them to another company first. (That refusal is what stops a company delete ` +
        `taking employee records with it.)`;
    }
    return `This ${noun} still has ${who} attached, so it cannot be deleted. ` +
      `Move them somewhere else first — or use Deactivate, which hides it from new assignments ` +
      `while keeping the history intact.`;
  }
  if (/duplicate key/i.test(raw) && /code/i.test(raw)) {
    return `Another ${noun} in this company already uses that code. Codes have to be unique.`;
  }
  if (/row-level security/i.test(raw)) {
    return `You do not have permission to change this ${noun}.`;
  }
  return raw;
}

export function useOrgMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ table, op, row }) => {
      let query;
      if (op === 'insert') {
        query = supabase.from(table).insert(row).select().single();
      } else if (op === 'update') {
        const { id, ...rest } = row;
        query = supabase.from(table).update(rest).eq('id', id).select().single();
      } else if (op === 'delete') {
        query = supabase.from(table).delete().eq('id', row.id);
      } else {
        throw new Error(`Unknown org op: ${op}`);
      }
      const { data, error } = await query;
      if (error) throw new Error(friendlyOrgError(error, table, op));
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org'] }),
  });
}
