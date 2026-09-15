import { QueryClient } from '@tanstack/react-query';

// Permanent refusals should reach the UI immediately, not repeat the same database request.
// Unknown application errors are also left to an explicit retry; only transient failures retry.
export function retryQuery(failureCount, error) {
  if (failureCount >= 2 || error?.name === 'AbortError') return false;
  // A long server cooldown belongs in the error state, not an extended loading spinner.
  if (Number(error?.retryAfter) > 30) return false;
  const code = String(error?.code ?? '');
  const status = Number(error?.status ?? error?.statusCode ?? (/^PT\d{3}$/.test(code) ? code.slice(2) : 0));
  if (status >= 400 && status < 500) return false;
  if (status >= 500 && status < 600) return true;
  if (/^(08|53)/.test(code) || ['40001', '40P01', '57P01', '57P02', '57P03', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'].includes(code)) return true;
  if (code) return false;
  return /failed to fetch|fetch failed|networkerror|network request failed|load failed|network connection|ECONNRESET|ETIMEDOUT/i.test(error?.message ?? '');
}

export function queryRetryDelay(attempt, error, random = Math.random) {
  const requestedWait = Number(error?.retryAfter);
  const backoff = Math.min(1000 * 2 ** Math.max(0, attempt), 15_000);
  const wait = Number.isFinite(requestedWait) && requestedWait > 0 ? Math.max(backoff, requestedWait * 1000) : backoff;
  return Math.min(wait, 30_000) + Math.floor(random() * 500);
}

export function signedUrlRefreshInterval(refreshAfterMs) {
  return query => {
    // A restored URL keeps its original signing time. Starting a full interval on remount
    // could leave an almost-expired URL visible for another hour.
    if (query.state.status === 'error') return 60_000;
    const age = query.state.dataUpdatedAt ? Math.max(0, Date.now() - query.state.dataUpdatedAt) : 0;
    return Math.max(1000, refreshAfterMs - age);
  };
}

export function createAppQueryClient() {
  const client = new QueryClient({ defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 24 * 60 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchOnMount: true,
      refetchInterval: 300_000,
      refetchIntervalInBackground: false,
      retry: retryQuery,
      retryDelay: queryRetryDelay,
    },
    // Retrying a write after an uncertain response can create a second record.
    mutations: { retry: false },
  } });
  // Reference data changes infrequently. Mutations and realtime still invalidate it immediately.
  client.setQueryDefaults(['org'], { staleTime: 5 * 60_000, refetchInterval: 15 * 60_000 });
  client.setQueryDefaults(['employees'], { staleTime: 2 * 60_000 });
  // Re-sign just before expiry, rather than signing every mounted image every five minutes.
  for (const key of ['employee-avatars', 'asset-photos']) {
    client.setQueryDefaults([key], { refetchInterval: signedUrlRefreshInterval(8 * 60_000) });
  }
  client.setQueryDefaults(['chat-media-url'], { refetchInterval: signedUrlRefreshInterval(55 * 60_000) });
  return client;
}
