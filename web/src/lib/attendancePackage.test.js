// The sync program the HR dashboard offers for download (public/downloads) must match the service
// in services/attendance, and must never carry a password. If this fails after changing the
// service, run `npm run pack:attendance` and commit the new zip and .json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { OUT_DIR, SERVICE_DIR, ZIP_NAME, serviceFiles, sourceHash, zip } from '../../scripts/pack-attendance-service.mjs';

const zipPath = join(OUT_DIR, ZIP_NAME);
const manifest = JSON.parse(readFileSync(join(OUT_DIR, ZIP_NAME.replace(/\.zip$/, '.json')), 'utf8'));

/** name -> contents, read straight from the central directory. */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = new Map();
  for (let i = 0; i < count; i += 1) {
    const size = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extra = buffer.readUInt16LE(at + 30);
    const comment = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    out.set(name, inflateRawSync(buffer.subarray(dataAt, dataAt + size)));
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

test('the download matches the service as it is now', { skip: !existsSync(SERVICE_DIR) && 'services/attendance is not in this checkout' }, () => {
  assert.equal(manifest.source_hash, sourceHash(), 'services/attendance changed since the zip was made - run `npm run pack:attendance`');
});

test('the download holds the installer and the template, and no settings file or build output', () => {
  const files = unzip(readFileSync(zipPath));
  const names = [...files.keys()];
  assert.ok(names.includes('parakkat-attendance-sync/Install.bat'), 'a top-level Install.bat to double-click');
  assert.ok(names.includes('parakkat-attendance-sync/deploy/windows/setup.ps1'));
  assert.ok(names.includes('parakkat-attendance-sync/deploy/env.template'));
  assert.ok(!names.some((name) => /(^|\/)\.env($|\.)|node_modules|\/dist\//.test(name)), 'no .env, node_modules or dist');
  const template = files.get('parakkat-attendance-sync/deploy/env.template').toString('utf8');
  for (const line of template.split(/\r?\n/).filter((l) => /^(DIRECT_)?DATABASE_URL=/.test(l))) assert.match(line, /:FILL_ME@/, 'no database password');
  assert.match(template, /^BIOTIME_PASSWORD="FILL_ME"$/m, 'no Easy Time Pro password');
  assert.match(files.get('parakkat-attendance-sync/Install.bat').toString('utf8'), /\r\n/, 'batch files travel with Windows line endings');
});

test('the zip writer round-trips', () => {
  const entries = [{ name: 'a/one.txt', data: Buffer.from('hello') }, { name: 'a/b/two.txt', data: Buffer.from('x'.repeat(5000)) }];
  const back = unzip(zip(entries, new Date('2026-10-23T10:00:00Z')));
  assert.equal(back.get('a/one.txt').toString(), 'hello');
  assert.equal(back.get('a/b/two.txt').length, 5000);
  assert.ok(serviceFiles().length > 10);
});
