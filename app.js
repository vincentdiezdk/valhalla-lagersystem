/* ═══════════════════════════════════════════════════════════════════════
   Valhalla Gruppe – Lagersystem SPA (Supabase Edition)
   Version 2.0 – Full feature update
   ═══════════════════════════════════════════════════════════════════════ */

// ─── Supabase Client ───────────────────────────────────────────────────
let sb = null;
let supabaseUrl = '';
let supabaseAnonKey = '';

function initSupabase(url, key) {
  supabaseUrl = url;
  supabaseAnonKey = key;
  var memStore = window.__memStorage || (function() {
    var s = {};
    return {
      getItem: function(k) { return s.hasOwnProperty(k) ? s[k] : null; },
      setItem: function(k, v) { s[k] = String(v); },
      removeItem: function(k) { delete s[k]; }
    };
  })();
  sb = window.supabase.createClient(url, key, {
    auth: {
      storage: memStore,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  });
  return sb;
}
