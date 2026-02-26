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

// ─── State ─────────────────────────────────────────────────────────────
let currentSession = null;
let currentUser = null;
let currentRoute = 'login';
let cachedData = { categories: null, locations: null, items: null };
let html5QrCode = null;
let scannerRunning = false;
let configReady = false;
let darkTheme = false;

// ─── Dark Theme ─────────────────────────────────────────────────────────
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

// ─── Toast ─────────────────────────────────────────────────────────────
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

// ─── Modal ─────────────────────────────────────────────────────────────
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

// ─── Router ────────────────────────────────────────────────────────────
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

// ─── Image Engine ────────────────────────────────────────────────────
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

// ─── Formatters ────────────────────────────────────────────────────────
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

// ─── Expiry helpers ────────────────────────────────────────────────────
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

// ─── Lucide icon helper ────────────────────────────────────────────────
function icon(name, cls = '') {
  return `<i data-lucide="${name}" class="${cls}"></i>`;
}

// ─── Image tag helper ──────────────────────────────────────────────────
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

// ─── Scanner ───────────────────────────────────────────────────────────
function stopScanner() {
  if (html5QrCode && scannerRunning) {
    try { html5QrCode.stop().catch(() => {}); } catch(e) {}
    scannerRunning = false;
  }
}

// ─── Activity Log Helper ───────────────────────────────────────────────
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

// ─── RENDER ────────────────────────────────────────────────────────────
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

// ─── Config Screen ─────────────────────────────────────────────────────
function renderConfigScreen() {
  return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="compass-icon">${icon('compass')}</div>
          <h1>Valhalla Gruppe</h1>
          <p>Lagersystem – Konfiguration</p>
        </div>
        <div class="login-error" id="config-error"></div>
        <form id="config-form">
          <div class="form-group">
            <label>Supabase Project URL</label>
            <input type="url" class="form-input" id="config-url" placeholder="https://xxxxx.supabase.co" required>
          </div>
          <div class="form-group">
            <label>Supabase Anon Key</label>
            <input type="text" class="form-input" id="config-key" placeholder="eyJhbGci..." required>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="config-btn">
            ${icon('plug')} Forbind
          </button>
          <p style="text-align:center;margin-top:12px;font-size:13px;color:var(--text-3)">
            Find disse i dit Supabase dashboard under Settings → API
          </p>
        </form>
      </div>
    </div>`;
}

function setupConfigHandlers() {
  const form = document.getElementById('config-form');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const url = document.getElementById('config-url').value.trim().replace(/\/+$/, '');
    const key = document.getElementById('config-key').value.trim();
    const btn = document.getElementById('config-btn');
    const errEl = document.getElementById('config-error');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width:20px;height:20px;border-width:2px;"></span> Forbinder...`;
    try {
      initSupabase(url, key);
      const { error } = await sb.from('categories').select('id').limit(1);
      if (error) throw new Error(error.message);
      configReady = true;
      const { data: { session } } = await sb.auth.getSession();
      if (session) {
        currentSession = session;
        await loadProfile();
        navigate('dashboard');
      } else {
        navigate('login');
      }
    } catch (err) {
      errEl.textContent = 'Kunne ikke forbinde: ' + err.message;
      errEl.classList.add('visible');
      btn.disabled = false;
      btn.innerHTML = `${icon('plug')} Forbind`;
      lucide.createIcons({ nodes: [btn] });
    }
  };
}

// ─── Login ─────────────────────────────────────────────────────────────
function renderLogin() {
  return `
    <div class="login-page">
      <div class="login-card">
        <div class="login-logo">
          <div class="compass-icon">${icon('compass')}</div>
          <h1>Valhalla Gruppe</h1>
          <p>Lagersystem</p>
        </div>
        <div class="login-error" id="login-error"></div>
        <form id="login-form">
          <div class="form-group">
            <label>Email</label>
            <input type="email" class="form-input" id="login-email" placeholder="din@email.dk" autocomplete="email" required>
          </div>
          <div class="form-group">
            <label>Adgangskode</label>
            <input type="password" class="form-input" id="login-pass" placeholder="Din adgangskode" autocomplete="current-password" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block btn-lg" id="login-btn">
            ${icon('log-in')} Log ind
          </button>
        </form>
      </div>
    </div>`;
}

function setupLoginHandlers() {
  const form = document.getElementById('login-form');
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-pass').value;
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner" style="width:20px;height:20px;border-width:2px;"></span> Logger ind...`;

    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      currentSession = data.session;
      await loadProfile();
      navigate('dashboard');
    } catch (err) {
      errEl.textContent = err.message || 'Ukendt fejl';
      errEl.classList.add('visible');
      btn.disabled = false;
      btn.innerHTML = `${icon('log-in')} Log ind`;
      lucide.createIcons({ nodes: [btn] });
    }
  };
}

async function loadProfile() {
  if (!currentSession) return;
  const { data, error } = await sb
    .from('profiles')
    .select('*')
    .eq('id', currentSession.user.id)
    .single();
  if (error) {
    await new Promise(r => setTimeout(r, 1000));
    const retry = await sb.from('profiles').select('*').eq('id', currentSession.user.id).single();
    if (retry.error) {
      const email = currentSession.user.email || '';
      const { count } = await sb.from('profiles').select('*', { count: 'exact', head: true });
      const firstUserRole = (count === 0 || count === null) ? 'admin' : 'leader';
      const { error: upsertErr } = await sb.from('profiles').upsert({
        id: currentSession.user.id,
        username: email,
        display_name: email.split('@')[0],
        role: firstUserRole
      });
      if (!upsertErr) {
        const fresh = await sb.from('profiles').select('*').eq('id', currentSession.user.id).single();
        currentUser = fresh.data || {
          id: currentSession.user.id,
          username: email,
          display_name: email.split('@')[0],
          role: 'leader'
        };
      } else {
        currentUser = {
          id: currentSession.user.id,
          username: email,
          display_name: email.split('@')[0],
          role: 'leader'
        };
      }
      return;
    }
    currentUser = retry.data;
  } else {
    currentUser = data;
  }
}

// ─── App Shell ─────────────────────────────────────────────────────────
function renderAppShell() {
  const adminLinks = isAdmin() ? `
    <div class="nav-section-label">Administration</div>
    <div class="nav-link" data-route="categories">${icon('tags')} Kategorier</div>
    <div class="nav-link" data-route="locations">${icon('map-pin')} Lokationer</div>
    <div class="nav-link" data-route="users">${icon('users')} Brugere</div>
    <div class="nav-link" data-route="sets">${icon('boxes')} Sæt</div>
    <div class="nav-link" data-route="trips">${icon('map')} Ture</div>
  ` : '';

  const initials = currentUser ? currentUser.display_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) : '?';

  return `
    <!-- Mobile Top Bar -->
    <div class="mobile-topbar">
      <div class="mobile-topbar-title">${icon('compass')} Valhalla Gruppe</div>
      <div class="mobile-topbar-user">
        <button onclick="toggleTheme()" title="Skift tema" style="margin-right:4px">${icon(darkTheme ? 'sun' : 'moon')}</button>
        <button onclick="handleLogout()" title="Log ud">${icon('log-out')}</button>
      </div>
    </div>

    <!-- Side Nav (Desktop) -->
    <div class="app-layout">
      <nav class="side-nav">
        <div class="side-nav-header">
          ${icon('compass')}
          <div><h2>Valhalla Gruppe</h2><span>Lagersystem</span></div>
        </div>
        <div class="nav-section-label">Oversigt</div>
        <div class="nav-link" data-route="dashboard">${icon('layout-dashboard')} Dashboard</div>
        <div class="nav-link" data-route="items">${icon('package')} Materiale</div>
        <div class="nav-link" data-route="sets">${icon('boxes')} Sæt</div>
        <div class="nav-link" data-route="loans">${icon('hand-helping')} Udlån <span class="badge" id="nav-loans-badge" style="display:none"></span></div>
        <div class="nav-link" data-route="reports">${icon('alert-triangle')} Rapporter <span class="badge" id="nav-reports-badge" style="display:none"></span></div>
        <div class="nav-link" data-route="kitchen">${icon('scan-barcode')} Køkken / Scanner</div>
        <div class="nav-link" data-route="history">${icon('scroll-text')} Historik</div>
        <div class="nav-link" data-route="shopping">${icon('shopping-cart')} Indkøbsliste</div>
        ${adminLinks}
        <div class="nav-spacer"></div>
        <div class="nav-user-section">
          <div class="nav-user-info">
            <div class="nav-user-avatar">${initials}</div>
            <div>
              <div class="nav-user-name">${currentUser?.display_name || ''}</div>
              <div class="nav-user-role">${currentUser?.role === 'admin' ? 'Administrator' : 'Leder'}</div>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm w-full" id="theme-toggle-btn" onclick="toggleTheme()">${icon(darkTheme ? 'sun' : 'moon')} ${darkTheme ? 'Lyst tema' : 'Mørkt tema'}</button>
          <button class="btn btn-ghost btn-sm w-full" onclick="handleLogout()" style="margin-top:4px">${icon('log-out')} Log ud</button>
        </div>
      </nav>

      <!-- Main Content -->
      <main class="main-content" id="main-content"></main>
    </div>

    <!-- Bottom Nav (Mobile) -->
    <nav class="bottom-nav">
      <div class="bottom-nav-items">
        <button class="bottom-nav-item" data-route="dashboard">${icon('layout-dashboard')}<span>Hjem</span></button>
        <button class="bottom-nav-item" data-route="items">${icon('package')}<span>Materiale</span></button>
        <button class="bottom-nav-item" data-route="loans">${icon('hand-helping')}<span>Udlån</span></button>
        <button class="bottom-nav-item" data-route="kitchen">${icon('scan-barcode')}<span>Scanner</span></button>
        <button class="bottom-nav-item" data-route="more-menu" id="more-menu-btn">${icon('menu')}<span>Mere</span></button>
      </div>
    </nav>`;
}

function renderPage() {
  const main = document.getElementById('main-content');
  if (!main) return;

  // Update active nav links
  document.querySelectorAll('.nav-link').forEach(el => {
    el.classList.toggle('active', el.dataset.route === currentRoute);
    el.onclick = () => navigate(el.dataset.route);
  });
  document.querySelectorAll('.bottom-nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.route === currentRoute);
    if (el.id === 'more-menu-btn') {
      el.onclick = () => showMoreMenu();
    } else {
      el.onclick = () => navigate(el.dataset.route);
    }
  });

  // Pull-to-refresh
  setupPullToRefresh(main);

  const route = currentRoute.split('/');
  switch(route[0]) {
    case 'dashboard':  renderDashboard(main); break;
    case 'items':      renderItems(main); break;
    case 'sets':       renderSets(main); break;
    case 'loans':      renderLoans(main); break;
    case 'reports':    renderReports(main); break;
    case 'kitchen':    renderKitchen(main); break;
    case 'history':    renderHistory(main); break;
    case 'shopping':   renderShoppingList(main); break;
    case 'trips':      isAdmin() ? renderTrips(main) : navigate('dashboard'); break;
    case 'categories': isAdmin() ? renderCategories(main) : navigate('dashboard'); break;
    case 'locations':  isAdmin() ? renderLocations(main) : navigate('dashboard'); break;
    case 'users':      isAdmin() ? renderUsers(main) : navigate('dashboard'); break;
    default: navigate('dashboard');
  }
}

