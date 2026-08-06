// Data-access hooks for employees. RLS scopes the rows automatically to what the caller may see
// (super admin = all; branch HR = their branch; employee = just themselves). Writes require
// employee.create / employee.update at the row's scope; entity/zone ancestry is stamped by a DB
// trigger from the chosen branch/department.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabaseClient';

export function useEmployees({ enabled = true } = {}) {
  return useQuery({
    enabled,
    queryKey: ['employees'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select(
          `id, full_name, employee_code, status, email, phone, join_date, salary, user_id,
           entity_id, zone_id, branch_id, department_id, designation_id,
           date_of_birth, gender, father_name, mother_name, personal_email, address, blood_group,
           pan, aadhaar, uan, pf_number, esi_number,
           bank_name, bank_account, bank_ifsc, account_holder,
           emergency_name, emergency_phone, emergency_relation,
           entity:entities(code,name),
           branch:branches(code,name),
           department:departments(name),
           designation:designations(title,grade)`
        )
        .order('full_name', { ascending: true })
        // Explicit, so the ceiling is visible here rather than PostgREST's silent 1000-row default.
        .limit(5000);
      if (error) throw error;
      return data ?? [];
    },
  });
}

// Fields an admin may set. entity_id is required (NOT NULL); branch/department/designation optional.
// An allow-list, so a stray form key can never reach the table. Grouped the way the form asks
// for them (migration 0047 added everything below "placement").
const EMPLOYEE_COLS = [
  'full_name', 'employee_code', 'email', 'phone', 'join_date', 'status',
  'entity_id', 'branch_id', 'department_id', 'designation_id',
  // identity
  'date_of_birth', 'gender', 'father_name', 'mother_name', 'personal_email', 'address', 'blood_group',
  // statutory — needed before anyone can be paid or filed for
  'pan', 'aadhaar', 'uan', 'pf_number', 'esi_number',
  // how they get paid
  'bank_name', 'bank_account', 'bank_ifsc', 'account_holder',
  // who to call
  'emergency_name', 'emergency_phone', 'emergency_relation',
];

function cleanEmployeePayload(input) {
  const row = {};
  for (const k of EMPLOYEE_COLS) {
    if (k in input) row[k] = input[k] === '' ? null : input[k];
  }
  return row;
}

/**
 * What the format guards from migration 0047 mean, in words HR can act on.
 *
 * Those checks are the reason a save comes back 400: Postgres is correctly refusing a PAN or an
 * IFSC that cannot be real. What it says while refusing is
 * `violates check constraint "employees_pan_format"`, which names the rule and not the fix. The
 * person looking at the screen typed a PAN and needs to be told the PAN is wrong.
 */
const EMPLOYEE_CONSTRAINT_MESSAGES = {
  employees_pan_format:
    'PAN looks wrong. It is five letters, four digits, then one letter — like AAAPZ1234C.',
  employees_ifsc_format:
    'IFSC looks wrong. It is four letters, then a zero, then six letters or digits — like SBIN0001234.',
  employees_aadhaar_format: 'Aadhaar must be exactly 12 digits.',
  employees_uan_format: 'UAN must be exactly 12 digits. A PF number is a different thing and goes in its own field.',
  employees_gender_values: 'Gender must be Male, Female or Other.',
  employees_dob_sane:
    'Date of birth is out of range — it has to put this person between 14 and 100 years old. Check the year.',
};

/** Postgres error -> something worth showing. Anything unrecognised is passed through untouched. */
function describeEmployeeError(error) {
  if (!error) return error;
  const haystack = `${error.message ?? ''} ${error.details ?? ''} ${error.hint ?? ''}`;
  const hit = Object.keys(EMPLOYEE_CONSTRAINT_MESSAGES).find((name) => haystack.includes(name));
  if (hit) return new Error(EMPLOYEE_CONSTRAINT_MESSAGES[hit]);
  // 23502 is NOT NULL. The only required column the form can leave empty is the company.
  if (error.code === '23502') {
    return new Error('A required field is empty. Every person needs at least a name and a company.');
  }
  return error;
}

export function useCreateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { data, error } = await supabase
        .from('employees')
        .insert(cleanEmployeePayload(payload))
        .select('id, full_name, employee_code')
        .single();
      if (error) throw describeEmployeeError(error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export function useUpdateEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...patch }) => {
      const { data, error } = await supabase
        .from('employees')
        .update(cleanEmployeePayload(patch))
        .eq('id', id)
        .select('id')
        .single();
      if (error) throw describeEmployeeError(error);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}
