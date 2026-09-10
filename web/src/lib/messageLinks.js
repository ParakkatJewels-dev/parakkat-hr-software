// Turn ordinary web addresses in a task message into safe link parts for React to render.
//
// Only http(s) and www addresses are recognised. This is deliberately narrower than accepting any
// URI scheme: a message must never turn `javascript:` or another executable scheme into a link.
const WEB_ADDRESS = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const SIMPLE_TRAILING = new Set(['.', ',', '!', '?', ';', ':']);
const BRACKETS = { ')': '(', ']': '[', '}': '{' };

function withoutSentencePunctuation(candidate) {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    if (SIMPLE_TRAILING.has(last)) {
      end -= 1;
      continue;
    }
    const open = BRACKETS[last];
    if (!open) break;
    const text = candidate.slice(0, end);
    const opens = [...text].filter((char) => char === open).length;
    const closes = [...text].filter((char) => char === last).length;
    if (closes <= opens) break;
    end -= 1;
  }
  return candidate.slice(0, end);
}

export function messageLinkParts(value) {
  const text = String(value ?? '');
  const parts = [];
  let cursor = 0;

  for (const match of text.matchAll(WEB_ADDRESS)) {
    const index = match.index ?? 0;
    // Do not turn the `www` portion of an email address into a link.
    if (index > 0 && /[\w@]/.test(text[index - 1])) continue;
    const label = withoutSentencePunctuation(match[0]);
    if (!label) continue;
    if (index > cursor) parts.push({ type: 'text', text: text.slice(cursor, index) });
    parts.push({
      type: 'link',
      text: label,
      href: /^www\./i.test(label) ? `https://${label}` : label,
    });
    cursor = index + label.length;
  }

  if (cursor < text.length) parts.push({ type: 'text', text: text.slice(cursor) });
  return parts;
}