// ─── More Menu (mobile) ──────────────────────────────────────────────
function showMoreMenu() {
  const adminItems = isAdmin() ? `
    <button class="more-menu-item" onclick="closeModal();navigate('sets')">${icon('boxes')} Sæt</button>
    <button class="more-menu-item" onclick="closeModal();navigate('trips')">${icon('map')} Ture</button>
    <button class="more-menu-item" onclick="closeModal();navigate('categories')">${icon('tags')} Kategorier</button>
    <button class="more-menu-item" onclick="closeModal();navigate('locations')">${icon('map-pin')} Lokationer</button>
    <button class="more-menu-item" onclick="closeModal();navigate('users')">${icon('users')} Brugere</button>
  ` : `
    <button class="more-menu-item" onclick="closeModal();navigate('sets')">${icon('boxes')} Sæt</button>
  `;

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>Mere</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body" style="padding:12px">
      <button class="more-menu-item" onclick="closeModal();navigate('reports')">${icon('alert-triangle')} Rapporter</button>
      <button class="more-menu-item" onclick="closeModal();navigate('history')">${icon('scroll-text')} Historik</button>
      <button class="more-menu-item" onclick="closeModal();navigate('shopping')">${icon('shopping-cart')} Indkøbsliste</button>
      ${adminItems}
      <hr style="margin:8px 0;border:none;border-top:1px solid var(--border)">
      <button class="more-menu-item" onclick="closeModal();toggleTheme()">${icon(darkTheme ? 'sun' : 'moon')} ${darkTheme ? 'Lyst tema' : 'Mørkt tema'}</button>
      <button class="more-menu-item danger" onclick="closeModal();handleLogout()">${icon('log-out')} Log ud</button>
    </div>`);
}

// ─── Pull-to-Refresh ─────────────────────────────────────────────────
function setupPullToRefresh(el) {
  let startY = 0, pulling = false;
  let indicator = null;

  el.addEventListener('touchstart', (e) => {
    if (el.scrollTop === 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const delta = e.touches[0].clientY - startY;
    if (delta > 10 && el.scrollTop === 0) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'pull-indicator';
        indicator.innerHTML = icon('refresh-cw');
        el.prepend(indicator);
        lucide.createIcons({ nodes: [indicator] });
      }
      const progress = Math.min(delta / 80, 1);
      indicator.style.opacity = String(progress);
      indicator.style.transform = `translateY(${Math.min(delta * 0.4, 32)}px) rotate(${progress * 180}deg)`;
    }
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    if (!pulling || !indicator) { pulling = false; return; }
    const delta = e.changedTouches[0].clientY - startY;
    pulling = false;
    if (delta > 80) {
      indicator.innerHTML = '<span class="spinner" style="width:20px;height:20px;border-width:2px;display:inline-block"></span>';
      setTimeout(() => {
        if (indicator) indicator.remove();
        indicator = null;
        renderPage();
        toast('Opdateret', 'info');
      }, 700);
    } else {
      indicator.remove();
      indicator = null;
    }
  });
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────
async function renderDashboard(el) {
  el.innerHTML = `<div class="page-body"><div class="loading-spinner"><div class="spinner"></div></div></div>`;
  try {
    const [
      { count: totalItems },
      { count: activeLoans },
      { count: openReports },
      { data: lowStockItems },
      { data: overdueLoans },
      { data: recentLoansData },
      { data: recentReportsData },
      { data: recentFoodData },
      { data: expiringItems }
    ] = await Promise.all([
      sb.from('items').select('*', { count: 'exact', head: true }),
      sb.from('loans').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      sb.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      sb.from('items').select('id, quantity, min_quantity').eq('type', 'food'),
      sb.from('loans').select('id').eq('status', 'active').not('expected_return', 'is', null).lt('expected_return', new Date().toISOString().split('T')[0]),
      sb.from('loans').select('*, items!loans_item_id_fkey(name, image_url), profiles!loans_user_id_fkey_profiles(display_name)').order('loan_date', { ascending: false }).limit(5),
      sb.from('reports').select('*, items!reports_item_id_fkey(name, image_url), profiles!reports_user_id_fkey_profiles(display_name)').order('created_at', { ascending: false }).limit(5),
      sb.from('food_log').select('*, items!food_log_item_id_fkey(name, image_url), profiles!food_log_user_id_fkey_profiles(display_name)').order('created_at', { ascending: false }).limit(5),
      sb.from('items').select('id, name, expiry_date, quantity').eq('type', 'food').not('expiry_date', 'is', null).lte('expiry_date', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]).order('expiry_date')
    ]);

    const lowStock = (lowStockItems || []).filter(i => i.quantity <= i.min_quantity).length;
    const overdueCount = (overdueLoans || []).length;

    const s = {
      total_items: totalItems || 0,
      active_loans: activeLoans || 0,
      open_reports: openReports || 0,
      low_stock: lowStock,
      overdue_loans: overdueCount
    };

    const recentLoans = (recentLoansData || []).map(l => ({
      ...l,
      item_name: l.items?.name || 'Ukendt',
      item_image: l.items?.image_url || '',
      user_name: l.profiles?.display_name || 'Ukendt'
    }));
    const recentReports = (recentReportsData || []).map(r => ({
      ...r,
      item_name: r.items?.name || 'Ukendt',
      item_image: r.items?.image_url || '',
      user_name: r.profiles?.display_name || 'Ukendt'
    }));
    const recentFood = (recentFoodData || []).map(f => ({
      ...f,
      item_name: f.items?.name || 'Ukendt',
      item_image: f.items?.image_url || '',
      user_name: f.profiles?.display_name || 'Ukendt'
    }));

    const expiryWidget = (expiringItems && expiringItems.length > 0) ? `
      <h3 class="section-title">${icon('clock')} Snart udløber</h3>
      <div class="expiry-widget">
        ${(expiringItems || []).slice(0, 5).map(item => {
          const st = expiryStatus(item.expiry_date);
          return `<div class="expiry-item expiry-item-${st}" onclick="showItemDetail('${item.id}')">
            <div class="expiry-item-name">${esc(item.name)}</div>
            <div>${expiryBadge(item.expiry_date)}</div>
          </div>`;
        }).join('')}
        ${expiringItems.length > 5 ? `<div class="expiry-more" onclick="navigate('kitchen')">+${expiringItems.length - 5} flere – se alle ${icon('arrow-right')}</div>` : ''}
      </div>` : '';

    el.innerHTML = `
      <div class="page-body">
        <div class="welcome-banner">
          <h2>Velkommen, ${esc(currentUser.display_name)}!</h2>
          <p>Her er en oversigt over Valhalla Gruppes lager</p>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon green">${icon('package')}</div>
            <div class="stat-info"><h3>${s.total_items}</h3><p>Total materiale</p></div>
          </div>
          <div class="stat-card">
            <div class="stat-icon blue">${icon('hand-helping')}</div>
            <div class="stat-info"><h3>${s.active_loans}</h3><p>Aktive udlån</p></div>
          </div>
          <div class="stat-card ${s.open_reports > 0 ? 'warning' : ''}">
            <div class="stat-icon ${s.open_reports > 0 ? 'red' : 'amber'}">${icon('alert-triangle')}</div>
            <div class="stat-info"><h3>${s.open_reports}</h3><p>Åbne rapporter</p></div>
          </div>
          <div class="stat-card ${s.low_stock > 0 ? 'warning' : ''}">
            <div class="stat-icon ${s.low_stock > 0 ? 'red' : 'amber'}">${icon('cookie')}</div>
            <div class="stat-info"><h3>${s.low_stock}</h3><p>Lavt lager (mad)</p></div>
          </div>
        </div>

        <div class="quick-actions">
          <button class="btn btn-primary" onclick="navigate('loans');setTimeout(()=>showLoanForm(),100)">${icon('plus-circle')} Nyt udlån</button>
          <button class="btn btn-outline" onclick="navigate('reports');setTimeout(()=>showReportForm(),100)">${icon('alert-triangle')} Rapportér problem</button>
          <button class="btn btn-secondary" onclick="navigate('kitchen')">${icon('scan-barcode')} Skan madvare</button>
        </div>

        ${expiryWidget}

        <h3 class="section-title">${icon('clock')} Seneste aktivitet</h3>
        <div class="activity-feed">
          ${renderActivityFeed({ recent_loans: recentLoans, recent_reports: recentReports, recent_food: recentFood })}
        </div>
      </div>`;
    lucide.createIcons({ nodes: [el] });
    updateNavBadges(s);
  } catch (err) {
    el.innerHTML = `<div class="page-body"><div class="empty-state">${icon('wifi-off')}<h3>Kunne ikke hente data</h3><p>${esc(err.message)}</p></div></div>`;
    lucide.createIcons({ nodes: [el] });
  }
}

function renderActivityFeed(data) {
  const items = [];
  (data.recent_loans || []).forEach(l => {
    items.push({
      type: 'loan',
      text: `<strong>${esc(l.user_name)}</strong> lånte <strong>${esc(l.item_name)}</strong>${l.purpose === 'scout_trip' ? ` (${esc(l.trip_name || 'Spejdertur')})` : ''}`,
      time: l.loan_date
    });
  });
  (data.recent_reports || []).forEach(r => {
    const typeLabel = r.type === 'missing' ? 'manglende' : 'beskadiget';
    items.push({
      type: 'report',
      text: `<strong>${esc(r.user_name)}</strong> rapporterede <strong>${esc(r.item_name)}</strong> som ${typeLabel}`,
      time: r.created_at
    });
  });
  (data.recent_food || []).forEach(f => {
    const actionLabels = { added: 'tilføjede', used: 'brugte', empty: 'markerede TOM' };
    items.push({
      type: 'food',
      text: `<strong>${esc(f.user_name)}</strong> ${actionLabels[f.action] || f.action} <strong>${esc(f.item_name)}</strong>`,
      time: f.created_at
    });
  });
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  if (items.length === 0) return `<div class="activity-empty">Ingen aktivitet endnu</div>`;
  return items.slice(0, 10).map(i => `
    <div class="activity-item">
      <div class="activity-icon ${i.type}">${icon(i.type === 'loan' ? 'hand-helping' : i.type === 'report' ? 'alert-triangle' : 'cooking-pot')}</div>
      <div class="activity-text">${i.text}</div>
      <div class="activity-time">${formatTime(i.time)}</div>
    </div>`).join('');
}

function updateNavBadges(stats) {
  const lb = document.getElementById('nav-loans-badge');
  const rb = document.getElementById('nav-reports-badge');
  if (lb) { if (stats.overdue_loans > 0) { lb.textContent = stats.overdue_loans; lb.style.display = ''; } else { lb.style.display = 'none'; } }
  if (rb) { if (stats.open_reports > 0) { rb.textContent = stats.open_reports; rb.style.display = ''; } else { rb.style.display = 'none'; } }
}

// ─── ITEMS ─────────────────────────────────────────────────────────────
async function renderItems(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Materiale</h1>
      <div class="page-header-actions">
        ${isAdmin() ? `<button class="btn btn-outline btn-sm" onclick="exportItemsPDF()">${icon('file-down')} PDF</button>` : ''}
        ${isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="showItemForm()">${icon('plus')} Tilføj nyt</button>` : ''}
      </div>
    </div>
    <div class="page-body">
      <div class="filters-bar">
        <div class="search-input-wrap">
          ${icon('search')}
          <input type="text" class="form-input" id="items-search" placeholder="Søg efter materiale...">
        </div>
        <div class="filter-chips" id="items-type-filter">
          <button class="filter-chip active" data-type="">Alle</button>
          <button class="filter-chip" data-type="equipment">Udstyr</button>
          <button class="filter-chip" data-type="food">Madvarer</button>
        </div>
      </div>
      <div class="filters-bar">
        <select class="form-input filter-select" id="items-cat-filter"><option value="">Alle kategorier</option></select>
        <select class="form-input filter-select" id="items-loc-filter"><option value="">Alle lokationer</option></select>
      </div>
      <div id="items-grid" class="items-grid"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>
    ${isAdmin() ? `<button class="fab" onclick="showItemForm()" title="Tilføj nyt materiale">${icon('plus')}</button>` : ''}`;
  lucide.createIcons({ nodes: [el] });

  const [categories, locations] = await Promise.all([loadCategories(), loadLocations()]);
  const catSel = document.getElementById('items-cat-filter');
  const locSel = document.getElementById('items-loc-filter');
  categories.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; catSel.appendChild(o); });
  locations.forEach(l => { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.room_name}${l.shelf_name ? ' – ' + l.shelf_name : ''}`; locSel.appendChild(o); });

  let currentType = '', currentCat = '', currentLoc = '', searchTimeout;
  const loadItemsList = async () => {
    const q = document.getElementById('items-search')?.value || '';

    let query = sb
      .from('items')
      .select('*, locations(room_name, shelf_name), item_categories(categories(id, name, icon))')
      .order('name');

    if (currentType) query = query.eq('type', currentType);
    if (currentLoc) query = query.eq('location_id', currentLoc);
    if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,barcode.ilike.%${q}%`);

    const { data: items, error } = await query;
    if (error) { toast(error.message, 'error'); return; }

    let filtered = items || [];
    if (currentCat) {
      filtered = filtered.filter(item =>
        (item.item_categories || []).some(ic => ic.categories?.id === currentCat)
      );
    }

    // Sort food by expiry date if food filter is active
    if (currentType === 'food') {
      filtered.sort((a, b) => {
        if (!a.expiry_date && !b.expiry_date) return 0;
        if (!a.expiry_date) return 1;
        if (!b.expiry_date) return -1;
        return new Date(a.expiry_date) - new Date(b.expiry_date);
      });
    }

    const flatItems = filtered.map(item => ({
      ...item,
      room_name: item.locations?.room_name || '',
      shelf_name: item.locations?.shelf_name || '',
      categories: (item.item_categories || []).map(ic => ic.categories).filter(Boolean)
    }));

    renderItemsGrid(flatItems);
  };

  document.querySelectorAll('#items-type-filter .filter-chip').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#items-type-filter .filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentType = btn.dataset.type;
      loadItemsList();
    };
  });
  catSel.onchange = () => { currentCat = catSel.value; loadItemsList(); };
  locSel.onchange = () => { currentLoc = locSel.value; loadItemsList(); };
  document.getElementById('items-search').oninput = () => { clearTimeout(searchTimeout); searchTimeout = setTimeout(loadItemsList, 300); };

  loadItemsList();
}

function renderItemsGrid(items) {
  const grid = document.getElementById('items-grid');
  if (!grid) return;
  if (items.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${icon('search')}<h3>Ingen resultater</h3><p>Prøv at ændre dine filtre</p></div>`;
    lucide.createIcons({ nodes: [grid] });
    return;
  }
  grid.innerHTML = items.map(item => {
    const isLow = item.type === 'food' && item.quantity <= item.min_quantity;
    const loc = item.room_name ? `${item.room_name}${item.shelf_name ? ' · ' + item.shelf_name : ''}` : '';
    const expiry = item.type === 'food' && item.expiry_date ? expiryBadge(item.expiry_date) : '';
    return `
      <div class="item-card" onclick="showItemDetail('${item.id}')">
        <div class="item-card-image">
          ${itemImage(item.image_url)}
          <div class="item-card-qty ${isLow ? 'low' : ''}">${item.quantity} stk</div>
        </div>
        <div class="item-card-body">
          <div class="item-card-name">${esc(item.name)}</div>
          ${loc ? `<div class="item-card-meta">${icon('map-pin')} ${esc(loc)}</div>` : ''}
          ${expiry ? `<div style="margin-bottom:6px">${expiry}</div>` : ''}
          <div class="item-card-tags">
            ${item.type === 'food' ? `<span class="tag food">Madvare</span>` : ''}
            ${(item.categories || []).slice(0, 3).map(c => `<span class="tag">${esc(c.name)}</span>`).join('')}
          </div>
        </div>
      </div>`;
  }).join('');
  lucide.createIcons({ nodes: [grid] });

  // Swipe-to-delete for admin
  if (isAdmin()) {
    setupSwipeToDelete(grid);
  }
}

function setupSwipeToDelete(container) {
  container.querySelectorAll('.item-card').forEach(card => {
    let startX = 0, startY = 0, swiping = false;
    card.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = false;
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > Math.abs(dy) && dx < -30) {
        swiping = true;
        card.style.transform = `translateX(${Math.max(dx, -80)}px)`;
        card.style.background = 'var(--red-light)';
      }
    }, { passive: true });
    card.addEventListener('touchend', (e) => {
      if (swiping) {
        const dx = e.changedTouches[0].clientX - startX;
        if (dx < -70) {
          // Extract item id from onclick
          const onclick = card.getAttribute('onclick') || '';
          const match = onclick.match(/showItemDetail\('([^']+)'\)/);
          if (match) deleteItem(match[1]);
        }
        card.style.transform = '';
        card.style.background = '';
      }
    });
  });
}

