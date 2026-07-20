// Single shared Supabase client for the whole app.
// Imported only by the data-access hooks in src/data and by src/auth — never by screens directly.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// True once real project keys are present in .env.local.
export const isSupabaseConfigured = Boolean(url && anonKey);

if (!isSupabaseConfigured) {
  console.warn(
    '[supabase] Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. ' +
      'Copy .env.local.example to .env.local and fill in your Supabase keys. ' +
      'The app will load, but login and data calls will fail until configured.'
  );
}

// Use harmless placeholders when unconfigured so createClient() does not throw at import time
// (lets the dev server boot and render the login / setup screen).
export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);
