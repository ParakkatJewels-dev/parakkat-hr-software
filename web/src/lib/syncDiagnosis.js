// Which link in the chain is broken?
//
// Punches travel along three hops, and a single "Connected / Not connected" cannot describe them:
//
//   1. punching machine  ->  Easy Time Pro      the terminal uploads what people punched
//   2. Easy Time Pro     ->  the sync service   the service polls it every two minutes
//   3. the sync service  ->  this application   the service writes to the database we read
//
// Any one can fail while the other two are perfectly healthy, and each needs a different person to
// do a different thing. On 29 July hop 1 failed: the terminal stopped uploading at 13:07. Hops 2
// and 3 kept working flawlessly, so every indicator stayed green — the service really was running,
// and it really was reaching Easy Time Pro, which really was answering. It just had nothing to
// give. Five hours passed before anyone noticed, because nothing on screen was wrong.
//
// EVIDENCE, AND WHY IT IS IN THIS ORDER
// Each hop is only observable through the ones after it, so the diagnosis has to work outside-in:
//
//   hop 3 is visible as   are sync runs appearing in the database at all?
//   hop 2 is visible as   are those runs succeeding, or erroring against Easy Time Pro?
//   hop 1 is visible as   are the successful runs actually bringing punches back?
//
// That ordering matters. When hop 3 is down we cannot see hops 1 or 2 at all, and must say so
// rather than reporting a stale guess about them as if it were current.
//
// Pure and dependency-free so it can be tested — see syncDiagnosis.test.js. The clock is passed
// in rather than read, for the same reason.

/** The service polls every 2 minutes. Ten covers a slow tick plus one abandoned run. */
const SERVICE_SILENT_MIN = 10;
/** Runs still appearing but none succeeding for this long means Easy Time Pro is not answering. */
const BIOTIME_UNREACHABLE_MIN = 15;
/**
 * No punch for this long, during working hours, is not a lull.
 *
 * Measured, not guessed: across thirty days of working hours the median gap between punches here
 * is 0 minutes, the 99th percentile is 30, and the longest legitimate silence ever recorded is 74.
 */
const TERMINAL_STALLED_MIN = 90;
const TERMINAL_QUIET_MIN = 45;

const minutesBetween = (fromIso, nowMs) =>
  fromIso ? (nowMs - new Date(fromIso).getTime()) / 60_000 : Infinity;

/** Is anyone expected to be punching right now? IST, Monday to Saturday, 08:00-20:00. */
export function withinWorkingHours(nowMs) {
  const ist = new Date(nowMs + 5.5 * 3600 * 1000);
  return ist.getUTCDay() !== 0 && ist.getUTCHours() >= 8 && ist.getUTCHours() < 20;
}

/**
 * Work out which hop is broken.
 *
 * @param {object} o
 * @param {number} o.nowMs             current time
 * @param {string|null} o.newestRunAt  newest sync run of ANY kind — proves the service is alive
 * @param {string|null} o.lastSuccessAt last successful punch pull — proves Easy Time Pro answered
 * @param {string|null} o.lastPunchAt   newest punch we hold — proves the terminal delivered
 * @returns {{level: string, brokenHop: 1|2|3|null}}
 */
export function diagnose({ nowMs, newestRunAt, lastSuccessAt, lastPunchAt }) {
  const sinceRun = minutesBetween(newestRunAt, nowMs);
  const sinceSuccess = minutesBetween(lastSuccessAt, nowMs);
  const sincePunch = minutesBetween(lastPunchAt, nowMs);

  // Hop 3 first. Nothing is being written, so nothing can be said about the other two — the last
  // punch we hold might be five minutes or five hours behind whatever the terminal has done since.
  if (sinceRun > SERVICE_SILENT_MIN) {
    return { level: 'service-down', brokenHop: 3, minutes: sinceRun };
  }

  // Hop 2. Runs are arriving, so the service is alive and can reach us; if none of them succeed,
  // the thing it cannot reach is Easy Time Pro.
  if (sinceSuccess > BIOTIME_UNREACHABLE_MIN) {
    return { level: 'biotime-unreachable', brokenHop: 2, minutes: sinceSuccess };
  }

  // Hops 2 and 3 are proven healthy from here: a run succeeded recently, which means the service
  // asked Easy Time Pro and Easy Time Pro answered. Anything missing now is upstream of both.
  if (!withinWorkingHours(nowMs)) {
    return { level: 'off-hours', brokenHop: null, minutes: sincePunch };
  }
  if (sincePunch > TERMINAL_STALLED_MIN) {
    return { level: 'terminal-down', brokenHop: 1, minutes: sincePunch };
  }
  if (sincePunch > TERMINAL_QUIET_MIN) {
    return { level: 'quiet', brokenHop: null, minutes: sincePunch };
  }
  return { level: 'ok', brokenHop: null, minutes: sincePunch };
}

/** "5h 1m" / "12m" — for a message somebody reads once and acts on. */
export function forHumans(minutes) {
  if (!Number.isFinite(minutes)) return 'ever';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * What to show, and what to do about it.
 *
 * Each hint names the hop in the words somebody would use, and says who fixes it — a status that
 * cannot be acted on is decoration.
 */
export const DIAGNOSIS = {
  ok: {
    label: 'Working',
    tone: 'text-emerald-600 dark:text-emerald-400',
    chain: 'machine → Easy Time Pro → service → here',
    hint: 'Punches are arriving normally.',
  },
  quiet: {
    label: 'No punches lately',
    tone: 'text-neutral-500 dark:text-neutral-400',
    chain: 'all three links healthy',
    hint: 'Everything is connected — there simply has not been a punch for a while. Normal in a lull.',
  },
  'off-hours': {
    label: 'Outside working hours',
    tone: 'text-neutral-450',
    chain: 'all three links healthy',
    hint: 'Nobody is expected to be punching, so quiet means nothing here.',
  },
  'terminal-down': {
    label: 'Machine not sending',
    tone: 'text-red-600 dark:text-red-400',
    chain: 'machine ✕ Easy Time Pro → service → here',
    hint:
      'The service is running and Easy Time Pro is answering it — but the punching machine has not '
      + 'handed over a punch for longer than any normal gap. It can show "connected" and still be '
      + 'stuck: that light is a heartbeat, not an upload. Try Get Transactions in Easy Time Pro, '
      + 'then reboot the terminal. Nothing is lost — it stores punches and re-sends them.',
  },
  'biotime-unreachable': {
    label: 'Easy Time Pro not answering',
    tone: 'text-red-600 dark:text-red-400',
    chain: 'machine → Easy Time Pro ✕ service → here',
    hint:
      'The sync service is running and reporting in, but Easy Time Pro is not responding to it. '
      + 'Usually Easy Time Pro has been closed or its service stopped, or its address changed. '
      + 'Check it opens in a browser on the HR laptop. Punches are still being collected by the '
      + 'machine and will come through once it answers again.',
  },
  'service-down': {
    label: 'Sync service not running',
    tone: 'text-red-600 dark:text-red-400',
    chain: 'machine → Easy Time Pro → service ✕ here',
    hint:
      'Nothing has been heard from the HR laptop. It is off or asleep, the service has stopped, or '
      + 'it has lost internet. While this is the case nothing can be said about the machine or '
      + 'Easy Time Pro either — this is the outermost link, and it hides the two behind it. '
      + 'Check the laptop is on, then services.msc → Parakkat Attendance Sync.',
  },
};
