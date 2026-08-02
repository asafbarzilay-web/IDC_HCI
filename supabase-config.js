const SUPABASE_URL = 'https://xxjamfgxccwfeytybhgg.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_693WCPrsLK3-hrAxaAed-g_LlegKFZt';
// Each page creates its own client: the app uses an isolated, never-
// authenticated client (so a dashboard login on this same origin can't
// leak into event inserts and get them rejected by RLS), while the
// dashboard uses a persistent client for login.
