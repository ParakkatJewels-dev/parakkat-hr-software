// Packs the attendance sync service into the zip the HR dashboard offers for download
// (Attendance setup -> Sync status), so the Easy Time Pro machine gets it from the browser instead
// of a pen drive or a git clone.
//
//   npm run pack:attendance        (from web/)
//
// Writes public/downloads/parakkat-attendance-sync.zip and a small .json beside it (when, which
// sources). The zip carries the code, the installer and deploy/env.template - never a .env, so it
// holds no password, and unzipping an update over an installed copy keeps that machine's settings.
// It is packed from what is COMMITTED (git HEAD), not from the working folder, so half-finished
// local edits never reach the Easy Time Pro machine: commit the service first, then pack.
// attendancePackage.test.js fails when the committed service has changed since the zip was made.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVICE_DIR = join(here, '..', '..', 'services', 'attendance');
export const OUT_DIR = join(here, '..', 'public', 'downloads');
export const ZIP_NAME = 'parakkat-attendance-sync.zip';
const ROOT = 'parakkat-attendance-sync';

// What the machine needs to install and run the service; nothing built, installed or secret.
const INCLUDE = ['package.json', 'package-lock.json', 'tsconfig.json', 'ecosystem.config.cjs', 'README.md', 'prisma', 'src', 'deploy'];
const SKIP = /(^|\/)(node_modules|dist|logs|\.git)(\/|$)|(^|\/)\.env($|\.)|\.log$|\.DS_Store$/;

const REPO = join(here, '..', '..');
const GIT_PREFIX = 'services/attendance/';
const wanted = (rel) => INCLUDE.some((name) => rel === name || rel.startsWith(`${name}/`)) && !SKIP.test(rel);

/** The committed files, or null outside a git checkout. */
function committed() {
  try {
    return execFileSync('git', ['-C', REPO, 'ls-files', '-z', '--', GIT_PREFIX], { encoding: 'utf8' })
      .split('\0').filter(Boolean).map((path) => path.slice(GIT_PREFIX.length)).filter(wanted).sort();
  } catch { return null; }
}

/** Every file that goes into the zip, as forward-slash paths relative to the service folder. */
export function serviceFiles(dir = SERVICE_DIR) {
  if (dir === SERVICE_DIR) {
    const tracked = committed();
    if (tracked) return tracked;
  }
  const out = [];
  const walk = (path) => {
    const rel = relative(dir, path).split(sep).join('/');
    if (rel && SKIP.test(rel)) return;
    if (statSync(path).isDirectory()) readdirSync(path).sort().forEach((name) => walk(join(path, name)));
    else out.push(rel);
  };
  INCLUDE.forEach((name) => walk(join(dir, name)));
  return out;
}

/** A file's committed contents (the working copy outside git, or for another folder). */
function readSource(dir, rel) {
  if (dir === SERVICE_DIR && committed()) {
    return execFileSync('git', ['-C', REPO, 'show', `HEAD:${GIT_PREFIX}${rel}`], { maxBuffer: 64 * 1024 * 1024 });
  }
  return readFileSync(join(dir, rel));
}

/** A fingerprint of the sources, to tell when the zip is out of date. */
export function sourceHash(dir = SERVICE_DIR) {
  const hash = createHash('sha256');
  for (const file of serviceFiles(dir)) hash.update(file).update('\0').update(readSource(dir, file)).update('\0');
  return hash.digest('hex');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A plain zip (deflate), readable by Windows' own "Extract all". */
export function zip(entries, when = new Date()) {
  const time = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const date = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// cmd.exe misreads batch files with bare LF line endings, so those travel as CRLF.
const forWindows = (name, data) => (/\.(bat|cmd)$/i.test(name) ? Buffer.from(data.toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8') : data);

// The one thing to double-click, at the top of the unzipped folder.
const LAUNCHER = `@echo off
REM Parakkat Attendance Sync - double-click to install or update (asks for administrator rights).
call "%~dp0deploy\\windows\\Install.bat"
`;

export function pack({ dir = SERVICE_DIR, outDir = OUT_DIR, when = new Date() } = {}) {
  const files = serviceFiles(dir);
  if (!files.includes('deploy/env.template')) throw new Error('deploy/env.template is missing - the installer needs it.');
  const template = readSource(dir, 'deploy/env.template').toString('utf8');
  for (const line of template.split(/\r?\n/)) {
    if (/^(DIRECT_)?DATABASE_URL=/.test(line) && !line.includes(':FILL_ME@')) throw new Error('env.template holds a database password - refusing to pack it.');
    if (/^BIOTIME_PASSWORD=/.test(line) && !line.includes('FILL_ME')) throw new Error('env.template holds the Easy Time Pro password - refusing to pack it.');
  }
  const entries = [
    { name: `${ROOT}/Install.bat`, data: forWindows('Install.bat', Buffer.from(LAUNCHER)) },
    ...files.map((file) => ({ name: `${ROOT}/${file}`, data: forWindows(file, readSource(dir, file)) })),
  ];
  mkdirSync(outDir, { recursive: true });
  const archive = zip(entries, when);
  writeFileSync(join(outDir, ZIP_NAME), archive);
  const manifest = { file: ZIP_NAME, packed_at: when.toISOString(), files: entries.length, bytes: archive.length, source_hash: sourceHash(dir) };
  writeFileSync(join(outDir, ZIP_NAME.replace(/\.zip$/, '.json')), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = pack();
  console.log(`Packed ${manifest.files} files (${Math.round(manifest.bytes / 1024)} KB) into public/downloads/${manifest.file}`);
}
