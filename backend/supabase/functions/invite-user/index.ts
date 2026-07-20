// Supabase Edge Function: invite-user
// Creates a login (service-role only) after verifying the caller may manage users.
// Optional in-app alternative to `backend/scripts/create_user.py`.
//
// Deploy (needs the Supabase CLI):
//   supabase functions deploy invite-user
// The frontend can then call it with the signed-in user's JWT:
//   await supabase.functions.invoke('invite-user', { body: { email, password } })
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey);

    // Identify the caller from their JWT.
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '');
    const { data: caller } = await admin.auth.getUser(jwt);
    if (!caller?.user) return json({ error: 'Not authenticated' }, 401);

    // Authorize: caller must be super admin or hold rbac.manage somewhere.
    const { data: prof } = await admin
      .from('profiles').select('is_super_admin').eq('user_id', caller.user.id).maybeSingle();
    let allowed = Boolean(prof?.is_super_admin);
    if (!allowed) {
      const { count } = await admin
        .from('role_assignments')
        .select('id, roles!inner(role_permissions!inner(permissions!inner(key)))', { count: 'exact', head: true })
        .eq('user_id', caller.user.id)
        .eq('roles.role_permissions.permissions.key', 'rbac.manage');
      allowed = (count ?? 0) > 0;
    }
    if (!allowed) return json({ error: 'Not authorized to invite users' }, 403);

    const { email, password, employee_id } = await req.json();
    if (!email) return json({ error: 'email is required' }, 400);

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password: password ?? crypto.randomUUID().slice(0, 12) + 'A1!',
      email_confirm: true,
    });
    if (error) return json({ error: error.message }, 400);

    // Optional: link to an employee.
    if (employee_id) {
      await admin.rpc('link_user_to_employee', { _user: created.user.id, _employee: employee_id });
    }
    return json({ user_id: created.user.id, email });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