async function showItemDetail(id) {
  try {
    const { data: item, error } = await sb
      .from('items')
      .select('*, locations(room_name, shelf_name), item_categories(categories(id, name, icon))')
      .eq('id', id)
      .single();
    if (error) throw error;

    item.room_name = item.locations?.room_name || '';
    item.shelf_name = item.locations?.shelf_name || '';
    item.categories = (item.item_categories || []).map(ic => ic.categories).filter(Boolean);

    const [{ data: activeLoansData }, { data: reportsData }, { data: extraImages }] = await Promise.all([
      sb.from('loans').select('*, profiles!loans_user_id_fkey_profiles(display_name)').eq('item_id', id).eq('status', 'active'),
      sb.from('reports').select('*, profiles!reports_user_id_fkey_profiles(display_name)').eq('item_id', id).order('created_at', { ascending: false }),
      sb.from('item_images').select('*').eq('item_id', id).order('sort_order')
    ]);

    const loans = (activeLoansData || []).map(l => ({ ...l, user_name: l.profiles?.display_name || 'Ukendt' }));
    const reports = (reportsData || []).map(r => ({ ...r, user_name: r.profiles?.display_name || 'Ukendt' }));
    const isLow = item.type === 'food' && item.quantity <= item.min_quantity;
    const loc = item.room_name ? `${item.room_name}${item.shelf_name ? ' – ' + item.shelf_name : ''}` : 'Ikke angivet';

    // Build image gallery
    const allImages = [];
    if (item.image_url) allImages.push({ url: item.image_url, caption: '' });
    (extraImages || []).forEach(img => allImages.push({ url: img.image_url, caption: img.caption || '' }));

    const galleryHtml = allImages.length > 1 ? `
      <div class="image-gallery">
        ${allImages.map((img, i) => `
          <div class="gallery-thumb ${i === 0 ? 'active' : ''}" onclick="setGalleryMain('${img.url.replace(/'/g, "\\'")}', this)">
            ${itemImage(img.url)}
          </div>`).join('')}
      </div>` : '';

    const mainImageHtml = allImages.length > 0
      ? `<div class="detail-image" id="detail-main-image">${itemImage(allImages[0].url)}</div>`
      : `<div class="detail-image">${itemImage('')}</div>`;

    openModal(`
      <div class="modal-handle"></div>
      ${mainImageHtml}
      ${galleryHtml}
      <div class="detail-info">
        <h2>${esc(item.name)}</h2>
        ${item.description ? `<p class="detail-description">${esc(item.description)}</p>` : ''}
        <div class="detail-meta-grid">
          <div class="detail-meta-item">
            <div class="detail-meta-label">Antal</div>
            <div class="detail-meta-value" style="${isLow ? 'color:var(--red)' : ''}">${item.quantity} stk ${isLow ? '⚠️ Lavt' : ''}</div>
          </div>
          <div class="detail-meta-item">
            <div class="detail-meta-label">Type</div>
            <div class="detail-meta-value">${item.type === 'food' ? 'Madvare' : 'Udstyr'}</div>
          </div>
          <div class="detail-meta-item">
            <div class="detail-meta-label">Lokation</div>
            <div class="detail-meta-value">${esc(loc)}</div>
          </div>
          ${item.barcode ? `<div class="detail-meta-item"><div class="detail-meta-label">Stregkode</div><div class="detail-meta-value">${esc(item.barcode)}</div></div>` : ''}
          ${item.type === 'food' && item.expiry_date ? `<div class="detail-meta-item" style="grid-column:1/-1"><div class="detail-meta-label">Udløbsdato</div><div class="detail-meta-value">${expiryBadge(item.expiry_date)}</div></div>` : ''}
        </div>
        <div class="item-card-tags mb-4">
          ${(item.categories || []).map(c => `<span class="tag">${esc(c.name)}</span>`).join('')}
        </div>

        <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
          <button class="btn btn-outline btn-sm" onclick="showItemQR('${item.id}','${esc(item.name).replace(/'/g,"\\'")}')">
            ${icon('qr-code')} QR-kode
          </button>
          ${isAdmin() ? `<button class="btn btn-outline btn-sm" onclick="showAddItemImage('${item.id}')">${icon('image-plus')} Tilføj billede</button>` : ''}
        </div>

        ${loans.length > 0 ? `
          <h4 class="section-title mb-2">${icon('hand-helping')} Aktive udlån</h4>
          ${loans.map(l => `
            <div class="food-list-item ok" style="margin-bottom:6px">
              <div class="food-info"><h4>${esc(l.user_name)}</h4><p>${l.quantity} stk · Retur: ${formatDate(l.expected_return)}</p></div>
            </div>`).join('')}` : ''}

        ${reports.length > 0 ? `
          <h4 class="section-title mb-2 mt-4">${icon('alert-triangle')} Rapporthistorik</h4>
          ${reports.slice(0, 5).map(r => `
            <div class="food-list-item ${r.status === 'open' ? 'low-stock' : 'ok'}" style="margin-bottom:6px">
              <div class="food-info"><h4>${r.type === 'missing' ? 'Manglende' : 'Beskadiget'} – ${esc(r.user_name)}</h4><p>${esc(r.description || '')} · ${formatDate(r.created_at)}</p></div>
              <span class="status-badge ${r.status}">${statusLabel(r.status)}</span>
            </div>`).join('')}` : ''}
      </div>
      <div class="detail-actions">
        <button class="btn btn-primary btn-sm" onclick="closeModal();showLoanForm('${item.id}')">${icon('hand-helping')} Lån</button>
        <button class="btn btn-outline btn-sm" onclick="closeModal();showReportForm('${item.id}','missing')">${icon('search')} Manglende</button>
        <button class="btn btn-outline btn-sm" onclick="closeModal();showReportForm('${item.id}','damaged')">${icon('alert-triangle')} Beskadiget</button>
        ${isAdmin() ? `
          <button class="btn btn-ghost btn-sm" onclick="closeModal();showItemForm('${item.id}')">${icon('pencil')} Redigér</button>
          <button class="btn btn-danger btn-sm" onclick="deleteItem('${item.id}')">${icon('trash-2')} Slet</button>
        ` : ''}
      </div>`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function setGalleryMain(url, thumbEl) {
  const mainImg = document.getElementById('detail-main-image');
  if (mainImg) {
    mainImg.innerHTML = itemImage(url);
    lucide.createIcons({ nodes: [mainImg] });
  }
  document.querySelectorAll('.gallery-thumb').forEach(t => t.classList.remove('active'));
  if (thumbEl) thumbEl.classList.add('active');
}

async function showAddItemImage(itemId) {
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>Tilføj billede</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="image-upload-area" id="extra-img-area">
        ${icon('camera')}
        <p>Vælg billede</p>
        <div class="image-btn-group">
          <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();document.getElementById('extra-img-capture').click()">${icon('camera')} Tag billede</button>
          <button type="button" class="btn btn-sm btn-outline" onclick="event.stopPropagation();document.getElementById('extra-img-file').click()">${icon('upload')} Vælg fil</button>
        </div>
      </div>
      <input type="file" id="extra-img-capture" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="extra-img-file" accept="image/*" style="display:none">
      <div class="form-group">
        <label>Billedtekst (valgfri)</label>
        <input type="text" class="form-input" id="extra-img-caption" placeholder="F.eks. Detalje af beslag">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="extra-img-save">Gem billede</button>
    </div>`);

  let imgResult = null;
  const handler = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const area = document.getElementById('extra-img-area');
    area.innerHTML = `<div style="padding:16px;text-align:center"><span class="spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span></div>`;
    try {
      imgResult = await optimizeImage(file);
      const prev = URL.createObjectURL(imgResult.blob);
      area.innerHTML = `<img src="${prev}" class="image-preview">`;
    } catch(e) {
      area.innerHTML = `<p style="color:var(--red)">Fejl: ${e.message}</p>`;
    }
  };
  document.getElementById('extra-img-capture').onchange = handler;
  document.getElementById('extra-img-file').onchange = handler;

  document.getElementById('extra-img-save').onclick = async () => {
    if (!imgResult) { toast('Vælg et billede først', 'error'); return; }
    try {
      const url = await uploadImage(imgResult.blob, 'item_extra', imgResult.format, imgResult.ext);
      const { count: sortOrder } = await sb.from('item_images').select('*', { count: 'exact', head: true }).eq('item_id', itemId);
      await sb.from('item_images').insert({
        item_id: itemId,
        image_url: url,
        caption: document.getElementById('extra-img-caption').value,
        sort_order: sortOrder || 0
      });
      toast('Billede tilføjet');
      closeModal();
      showItemDetail(itemId);
    } catch(e) { toast(e.message, 'error'); }
  };
}

function showItemQR(itemId, itemName) {
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${icon('qr-code')} QR-kode – ${esc(itemName)}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body" style="text-align:center">
      <div id="qr-container" style="display:inline-block;padding:16px;background:#fff;border-radius:8px;box-shadow:var(--shadow-md);margin:12px auto"></div>
      <p style="font-size:0.8rem;color:var(--text-3);margin-top:8px">${esc(itemName)}</p>
      <p style="font-size:0.72rem;color:var(--text-3)">${itemId}</p>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:16px">
        <button class="btn btn-primary btn-sm" onclick="printQRLabel('${itemId}','${esc(itemName).replace(/'/g,"\\'")}')">${icon('printer')} Udskriv label</button>
      </div>
    </div>`);

  setTimeout(() => {
    const container = document.getElementById('qr-container');
    if (container && window.QRCode) {
      new QRCode(container, {
        text: itemId,
        width: 180,
        height: 180,
        colorDark: '#003366',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
    }
  }, 100);
}

function printQRLabel(itemId, itemName) {
  const win = window.open('', '_blank', 'width=400,height=300');
  win.document.write(`<!DOCTYPE html><html><head><style>
    body{font-family:sans-serif;text-align:center;padding:20px}
    #qr{display:inline-block}
    h3{margin-top:8px;font-size:16px}
    p{font-size:10px;color:#666}
  </style></head><body>
    <div id="qr"></div>
    <h3>${esc(itemName)}</h3>
    <p>${itemId}</p>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
    <script>
      new QRCode(document.getElementById('qr'),{text:'${itemId}',width:160,height:160,colorDark:'#003366',colorLight:'#ffffff'});
      setTimeout(()=>window.print(),600);
    <\/script>
  </body></html>`);
  win.document.close();
}

async function showItemForm(editId) {
  const categories = await loadCategories();
  const locations = await loadLocations();
  let item = null;
  if (editId) {
    try {
      const { data, error } = await sb
        .from('items')
        .select('*, item_categories(categories(id, name, icon))')
        .eq('id', editId)
        .single();
      if (!error) {
        item = data;
        item.categories = (item.item_categories || []).map(ic => ic.categories).filter(Boolean);
      }
    } catch(e) {}
  }
  const isEdit = !!item;
  const itemCatIds = (item?.categories || []).map(c => c.id);

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${isEdit ? 'Redigér genstand' : 'Tilføj ny genstand'}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="image-upload-area" id="image-upload-area">
        ${item?.image_url ? `<img src="${item.image_url.startsWith('http') ? item.image_url : './' + item.image_url}" class="image-preview" id="image-preview">` : `
          ${icon('camera')}
          <p>Tilføj billede</p>
          <div class="image-btn-group">
            <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();document.getElementById('item-image-capture').click()">${icon('camera')} Tag billede</button>
            <button type="button" class="btn btn-sm btn-outline" onclick="event.stopPropagation();document.getElementById('item-image-upload').click()">${icon('upload')} Vælg fil</button>
          </div>
        `}
      </div>
      <input type="file" id="item-image-capture" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="item-image-upload" accept="image/*" style="display:none">
      <div id="image-preview-wrap"></div>

      <div class="form-group">
        <label>Navn</label>
        <input type="text" class="form-input" id="item-name" value="${esc(item?.name || '')}" placeholder="Genstandens navn">
      </div>
      <div class="form-group">
        <label>Beskrivelse</label>
        <textarea class="form-input" id="item-desc" placeholder="Valgfri beskrivelse">${esc(item?.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Type</label>
        <select class="form-input" id="item-type">
          <option value="equipment" ${item?.type === 'equipment' ? 'selected' : ''}>Udstyr</option>
          <option value="food" ${item?.type === 'food' ? 'selected' : ''}>Madvare</option>
        </select>
      </div>
      <div class="form-group" id="expiry-group" style="display:${item?.type === 'food' ? '' : 'none'}">
        <label>Udløbsdato</label>
        <input type="date" class="form-input" id="item-expiry" value="${item?.expiry_date || ''}">
      </div>
      <div class="form-group" style="display:flex;gap:12px">
        <div style="flex:1">
          <label>Antal</label>
          <input type="number" class="form-input" id="item-qty" value="${item?.quantity ?? 1}" min="0">
        </div>
        <div style="flex:1">
          <label>Min. antal (mad)</label>
          <input type="number" class="form-input" id="item-minqty" value="${item?.min_quantity ?? 0}" min="0">
        </div>
      </div>
      <div class="form-group">
        <label>Stregkode</label>
        <input type="text" class="form-input" id="item-barcode" value="${esc(item?.barcode || '')}" placeholder="Valgfri stregkode">
      </div>
      <div class="form-group">
        <label>Lokation</label>
        <select class="form-input" id="item-location">
          <option value="">Vælg lokation</option>
          ${locations.map(l => `<option value="${l.id}" ${item?.location_id === l.id ? 'selected' : ''}>${esc(l.room_name)}${l.shelf_name ? ' – ' + esc(l.shelf_name) : ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Kategorier</label>
        <div class="checkbox-group">
          ${categories.map(c => `
            <label class="checkbox-label">
              <input type="checkbox" name="item-cats" value="${c.id}" ${itemCatIds.includes(c.id) ? 'checked' : ''}>
              ${esc(c.name)}
            </label>`).join('')}
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="item-save-btn">${isEdit ? 'Gem ændringer' : 'Opret genstand'}</button>
    </div>`);

  // Show/hide expiry date based on type
  document.getElementById('item-type').onchange = (e) => {
    document.getElementById('expiry-group').style.display = e.target.value === 'food' ? '' : 'none';
  };

  let imageResult = null;
  const imageHandler = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const area = document.getElementById('image-upload-area');
    area.innerHTML = `<div style="padding:20px;text-align:center"><span class="spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span><p style="margin-top:8px;font-size:0.82rem;color:var(--text-3)">Optimerer billede...</p></div>`;
    try {
      imageResult = await optimizeImage(file);
      const previewUrl = URL.createObjectURL(imageResult.blob);
      area.innerHTML = `<img src="${previewUrl}" class="image-preview">
        <div class="image-btn-group" style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%)">
          <button type="button" class="btn btn-sm btn-outline" style="background:rgba(0,0,0,0.6);color:#fff;border-color:rgba(255,255,255,0.3)" onclick="event.stopPropagation();document.getElementById('item-image-capture').click()">${icon('camera')} Skift</button>
          <button type="button" class="btn btn-sm btn-outline" style="background:rgba(0,0,0,0.6);color:#fff;border-color:rgba(255,255,255,0.3)" onclick="event.stopPropagation();document.getElementById('item-image-upload').click()">${icon('upload')} Vælg</button>
        </div>`;
      lucide.createIcons({ nodes: [area] });
    } catch (err) {
      area.innerHTML = `${icon('camera')}<p>Fejl: ${err.message}</p>
        <div class="image-btn-group">
          <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();document.getElementById('item-image-capture').click()">${icon('camera')} Tag billede</button>
          <button type="button" class="btn btn-sm btn-outline" onclick="event.stopPropagation();document.getElementById('item-image-upload').click()">${icon('upload')} Vælg fil</button>
        </div>`;
      lucide.createIcons({ nodes: [area] });
      imageResult = null;
    }
  };
  document.getElementById('item-image-capture').onchange = imageHandler;
  document.getElementById('item-image-upload').onchange = imageHandler;

  document.getElementById('item-save-btn').onclick = async () => {
    const name = document.getElementById('item-name').value.trim();
    if (!name) { toast('Navn er påkrævet', 'error'); return; }
    const catCheckboxes = document.querySelectorAll('input[name="item-cats"]:checked');
    const catIds = Array.from(catCheckboxes).map(cb => cb.value);
    const itemType = document.getElementById('item-type').value;

    let imageUrl = item?.image_url || '';
    const oldImageUrl = item?.image_url || '';
    if (imageResult) {
      try {
        imageUrl = await uploadImage(imageResult.blob, 'item', imageResult.format, imageResult.ext);
        if (oldImageUrl && oldImageUrl !== imageUrl) {
          deleteStorageImage(oldImageUrl);
        }
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
    }

    const record = {
      name,
      description: document.getElementById('item-desc').value,
      type: itemType,
      quantity: parseInt(document.getElementById('item-qty').value) || 0,
      min_quantity: parseInt(document.getElementById('item-minqty').value) || 0,
      barcode: document.getElementById('item-barcode').value.trim(),
      location_id: document.getElementById('item-location').value || null,
      image_url: imageUrl,
      expiry_date: itemType === 'food' ? (document.getElementById('item-expiry').value || null) : null,
      updated_at: new Date().toISOString()
    };

    try {
      if (isEdit) {
        const { error } = await sb.from('items').update(record).eq('id', editId);
        if (error) throw error;
        await sb.from('item_categories').delete().eq('item_id', editId);
        if (catIds.length > 0) {
          await sb.from('item_categories').insert(catIds.map(cid => ({ item_id: editId, category_id: cid })));
        }
        await logActivity('item_updated', 'item', editId, `Genstand opdateret: ${name}`, { name });
        toast('Genstand opdateret');
      } else {
        record.created_by = currentSession.user.id;
        const { data: newItem, error } = await sb.from('items').insert(record).select('id').single();
        if (error) throw error;
        if (catIds.length > 0) {
          await sb.from('item_categories').insert(catIds.map(cid => ({ item_id: newItem.id, category_id: cid })));
        }
        await logActivity('item_created', 'item', newItem.id, `Ny genstand oprettet: ${name}`, { name });
        toast('Genstand oprettet');
      }
      closeModal();
      cachedData.items = null;
      navigate('items');
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function deleteItem(id) {
  if (!confirm('Er du sikker på at du vil slette denne genstand?')) return;
  try {
    const { data: item } = await sb.from('items').select('image_url, name').eq('id', id).single();
    const { error } = await sb.from('items').delete().eq('id', id);
    if (error) throw error;
    if (item?.image_url) deleteStorageImage(item.image_url);
    await logActivity('item_deleted', 'item', id, `Genstand slettet: ${item?.name || id}`, {});
    toast('Genstand slettet');
    closeModal();
    cachedData.items = null;
    navigate('items');
  } catch (err) { toast(err.message, 'error'); }
}

async function exportItemsPDF() {
  try {
    const { data: items } = await sb.from('items').select('*, locations(room_name, shelf_name)').order('name');
    if (!items || items.length === 0) { toast('Ingen genstande at eksportere', 'error'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Valhalla Gruppe – Materialeliste', 14, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Genereret: ${new Date().toLocaleDateString('da-DK')}`, 14, 28);

    const rows = items.map(i => [
      i.name,
      i.type === 'food' ? 'Madvare' : 'Udstyr',
      String(i.quantity),
      i.locations ? `${i.locations.room_name}${i.locations.shelf_name ? ' - ' + i.locations.shelf_name : ''}` : '–',
      i.expiry_date ? formatDate(i.expiry_date) : '–'
    ]);

    doc.autoTable({
      head: [['Navn', 'Type', 'Antal', 'Lokation', 'Udløbsdato']],
      body: rows,
      startY: 34,
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [0, 51, 102], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] }
    });

    doc.save(`valhalla-materiale-${new Date().toISOString().split('T')[0]}.pdf`);
    toast('PDF eksporteret');
  } catch(e) { toast('PDF fejl: ' + e.message, 'error'); }
}

// ─── SETS / KITS ─────────────────────────────────────────────────────
async function renderSets(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Sæt</h1>
      <div class="page-header-actions">
        ${isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="showSetForm()">${icon('plus')} Nyt sæt</button>` : ''}
      </div>
    </div>
    <div class="page-body">
      <div id="sets-grid" class="sets-grid"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  const { data: sets, error } = await sb.from('item_sets').select('*').order('name');
  if (error) { toast(error.message, 'error'); return; }

  const grid = document.getElementById('sets-grid');
  if (!sets || sets.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${icon('boxes')}<h3>Ingen sæt</h3><p>Opret dit første sæt for at komme i gang</p></div>`;
    lucide.createIcons({ nodes: [grid] });
    return;
  }

  // Get component counts
  const setIds = sets.map(s => s.id);
  const { data: setItemsData } = await sb.from('set_items').select('set_id, quantity, items(id, name, quantity, min_quantity)').in('set_id', setIds);

  const setItemsMap = {};
  (setItemsData || []).forEach(si => {
    if (!setItemsMap[si.set_id]) setItemsMap[si.set_id] = [];
    setItemsMap[si.set_id].push(si);
  });

  grid.innerHTML = sets.map(s => {
    const components = setItemsMap[s.id] || [];
    const hasIssues = components.some(c => c.items && c.items.quantity < c.quantity);
    const hasLow = components.some(c => c.items && c.items.quantity < c.items.min_quantity);
    const statusBadge = hasIssues
      ? `<span class="set-status-badge red">${icon('alert-triangle')} Mangler komponenter</span>`
      : hasLow
        ? `<span class="set-status-badge amber">${icon('alert-triangle')} Lavt lager</span>`
        : `<span class="set-status-badge green">${icon('check-circle')} Komplet</span>`;
    return `
      <div class="set-card" onclick="showSetDetail('${s.id}')">
        <div class="set-card-image">
          ${s.image_url ? `<img src="${s.image_url.startsWith('http') ? s.image_url : './' + s.image_url}" alt="" onerror="handleImgError(this)">` : `<div class="placeholder-icon">${icon('boxes')}</div>`}
        </div>
        <div class="set-card-body">
          <div class="set-card-name">${esc(s.name)}</div>
          ${s.description ? `<div class="set-card-desc">${esc(s.description)}</div>` : ''}
          <div class="set-card-meta">${icon('package')} ${components.length} komponenter</div>
          ${statusBadge}
        </div>
      </div>`;
  }).join('');
  lucide.createIcons({ nodes: [grid] });
}

async function showSetDetail(setId) {
  const [{ data: setData }, { data: setItems }] = await Promise.all([
    sb.from('item_sets').select('*').eq('id', setId).single(),
    sb.from('set_items').select('*, items(id, name, quantity, min_quantity, image_url)').eq('set_id', setId)
  ]);

  if (!setData) { toast('Sæt ikke fundet', 'error'); return; }

  const components = setItems || [];

  openModal(`
    <div class="modal-handle"></div>
    <div class="detail-image">
      ${setData.image_url ? `<img src="${setData.image_url}" alt="" onerror="handleImgError(this)">` : `<div class="placeholder-icon">${icon('boxes')}</div>`}
    </div>
    <div class="detail-info">
      <h2>${esc(setData.name)}</h2>
      ${setData.description ? `<p class="detail-description">${esc(setData.description)}</p>` : ''}

      <h4 class="section-title mb-2">${icon('package')} Komponenter (${components.length})</h4>
      ${components.length === 0 ? '<p style="color:var(--text-3)">Ingen komponenter endnu</p>' : ''}
      ${components.map(c => {
        const item = c.items;
        if (!item) return '';
        const available = item.quantity;
        const needed = c.quantity;
        const statusCls = available < needed ? 'set-component-missing' : available <= item.min_quantity ? 'set-component-low' : 'set-component-ok';
        return `
          <div class="set-component ${statusCls}" onclick="closeModal();showItemDetail('${item.id}')">
            <div class="set-component-image">${itemImage(item.image_url)}</div>
            <div class="set-component-info">
              <div class="set-component-name">${esc(item.name)}</div>
              <div class="set-component-qty">Behov: ${needed} · Lager: ${available}</div>
            </div>
            ${available < needed ? `<span class="set-status-badge red">${icon('x-circle')} Mangler</span>` : available <= item.min_quantity ? `<span class="set-status-badge amber">${icon('alert-triangle')} Lavt</span>` : `<span class="set-status-badge green">${icon('check')}</span>`}
          </div>`;
      }).join('')}
    </div>
    <div class="detail-actions">
      ${isAdmin() ? `
        <button class="btn btn-ghost btn-sm" onclick="closeModal();showSetForm('${setId}')">${icon('pencil')} Redigér</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSet('${setId}')">${icon('trash-2')} Slet</button>
      ` : ''}
    </div>`);
}

async function showSetForm(editId) {
  const { data: allItems } = await sb.from('items').select('id, name, quantity').order('name');
  let setData = null;
  let existingComponents = [];

  if (editId) {
    const [{ data: s }, { data: si }] = await Promise.all([
      sb.from('item_sets').select('*').eq('id', editId).single(),
      sb.from('set_items').select('*, items(id, name)').eq('set_id', editId)
    ]);
    setData = s;
    existingComponents = si || [];
  }

  let components = existingComponents.map(c => ({ item_id: c.item_id, quantity: c.quantity, name: c.items?.name || '' }));

  const renderComponentsList = () => {
    const el = document.getElementById('set-components-list');
    if (!el) return;
    if (components.length === 0) {
      el.innerHTML = `<p style="color:var(--text-3);font-size:0.88rem;text-align:center;padding:12px">Ingen komponenter tilføjet endnu</p>`;
      return;
    }
    el.innerHTML = components.map((c, i) => `
      <div class="set-component-row">
        <div style="flex:1;font-size:0.9rem;font-weight:600">${esc(c.name || c.item_id)}</div>
        <input type="number" class="form-input" value="${c.quantity}" min="1" style="width:70px" onchange="updateSetComponent(${i}, this.value)">
        <button class="btn btn-ghost btn-sm" onclick="removeSetComponent(${i})">${icon('x')}</button>
      </div>`).join('');
    lucide.createIcons({ nodes: [el] });
  };

  window.updateSetComponent = (i, val) => { components[i].quantity = parseInt(val) || 1; };
  window.removeSetComponent = (i) => { components.splice(i, 1); renderComponentsList(); };
  window.addSetComponent = () => {
    const sel = document.getElementById('set-item-select');
    const qty = parseInt(document.getElementById('set-item-qty').value) || 1;
    if (!sel.value) return;
    const item = (allItems || []).find(it => it.id === sel.value);
    if (!item) return;
    const existing = components.findIndex(c => c.item_id === sel.value);
    if (existing >= 0) {
      components[existing].quantity += qty;
    } else {
      components.push({ item_id: sel.value, quantity: qty, name: item.name });
    }
    renderComponentsList();
  };

  let imgResult = null;

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${editId ? 'Redigér sæt' : 'Nyt sæt'}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="image-upload-area" id="set-img-area">
        ${setData?.image_url ? `<img src="${setData.image_url}" class="image-preview">` : `
          ${icon('camera')}<p>Sæt-billede (valgfrit)</p>
          <div class="image-btn-group">
            <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();document.getElementById('set-img-capture').click()">${icon('camera')} Tag billede</button>
            <button type="button" class="btn btn-sm btn-outline" onclick="event.stopPropagation();document.getElementById('set-img-file').click()">${icon('upload')} Vælg fil</button>
          </div>`}
      </div>
      <input type="file" id="set-img-capture" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="set-img-file" accept="image/*" style="display:none">
      <div class="form-group">
        <label>Navn</label>
        <input type="text" class="form-input" id="set-name" value="${esc(setData?.name || '')}" placeholder="F.eks. Patrol Telt Komplet">
      </div>
      <div class="form-group">
        <label>Beskrivelse</label>
        <textarea class="form-input" id="set-desc" placeholder="Valgfri beskrivelse">${esc(setData?.description || '')}</textarea>
      </div>
      <h4 class="section-title" style="margin-bottom:12px">${icon('package')} Komponenter</h4>
      <div id="set-components-list"></div>
      <div style="display:flex;gap:8px;margin-top:12px;align-items:flex-end">
        <div style="flex:1">
          <select class="form-input" id="set-item-select">
            <option value="">Vælg genstand...</option>
            ${(allItems || []).map(i => `<option value="${i.id}">${esc(i.name)} (${i.quantity} stk)</option>`).join('')}
          </select>
        </div>
        <div style="width:70px">
          <input type="number" class="form-input" id="set-item-qty" value="1" min="1" placeholder="Antal">
        </div>
        <button class="btn btn-outline btn-sm" style="white-space:nowrap" onclick="addSetComponent()">${icon('plus')} Tilføj</button>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="set-save-btn">${editId ? 'Gem ændringer' : 'Opret sæt'}</button>
    </div>`);

  renderComponentsList();

  const imgHandler = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const area = document.getElementById('set-img-area');
    area.innerHTML = `<div style="padding:16px;text-align:center"><span class="spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span></div>`;
    try {
      imgResult = await optimizeImage(file);
      area.innerHTML = `<img src="${URL.createObjectURL(imgResult.blob)}" class="image-preview">`;
    } catch(e) { area.innerHTML = `<p style="color:var(--red)">${e.message}</p>`; }
  };
  document.getElementById('set-img-capture').onchange = imgHandler;
  document.getElementById('set-img-file').onchange = imgHandler;

  document.getElementById('set-save-btn').onclick = async () => {
    const name = document.getElementById('set-name').value.trim();
    if (!name) { toast('Navn er påkrævet', 'error'); return; }

    let imageUrl = setData?.image_url || '';
    if (imgResult) {
      try { imageUrl = await uploadImage(imgResult.blob, 'set', imgResult.format, imgResult.ext); }
      catch(e) { toast(e.message, 'error'); return; }
    }

    const record = {
      name,
      description: document.getElementById('set-desc').value,
      image_url: imageUrl
    };

    try {
      let setId;
      if (editId) {
        await sb.from('item_sets').update(record).eq('id', editId);
        await sb.from('set_items').delete().eq('set_id', editId);
        setId = editId;
        toast('Sæt opdateret');
      } else {
        record.created_by = currentSession.user.id;
        const { data: ns, error } = await sb.from('item_sets').insert(record).select('id').single();
        if (error) throw error;
        setId = ns.id;
        await logActivity('set_created', 'set', setId, `Sæt oprettet: ${name}`, { name });
        toast('Sæt oprettet');
      }

      if (components.length > 0) {
        const rows = components.map(c => ({ set_id: setId, item_id: c.item_id, quantity: c.quantity }));
        await sb.from('set_items').insert(rows);
      }

      closeModal();
      navigate('sets');
    } catch(e) { toast(e.message, 'error'); }
  };
}

async function deleteSet(id) {
  if (!confirm('Slet dette sæt?')) return;
  try {
    await sb.from('set_items').delete().eq('set_id', id);
    await sb.from('item_sets').delete().eq('id', id);
    toast('Sæt slettet');
    closeModal();
    navigate('sets');
  } catch(e) { toast(e.message, 'error'); }
}

// ─── LOANS ─────────────────────────────────────────────────────────────
async function renderLoans(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Udlån</h1>
      <div class="page-header-actions">
        <button class="btn btn-primary btn-sm" onclick="showLoanForm()">${icon('plus')} Nyt udlån</button>
      </div>
    </div>
    <div class="page-body">
      <div class="tabs" id="loans-tabs">
        <button class="tab active" data-status="active">Aktive</button>
        <button class="tab" data-status="returned">Returnerede</button>
        <button class="tab" data-status="overdue">Forfaldne</button>
      </div>
      <div id="loans-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  let currentStatus = 'active';
  const loadLoans = async () => {
    let query = sb
      .from('loans')
      .select('*, items!loans_item_id_fkey(name, image_url), profiles!loans_user_id_fkey_profiles(display_name)')
      .order('loan_date', { ascending: false });

    if (currentStatus === 'overdue') {
      query = query.eq('status', 'active').not('expected_return', 'is', null).lt('expected_return', new Date().toISOString().split('T')[0]);
    } else {
      query = query.eq('status', currentStatus);
    }

    const { data: loans, error } = await query;
    if (error) { toast(error.message, 'error'); return; }

    const flatLoans = (loans || []).map(l => ({
      ...l,
      item_name: l.items?.name || 'Ukendt',
      item_image: l.items?.image_url || '',
      user_name: l.profiles?.display_name || 'Ukendt'
    }));
    renderLoansList(flatLoans, currentStatus);
  };

  document.querySelectorAll('#loans-tabs .tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#loans-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentStatus = tab.dataset.status;
      loadLoans();
    };
  });
  loadLoans();
}

function renderLoansList(loans, status) {
  const list = document.getElementById('loans-list');
  if (!list) return;
  if (loans.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('hand-helping')}<h3>Ingen udlån</h3><p>${status === 'active' ? 'Ingen aktive udlån lige nu' : status === 'overdue' ? 'Ingen forfaldne udlån' : 'Ingen returnerede udlån'}</p></div>`;
    lucide.createIcons({ nodes: [list] });
    return;
  }
  list.innerHTML = loans.map(l => {
    const overdue = l.status === 'active' && isOverdue(l.expected_return);
    const badgeClass = overdue ? 'overdue' : l.status;
    const badgeText = overdue ? 'Forfalden' : l.status === 'active' ? 'Aktiv' : 'Returneret';
    return `
      <div class="loan-card">
        <div class="loan-card-image">${itemImage(l.item_image)}</div>
        <div class="loan-card-info">
          <h4>${esc(l.item_name)}</h4>
          <p>${icon('user')} ${esc(l.user_name)} · ${l.quantity} stk</p>
          <p>${l.purpose === 'scout_trip' ? `🏕️ ${esc(l.trip_name || 'Spejdertur')}` : '🏠 Privat brug'}</p>
          <p>Udlånt: ${formatDate(l.loan_date)}${l.expected_return ? ` · Retur: ${formatDate(l.expected_return)}` : ''}</p>
        </div>
        <div class="loan-card-actions">
          <span class="status-badge ${badgeClass}">${badgeText}</span>
          ${l.status === 'active' ? `<button class="btn btn-primary btn-sm" onclick="returnLoan('${l.id}','${l.item_id}',${l.quantity})">${icon('check')} Returnér</button>` : ''}
        </div>
      </div>`;
  }).join('');
  lucide.createIcons({ nodes: [list] });
}

async function showLoanForm(preselectedItemId) {
  const { data: items, error } = await sb.from('items').select('id, name, quantity').order('name');
  if (error) { toast(error.message, 'error'); return; }

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>Nyt udlån</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>Genstand</label>
        <select class="form-input" id="loan-item">
          <option value="">Vælg genstand</option>
          ${(items || []).map(i => `<option value="${i.id}" ${preselectedItemId === i.id ? 'selected' : ''}>${esc(i.name)} (${i.quantity} tilgængelig)</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Antal</label>
        <input type="number" class="form-input" id="loan-qty" value="1" min="1">
      </div>
      <div class="form-group">
        <label>Formål</label>
        <select class="form-input" id="loan-purpose">
          <option value="private">Privat brug</option>
          <option value="scout_trip">Spejdertur</option>
        </select>
      </div>
      <div class="form-group" id="loan-trip-group" style="display:none">
        <label>Turnavn</label>
        <input type="text" class="form-input" id="loan-trip" placeholder="F.eks. Sommerlejr 2026">
      </div>
      <div class="form-group">
        <label>Forventet retur</label>
        <input type="date" class="form-input" id="loan-return">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="loan-save-btn">Opret udlån</button>
    </div>`);

  document.getElementById('loan-purpose').onchange = (e) => {
    document.getElementById('loan-trip-group').style.display = e.target.value === 'scout_trip' ? '' : 'none';
  };

  document.getElementById('loan-save-btn').onclick = async () => {
    const itemId = document.getElementById('loan-item').value;
    if (!itemId) { toast('Vælg en genstand', 'error'); return; }
    const quantity = parseInt(document.getElementById('loan-qty').value) || 1;
    try {
      const { data: newLoan, error } = await sb.from('loans').insert({
        item_id: itemId,
        user_id: currentSession.user.id,
        quantity,
        purpose: document.getElementById('loan-purpose').value,
        trip_name: document.getElementById('loan-trip')?.value || '',
        expected_return: document.getElementById('loan-return').value || null
      }).select('id').single();
      if (error) throw error;
      await sb.rpc('decrement_item_quantity', { p_item_id: itemId, p_amount: quantity });
      const itemName = (items || []).find(i => i.id === itemId)?.name || itemId;
      await logActivity('loan_created', 'loan', newLoan?.id, `Udlån oprettet: ${itemName} (${quantity} stk)`, { item_id: itemId, quantity });
      toast('Udlån oprettet');
      closeModal();
      navigate('loans');
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function returnLoan(loanId, itemId, quantity) {
  try {
    const { error } = await sb
      .from('loans')
      .update({ status: 'returned', actual_return: new Date().toISOString() })
      .eq('id', loanId);
    if (error) throw error;
    await sb.rpc('increment_item_quantity', { p_item_id: itemId, p_amount: quantity });
    await logActivity('loan_returned', 'loan', loanId, `Udlån returneret`, { item_id: itemId, quantity });
    toast('Udlån markeret som returneret');
    navigate('loans');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── REPORTS ───────────────────────────────────────────────────────────
async function renderReports(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Rapporter</h1>
      <div class="page-header-actions">
        <button class="btn btn-outline btn-sm" onclick="showReportForm()">${icon('plus')} Ny rapport</button>
      </div>
    </div>
    <div class="page-body">
      <div class="tabs" id="reports-tabs">
        <button class="tab active" data-status="open">Åbne</button>
        <button class="tab" data-status="acknowledged">Behandlede</button>
        <button class="tab" data-status="">Alle</button>
      </div>
      <div id="reports-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  let currentStatus = 'open';
  const loadReportsList = async () => {
    let query = sb
      .from('reports')
      .select('*, items!reports_item_id_fkey(name, image_url), profiles!reports_user_id_fkey_profiles(display_name)')
      .order('created_at', { ascending: false });

    if (currentStatus) query = query.eq('status', currentStatus);

    const { data: reports, error } = await query;
    if (error) { toast(error.message, 'error'); return; }

    const flatReports = (reports || []).map(r => ({
      ...r,
      item_name: r.items?.name || 'Ukendt',
      item_image: r.items?.image_url || '',
      user_name: r.profiles?.display_name || 'Ukendt'
    }));
    renderReportsList(flatReports);
  };

  document.querySelectorAll('#reports-tabs .tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('#reports-tabs .tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentStatus = tab.dataset.status;
      loadReportsList();
    };
  });
  loadReportsList();
}

function renderReportsList(reports) {
  const list = document.getElementById('reports-list');
  if (!list) return;
  if (reports.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('check-circle')}<h3>Ingen rapporter</h3><p>Alt ser godt ud!</p></div>`;
    lucide.createIcons({ nodes: [list] });
    return;
  }
  list.innerHTML = reports.map(r => `
    <div class="report-card" onclick="showReportDetail('${r.id}')" style="cursor:pointer">
      <div class="report-card-image">${itemImage(r.item_image)}</div>
      <div class="report-card-info">
        <h4>${esc(r.item_name)}</h4>
        <p>${icon('user')} ${esc(r.user_name)} · ${formatDate(r.created_at)}</p>
        <p>${esc(r.description || '').slice(0, 80)}</p>
      </div>
      <div class="loan-card-actions">
        <span class="status-badge ${r.type}">${r.type === 'missing' ? 'Manglende' : 'Beskadiget'}</span>
        <span class="status-badge ${r.status}">${statusLabel(r.status)}</span>
      </div>
    </div>`).join('');
  lucide.createIcons({ nodes: [list] });
}

async function showReportDetail(id) {
  const { data: r, error } = await sb
    .from('reports')
    .select('*, items!reports_item_id_fkey(name, image_url), profiles!reports_user_id_fkey_profiles(display_name)')
    .eq('id', id)
    .single();
  if (error || !r) { toast('Rapport ikke fundet', 'error'); return; }

  r.item_name = r.items?.name || 'Ukendt';
  r.item_image = r.items?.image_url || '';
  r.user_name = r.profiles?.display_name || 'Ukendt';

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>Rapport</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="detail-meta-grid">
        <div class="detail-meta-item">
          <div class="detail-meta-label">Genstand</div>
          <div class="detail-meta-value">${esc(r.item_name)}</div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Type</div>
          <div class="detail-meta-value"><span class="status-badge ${r.type}">${r.type === 'missing' ? 'Manglende' : 'Beskadiget'}</span></div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Rapporteret af</div>
          <div class="detail-meta-value">${esc(r.user_name)}</div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Status</div>
          <div class="detail-meta-value"><span class="status-badge ${r.status}">${statusLabel(r.status)}</span></div>
        </div>
      </div>
      ${r.description ? `<div class="form-group"><label>Beskrivelse</label><p>${esc(r.description)}</p></div>` : ''}
      ${r.image_url ? `<img src="${r.image_url.startsWith('http') ? r.image_url : './' + r.image_url}" class="image-preview">` : ''}
      ${r.admin_response ? `<div class="form-group"><label>Admin-svar</label><p>${esc(r.admin_response)}</p></div>` : ''}

      ${isAdmin() && r.status === 'open' ? `
        <hr style="margin:16px 0;border:none;border-top:1px solid var(--border)">
        <h4 class="mb-2">Admin-handling</h4>
        <div class="form-group">
          <label>Svar</label>
          <textarea class="form-input" id="report-response" placeholder="Skriv et svar..."></textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="respondReport('${r.id}','acknowledged','${r.item_id}')">${icon('check')} Bekræft modtagelse</button>
          <button class="btn btn-secondary btn-sm" onclick="respondReport('${r.id}','resolved','${r.item_id}')">${icon('package-check')} Erstatning på vej</button>
          <button class="btn btn-danger btn-sm" onclick="respondReport('${r.id}','retired','${r.item_id}')">${icon('archive')} Udgår</button>
        </div>
      ` : ''}
    </div>`);
}

async function respondReport(id, status, itemId) {
  try {
    const response = document.getElementById('report-response')?.value || '';
    const resolvedAt = (status === 'resolved' || status === 'retired') ? new Date().toISOString() : null;
    const { error } = await sb
      .from('reports')
      .update({ status, admin_response: response, resolved_at: resolvedAt })
      .eq('id', id);
    if (error) throw error;

    if (status === 'retired' && itemId) {
      await sb.rpc('set_item_quantity_zero', { p_item_id: itemId });
    }
    await logActivity('report_updated', 'report', id, `Rapport opdateret: ${status}`, { status });
    toast('Rapport opdateret');
    closeModal();
    navigate('reports');
  } catch (err) { toast(err.message, 'error'); }
}

async function showReportForm(preselectedItemId, preselectedType) {
  const { data: items } = await sb.from('items').select('id, name').order('name');

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>Rapportér problem</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>Genstand</label>
        <select class="form-input" id="report-item">
          <option value="">Vælg genstand</option>
          ${(items || []).map(i => `<option value="${i.id}" ${preselectedItemId === i.id ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Problem-type</label>
        <select class="form-input" id="report-type">
          <option value="missing" ${preselectedType === 'missing' ? 'selected' : ''}>Manglende</option>
          <option value="damaged" ${preselectedType === 'damaged' ? 'selected' : ''}>Beskadiget</option>
        </select>
      </div>
      <div class="form-group">
        <label>Beskrivelse</label>
        <textarea class="form-input" id="report-desc" placeholder="Beskriv problemet..."></textarea>
      </div>
      <div class="image-upload-area" id="report-image-area">
        ${icon('camera')}<p>Tilføj billede (valgfrit)</p>
        <div class="image-btn-group">
          <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();document.getElementById('report-image-capture').click()">${icon('camera')} Tag billede</button>
          <button type="button" class="btn btn-sm btn-outline" onclick="event.stopPropagation();document.getElementById('report-image-upload').click()">${icon('upload')} Vælg fil</button>
        </div>
      </div>
      <input type="file" id="report-image-capture" accept="image/*" capture="environment" style="display:none">
      <input type="file" id="report-image-upload" accept="image/*" style="display:none">
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="report-save-btn">Indsend rapport</button>
    </div>`);

  let reportImageResult = null;
  const reportImageHandler = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const area = document.getElementById('report-image-area');
    area.innerHTML = `<div style="padding:20px;text-align:center"><span class="spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span></div>`;
    try {
      reportImageResult = await optimizeImage(file);
      const previewUrl = URL.createObjectURL(reportImageResult.blob);
      area.innerHTML = `<img src="${previewUrl}" class="image-preview">
        <div class="image-btn-group" style="position:absolute;bottom:8px;left:50%;transform:translateX(-50%)">
          <button type="button" class="btn btn-sm btn-outline" style="background:rgba(0,0,0,0.6);color:#fff;border-color:rgba(255,255,255,0.3)" onclick="event.stopPropagation();document.getElementById('report-image-capture').click()">${icon('camera')} Skift</button>
          <button type="button" class="btn btn-sm btn-outline" style="background:rgba(0,0,0,0.6);color:#fff;border-color:rgba(255,255,255,0.3)" onclick="event.stopPropagation();document.getElementById('report-image-upload').click()">${icon('upload')} Vælg</button>
        </div>`;
      lucide.createIcons({ nodes: [area] });
    } catch (err) {
      area.innerHTML = `${icon('camera')}<p>Fejl: ${err.message}</p>
        <div class="image-btn-group">
          <button type="button" class="btn btn-sm btn-primary" onclick="event.stopPropagation();document.getElementById('report-image-capture').click()">${icon('camera')} Tag billede</button>
          <button type="button" class="btn btn-sm btn-outline" onclick="event.stopPropagation();document.getElementById('report-image-upload').click()">${icon('upload')} Vælg fil</button>
        </div>`;
      lucide.createIcons({ nodes: [area] });
      reportImageResult = null;
    }
  };
  document.getElementById('report-image-capture').onchange = reportImageHandler;
  document.getElementById('report-image-upload').onchange = reportImageHandler;

  document.getElementById('report-save-btn').onclick = async () => {
    const itemId = document.getElementById('report-item').value;
    if (!itemId) { toast('Vælg en genstand', 'error'); return; }
    try {
      let imageUrl = '';
      if (reportImageResult) {
        imageUrl = await uploadImage(reportImageResult.blob, 'report', reportImageResult.format, reportImageResult.ext);
      }
      const { data: newReport, error } = await sb.from('reports').insert({
        item_id: itemId,
        user_id: currentSession.user.id,
        type: document.getElementById('report-type').value,
        description: document.getElementById('report-desc').value,
        image_url: imageUrl
      }).select('id').single();
      if (error) throw error;
      const itemName = (items || []).find(i => i.id === itemId)?.name || itemId;
      await logActivity('report_created', 'report', newReport?.id, `Rapport oprettet: ${itemName}`, { item_id: itemId });
      toast('Rapport indsendt');
      closeModal();
      navigate('reports');
    } catch (err) { toast(err.message, 'error'); }
  };
}

// ─── KITCHEN / SCANNER ─────────────────────────────────────────────────
async function renderKitchen(el) {
  el.innerHTML = `
    <div class="page-header"><h1>Køkken / Scanner</h1></div>
    <div class="page-body">
      <div class="scanner-section">
        <button class="scanner-btn" id="start-scan-btn">${icon('scan-barcode')} SKAN STREGKODE</button>
        <div id="scanner-container" style="display:none"></div>
        <div id="scan-result"></div>
      </div>

      <h3 class="section-title">${icon('cookie')} Madvarelager</h3>
      <div id="food-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  const { data: items } = await sb
    .from('items')
    .select('*, locations(room_name, shelf_name)')
    .eq('type', 'food')
    .order('quantity', { ascending: true });

  const foodList = document.getElementById('food-list');
  if (!items || items.length === 0) {
    foodList.innerHTML = `<div class="empty-state">${icon('cookie')}<h3>Ingen madvarer</h3><p>Tilføj madvarer via Materiale-siden</p></div>`;
  } else {
    foodList.innerHTML = items.map(i => {
      const isLow = i.quantity <= i.min_quantity;
      const expiry = i.expiry_date ? expiryBadge(i.expiry_date) : '';
      return `
        <div class="food-list-item ${isLow ? 'low-stock' : 'ok'}">
          <div class="food-qty ${isLow ? 'low' : ''}">${i.quantity}</div>
          <div class="food-info">
            <h4>${esc(i.name)}</h4>
            <p>${i.locations?.room_name ? esc(i.locations.room_name) : ''}${i.locations?.shelf_name ? ' · ' + esc(i.locations.shelf_name) : ''}${i.barcode ? ' · ' + esc(i.barcode) : ''}</p>
            ${expiry ? `<div style="margin-top:4px">${expiry}</div>` : ''}
          </div>
          ${isLow ? `<div class="food-warning">${icon('alert-triangle')} Lavt</div>` : ''}
          <div style="display:flex;gap:4px">
            <button class="btn btn-primary btn-sm" onclick="logFood('${i.id}','added')" title="Tilføj">+</button>
            <button class="btn btn-outline btn-sm" onclick="logFood('${i.id}','used')" title="Brugt">−</button>
            <button class="btn btn-danger btn-sm" onclick="logFood('${i.id}','empty')" title="Tom">0</button>
          </div>
        </div>`;
    }).join('');
  }
  lucide.createIcons({ nodes: [el] });

  document.getElementById('start-scan-btn').onclick = () => startScanner();
}

async function startScanner() {
  const container = document.getElementById('scanner-container');
  if (!container) return;
  container.style.display = 'block';
  const scanBtn = document.getElementById('start-scan-btn');
  if (scanBtn) scanBtn.style.display = 'none';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    stream.getTracks().forEach(t => t.stop());
  } catch (permErr) {
    let msg = 'Kamera-adgang blev afvist.';
    if (permErr.name === 'NotAllowedError') {
      msg = 'Du skal give tilladelse til kameraet.<br><br>'
        + '<strong>iPhone/Safari:</strong> Tryk på "Aa" i adresselinjen → Webstedsindstillinger → Kamera → Tillad<br><br>'
        + '<strong>Android/Chrome:</strong> Tryk på hængelåsikonet → Tilladelser → Kamera → Tillad';
    } else if (permErr.name === 'NotFoundError') {
      msg = 'Ingen kamera fundet på denne enhed.';
    } else if (permErr.name === 'NotReadableError') {
      msg = 'Kameraet er i brug af en anden app. Luk andre apps og prøv igen.';
    }
    container.innerHTML = `<div class="empty-state" style="padding:20px">
      ${icon('camera-off')}
      <p>${msg}</p>
      <button class="btn btn-primary" style="margin-top:12px" onclick="retryScanner()">Prøv igen</button>
    </div>`;
    lucide.createIcons({ nodes: [container] });
    scannerRunning = false;
    return;
  }

  if (html5QrCode) { try { html5QrCode.clear(); } catch(e) {} }
  html5QrCode = new Html5Qrcode("scanner-container");
  scannerRunning = true;

  html5QrCode.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: { width: 280, height: 150 }, formatsToSupport: [
      Html5QrcodeSupportedFormats.EAN_13,
      Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A,
      Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128,
      Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.QR_CODE
    ]},
    async (decodedText) => {
      stopScanner();
      container.style.display = 'none';
      await handleBarcodeScan(decodedText);
    },
    () => {}
  ).catch(err => {
    container.innerHTML = `<div class="empty-state" style="padding:20px">${icon('camera-off')}<p>Kunne ikke starte scanner: ${err}</p>
      <button class="btn btn-primary" style="margin-top:12px" onclick="retryScanner()">Prøv igen</button></div>`;
    lucide.createIcons({ nodes: [container] });
  });
}

function retryScanner() {
  const scanBtn = document.getElementById('start-scan-btn');
  if (scanBtn) scanBtn.style.display = '';
  const container = document.getElementById('scanner-container');
  if (container) { container.style.display = 'none'; container.innerHTML = ''; }
  startScanner();
}

async function handleBarcodeScan(code) {
  const resultDiv = document.getElementById('scan-result');
  if (!resultDiv) return;

  // First check if it's a UUID (from QR code label) and navigate to item
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (uuidRegex.test(code)) {
    const { data: item } = await sb.from('items').select('id, name').eq('id', code).maybeSingle();
    if (item) {
      toast(`QR: Åbner ${item.name}`, 'info');
      setTimeout(() => showItemDetail(item.id), 300);
      const scanBtn = document.getElementById('start-scan-btn');
      if (scanBtn) scanBtn.style.display = '';
      return;
    }
  }

  try {
    const { data: item } = await sb
      .from('items')
      .select('*, locations(room_name, shelf_name)')
      .eq('barcode', code)
      .maybeSingle();

    if (item) {
      resultDiv.innerHTML = `
        <div class="scan-result">
          <h4>${icon('check-circle')} Fundet: ${esc(item.name)}</h4>
          <p>Antal: ${item.quantity} · Stregkode: ${esc(code)}</p>
          <div class="scan-actions">
            <button class="btn btn-primary btn-sm" onclick="logFood('${item.id}','added')">Tilføjet til lager</button>
            <button class="btn btn-outline btn-sm" onclick="logFood('${item.id}','used')">Brugt</button>
            <button class="btn btn-danger btn-sm" onclick="logFood('${item.id}','empty')">TOM</button>
            <button class="btn btn-ghost btn-sm" onclick="showItemDetail('${item.id}')">Detaljer</button>
          </div>
        </div>`;
    } else {
      resultDiv.innerHTML = `
        <div class="scan-result" style="border-color:var(--amber);background:var(--amber-light)">
          <h4>${icon('help-circle')} Ukendt vare: ${esc(code)}</h4>
          <p>Denne stregkode er ikke registreret endnu.</p>
          <div class="scan-actions">
            ${isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="closeModal();showItemFormWithBarcode('${esc(code)}')">Opret ny madvare</button>` : '<p>Bed en admin om at oprette varen.</p>'}
          </div>
        </div>`;
    }
    lucide.createIcons({ nodes: [resultDiv] });
  } catch (err) {
    resultDiv.innerHTML = `<p class="text-center" style="color:var(--red)">Fejl: ${esc(err.message)}</p>`;
  }
  const scanBtn = document.getElementById('start-scan-btn');
  if (scanBtn) scanBtn.style.display = '';
}

