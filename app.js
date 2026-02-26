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

// ─── State ────────────────────────────────────────────────────────────────────
let currentSession = null;
let currentUser = null;
let currentRoute = 'login';
let cachedData = { categories: null, locations: null, items: null };
let html5QrCode = null;
let scannerRunning = false;
let configReady = false;
let darkTheme = false;

// ─── Dark Theme ──────────────────────────────────────────────────────────────────────
function initTheme() {
  // Check memStore first
  const stored = window.__memStorage ? window.__memStorage.getItem('valhalla_theme') : null;
  if (stored === 'dark') {
    applyTheme(true);
  } else if (stored === 'light') {
    applyTheme(false);
  } else {
    // Respect system preference
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(prefersDark);
  }
}

function applyTheme(dark) {
  darkTheme = dark;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  if (window.__memStorage) window.__memStorage.setItem('valhalla_theme', dark ? 'dark' : 'light');
}

function toggleTheme() {
  applyTheme(!darkTheme);
  toast(darkTheme ? 'Mørkt tema aktiveret' : 'Lyst tema aktiveret', 'info');
  // Update toggle button if visible
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) {
    btn.innerHTML = icon(darkTheme ? 'sun' : 'moon') + (darkTheme ? ' Lyst tema' : ' Mørkt tema');
    lucide.createIcons({ nodes: [btn] });
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-circle' : 'info';
  el.innerHTML = `<i data-lucide="${ic}"></i><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  lucide.createIcons({ nodes: [el] });
  // Haptic-style visual feedback
  el.style.transform = 'scale(1.04)';
  setTimeout(() => { el.style.transform = ''; }, 120);
  setTimeout(() => el.remove(), 3000);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function openModal(html) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-content').innerHTML = html;
  overlay.classList.add('open');
  lucide.createIcons({ nodes: [document.getElementById('modal-content')] });
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  stopScanner();
}

// ─── Router ────────────────────────────────────────────────────────────────────
function navigate(route) {
  stopScanner();
  currentRoute = route;
  window.location.hash = route;
  render();
}

function getRoute() {
  const hash = window.location.hash.slice(1) || '';
  return hash || (currentSession ? 'dashboard' : 'login');
}

window.addEventListener('hashchange', () => {
  const route = getRoute();
  if (!configReady) return;
  if (!currentSession && route !== 'login') { navigate('login'); return; }
  currentRoute = route;
  render();
});

// ─── Image Engine ───────────────────────────────────────────────────────────────────────────
const IMG_MAX_WIDTH  = 800;
const IMG_MAX_HEIGHT = 800;
const IMG_QUALITY    = 0.75;
const IMG_FORMAT     = 'image/webp';
const IMG_EXT        = '.webp';

const WEBP_SUPPORTED = (() => {
  try {
    const c = document.createElement('canvas');
    return c.toDataURL('image/webp').startsWith('data:image/webp');
  } catch { return false; }
})();

function optimizeImage(file, maxW = IMG_MAX_WIDTH, maxH = IMG_MAX_HEIGHT, quality = IMG_QUALITY) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Kunne ikke læse billedfilen'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Ugyldigt billedformat'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        if (w > maxW || h > maxH) {
          const ratio = Math.min(maxW / w, maxH / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        const format = WEBP_SUPPORTED ? IMG_FORMAT : 'image/jpeg';
        const ext    = WEBP_SUPPORTED ? IMG_EXT : '.jpg';
        canvas.toBlob(
          (blob) => {
            if (!blob) { reject(new Error('Billedkonvertering fejlede')); return; }
            resolve({ blob, format, ext, originalSize: file.size, optimizedSize: blob.size });
          },
          format,
          quality
        );
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function storageFilename(url) {
  if (!url || !url.includes('/storage/v1/object/public/images/')) return null;
  try {
    const parts = url.split('/storage/v1/object/public/images/');
    return parts[1] ? decodeURIComponent(parts[1].split('?')[0]) : null;
  } catch { return null; }
}

async function deleteStorageImage(publicUrl) {
  const filename = storageFilename(publicUrl);
  if (!filename) return;
  try {
    await sb.storage.from('images').remove([filename]);
  } catch (e) {
    console.warn('Kunne ikke slette gammelt billede:', e.message);
  }
}

async function uploadImage(blob, prefix = 'item', format, ext) {
  const contentType = format || (WEBP_SUPPORTED ? IMG_FORMAT : 'image/jpeg');
  const fileExt = ext || (WEBP_SUPPORTED ? IMG_EXT : '.jpg');
  const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${fileExt}`;
  const { error } = await sb.storage.from('images').upload(filename, blob, {
    contentType,
    upsert: false
  });
  if (error) throw new Error('Billedupload fejlede: ' + error.message);
  const { data } = sb.storage.from('images').getPublicUrl(filename);
  return data.publicUrl;
}

