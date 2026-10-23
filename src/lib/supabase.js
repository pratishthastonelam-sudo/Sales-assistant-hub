import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

if (!supabaseConfigured) {
  console.warn(
    '[Sales Assistant Hub] Missing Supabase env vars.\n' +
      'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in your .env file.\n' +
      'See .env.example for reference.'
  )
}

export const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'placeholder-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
)

// Edge Function URL — deployed or local
export const EDGE_FUNCTION_URL =
  import.meta.env.VITE_EDGE_FUNCTION_URL ||
  `${supabaseUrl}/functions/v1/process_chat_query`

// Turns low-level network failures into a message the sales team can act on
export function friendlyAuthError(message = '') {
  if (!supabaseConfigured) {
    return 'App is not configured: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing from this build.'
  }
  const m = message.toLowerCase()
  if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('load failed')) {
    return 'Cannot reach the login server. The Supabase project may be paused or its URL changed. Please contact the admin.'
  }
  if (m.includes('database error saving new user') || m.includes('company email')) {
    return 'Please sign up with your company email address.'
  }
  if (m.includes('invalid api key') || m.includes('no api key')) {
    return 'The app\'s Supabase API key is invalid or was rotated. Please contact the admin.'
  }
  return message
}
