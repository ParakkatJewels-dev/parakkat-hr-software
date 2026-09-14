import { fetchCollection } from './fetchCollection.js';

export const API_KEY_SCOPES = [
  { key: 'employees:read', label: 'Employee directory', description: 'Read work profiles and company placement.' },
  { key: 'organization:read', label: 'Organization', description: 'Read companies, zones, branches, departments and designations.' },
  { key: 'attendance:read', label: 'Attendance', description: 'Read daily attendance summaries, up to 31 days per request.' },
];
export const API_KEY_EXPIRY_DAYS = [30, 90, 365];
export const developerSettingsKey = (userId) => ['developer-settings', userId ?? null];
export const developerKeysKey = (userId) => ['developer-api-keys', userId ?? null];

const metadataFields = ['id', 'name', 'key_prefix', 'scopes', 'entity_id', 'created_at', 'expires_at', 'last_used_at', 'revoked_at'];
// An explicit allowlist prevents an accidental backend response change from moving a secret
// into a query cache. Generation uses a direct promise, never a mutation/query cache.
function keyMetadata(row) {
  if (!row || typeof row !== 'object' || typeof row.id !== 'string') {
    throw new Error('The server returned an incomplete API key record. Refresh and try again.');
  }
  return Object.fromEntries(metadataFields.map((field) => [field, field === 'scopes'
    ? (Array.isArray(row.scopes) ? row.scopes.filter((scope) => API_KEY_SCOPES.some((item) => item.key === scope)) : [])
    : row[field] ?? null]));
}

function settingsMetadata(data) {
  if (!data || typeof data.enabled !== 'boolean') throw new Error('Developer settings could not be loaded. Try again.');
  return { enabled: data.enabled, updated_at: data.updated_at ?? null };
}

async function call(client, name, args, signal, range) {
  let result;
  try {
    let request = client.rpc(name, args);
    if (range) request = request.range(...range);
    result = await (signal ? request.abortSignal(signal) : request);
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!result?.error) return result?.data;
  // Database errors can contain request values. Only fixed messages cross this boundary.
  const code = result.error.code;
  if (code === 'PGRST202') throw new Error('Developer settings are not available yet. The server needs to be updated.');
  if (['42501', 'PT403'].includes(code)) throw new Error('Only a super admin can manage developer access.');
  if (['PT401', 'PGRST301', 'PGRST302'].includes(code)) throw new Error('Your session has expired. Sign in again.');
  if (['22023', '22P02', '23503', '23514', 'PT400'].includes(code)) throw new Error('Check the key name, permissions, company and expiry, then try again.');
  if (code === 'PT404') throw new Error('This API key is no longer available. Refresh the list.');
  if (code === 'PT429') throw new Error('Too many requests. Wait a minute and try again.');
  throw new Error('Could not update developer access. Refresh and try again.');
}

export async function fetchDeveloperSettings(client, signal) {
  return settingsMetadata(await call(client, 'get_developer_settings', undefined, signal));
}

export async function fetchDeveloperKeys(client, signal) {
  // Retained expired/revoked keys must never push active credentials beyond PostgREST's row cap.
  // The RPC orders by created_at/id; fetchCollection checks overlapping page boundaries too.
  const rows = await fetchCollection(() => ({
    range: async (from, to) => ({
      data: await call(client, 'list_developer_api_keys', undefined, signal, [from, to]),
    }),
  }));
  return rows.map(keyMetadata);
}

export async function saveDeveloperSettings(client, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Choose whether API access should be enabled.');
  return settingsMetadata(await call(client, 'set_developer_settings', { _enabled: enabled }));
}

export async function createDeveloperKey(client, { name, scopes, entityId = null, expiresInDays = 90 } = {}) {
  const label = typeof name === 'string' ? name.trim() : '';
  if (!label || [...label].length > 80) throw new Error('Enter a key name of 1 to 80 characters.');
  if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => !API_KEY_SCOPES.some((item) => item.key === scope))) {
    throw new Error('Choose at least one of the available permissions.');
  }
  if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) throw new Error('Choose an expiry between 1 and 365 days.');
  if (entityId != null && (typeof entityId !== 'string' || !entityId || entityId.length > 128)) throw new Error('Choose a company or all companies.');
  const data = await call(client, 'create_developer_api_key', {
    _name: label, _scopes: [...new Set(scopes)], _entity_id: entityId, _expires_in_days: expiresInDays,
  });
  if (typeof data?.api_key !== 'string' || !data.api_key || data.api_key.length > 256) {
    throw new Error('The key could not be displayed. Refresh the list and revoke that key before creating another.');
  }
  return { api_key: data.api_key, key: keyMetadata(data.key) };
}

export async function revokeDeveloperKey(client, id) {
  if (typeof id !== 'string' || !id) throw new Error('Choose an API key to revoke.');
  await call(client, 'revoke_developer_api_key', { _key_id: id });
}

export function developerKeyStatus(key, now = Date.now()) {
  if (key.revoked_at) return 'revoked';
  if (!key.expires_at || Date.parse(key.expires_at) <= now || !Number.isFinite(Date.parse(key.expires_at))) return 'expired';
  return 'active';
}