async function showItemFormWithBarcode(barcode) {
  await showItemForm();
  setTimeout(() => {
    const bc = document.getElementById('item-barcode');
    if (bc) bc.value = barcode;
    const type = document.getElementById('item-type');
    if (type) type.value = 'food';
  }, 100);
}

async function logFood(itemId, action) {
  try {
    const { error } = await sb.from('food_log').insert({
      item_id: itemId,
      user_id: currentSession.user.id,
      action,
      quantity: 1
    });
    if (error) throw error;

    if (action === 'added') {
      await sb.rpc('increment_item_quantity', { p_item_id: itemId, p_amount: 1 });
    } else if (action === 'used') {
      await sb.rpc('decrement_item_quantity', { p_item_id: itemId, p_amount: 1 });
    } else if (action === 'empty') {
      await sb.rpc('set_item_quantity_zero', { p_item_id: itemId });
    }

    const labels = { added: 'Tilføjet', used: 'Brugt', empty: 'Markeret tom' };
    const { data: itemData } = await sb.from('items').select('name').eq('id', itemId).single();
    await logActivity(`food_${action}`, 'food_log', itemId, `${labels[action]}: ${itemData?.name || itemId}`, { action, item_id: itemId });
    toast(labels[action] || action);
    navigate('kitchen');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── ACTIVITY LOG / HISTORIK ───────────────────────────────────────────
async function renderHistory(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Historik</h1>
      <div class="page-header-actions">
        <button class="btn btn-outline btn-sm" onclick="exportHistoryPDF()">${icon('file-down')} PDF</button>
      </div>
    </div>
    <div class="page-body">
      <div class="filters-bar">
        <select class="form-input filter-select" id="history-entity-filter">
          <option value="">Alle typer</option>
          <option value="item">Genstande</option>
          <option value="loan">Udlån</option>
          <option value="report">Rapporter</option>
          <option value="food_log">Madvarer</option>
          <option value="set">Sæt</option>
          <option value="trip">Ture</option>
        </select>
        <input type="date" class="form-input filter-select" id="history-date-from" placeholder="Fra dato">
        <input type="date" class="form-input filter-select" id="history-date-to" placeholder="Til dato">
      </div>
      <div id="history-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
      <div id="history-load-more" style="text-align:center;margin-top:16px"></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  let offset = 0;
  const pageSize = 30;
  let currentEntityType = '';
  let dateFrom = '';
  let dateTo = '';
  let allEntries = [];

  const loadHistory = async (reset = true) => {
    if (reset) {
      offset = 0;
      allEntries = [];
      document.getElementById('history-list').innerHTML = '<div class="loading-spinner"><div class="spinner"></div></div>';
    }

    let query = sb
      .from('activity_log')
      .select('*, profiles!activity_log_user_id_fkey(display_name)')
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (currentEntityType) query = query.eq('entity_type', currentEntityType);
    if (dateFrom) query = query.gte('created_at', dateFrom);
    if (dateTo) query = query.lte('created_at', dateTo + 'T23:59:59');

    const { data: entries, error } = await query;
    if (error) { toast(error.message, 'error'); return; }

    allEntries = reset ? (entries || []) : [...allEntries, ...(entries || [])];
    renderHistoryList(allEntries);

    const loadMoreEl = document.getElementById('history-load-more');
    if (entries && entries.length === pageSize) {
      loadMoreEl.innerHTML = `<button class="btn btn-outline" onclick="loadMoreHistory()">Indlæs flere</button>`;
    } else {
      loadMoreEl.innerHTML = '';
    }
    offset += pageSize;
  };

  window.loadMoreHistory = () => loadHistory(false);

  document.getElementById('history-entity-filter').onchange = (e) => { currentEntityType = e.target.value; loadHistory(); };
  document.getElementById('history-date-from').onchange = (e) => { dateFrom = e.target.value; loadHistory(); };
  document.getElementById('history-date-to').onchange = (e) => { dateTo = e.target.value; loadHistory(); };

  loadHistory();
}

function renderHistoryList(entries) {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (entries.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('scroll-text')}<h3>Ingen aktivitet</h3><p>Ingen poster matcher dine filtre</p></div>`;
    lucide.createIcons({ nodes: [list] });
    return;
  }

  const actionIcons = {
    item_created: 'package-plus',
    item_updated: 'pencil',
    item_deleted: 'trash-2',
    loan_created: 'hand-helping',
    loan_returned: 'check-circle',
    report_created: 'alert-triangle',
    report_updated: 'check-circle',
    food_added: 'plus-circle',
    food_used: 'minus-circle',
    food_empty: 'x-circle',
    set_created: 'boxes',
    trip_created: 'map',
    trip_packed: 'package-check',
    default: 'activity'
  };

  const actionColors = {
    item_created: 'green',
    item_updated: 'blue',
    item_deleted: 'red',
    loan_created: 'blue',
    loan_returned: 'green',
    report_created: 'red',
    report_updated: 'amber',
    food_added: 'green',
    food_used: 'amber',
    food_empty: 'red',
    set_created: 'navy',
    trip_created: 'teal',
    default: 'gray'
  };

  list.innerHTML = `<div class="history-list">` + entries.map(e => {
    const userName = e.profiles?.display_name || 'Ukendt';
    const initials = userName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const icName = actionIcons[e.action] || actionIcons.default;
    const color = actionColors[e.action] || 'gray';
    return `
      <div class="history-item">
        <div class="history-avatar">${initials}</div>
        <div class="history-icon ${color}">${icon(icName)}</div>
        <div class="history-body">
          <div class="history-desc"><strong>${esc(userName)}</strong> ${esc(e.description || e.action)}</div>
          <div class="history-meta">${formatTime(e.created_at)}</div>
        </div>
      </div>`;
  }).join('') + '</div>';
  lucide.createIcons({ nodes: [list] });
}

async function exportHistoryPDF() {
  try {
    const { data: entries } = await sb.from('activity_log')
      .select('*, profiles!activity_log_user_id_fkey(display_name)')
      .order('created_at', { ascending: false })
      .limit(200);

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Valhalla Gruppe – Aktivitetslog', 14, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Genereret: ${new Date().toLocaleDateString('da-DK')}`, 14, 28);

    const rows = (entries || []).map(e => [
      e.profiles?.display_name || 'Ukendt',
      e.action,
      e.description || '',
      new Date(e.created_at).toLocaleDateString('da-DK')
    ]);

    doc.autoTable({
      head: [['Bruger', 'Handling', 'Beskrivelse', 'Dato']],
      body: rows,
      startY: 34,
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [0, 51, 102], textColor: 255 },
      columnStyles: { 2: { cellWidth: 80 } }
    });

    doc.save(`valhalla-historik-${new Date().toISOString().split('T')[0]}.pdf`);
    toast('PDF eksporteret');
  } catch(e) { toast('PDF fejl: ' + e.message, 'error'); }
}

