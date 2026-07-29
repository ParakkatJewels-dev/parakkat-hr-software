// Where Easy Time Pro is, when the configured answer stops being true.
//
// The address in .env is a LAN IP — 192.168.1.45:8081 — for a program running on the same laptop
// as this service. Every request therefore leaves the machine, crosses the Wi-Fi, and comes back
// to the same box. That works, mostly: 5.8 seconds average against milliseconds for a local call,
// with occasional 33-second stalls and sixteen outright timeouts so far.
//
// The real hazard is not the latency. That laptop uses a randomised Wi-Fi MAC, so the router can
// hand it a different lease after a power cut. The day 192.168.1.45 becomes 192.168.1.52, punch
// collection stops and stays stopped until somebody edits a file — and nobody will know why.
//
// So rather than insisting the address be written differently, this tries the alternatives. If the
// configured host cannot be reached, it tries the same port on loopback, then on the machine's own
// hostname. Whichever answers becomes the address for the rest of the process, and the choice is
// logged loudly enough to be found later.
//
// This only ever moves BETWEEN ADDRESSES FOR THE SAME SERVER. Loopback on port 8081 is either Easy
// Time Pro or nothing; a wrong guess fails to authenticate and is discarded rather than silently
// pointed at some other application.
import { hostname } from 'node:os';
import { env } from '../config/env';
import { logger } from '../lib/logger';

/** Split a base URL into its parts so alternatives can be built from the same port and scheme. */
function parts(url: string): { scheme: string; host: string; port: string } | null {
  const m = url.match(/^(https?):\/\/([^:/]+)(?::(\d+))?/i);
  if (!m) return null;
  return { scheme: m[1]!.toLowerCase(), host: m[2]!, port: m[3] ?? (m[1]!.toLowerCase() === 'https' ? '443' : '80') };
}

const isLoopback = (host: string) =>
  host === '127.0.0.1' || host === 'localhost' || host === '::1';

/**
 * The addresses worth trying, best first.
 *
 * The configured one leads, always — if somebody wrote it down it is the intended answer, and a
 * genuinely remote Easy Time Pro must not be silently replaced by whatever is listening locally.
 */
export function candidates(configured: string): string[] {
  const p = parts(configured);
  if (!p) return [configured];

  const out = [configured.replace(/\/+$/, '')];
  if (!isLoopback(p.host)) {
    // Same server, no network hop. Only reachable if Easy Time Pro is on this machine, which is
    // exactly the case this exists for.
    out.push(`${p.scheme}://127.0.0.1:${p.port}`);
    // A hostname survives a DHCP change where a hardcoded IP does not.
    const h = hostname();
    if (h && h.toLowerCase() !== p.host.toLowerCase()) out.push(`${p.scheme}://${h}:${p.port}`);
  }
  return [...new Set(out)];
}

let list: string[] = [];
let index = 0;

function ensure(): void {
  if (list.length === 0) {
    list = candidates(env.BIOTIME_BASE_URL || '');
    index = 0;
  }
}

/** The address in use right now. */
export function currentBaseUrl(): string {
  ensure();
  return list[index] ?? env.BIOTIME_BASE_URL ?? '';
}

/** True when the configured address is the one being used. */
export function usingConfigured(): boolean {
  ensure();
  return index === 0;
}

/**
 * Move to the next candidate. Returns false once they are exhausted, which is the signal to stop
 * retrying and report a genuine outage rather than cycling forever.
 */
export function rotateEndpoint(reason: string): boolean {
  ensure();
  if (index + 1 >= list.length) {
    // Back to the configured address, so a later recovery is noticed rather than being stuck on a
    // fallback that also died.
    if (index !== 0) {
      logger.warn({ from: list[index], to: list[0] }, 'no alternative reachable — back to the configured address');
      index = 0;
    }
    return false;
  }

  const from = list[index];
  index += 1;
  logger.warn(
    { from, to: list[index], reason },
    'Easy Time Pro unreachable at the configured address — trying another route to the same server'
  );
  return true;
}

/** Pin the working address once a request succeeds on it, so a stale choice cannot linger. */
export function confirmEndpoint(): void {
  ensure();
  if (index !== 0) {
    logger.info(
      { using: list[index], configured: list[0] },
      'reaching Easy Time Pro on a fallback address — consider setting BIOTIME_BASE_URL to this'
    );
  }
}

/** Test seam: forget everything learned so far. */
export function resetEndpoints(): void {
  list = [];
  index = 0;
}
