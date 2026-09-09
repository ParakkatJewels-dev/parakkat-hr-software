import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanDbError } from './dbErrors.js';

test('an RLS refusal on a task says what actually went wrong', () => {
  // The reported bug: reassigning a task outside your scope showed the reader this exact string.
  const raw = 'new row violates row-level security policy for table "tasks"';
  assert.equal(humanDbError(raw, 'tasks'), "You can't move that task to somebody outside the part of the organisation you manage.");
  assert.ok(!humanDbError(raw, 'tasks').includes('row-level'));
});

test('an RLS refusal elsewhere is still explained, just less specifically', () => {
  const msg = humanDbError('new row violates row-level security policy for table "leaves"', 'leaves');
  assert.equal(msg, "You don't have permission to make that change.");
});

test('the common constraint failures each get a sentence', () => {
  assert.match(humanDbError('duplicate key value violates unique constraint "x"'), /already exists/i);
  assert.match(humanDbError('insert violates foreign key constraint "y"'), /no longer exists/i);
  assert.match(humanDbError('null value in column "title" violates not-null constraint'), /required field/i);
  assert.match(humanDbError('new row for relation "t" violates check constraint "c"'), /isn't allowed/i);
});

test('an expired session says to sign in, not "invalid claim"', () => {
  assert.match(humanDbError('JWT expired'), /sign in again/i);
});

test('being offline is named as being offline', () => {
  assert.match(humanDbError('TypeError: Failed to fetch'), /connection/i);
});

test('anything unrecognised is passed through, not guessed at', () => {
  // A confident wrong translation sends the reader looking in the wrong place. Better to show the
  // technical string than to invent a friendly one that does not match what happened.
  const odd = 'deadlock detected while updating relation 12345';
  assert.equal(humanDbError(odd), odd);
});

test('an Error object works as well as a string', () => {
  assert.match(humanDbError(new Error('JWT expired')), /sign in again/i);
});

test('no error means no message, so a fresh form shows no banner', () => {
  // Call sites hand this straight to a panel's `error` prop. Returning a string here would paint a
  // failure onto a form the user has not submitted yet.
  assert.equal(humanDbError(null), null);
  assert.equal(humanDbError(undefined), null);
});

test('an error object with no message still says something', () => {
  assert.equal(humanDbError({}), 'Something went wrong.');
  assert.equal(humanDbError(new Error()), 'Something went wrong.');
});
