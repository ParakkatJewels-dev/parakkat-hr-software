import test from 'node:test';
import assert from 'node:assert/strict';
import { isMissingSchema, withSchemaFallback } from './pendingMigration.js';

test('the schema-behind errors are recognised, by code and by wording', () => {
  assert.equal(isMissingSchema({ code: '42703' }), true, 'undefined_column');
  assert.equal(isMissingSchema({ code: '42P01' }), true, 'undefined_table');
  assert.equal(isMissingSchema({ code: 'PGRST204' }), true, 'PostgREST schema cache');
  assert.equal(isMissingSchema({ message: 'column task_comments.parent_id does not exist' }), true);
  assert.equal(isMissingSchema({ message: "Could not find the 'parent_id' column of 'task_comments' in the schema cache" }), true);
});

test('a real failure is NOT mistaken for a pending migration', () => {
  // The whole point: swallowing these would hide a permission bug behind a shrug.
  assert.equal(isMissingSchema({ code: '42501', message: 'violates row-level security policy' }), false);
  assert.equal(isMissingSchema({ message: 'Failed to fetch' }), false);
  assert.equal(isMissingSchema({ code: '23503', message: 'violates foreign key constraint' }), false);
  assert.equal(isMissingSchema(null), false);
  assert.equal(isMissingSchema(undefined), false);
});

test('the attempt is used when it succeeds, and the fallback never runs', async () => {
  let fallbackRan = false;
  const out = await withSchemaFallback(
    async () => 'new shape',
    async () => { fallbackRan = true; return 'old shape'; }
  );
  assert.equal(out, 'new shape');
  assert.equal(fallbackRan, false);
});

test('a missing column falls back to the old shape', async () => {
  const out = await withSchemaFallback(
    async () => { throw { code: '42703', message: 'column parent_id does not exist' }; },
    async () => 'old shape'
  );
  assert.equal(out, 'old shape');
});

test('any other error is rethrown untouched, not swallowed', async () => {
  await assert.rejects(
    withSchemaFallback(
      async () => { throw { code: '42501', message: 'violates row-level security policy' }; },
      async () => 'old shape'
    ),
    (e) => e.code === '42501'
  );
});

test('a failure inside the fallback surfaces as itself', async () => {
  await assert.rejects(
    withSchemaFallback(
      async () => { throw { code: '42703' }; },
      async () => { throw new Error('the old shape failed too'); }
    ),
    /the old shape failed too/
  );
});
