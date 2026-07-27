// Client for the attendance service (services/attendance).
//
// Most screens read straight from Supabase, where RLS enforces the Role x Scope rules. This client
// is only for the things PostgREST cannot do: triggering a sync or recompute, mapping device codes,
// and generating Excel files. It forwards the caller's Supabase access token, and the service
// verifies it and re-reads their permissions — so the same grants apply on both paths.
import { supabase } from './supabaseClient';

const BASE_URL = (import.meta.env.VITE_ATTENDANCE_API_URL || 'http://localhost:8091').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new ApiError('Not signed in.', 401);
  return { Authorization: `Bearer ${token}` };
}

function buildUrl(path, params) {
  const url = new URL(BASE_URL + path);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return url.toString();
}

async function parse(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message =
      (body && typeof body === 'object' && (body.message || body.error)) ||
      `Request failed (HTTP ${response.status})`;
    throw new ApiError(message, response.status, body);
  }

  return body;
}

/** Network failures get a message that names the likely cause, not "Failed to fetch". */
function wrapNetworkError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError(
    `Cannot reach the attendance service at ${BASE_URL}. It may be switched off, on a network this device cannot reach, or blocking this website's origin (CORS).`,
    0,
    null
  );
}

export async function apiGet(path, params) {
  try {
    const response = await fetch(buildUrl(path, params), { headers: await authHeader() });
    return await parse(response);
  } catch (err) {
    throw wrapNetworkError(err);
  }
}

export async function apiPost(path, body) {
  try {
    const response = await fetch(buildUrl(path), {
      method: 'POST',
      headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return await parse(response);
  } catch (err) {
    throw wrapNetworkError(err);
  }
}

/** Fetch a generated .xlsx and hand it to the browser as a download. */
export async function apiDownload(path, params, filename) {
  let response;
  try {
    response = await fetch(buildUrl(path, params), { headers: await authHeader() });
  } catch (err) {
    throw wrapNetworkError(err);
  }

  if (!response.ok) {
    await parse(response); // throws with the server's message
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick — Safari cancels the download if the URL dies too early.
  setTimeout(() => URL.revokeObjectURL(url), 2_000);
}

/** Is the service reachable? Used to grey out actions that need it rather than failing on click. */
export async function apiHealth() {
  try {
    const response = await fetch(`${BASE_URL}/health`);
    return await response.json();
  } catch {
    return { status: 'unreachable' };
  }
}

export const ATTENDANCE_API_URL = BASE_URL;
