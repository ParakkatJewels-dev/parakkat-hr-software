import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Exercise the real message mutation and inspect exactly what reaches the database boundary.
const stubs = {
  '@tanstack/react-query': `export const useQuery = x => x;
    export const useInfiniteQuery = x => x; export const useMutation = x => x;
    export const useQueryClient = () => ({ invalidateQueries() {} });`,
  react: 'export const useMemo = fn => fn();',
  supabaseClient: 'export const supabase = { from: (...args) => globalThis.messageTestDb.from(...args) };',
  AuthContext: 'export const useAuth = () => ({ employee: { id: "employee-1" } });',
};
registerHooks({
  resolve(specifier, context, next) {
    const key = specifier in stubs ? specifier : specifier.split('/').at(-1).replace(/\.jsx?$/, '');
    if (stubs[key]) return { url: `data:text/javascript,${encodeURIComponent(stubs[key])}`, shortCircuit: true };
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(`${specifier}.js`, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    return next(specifier, context);
  },
});

const { useSendMessage } = await import('./messages.js');

test('sending or retrying uploaded voice notes inserts integer milliseconds', async () => {
  const inserted = [];
  globalThis.messageTestDb = {
    from(table) {
      assert.equal(table, 'messages');
      return { async insert(row) {
        assert.ok(row.duration_ms === null || Number.isInteger(row.duration_ms), 'duration_ms must satisfy the integer column');
        inserted.push(row);
        return { error: null };
      } };
    },
  };
  const cases = [
    [6191.5999999996275, 6192],
    [6191.4, 6191],
    [6192, 6192],
    [0, 0],
    [null, null],
    [undefined, null],
    [NaN, null],
    [Infinity, null],
  ];
  for (const [durationMs, expected] of cases) {
    const media = { path: 'conversation/already-uploaded.webm', mimeType: 'audio/webm', byteSize: 1234, durationMs };
    await useSendMessage().mutationFn({ conversationId: 'conversation', kind: 'voice', media });
    assert.equal(inserted.at(-1).duration_ms, expected);
    assert.equal(inserted.at(-1).storage_path, media.path);
    assert.equal(media.durationMs, durationMs, 'retry metadata is not mutated');
  }
});

test('text messages keep an absent audio duration as null', async () => {
  globalThis.messageTestDb = {
    from() { return { async insert(row) {
      assert.equal(row.duration_ms, null);
      assert.equal(row.body, 'Hello');
      return { error: null };
    } }; },
  };
  await useSendMessage().mutationFn({ conversationId: 'conversation', body: 'Hello' });
});
