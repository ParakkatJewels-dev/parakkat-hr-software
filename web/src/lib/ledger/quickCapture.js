// Work Ledger command bar parser. A typed line is either a search (plain text) or a quick capture
// when it starts with `task:`, `idea:`, `help:` or `remind:`. Parsing is token-based and
// case-insensitive: every token we recognise is removed, and what is left becomes the title/text.
// Pure and fast (it runs on every keystroke for the live preview) and it never throws.
// `today` is 'YYYY-MM-DD' in Asia/Kolkata, supplied by the caller.
import { parseDay, addDays } from './periods.js';

export const BRAND_TOKENS = {
  jewels: 'Parakkat Jewels',
  munnar: 'Parakkat Munnar Resort',
  riverscape: 'Parakkat Riverscape',
  river: 'Parakkat Riverscape',
  adimali: 'Parakkat Adimali Retreat',
  general: 'General',
};
export const BRAND_LABELS = {
  'Parakkat Jewels': 'Jewels',
  'Parakkat Munnar Resort': 'Munnar',
  'Parakkat Riverscape': 'Riverscape',
  'Parakkat Adimali Retreat': 'Adimali',
  General: 'General',
};

const PREFIX = /^\s*(task|idea|help|remind)\s*:\s*/i;
const PRIORITIES = { '!high': 'High', urgent: 'High', '!medium': 'Medium', '!low': 'Low' };
const WEEKDAYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const REPEATS = new Set(['daily', 'weekly', 'monthly', 'weekdays']);
const TEAM_WORDS = new Set(['support', 'helped', 'unblocked']);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Which tokens each kind understands. Ideas only get brand (+ tags, handled separately).
const FEATURES = {
  task: { brand: true, priority: true, date: true, repeat: true },
  help: { brand: true, date: true, who: true, duration: true },
  remind: { brand: true, date: true, repeat: true, time: true },
};

// Own-property lookup so words like "constructor" never match.
const own = (object, key) => (Object.hasOwn(object, key) ? object[key] : undefined);
const pad = (n) => String(n).padStart(2, '0');

function tokenize(body) {
  return body.split(/\s+/).filter(Boolean).map((raw) => {
    const core = raw.replace(/[.,;]+$/, ''); // "fri." still matches, the title keeps its own punctuation
    return { raw, core, low: core.toLowerCase(), punct: core !== raw, used: false };
  });
}

const isKeyword = (low) =>
  own(WEEKDAYS, low) !== undefined || REPEATS.has(low) || own(PRIORITIES, low) !== undefined ||
  low === 'today' || low === 'tomorrow';

/** 'YYYY-MM-DD' for a date word, or null. Relative words need a valid `today`. */
function dateFromToken(low, today) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(low)) return parseDay(low) ? low : null;
  if (!today) return null;
  if (low === 'today') return today;
  if (low === 'tomorrow') return addDays(today, 1);
  const target = own(WEEKDAYS, low);
  if (target === undefined) return null;
  return addDays(today, (target - parseDay(today).getUTCDay() + 7) % 7);
}

/** 'HH:mm' for 10am, 4:30pm, 4.30pm, 14:00, noon, midnight, or null. */
function timeFromToken(low) {
  if (low === 'noon') return '12:00';
  if (low === 'midnight') return '00:00';
  let m = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)$/.exec(low);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2] ?? 0);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    return `${pad((hour % 12) + (m[3] === 'pm' ? 12 : 0))}:${pad(minute)}`;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(low);
  if (m && Number(m[1]) <= 23 && Number(m[2]) <= 59) return `${pad(Number(m[1]))}:${m[2]}`;
  return null;
}

/** Minutes for `30m`, `45min`, `1.5h`, `1h30m` (one token) or `45 mins` (two). Returns { minutes, span } or null. */
function durationAt(tokens, i) {
  const low = tokens[i].low;
  const one = /^(?:(\d+(?:\.\d+)?)(?:h|hr|hrs|hour|hours))?(?:(\d+)(?:m|min|mins|minute|minutes))?$/.exec(low);
  if (one && (one[1] || one[2])) {
    const minutes = Math.round(Number(one[1] ?? 0) * 60 + Number(one[2] ?? 0));
    return minutes > 0 ? { minutes, span: 1 } : null;
  }
  const next = tokens[i + 1]?.low;
  if (/^\d+(?:\.\d+)?$/.test(low) && next && !tokens[i + 1].used) {
    if (/^(m|min|mins|minute|minutes)$/.test(next)) return Number(low) > 0 ? { minutes: Math.round(Number(low)), span: 2 } : null;
    if (/^(h|hr|hrs|hour|hours)$/.test(next)) return Number(low) > 0 ? { minutes: Math.round(Number(low) * 60), span: 2 } : null;
  }
  return null;
}

