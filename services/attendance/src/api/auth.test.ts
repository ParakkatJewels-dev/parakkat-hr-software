import { before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

let auth: typeof import('./auth');
const verifiedTokens: string[] = [];
const validTokens = new Set<string>();

before(async () => {
  mock.module(require.resolve('../config/env'), {
    namedExports: { env: { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'fixture' }, canVerifyTokens: true },
  });
  mock.module(require.resolve('../lib/db'), { namedExports: { prisma: {} } });
  mock.module(require.resolve('../lib/logger'), {
    namedExports: { logger: { warn() {}, error() {} } },
  });
  mock.module(require.resolve('@supabase/supabase-js'), {
    namedExports: {
      createClient: (_url: string, _key: string, options: { global: { headers: { Authorization: string } } }) => {
        const token = options.global.headers.Authorization.slice(7);
        return {
          auth: { getUser: async () => {
            verifiedTokens.push(token);
            return validTokens.has(token)
              ? { data: { user: { id: token, email: null } }, error: null }
              : { data: { user: null }, error: { message: 'invalid signature' } };
          } },
          rpc: async () => ({ data: { is_super_admin: true }, error: null }),
        };
      },
    },
  });
  auth = require('./auth');
});

beforeEach(() => {
  auth.clearAuthCache();
  verifiedTokens.length = 0;
  validTokens.clear();
});

async function request(token?: string) {
  const req = { headers: token ? { authorization: token } : {} } as Request;
  let status = 200;
  let continued = false;
  const res = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  await auth.authenticate(req, res, () => { continued = true; });
  return { status, continued, context: req.auth };
}

test('a token colliding under the former 32-bit hash cannot inherit a cached administrator', async () => {
  // Aa and BB have the same length and polynomial hash: 65*31+97 === 66*31+66.
  validTokens.add('Aa');
  assert.equal((await request('Bearer Aa')).context?.isSuperAdmin, true);
  const forged = await request('Bearer BB');
  assert.equal(forged.status, 401);
  assert.equal(forged.continued, false);
  assert.deepEqual(verifiedTokens, ['Aa', 'BB']);
});

test('repeated requests verify a valid token once within the cache lifetime', async () => {
  validTokens.add('valid-token');
  assert.equal((await request('Bearer valid-token')).status, 200);
  assert.equal((await request('Bearer valid-token')).status, 200);
  assert.deepEqual(verifiedTokens, ['valid-token']);
});

test('expired entries reverify the session, and token refreshes cannot grow the cache without bound', async () => {
  for (let index = 0; index <= 2000; index++) {
    const token = `session-${index}`;
    validTokens.add(token);
    assert.equal((await request(`Bearer ${token}`)).status, 200);
  }
  assert.equal(verifiedTokens.length, 2001);
  await request('Bearer session-0');
  assert.equal(verifiedTokens.length, 2002, 'the oldest entry was evicted at the capacity limit');

  const future = Date.now() + 60_001;
  const clock = mock.method(Date, 'now', () => future);
  try {
    validTokens.delete('session-0');
    assert.equal((await request('Bearer session-0')).status, 401, 'an expired cache entry cannot preserve revoked access');
  } finally { clock.mock.restore(); }
});

test('missing or malformed authorization never reaches a protected handler', async () => {
  validTokens.add('valid-token');
  for (const header of [undefined, 'Basic valid-token', 'Bearer', 'Bearer valid-token extra']) {
    assert.equal((await request(header)).status, 401, header);
  }
});