// ─── SHOPPING LIST ────────────────────────────────────────────────────
async function renderShoppingList(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Indkøbsliste</h1>
      <div class="page-header-actions">
        <button class="btn btn-outline btn-sm" onclick="exportShoppingPDF()">${icon('file-down')} PDF</button>
        <button class="btn btn-ghost btn-sm" onclick="copyShoppingList()">${icon('copy')} Kopiér</button>
      </div>
    </div>
    <div class="page-body">
      <div id="shopping-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const [{ data: lowStock }, { data: expiring }] = await Promise.all([
    sb.from('items').select('id, name, quantity, min_quantity, expiry_date').eq('type', 'food'),
    sb.from('items').select('id, name, quantity, expiry_date').eq('type', 'food').not('expiry_date', 'is', null).lte('expiry_date', in7Days)
  ]);

  const shoppingItems = [];
  const seenIds = new Set();

  // Low stock items
  (lowStock || []).filter(i => i.quantity <= i.min_quantity).forEach(i => {
    if (!seenIds.has(i.id)) {
      shoppingItems.push({ ...i, reason: `Lavt lager (${i.quantity}/${i.min_quantity} stk)`, priority: 'high' });
      seenIds.add(i.id);
    }
  });

  // Expiring items (< 7 days)
  (expiring || []).forEach(i => {
    if (!seenIds.has(i.id)) {
      const st = expiryStatus(i.expiry_date);
      shoppingItems.push({ ...i, reason: `Udløber ${formatDate(i.expiry_date)}`, priority: st === 'expired' || st === 'critical' ? 'high' : 'medium' });
      seenIds.add(i.id);
    }
  });

  const listEl = document.getElementById('shopping-list');
  if (shoppingItems.length === 0) {
    listEl.innerHTML = `<div class="empty-state">${icon('shopping-cart')}<h3>Ingen indkøb nødvendige</h3><p>Alle madvarer er på lager og indenfor udløbsdato</p></div>`;
    lucide.createIcons({ nodes: [listEl] });
    return;
  }

  const high = shoppingItems.filter(i => i.priority === 'high');
  const medium = shoppingItems.filter(i => i.priority === 'medium');

  listEl.innerHTML = `
    <p style="color:var(--text-3);margin-bottom:16px;font-size:0.9rem">${shoppingItems.length} varer skal købes</p>
    ${high.length > 0 ? `
      <h4 class="section-title" style="color:var(--red)">${icon('alert-triangle')} Høj prioritet (${high.length})</h4>
      ${high.map(i => `
        <div class="shopping-item high">
          <div class="shopping-item-name">${esc(i.name)}</div>
          <div class="shopping-item-reason">${esc(i.reason)}</div>
        </div>`).join('')}
    ` : ''}
    ${medium.length > 0 ? `
      <h4 class="section-title" style="color:var(--amber);margin-top:16px">${icon('clock')} Medium prioritet (${medium.length})</h4>
      ${medium.map(i => `
        <div class="shopping-item medium">
          <div class="shopping-item-name">${esc(i.name)}</div>
          <div class="shopping-item-reason">${esc(i.reason)}</div>
        </div>`).join('')}
    ` : ''}`;
  lucide.createIcons({ nodes: [listEl] });

  // Store for copy/export
  window._shoppingItems = shoppingItems;
}

