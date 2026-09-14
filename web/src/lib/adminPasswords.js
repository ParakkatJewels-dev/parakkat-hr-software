import { MIN_LENGTH, passwordProblem } from './passwordRules.js';

export const MAX_TEMPORARY_PASSWORD_BYTES = 72;

export function temporaryPasswordProblem(password, confirm, target) {
  // PostgreSQL counts Unicode characters, whereas String.length counts UTF-16 code units.
  if ([...password].length < MIN_LENGTH) return `At least ${MIN_LENGTH} characters`;
  if (new TextEncoder().encode(password).length > MAX_TEMPORARY_PASSWORD_BYTES) return 'Use a password of at most 72 bytes (special characters may use more than one).';
  const problem = passwordProblem(password, { name: target.employee_name, email: target.email });
  if (problem) return problem.id === 'not-name' ? "Do not use this person's name or email in the password." : problem.label;
  if (password !== confirm) return 'Passwords do not match.';
  return null;
}

// Use only the privileged target-user RPC. auth.updateUser would change the signed-in admin.
// Only fixed messages escape this boundary: a database error must never echo the submitted secret.
export async function setManagedUserPassword(client, { user_id, password }) {
  let result;
  try {
    result = await client.rpc('admin_set_user_password', { _user_id: user_id, _password: password });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  if (!result.error) return;
  if (result.error.code === 'PGRST202') throw new Error('Password management is not available yet. The server needs to be updated.');
  if (result.error.code === '42501') throw new Error('You do not have permission to change this account’s password.');
  throw new Error('Could not set the temporary password. Check the password rules and try again.');
}