// ─── Formatters ────────────────────────────────────────────────────────────────────
function formatDate(d) {
  if (!d) return '–';
  const dt = new Date(d);
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' });
}
function formatTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return dt.toLocaleDateString('da-DK', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function isOverdue(expectedReturn) {
  if (!expectedReturn) return false;
  return new Date(expectedReturn) < new Date();
}
function isAdmin() { return currentUser && currentUser.role === 'admin'; }

// ─── Expiry helpers ────────────────────────────────────────────────────────────────────
function expiryStatus(expiryDate) {
  if (!expiryDate) return null;
  const now = new Date();
  const exp = new Date(expiryDate);
  const diffDays = Math.floor((exp - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return 'expired';
  if (diffDays < 7) return 'critical';
  if (diffDays <= 30) return 'warning';
  return 'ok';
}

function expiryBadge(expiryDate) {
  if (!expiryDate) return '';
  const status = expiryStatus(expiryDate);
  const daysLeft = Math.floor((new Date(expiryDate) - new Date()) / (1000 * 60 * 60 * 24));
  const colors = {
    expired: 'expiry-expired',
    critical: 'expiry-critical',
    warning: 'expiry-warning',
    ok: 'expiry-ok'
  };
  const labels = {
    expired: `Udløbet (${formatDate(expiryDate)})`,
    critical: `Udløber om ${daysLeft} dag${daysLeft === 1 ? '' : 'e'}`,
    warning: `Udløber om ${daysLeft} dage`,
    ok: `Udløber ${formatDate(expiryDate)}`
  };
  return `<span class="expiry-badge ${colors[status]}">${icon('calendar')} ${labels[status]}</span>`;
}

// ─── Lucide icon helper ────────────────────────────────────────────────────────────────────
function icon(name, cls = '') {
  return `<i data-lucide="${name}" class="${cls}"></i>`;
}

// ─── Image tag helper ─────────────────────────────────────────────────────────────────────
function handleImgError(el) {
  el.style.display = 'none';
  const placeholder = document.createElement('div');
  placeholder.className = 'placeholder-icon';
  placeholder.innerHTML = '<i data-lucide="package"></i>';
  el.parentElement.appendChild(placeholder);
  lucide.createIcons({ nodes: [placeholder] });
}

function itemImage(url, size = 'card') {
  if (url) {
    const src = url.startsWith('http') ? url : './' + url;
    return '<img src="' + src + '" alt="" onerror="handleImgError(this)">';
  }
  return '<div class="placeholder-icon">' + icon('package') + '</div>';
}

// ─── Scanner ──────────────────────────────────────────────────────────────────────
function stopScanner() {
  if (html5QrCode && scannerRunning) {
    try { html5QrCode.stop().catch(() => {}); } catch(e) {}
    scannerRunning = false;
  }
}

// ─── Activity Log Helper ───────────────────────────────────────────────────────────────────
async function logActivity(action, entityType, entityId, description, metadata = {}) {
  if (!currentSession) return;
  try {
    await sb.from('activity_log').insert({
      user_id: currentSession.user.id,
      action,
      entity_type: entityType,
      entity_id: entityId ? String(entityId) : null,
      description,
      metadata: metadata || {}
    });
  } catch(e) {
    console.warn('logActivity fejl:', e.message);
  }
}

// ─── RENDER ────────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');

  if (!configReady) {
    app.innerHTML = renderConfigScreen();
    lucide.createIcons({ nodes: [app] });
    setupConfigHandlers();
    return;
  }

  if (!currentSession || currentRoute === 'login') {
    app.innerHTML = renderLogin();
    lucide.createIcons({ nodes: [app] });
    setupLoginHandlers();
    return;
  }
  app.innerHTML = renderAppShell();
  lucide.createIcons({ nodes: [app] });
  renderPage();
}