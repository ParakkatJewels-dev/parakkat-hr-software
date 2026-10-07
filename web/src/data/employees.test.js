import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const loader = registerHooks({ resolve(specifier, context, next) {
  const source = specifier === '@tanstack/react-query'
    ? 'export const useQuery=x=>x; export const useMutation=x=>x; export const useQueryClient=()=>globalThis.employeeCreateClient;'
    : specifier === '../lib/supabaseClient'
      ? 'export const supabase = { from: (...args) => globalThis.employeeCreateDb.from(...args), rpc: (...args) => globalThis.employeeCreateDb.rpc(...args) };'
      : specifier === '../lib/fetchCollection' ? 'export const fetchCollection = () => [];' : null;
  return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
} });
const { useCreateEmployee, useUpdateEmployee } = await import('./employees.js');
const calls = [], invalidations = [];
let createError, loginError;
const payload = { full_name: 'New employee', entity_id: 'company', branch_id: 'branch', join_date: '2026-10-07', shift_id: 'night', email: '' };
beforeEach(() => {
  calls.length = 0; invalidations.length = 0; createError = null; loginError = null;
  globalThis.employeeCreateClient = { invalidateQueries: ({ queryKey }) => { invalidations.push(queryKey[0]); } };
  globalThis.employeeCreateDb = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      return name === 'create_employee_with_shift' ? { data: { id: 'employee', full_name: 'New employee', employee_code: 'E1' }, error: createError }
        : { data: { created: true, user_id: 'user' }, error: loginError };
    },
    from: table => ({ update: patch => ({ eq: (key, value) => ({ select: () => ({ single: async () => {
      calls.push({ table, patch, key, value }); return { data: { id: value }, error: null };
    } }) }) }) }),
  };
});
after(() => { loader.deregister(); delete globalThis.employeeCreateDb; delete globalThis.employeeCreateClient; });

test('new employee and chosen initial shift use one atomic create RPC before login provisioning', async () => {
  const mutation = useCreateEmployee();
  const result = await mutation.mutationFn({ ...payload, id: 'forged', user_id: 'forged', initial_shift_id: 'forged' });
  assert.deepEqual(calls[0], { name: 'create_employee_with_shift', args: { _employee: {
    full_name: 'New employee', email: null, join_date: '2026-10-07', entity_id: 'company', branch_id: 'branch',
  }, _shift_id: 'night' } });
  assert.deepEqual(calls[1], { name: 'provision_employee_login', args: { _employee_id: 'employee' } });
  assert.equal(result.id, 'employee');
  await mutation.onSuccess();
  for (const key of ['employees', 'shift-assignments', 'attendance', 'payroll-attendance-summary', 'payroll-worksheet-run']) assert.ok(invalidations.includes(key));
});

test('missing shift or joining date never creates a partial employee', async () => {
  await assert.rejects(useCreateEmployee().mutationFn({ ...payload, shift_id: '' }), /initial shift/);
  await assert.rejects(useCreateEmployee().mutationFn({ ...payload, join_date: '' }), /joining date/);
  assert.equal(calls.length, 0);
});

test('assignment rejection or missing migration never falls back to an employee-only save', async () => {
  createError = { code: '23514', message: 'Shift belongs to another company.' };
  await assert.rejects(useCreateEmployee().mutationFn(payload), error => error === createError);
  assert.equal(calls.length, 1);
  createError = { code: 'PGRST202', message: 'RPC not found' };
  await assert.rejects(useCreateEmployee().mutationFn(payload), /migration 0165/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.name === 'create_employee_with_shift'));
});

test('login creation remains optional and a login failure keeps the already-created employee and shift', async () => {
  const noLogin = await useCreateEmployee().mutationFn({ ...payload, provisionLogin: false });
  assert.equal(calls.length, 1);
  assert.equal(noLogin.login, null);
  loginError = { message: 'Login provisioning unavailable' };
  const result = await useCreateEmployee().mutationFn(payload);
  assert.equal(result.id, 'employee');
  assert.equal(result.loginError, 'Login provisioning unavailable');
});

test('ordinary employee edits cannot change initial shift provenance or assignments', async () => {
  await useUpdateEmployee().mutationFn({ id: 'existing', full_name: 'Updated name', shift_id: 'night', initial_shift_id: 'night' });
  assert.deepEqual(calls, [{ table: 'employees', patch: { full_name: 'Updated name' }, key: 'id', value: 'existing' }]);
});
