// Copy / Share for report text. WhatsApp is the main destination: the Web Share sheet when the
// device has one, otherwise the clipboard. Returns what happened so the screen can say so.
export async function shareText(textValue, { title = 'Work report', nav = globalThis.navigator } = {}) {
  if (typeof nav?.share === 'function') {
    try { await nav.share({ title, text: textValue }); return 'shared'; }
    catch (error) { if (error?.name === 'AbortError') return 'cancelled'; }
  }
  return copyText(textValue, { nav });
}

export async function copyText(textValue, { nav = globalThis.navigator } = {}) {
  try { await nav.clipboard.writeText(textValue); return 'copied'; }
  catch { return 'failed'; }
}
