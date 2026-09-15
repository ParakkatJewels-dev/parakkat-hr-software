/** One value, one in-flight read. Rejections never become cached successes. */
export function shortCache<T>(load: () => Promise<T>, ttlMs: number, now = Date.now) {
  let value: { data: T; expiresAt: number } | undefined;
  let inFlight: Promise<T> | undefined;
  return () => {
    if (value && value.expiresAt > now()) return Promise.resolve(value.data);
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(load).then(data => {
      value = { data, expiresAt: now() + ttlMs };
      return data;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
