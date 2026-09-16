// QA only: executes the real frontend mutation with an in-memory Supabase capture.
// Run: node docs/qa/2026-09-16/night-regularization-repro.mjs
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';

const stubs = {
  '@tanstack/react-query': `export const useQuery = x => x; export const useMutation = x => x;
    export const useQueryClient = () => ({ invalidateQueries() {} });`,
  supabaseClient: `export const supabase = { from: table => ({ insert: async payload => {
    globalThis.qaCapturedRegularization = { table, payload }; return { error: null };
  } }) };`,
  fetchCollection: `export const fetchCollection = () => { throw new Error('Not used in this QA reproduction'); };`,
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.js$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    return next(specifier, context);
  },
});
const { useCreateRegularization } = await import('../../../web/src/data/regularizations.js');
const rows = [];
for (const [label, checkIn, checkOut, expectedOut] of [
  ['CONTROL: same-day correction', '09:00', '17:30', '2026-07-15T12:00:00.000Z'],
  ['ATT-05: overnight correction', '22:00', '06:00', '2026-07-16T00:30:00.000Z'],
]) {
  await useCreateRegularization().mutationFn({ employeeId: 'qa-employee', workDate: '2026-07-15',
    checkIn, checkOut, reason: 'QA only; never transmitted' });
  const payload = globalThis.qaCapturedRegularization.payload;
  const passesDatabaseOrderConstraint = new Date(payload.check_out) > new Date(payload.check_in);
  let pass = true;
  try { assert.equal(payload.check_out, expectedOut); assert.ok(passesDatabaseOrderConstraint); }
  catch { pass = false; }
  rows.push({ label, pass, expectedOut, actual: payload, passesDatabaseOrderConstraint });
}
console.log(JSON.stringify({ checks: rows.length, pass: rows.filter(r => r.pass).length,
  fail: rows.filter(r => !r.pass).length, results: rows }, null, 2));
process.exitCode = rows.some(r => !r.pass) ? 1 : 0;