window.copyShoppingList = () => {
  const items = window._shoppingItems || [];
  if (items.length === 0) { toast('Ingen varer at kopiere', 'error'); return; }
  const text = `Valhalla Gruppe – Indkøbsliste (${new Date().toLocaleDateString('da-DK')})\n\n` +
    items.map(i => `☐ ${i.name} – ${i.reason}`).join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Kopieret til udklipsholder')).catch(() => toast('Kopiering fejlede', 'error'));
};

window.exportShoppingPDF = async () => {
  const items = window._shoppingItems || [];
  if (items.length === 0) { toast('Ingen varer at eksportere', 'error'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('Valhalla Gruppe – Indkøbsliste', 14, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Genereret: ${new Date().toLocaleDateString('da-DK')}`, 14, 28);

  doc.autoTable({
    head: [['Vare', 'Årsag', 'Prioritet']],
    body: items.map(i => [i.name, i.reason, i.priority === 'high' ? 'Høj' : 'Medium']),
    startY: 34,
    styles: { fontSize: 10, cellPadding: 3 },
    headStyles: { fillColor: [0, 51, 102], textColor: 255 }
  });

  doc.save(`valhalla-indkoebsliste-${new Date().toISOString().split('T')[0]}.pdf`);
  toast('PDF eksporteret');
};

// ─── TRIPS / TURE ─────────────────────────────────────────────────────
async function renderTrips(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Ture</h1>
      <div class="page-header-actions">
        <button class="btn btn-primary btn-sm" onclick="showTripForm()">${icon('plus')} Ny tur</button>
      </div>
    </div>
    <div class="page-body">
      <div id="trips-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  const { data: trips, error } = await sb.from('trips').select('*').order('start_date', { ascending: false });
  if (error) { toast(error.message, 'error'); return; }

  const list = document.getElementById('trips-list');
  if (!trips || trips.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('map')}<h3>Ingen ture</h3><p>Opret din første tur for at komme i gang</p></div>`;
    lucide.createIcons({ nodes: [list] });
    return;
  }

  const statusColors = { planning: 'amber', packing: 'blue', active: 'green', completed: 'gray' };
  const statusLabels = { planning: 'Planlægning', packing: 'Pakning', active: 'Aktiv', completed: 'Afsluttet' };

  list.innerHTML = trips.map(t => `
    <div class="trip-card" onclick="showTripDetail('${t.id}')">
      <div class="trip-card-header">
        <div>
          <h3>${esc(t.name)}</h3>
          ${t.description ? `<p style="color:var(--text-3);font-size:0.88rem">${esc(t.description)}</p>` : ''}
        </div>
        <span class="status-badge ${statusColors[t.status] || 'gray'}">${statusLabels[t.status] || t.status}</span>
      </div>
      <div class="trip-card-meta">
        ${icon('calendar')} ${formatDate(t.start_date)}${t.end_date ? ` – ${formatDate(t.end_date)}` : ''}
      </div>
    </div>`).join('');
  lucide.createIcons({ nodes: [list] });
}

async function showTripDetail(tripId) {
  const [{ data: trip }, { data: tripItems }] = await Promise.all([
    sb.from('trips').select('*').eq('id', tripId).single(),
    sb.from('trip_items').select('*, items(id, name, image_url), item_sets(id, name)').eq('trip_id', tripId)
  ]);

  if (!trip) { toast('Tur ikke fundet', 'error'); return; }

  const items = tripItems || [];
  const totalPacked = items.filter(i => i.quantity_packed >= i.quantity_needed).length;
  const totalItems = items.length;
  const progress = totalItems > 0 ? Math.round((totalPacked / totalItems) * 100) : 0;

  const statusLabels = { planning: 'Planlægning', packing: 'Pakning', active: 'Aktiv', completed: 'Afsluttet' };
  const statusColors = { planning: 'amber', packing: 'blue', active: 'green', completed: 'gray' };
  const nextStatus = { planning: 'packing', packing: 'active', active: 'completed', completed: null };

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${esc(trip.name)}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="detail-meta-grid">
        <div class="detail-meta-item">
          <div class="detail-meta-label">Status</div>
          <div class="detail-meta-value"><span class="status-badge ${statusColors[trip.status]}">${statusLabels[trip.status]}</span></div>
        </div>
        <div class="detail-meta-item">
          <div class="detail-meta-label">Datoer</div>
          <div class="detail-meta-value">${formatDate(trip.start_date)}${trip.end_date ? ` – ${formatDate(trip.end_date)}` : ''}</div>
        </div>
      </div>

      ${totalItems > 0 ? `
        <div class="trip-progress">
          <div class="trip-progress-label">
            <span>Pakket: ${totalPacked}/${totalItems}</span>
            <span>${progress}%</span>
          </div>
          <div class="trip-progress-bar">
            <div class="trip-progress-fill" style="width:${progress}%"></div>
          </div>
        </div>
      ` : ''}

      <h4 class="section-title mt-4">${icon('package')} Pakkeliste (${items.length})</h4>
      ${items.length === 0 ? '<p style="color:var(--text-3)">Ingen genstande tilføjet endnu</p>' : ''}
      ${items.map(i => {
        const isPacked = i.quantity_packed >= i.quantity_needed;
        const name = i.items?.name || i.item_sets?.name || 'Ukendt';
        return `
          <div class="pack-item ${isPacked ? 'packed' : ''}">
            <div class="pack-item-check">
              <input type="checkbox" ${isPacked ? 'checked' : ''} onchange="togglePackItem('${i.id}', this.checked, ${i.quantity_needed}, '${tripId}')">
            </div>
            <div class="pack-item-image">${itemImage(i.items?.image_url)}</div>
            <div class="pack-item-info">
              <div class="pack-item-name">${esc(name)}</div>
              <div class="pack-item-qty">Behov: ${i.quantity_needed} · Pakket: ${i.quantity_packed}</div>
              ${i.notes ? `<div class="pack-item-notes">${esc(i.notes)}</div>` : ''}
            </div>
          </div>`;
      }).join('')}
    </div>
    <div class="detail-actions">
      ${isAdmin() ? `
        <button class="btn btn-outline btn-sm" onclick="showAddTripItem('${tripId}')">${icon('plus')} Tilføj genstand</button>
        ${nextStatus[trip.status] ? `<button class="btn btn-primary btn-sm" onclick="advanceTripStatus('${tripId}','${nextStatus[trip.status]}')">${icon('arrow-right')} ${statusLabels[nextStatus[trip.status]]}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="closeModal();showTripForm('${tripId}')">${icon('pencil')} Redigér</button>
        <button class="btn btn-outline btn-sm" onclick="exportTripPDF('${tripId}','${esc(trip.name).replace(/'/g,"\\'")}')">${icon('file-down')} PDF</button>
      ` : ''}
    </div>`);
}

async function togglePackItem(tripItemId, checked, quantityNeeded, tripId) {
  try {
    const quantityPacked = checked ? quantityNeeded : 0;
    await sb.from('trip_items').update({
      quantity_packed: quantityPacked,
      packed_by: checked ? currentSession.user.id : null,
      packed_at: checked ? new Date().toISOString() : null
    }).eq('id', tripItemId);
    await logActivity('trip_packed', 'trip', tripId, `Pakkeliste opdateret`, { trip_item_id: tripItemId, packed: checked });
    // Refresh the detail view
    closeModal();
    setTimeout(() => showTripDetail(tripId), 100);
  } catch(e) { toast(e.message, 'error'); }
}

async function advanceTripStatus(tripId, newStatus) {
  try {
    await sb.from('trips').update({ status: newStatus }).eq('id', tripId);

    // If going active, create loans for all packed items
    if (newStatus === 'active') {
      const { data: tripItems } = await sb.from('trip_items').select('*, items(id, name)').eq('trip_id', tripId).gt('quantity_packed', 0);
      for (const ti of (tripItems || [])) {
        if (ti.item_id && ti.items) {
          try {
            await sb.from('loans').insert({
              item_id: ti.item_id,
              user_id: currentSession.user.id,
              quantity: ti.quantity_packed,
              purpose: 'scout_trip',
              trip_name: '',
              expected_return: null
            });
            await sb.rpc('decrement_item_quantity', { p_item_id: ti.item_id, p_amount: ti.quantity_packed });
          } catch(e) { console.warn('Auto-lån fejlede for', ti.item_id, e.message); }
        }
      }
      toast('Tur aktiveret – udlån oprettet automatisk');
    }

    await logActivity('trip_status_changed', 'trip', tripId, `Tur status ændret til: ${newStatus}`, { status: newStatus });
    closeModal();
    setTimeout(() => showTripDetail(tripId), 100);
  } catch(e) { toast(e.message, 'error'); }
}

async function showAddTripItem(tripId) {
  const [{ data: items }, { data: sets }] = await Promise.all([
    sb.from('items').select('id, name, quantity').order('name'),
    sb.from('item_sets').select('id, name').order('name')
  ]);

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>Tilføj til pakkeliste</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>Type</label>
        <select class="form-input" id="trip-add-type">
          <option value="item">Enkelt genstand</option>
          <option value="set">Sæt</option>
        </select>
      </div>
      <div class="form-group" id="trip-item-group">
        <label>Genstand</label>
        <select class="form-input" id="trip-item-select">
          <option value="">Vælg genstand...</option>
          ${(items || []).map(i => `<option value="${i.id}">${esc(i.name)} (${i.quantity} stk)</option>`).join('')}
        </select>
      </div>
      <div class="form-group" id="trip-set-group" style="display:none">
        <label>Sæt</label>
        <select class="form-input" id="trip-set-select">
          <option value="">Vælg sæt...</option>
          ${(sets || []).map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Antal</label>
        <input type="number" class="form-input" id="trip-item-qty" value="1" min="1">
      </div>
      <div class="form-group">
        <label>Noter (valgfrit)</label>
        <input type="text" class="form-input" id="trip-item-notes" placeholder="F.eks. Tag stave med">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="trip-item-save">Tilføj</button>
    </div>`);

  document.getElementById('trip-add-type').onchange = (e) => {
    document.getElementById('trip-item-group').style.display = e.target.value === 'item' ? '' : 'none';
    document.getElementById('trip-set-group').style.display = e.target.value === 'set' ? '' : 'none';
  };

  document.getElementById('trip-item-save').onclick = async () => {
    const type = document.getElementById('trip-add-type').value;
    const qty = parseInt(document.getElementById('trip-item-qty').value) || 1;
    const notes = document.getElementById('trip-item-notes').value;

    const record = {
      trip_id: tripId,
      quantity_needed: qty,
      quantity_packed: 0,
      notes
    };

    if (type === 'item') {
      const itemId = document.getElementById('trip-item-select').value;
      if (!itemId) { toast('Vælg en genstand', 'error'); return; }
      record.item_id = itemId;
    } else {
      const setId = document.getElementById('trip-set-select').value;
      if (!setId) { toast('Vælg et sæt', 'error'); return; }
      record.set_id = setId;
    }

    try {
      await sb.from('trip_items').insert(record);
      toast('Tilføjet til pakkeliste');
      closeModal();
      setTimeout(() => showTripDetail(tripId), 100);
    } catch(e) { toast(e.message, 'error'); }
  };
}

async function showTripForm(editId) {
  let trip = null;
  if (editId) {
    const { data } = await sb.from('trips').select('*').eq('id', editId).single();
    trip = data;
  }

  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${trip ? 'Redigér tur' : 'Ny tur'}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group">
        <label>Turnavn</label>
        <input type="text" class="form-input" id="trip-name" value="${esc(trip?.name || '')}" placeholder="F.eks. Sommerlejr 2026">
      </div>
      <div class="form-group">
        <label>Beskrivelse</label>
        <textarea class="form-input" id="trip-desc" placeholder="Valgfri beskrivelse">${esc(trip?.description || '')}</textarea>
      </div>
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1">
          <label>Startdato</label>
          <input type="date" class="form-input" id="trip-start" value="${trip?.start_date || ''}">
        </div>
        <div class="form-group" style="flex:1">
          <label>Slutdato</label>
          <input type="date" class="form-input" id="trip-end" value="${trip?.end_date || ''}">
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="trip-save-btn">${trip ? 'Gem' : 'Opret tur'}</button>
    </div>`);

  document.getElementById('trip-save-btn').onclick = async () => {
    const name = document.getElementById('trip-name').value.trim();
    if (!name) { toast('Navn er påkrævet', 'error'); return; }

    const record = {
      name,
      description: document.getElementById('trip-desc').value,
      start_date: document.getElementById('trip-start').value || null,
      end_date: document.getElementById('trip-end').value || null
    };

    try {
      if (trip) {
        await sb.from('trips').update(record).eq('id', editId);
        toast('Tur opdateret');
      } else {
        record.status = 'planning';
        record.created_by = currentSession.user.id;
        const { data: newTrip, error } = await sb.from('trips').insert(record).select('id').single();
        if (error) throw error;
        await logActivity('trip_created', 'trip', newTrip?.id, `Ny tur oprettet: ${name}`, { name });
        toast('Tur oprettet');
      }
      closeModal();
      navigate('trips');
    } catch(e) { toast(e.message, 'error'); }
  };
}

async function exportTripPDF(tripId, tripName) {
  try {
    const { data: tripItems } = await sb.from('trip_items').select('*, items(name), item_sets(name)').eq('trip_id', tripId);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text(`Valhalla Gruppe – ${tripName}`, 14, 20);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Pakkeliste – ${new Date().toLocaleDateString('da-DK')}`, 14, 28);

    const rows = (tripItems || []).map(i => [
      i.items?.name || i.item_sets?.name || '–',
      String(i.quantity_needed),
      String(i.quantity_packed),
      i.quantity_packed >= i.quantity_needed ? '✓ Pakket' : '○ Mangler',
      i.notes || ''
    ]);

    doc.autoTable({
      head: [['Genstand', 'Behov', 'Pakket', 'Status', 'Noter']],
      body: rows,
      startY: 34,
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [0, 51, 102], textColor: 255 }
    });

    doc.save(`valhalla-pakkeliste-${tripId}.pdf`);
    toast('PDF eksporteret');
  } catch(e) { toast('PDF fejl: ' + e.message, 'error'); }
}

// ─── CATEGORIES ────────────────────────────────────────────────────────
async function renderCategories(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Kategorier</h1>
      <div class="page-header-actions">
        <button class="btn btn-primary btn-sm" onclick="showCategoryForm()">${icon('plus')} Ny kategori</button>
      </div>
    </div>
    <div class="page-body">
      <div id="categories-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  const cats = await loadCategories(true);

  const { data: catCounts } = await sb.from('item_categories').select('category_id');
  const countMap = {};
  (catCounts || []).forEach(row => {
    countMap[row.category_id] = (countMap[row.category_id] || 0) + 1;
  });

  // Get profiles for responsible user
  const { data: profiles } = await sb.from('profiles').select('id, display_name').order('display_name');
  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.id] = p.display_name; });

  const list = document.getElementById('categories-list');
  if (cats.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('tags')}<h3>Ingen kategorier</h3></div>`;
  } else {
    list.innerHTML = `<div class="admin-list">${cats.map(c => {
      const responsibleName = c.responsible_user_id ? (profileMap[c.responsible_user_id] || 'Ukendt') : (c.responsible_person || '');
      return `
        <div class="admin-list-item">
          <div class="admin-list-icon">${icon(c.icon || 'folder')}</div>
          <div class="admin-list-info">
            <h4>${esc(c.name)}</h4>
            <p>${esc(c.description || '')}${responsibleName ? ' · Ansvarlig: ' + esc(responsibleName) : ''}</p>
          </div>
          <div class="admin-list-meta">${countMap[c.id] || 0} genstande</div>
          <div class="admin-list-actions">
            <button class="btn btn-ghost btn-sm" onclick="showCategoryForm('${c.id}')">${icon('pencil')}</button>
            <button class="btn btn-ghost btn-sm" onclick="deleteCategory('${c.id}')">${icon('trash-2')}</button>
          </div>
        </div>`;
    }).join('')}</div>`;
  }
  lucide.createIcons({ nodes: [el] });
}

async function showCategoryForm(editId) {
  const { data: profiles } = await sb.from('profiles').select('id, display_name').order('display_name');

  let cat = null;
  if (editId) {
    const cats = await loadCategories(true);
    cat = cats.find(c => c.id === editId);
  }
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${cat ? 'Redigér kategori' : 'Ny kategori'}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label>Navn</label><input type="text" class="form-input" id="cat-name" value="${esc(cat?.name || '')}"></div>
      <div class="form-group"><label>Beskrivelse</label><textarea class="form-input" id="cat-desc">${esc(cat?.description || '')}</textarea></div>
      <div class="form-group">
        <label>Ansvarlig leder</label>
        <select class="form-input" id="cat-responsible-user">
          <option value="">Ingen ansvarlig</option>
          ${(profiles || []).map(p => `<option value="${p.id}" ${cat?.responsible_user_id === p.id ? 'selected' : ''}>${esc(p.display_name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label>Ikon (Lucide-navn)</label><input type="text" class="form-input" id="cat-icon" value="${esc(cat?.icon || 'folder')}" placeholder="f.eks. tent, flame, wrench"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="cat-save-btn">${cat ? 'Gem' : 'Opret'}</button>
    </div>`);

  document.getElementById('cat-save-btn').onclick = async () => {
    const responsibleUserId = document.getElementById('cat-responsible-user').value || null;
    const body = {
      name: document.getElementById('cat-name').value.trim(),
      description: document.getElementById('cat-desc').value,
      responsible_user_id: responsibleUserId,
      icon: document.getElementById('cat-icon').value || 'folder'
    };
    if (!body.name) { toast('Navn er påkrævet', 'error'); return; }
    try {
      if (cat) {
        const { error } = await sb.from('categories').update(body).eq('id', editId);
        if (error) throw error;
        toast('Kategori opdateret');
      } else {
        const { error } = await sb.from('categories').insert(body);
        if (error) throw error;
        toast('Kategori oprettet');
      }
      closeModal();
      cachedData.categories = null;
      navigate('categories');
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function deleteCategory(id) {
  if (!confirm('Slet denne kategori?')) return;
  try {
    const { error } = await sb.from('categories').delete().eq('id', id);
    if (error) throw error;
    toast('Kategori slettet');
    cachedData.categories = null;
    navigate('categories');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── LOCATIONS ─────────────────────────────────────────────────────────
async function renderLocations(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Lokationer</h1>
      <div class="page-header-actions">
        <button class="btn btn-primary btn-sm" onclick="showLocationForm()">${icon('plus')} Ny lokation</button>
      </div>
    </div>
    <div class="page-body">
      <div id="locations-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  const locs = await loadLocations(true);

  const { data: locCounts } = await sb.from('items').select('location_id');
  const countMap = {};
  (locCounts || []).forEach(row => {
    if (row.location_id) countMap[row.location_id] = (countMap[row.location_id] || 0) + 1;
  });

  const list = document.getElementById('locations-list');
  if (locs.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('map-pin')}<h3>Ingen lokationer</h3></div>`;
  } else {
    list.innerHTML = `<div class="admin-list">${locs.map(l => `
      <div class="admin-list-item">
        <div class="admin-list-icon">${icon('map-pin')}</div>
        <div class="admin-list-info">
          <h4>${esc(l.room_name)}${l.shelf_name ? ' – ' + esc(l.shelf_name) : ''}</h4>
          <p>${esc(l.description || '')}</p>
        </div>
        <div class="admin-list-meta">${countMap[l.id] || 0} genstande</div>
        <div class="admin-list-actions">
          <button class="btn btn-ghost btn-sm" onclick="showLocationForm('${l.id}')">${icon('pencil')}</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteLocation('${l.id}')">${icon('trash-2')}</button>
        </div>
      </div>`).join('')}</div>`;
  }
  lucide.createIcons({ nodes: [el] });
}

async function showLocationForm(editId) {
  let loc = null;
  if (editId) {
    const locs = await loadLocations(true);
    loc = locs.find(l => l.id === editId);
  }
  openModal(`
    <div class="modal-handle"></div>
    <div class="modal-header">
      <h2>${loc ? 'Redigér lokation' : 'Ny lokation'}</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="form-group"><label>Rum</label><input type="text" class="form-input" id="loc-room" value="${esc(loc?.room_name || '')}" placeholder="F.eks. Materiale-rum"></div>
      <div class="form-group"><label>Hylde/Skab</label><input type="text" class="form-input" id="loc-shelf" value="${esc(loc?.shelf_name || '')}" placeholder="F.eks. Hylde 1"></div>
      <div class="form-group"><label>Beskrivelse</label><textarea class="form-input" id="loc-desc">${esc(loc?.description || '')}</textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="loc-save-btn">${loc ? 'Gem' : 'Opret'}</button>
    </div>`);

  document.getElementById('loc-save-btn').onclick = async () => {
    const body = {
      room_name: document.getElementById('loc-room').value.trim(),
      shelf_name: document.getElementById('loc-shelf').value,
      description: document.getElementById('loc-desc').value
    };
    if (!body.room_name) { toast('Rum er påkrævet', 'error'); return; }
    try {
      if (loc) {
        const { error } = await sb.from('locations').update(body).eq('id', editId);
        if (error) throw error;
        toast('Lokation opdateret');
      } else {
        const { error } = await sb.from('locations').insert(body);
        if (error) throw error;
        toast('Lokation oprettet');
      }
      closeModal();
      cachedData.locations = null;
      navigate('locations');
    } catch (err) { toast(err.message, 'error'); }
  };
}

async function deleteLocation(id) {
  if (!confirm('Slet denne lokation?')) return;
  try {
    await sb.from('items').update({ location_id: null }).eq('location_id', id);
    const { error } = await sb.from('locations').delete().eq('id', id);
    if (error) throw error;
    toast('Lokation slettet');
    cachedData.locations = null;
    navigate('locations');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── USERS ─────────────────────────────────────────────────────────────
async function renderUsers(el) {
  el.innerHTML = `
    <div class="page-header">
      <h1>Brugere</h1>
      <button class="btn btn-primary" onclick="showCreateUserModal()">
        ${icon('user-plus')} Opret bruger
      </button>
    </div>
    <div class="page-body">
      <div id="users-list"><div class="loading-spinner"><div class="spinner"></div></div></div>
    </div>`;
  lucide.createIcons({ nodes: [el] });

  try {
    const { data: users, error } = await sb.from('profiles').select('*').order('display_name');
    if (error) throw error;

    const list = document.getElementById('users-list');
    list.innerHTML = `<div class="admin-list">${(users || []).map(u => {
      const initials = u.display_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
      return `
        <div class="admin-list-item">
          <div class="nav-user-avatar" style="width:40px;height:40px;background:var(--green-600);color:var(--amber-300);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0">${initials}</div>
          <div class="admin-list-info">
            <h4>${esc(u.display_name)}</h4>
            <p>${esc(u.username || '')} · ${u.role === 'admin' ? 'Administrator' : 'Leder'}</p>
          </div>
          <div class="admin-list-meta">${formatDate(u.created_at)}</div>
          <div class="admin-list-actions">
            ${u.id !== currentUser.id ? `
              <button class="btn btn-ghost btn-sm" onclick="toggleUserRole('${u.id}','${u.role}')" title="Skift rolle">${icon(u.role === 'admin' ? 'shield-off' : 'shield')}</button>
            ` : ''}
          </div>
        </div>`;
    }).join('')}</div>`;
    lucide.createIcons({ nodes: [el] });
  } catch (err) { toast(err.message, 'error'); }
}

function showCreateUserModal() {
  openModal(`
    <div class="modal-header">
      <h2>${icon('user-plus')} Opret ny bruger</h2>
      <button class="modal-close" onclick="closeModal()">${icon('x')}</button>
    </div>
    <form id="create-user-form">
      <div class="form-group" style="padding:0 24px">
        <label>Navn</label>
        <input type="text" class="form-input" id="new-user-name" placeholder="F.eks. Anders Hansen" required>
      </div>
      <div class="form-group" style="padding:0 24px">
        <label>Email</label>
        <input type="email" class="form-input" id="new-user-email" placeholder="email@eksempel.dk" required>
      </div>
      <div class="form-group" style="padding:0 24px">
        <label>Adgangskode</label>
        <input type="password" class="form-input" id="new-user-pass" placeholder="Mindst 6 tegn" minlength="6" required>
      </div>
      <div class="form-group" style="padding:0 24px">
        <label>Rolle</label>
        <select class="form-input" id="new-user-role">
          <option value="leader">Leder</option>
          <option value="admin">Administrator</option>
        </select>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Annuller</button>
        <button type="submit" class="btn btn-primary" id="create-user-btn">${icon('user-plus')} Opret</button>
      </div>
    </form>`);
  document.getElementById('create-user-form').onsubmit = handleCreateUser;
}

async function handleCreateUser(e) {
  e.preventDefault();
  const name = document.getElementById('new-user-name').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const password = document.getElementById('new-user-pass').value;
  const role = document.getElementById('new-user-role').value;
  const btn = document.getElementById('create-user-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span> Opretter...`;

  try {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    const userId = data.user?.id;
    if (!userId) throw new Error('Brugeren blev ikke oprettet korrekt');

    await new Promise(r => setTimeout(r, 1500));
    const { error: upErr } = await sb.from('profiles').upsert({
      id: userId,
      username: email,
      display_name: name,
      role: role
    });
    if (upErr) throw upErr;

    const { data: { session } } = await sb.auth.getSession();
    if (session) {
      currentSession = session;
    }

    toast(`Bruger ${name} oprettet!`);
    closeModal();
    navigate('users');
  } catch (err) {
    toast(err.message || 'Kunne ikke oprette bruger', 'error');
    btn.disabled = false;
    btn.innerHTML = `${icon('user-plus')} Opret`;
    lucide.createIcons({ nodes: [btn] });
  }
}

async function toggleUserRole(userId, currentRole) {
  const newRole = currentRole === 'admin' ? 'leader' : 'admin';
  const label = newRole === 'admin' ? 'Administrator' : 'Leder';
  if (!confirm(`Ændr brugerens rolle til ${label}?`)) return;
  try {
    const { error } = await sb.from('profiles').update({ role: newRole }).eq('id', userId);
    if (error) throw error;
    toast(`Rolle ændret til ${label}`);
    navigate('users');
  } catch (err) { toast(err.message, 'error'); }
}

// ─── Data Loaders ──────────────────────────────────────────────────────
async function loadCategories(force) {
  if (!force && cachedData.categories) return cachedData.categories;
  const { data, error } = await sb.from('categories').select('*').order('name');
  if (error) { toast(error.message, 'error'); return []; }
  cachedData.categories = data || [];
  return cachedData.categories;
}
async function loadLocations(force) {
  if (!force && cachedData.locations) return cachedData.locations;
  const { data, error } = await sb.from('locations').select('*').order('room_name').order('shelf_name');
  if (error) { toast(error.message, 'error'); return []; }
  cachedData.locations = data || [];
  return cachedData.locations;
}

// ─── Helpers ───────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function statusLabel(status) {
  const labels = {
    open: 'Åben',
    acknowledged: 'Bekræftet',
    resolved: 'Løst',
    retired: 'Udgået',
    active: 'Aktiv',
    returned: 'Returneret'
  };
  return labels[status] || status;
}

async function handleLogout() {
  try { await sb.auth.signOut(); } catch(e) {}
  currentSession = null;
  currentUser = null;
  cachedData = { categories: null, locations: null, items: null };
  navigate('login');
}

// ─── Auth State Listener ───────────────────────────────────────────────
function setupAuthListener() {
  if (!sb) return;
  sb.auth.onAuthStateChange(async (event, session) => {
    if (event === 'SIGNED_OUT') {
      currentSession = null;
      currentUser = null;
      cachedData = { categories: null, locations: null, items: null };
      if (currentRoute !== 'login') navigate('login');
    } else if (event === 'SIGNED_IN' && session) {
      currentSession = session;
      await loadProfile();
    } else if (event === 'TOKEN_REFRESHED' && session) {
      currentSession = session;
    }
  });
}

// ─── Init ──────────────────────────────────────────────────────────────
(async function init() {
  try {
    // Initialize theme before rendering
    initTheme();

    if (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey) {
      try {
        initSupabase(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
        configReady = true;
        setupAuthListener();

        const { data: { session } } = await sb.auth.getSession();
        if (session) {
          currentSession = session;
          await loadProfile();
          currentRoute = getRoute();
          if (currentRoute === 'login') currentRoute = 'dashboard';
        } else {
          currentRoute = 'login';
        }
      } catch (e) {
        configReady = false;
      }
    }

    currentRoute = getRoute();
    render();

    if (configReady) setupAuthListener();
  } catch (fatal) {
    var app = document.getElementById('app');
    if (app) app.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif;"><h2>Noget gik galt</h2><p>' + (fatal.message || 'Ukendt fejl') + '</p><button onclick="location.reload()" style="padding:10px 20px;margin-top:16px;cursor:pointer;">Genindlæs</button></div>';
  }
})();
