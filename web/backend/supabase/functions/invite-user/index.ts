// Supabase Edge Function: invite-user
// Creates a login through the same atomic, super-admin-only RPC as Administration.
// Optional in-app alternative to `backend/scripts/create_user.py`.
//
// Deploy (needs the Supabase CLI):
//   supabase functions deploy invite-user
// The frontend can then call it with the signed-in user's JWT:
//   await supabase.functions.invoke('invite-user', { body: { email, password } })
//
// SUPABASE_URL and SUPABASE_ANON_KEY are injected by the platform. No service-role bypass.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    if (!jwt) return json({ error: 'Not authenticated' }, 401);
    const callerClient = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: caller } = await callerClient.auth.getUser(jwt);
    if (!caller?.user) return json({ error: 'Not authenticated' }, 401);

    const { email, password, employee_id } = await req.json();
    if (!email) return json({ error: 'email is required' }, 400);

    // The RPC checks the verified caller's super-admin flag OR role assignment. Linking failure
    // rolls back the login too; the old second request silently ignored linking errors.
    const { data: userId, error } = await callerClient.rpc('admin_create_user_with_employee', {
      _email: email,
      _password: password ?? crypto.randomUUID().slice(0, 12) + 'A1!',
      _employee: employee_id ?? null,
      _super_admin: false,
    });
    if (error) return json({ error: error.message }, error.message.includes('only a super admin') ? 403 : 400);
    return json({ user_id: userId, email });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