/** `for Priya` / `for Anu Mathew`: returns { name, span } or null. */
function whoAt(tokens, i) {
  if (tokens[i].low !== 'for') return null;
  const isName = (t) => t && !t.used && /^[A-Z][A-Za-z'-]*$/.test(t.core) && !isKeyword(t.low);
  const first = tokens[i + 1];
  if (!isName(first)) return null;
  const second = tokens[i + 2];
  if (!first.punct && isName(second)) return { name: `${first.core} ${second.core}`, span: 3 };
  return { name: first.core, span: 2 };
}

const markUsed = (tokens, from, count) => { for (let k = from; k < from + count; k += 1) tokens[k].used = true; };
// Drop a filler word ("by", "at") just before a token we consumed.
function dropFiller(tokens, i, words) {
  const prev = tokens[i - 1];
  if (prev && !prev.used && words.includes(prev.low)) prev.used = true;
}
const remaining = (tokens) => tokens.filter((t) => !t.used).map((t) => t.raw).join(' ');

/** Walk the tokens once, taking the FIRST of each field and marking recognised tokens as used. */
function scan(tokens, features, today) {
  const found = { brand: null, priority: null, date: null, repeat: null, time: null, minutes: null, forWhom: null };
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.used) continue;
    const brand = features.brand && /^[@#]/.test(t.low) ? own(BRAND_TOKENS, t.low.slice(1)) : undefined;
    if (brand && !found.brand) { found.brand = brand; t.used = true; continue; }
    const priority = features.priority ? own(PRIORITIES, t.low) : undefined;
    if (priority && !found.priority) { found.priority = priority; t.used = true; continue; }
    if (features.repeat && !found.repeat && REPEATS.has(t.low)) { found.repeat = t.low; t.used = true; continue; }
    if (features.date && !found.date) {
      const date = dateFromToken(t.low, today);
      if (date) { found.date = date; t.used = true; dropFiller(tokens, i, ['by', 'on', 'due']); continue; }
    }
    if (features.time && !found.time) {
      const time = timeFromToken(t.low);
      if (time) { found.time = time; t.used = true; dropFiller(tokens, i, ['at']); continue; }
    }
    if (features.who && !found.forWhom) {
      const who = whoAt(tokens, i);
      if (who) { found.forWhom = who.name; markUsed(tokens, i, who.span); continue; }
    }
    if (features.duration && found.minutes === null) {
      const duration = durationAt(tokens, i);
      if (duration) { found.minutes = duration.minutes; markUsed(tokens, i, duration.span); continue; }
    }
  }
  return found;
}

/** Ideas: brand (first wins) and tags. Any other @word / #word becomes a tag and leaves the text. */
function scanIdea(tokens) {
  let brand = null;
  const tags = [];
  for (const t of tokens) {
    if (!/^[@#][\w-]+$/.test(t.core)) continue;
    const word = t.low.slice(1);
    const named = own(BRAND_TOKENS, word);
    if (named && !brand) brand = named;
    else if (!tags.includes(word)) tags.push(word);
    t.used = true;
  }
  return { brand, tags };
}

/** Parse a command-bar line. See the header for the shapes returned. */
export function parseQuickCapture(input, { today } = {}) {
  if (typeof input !== 'string') return { kind: 'search', query: '' };
  const match = PREFIX.exec(input);
  if (!match) return { kind: 'search', query: input.trim() };
  const kind = match[1].toLowerCase();
  const tokens = tokenize(input.slice(match[0].length));
  const day = parseDay(today) ? today : null;

  if (kind === 'idea') {
    const { brand, tags } = scanIdea(tokens);
    return { kind, text: remaining(tokens), brand, tags };
  }
  const f = scan(tokens, FEATURES[kind], day);
  const title = remaining(tokens);
  if (kind === 'task') {
    return { kind, title, brand: f.brand, priority: f.priority ?? 'Medium', deadline: f.date, repeat: f.repeat };
  }
  if (kind === 'help') {
    const team = tokens.some((t) => !t.used && TEAM_WORDS.has(t.low));
    return {
      kind, title, brand: f.brand, forWhom: f.forWhom, minutes: f.minutes,
      supportType: team ? 'Team support' : 'Review / Feedback', date: f.date ?? day,
    };
  }
  const date = f.date ?? day;
  return { kind, text: title, brand: f.brand, dueAt: date ? `${date}T${f.time ?? '09:00'}` : null, repeat: f.repeat };
}

const dayLabel = (date) => {
  const d = parseDay(date);
  return d ? `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}` : '';
};
const timeLabel = (time) => {
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? 'AM' : 'PM'}`;
};
const durationLabel = (minutes) => {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`;
};

/** Short preview chips for the live preview, e.g. ['Task', 'Jewels', 'High', 'Due Fri 9 Oct', 'Repeats weekly']. */
export function describeCapture(parsed) {
  if (!parsed || parsed.kind === 'search') return [];
  const chips = [{ task: 'Task', idea: 'Idea', help: 'Help', remind: 'Reminder' }[parsed.kind]];
  if (parsed.brand) chips.push(BRAND_LABELS[parsed.brand] ?? parsed.brand);
  if (parsed.kind === 'task') {
    chips.push(parsed.priority);
    if (parsed.deadline) chips.push(`Due ${dayLabel(parsed.deadline)}`);
  } else if (parsed.kind === 'idea') {
    for (const tag of parsed.tags ?? []) chips.push(`#${tag}`);
  } else if (parsed.kind === 'help') {
    if (parsed.forWhom) chips.push(`For ${parsed.forWhom}`);
    if (parsed.minutes) chips.push(durationLabel(parsed.minutes));
    chips.push(parsed.supportType);
    if (parsed.date) chips.push(dayLabel(parsed.date));
  } else if (parsed.kind === 'remind' && parsed.dueAt) {
    const [date, time] = parsed.dueAt.split('T');
    chips.push(`Due ${dayLabel(date)}, ${timeLabel(time)}`);
  }
  if (parsed.repeat) chips.push(`Repeats ${parsed.repeat}`);
  return chips;
}
