/* ═══════════════════════════════════════════════════════════════════════
   Valhalla Gruppe – Lagersystem SPA (Supabase Edition)
   ═══════════════════════════════════════════════════════════════════════ */

// ─── Supabase Client ───────────────────────────────────────────────────
let sb = null;
let supabaseUrl = '';
let supabaseAnonKey = '';

function initSupabase(url, key) {
  supabaseUrl = url;
  supabaseAnonKey = key;
  // Use in-memory storage adapter to work in sandboxed iframes
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
let currentUser = null;  // { id, username, display_name, role }
let currentRoute = 'login';
let cachedData = { categories: null, locations: null, items: null };
let html5QrCode = null;
let scannerRunning = false;
let configReady = false;

// ─── Toast ─────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const ic = type === 'success' ? 'check-circle' : type === 'error' ? 'alert-circle' : 'info';
  el.innerHTML = `<i data-lucide="${ic}"></i><span>${msg}</span>`;
  document.getElementById('toast-container').appendChild(el);
  lucide.createIcons({ nodes: [el] });
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

// ─── Image Engine (WebP, resize, auto-cleanup) ───────────────────────
const IMG_MAX_WIDTH  = 800;   // max bredde i px
const IMG_MAX_HEIGHT = 800;   // max højde i px
const IMG_QUALITY    = 0.75;  // 0-1 kvalitet (0.75 ≈ god balance)
const IMG_FORMAT     = 'image/webp'; // WebP = ~30-50% mindre end JPEG
const IMG_EXT        = '.webp';

// Tjek om browseren understøtter WebP-encoding
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

        // Scale ned så det passer inden for maxW × maxH
        if (w > maxW || h > maxH) {
          const ratio = Math.min(maxW / w, maxH / h);
          w = Math.round(w * ratio);
          h = Math.round(h * ratio);
        }
        canvas.width = w;
        canvas.height = h;

        // Tegn med høj kvalitet
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);

        // WebP hvis understøttet, ellers JPEG som fallback
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

// Hent filnavnet fra en Supabase Storage public URL
function storageFilename(url) {
  if (!url || !url.includes('/storage/v1/object/public/images/')) return null;
  try {
    const parts = url.split('/storage/v1/object/public/images/');
    return parts[1] ? decodeURIComponent(parts[1].split('?')[0]) : null;
  } catch { return null; }
}

// Slet et gammelt billede fra Supabase Storage
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
    // Support both full URLs (Supabase) and relative paths (legacy)
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

// ─── RENDER ────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');

  // Show config screen if Supabase not initialized
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
          <p style="text-align:center;margin-top:12px;font-size:13px;color:var(--stone-500)">
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
      // Test the connection by querying categories
      const { error } = await sb.from('categories').select('id').limit(1);
      if (error) throw new Error(error.message);
      configReady = true;
      // Check for existing session
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
    // Profile might not exist yet — try to create it
    await new Promise(r => setTimeout(r, 1000));
    const retry = await sb.from('profiles').select('*').eq('id', currentSession.user.id).single();
    if (retry.error) {
      // Profile still missing — create it now
      const email = currentSession.user.email || '';
      // Check if this is the first user — make them admin
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
  ` : '';

  const initials = currentUser ? currentUser.display_name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2) : '?';

  return `
    <!-- Mobile Top Bar -->
    <div class="mobile-topbar">
      <div class="mobile-topbar-title">${icon('compass')} Valhalla Gruppe</div>
      <div class="mobile-topbar-user">
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
        <div class="nav-link" data-route="loans">${icon('hand-helping')} Udlån <span class="badge" id="nav-loans-badge" style="display:none"></span></div>
        <div class="nav-link" data-route="reports">${icon('alert-triangle')} Rapporter <span class="badge" id="nav-reports-badge" style="display:none"></span></div>
        <div class="nav-link" data-route="kitchen">${icon('scan-barcode')} Køkken / Scanner</div>
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
          <button class="btn btn-ghost btn-sm w-full" onclick="handleLogout()">${icon('log-out')} Log ud</button>
        </div>
      </nav>

      <!-- Main Content -->
      <main class="main-content" id="main-content"></main>
    </div>

    <!-- Bottom Nav (Mobile) -->
    <nav class="bottom-nav">
      <div class="bottom-nav-items">
        <button class="bottom-nav-item" data-route="dashboard">${icon('layout-dashboard')}<span>Dashboard</span></button>
        <button class="bottom-nav-item" data-route="items">${icon('package')}<span>Materiale</span></button>
        <button class="bottom-nav-item" data-route="loans">${icon('hand-helping')}<span>Udlån</span></button>
        <button class="bottom-nav-item" data-route="reports">${icon('alert-triangle')}<span>Rapporter</span></button>
        <button class="bottom-nav-item" data-route="kitchen">${icon('scan-barcode')}<span>Scanner</span></button>
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
    el.onclick = () => navigate(el.dataset.route);
  });

  // Route
  const route = currentRoute.split('/');
  switch(route[0]) {
    case 'dashboard': renderDashboard(main); break;
    case 'items': renderItems(main); break;
    case 'loans': renderLoans(main); break;
    case 'reports': renderReports(main); break;
    case 'kitchen': renderKitchen(main); break;
    case 'categories': isAdmin() ? renderCategories(main) : navigate('dashboard'); break;
    case 'locations': isAdmin() ? renderLocations(main) : navigate('dashboard'); break;
    case 'users': isAdmin() ? renderUsers(main) : navigate('dashboard'); break;
    default: navigate('dashboard');
  }
}

// ─── DASHBOARD ─────────────────────────────────────────────────────────
async function renderDashboard(el) {
  el.innerHTML = `<div class="page-body"><div class="loading-spinner"><div class="spinner"></div></div></div>`;
  try {
    // Fetch stats in parallel
    const [
      { count: totalItems },
      { count: activeLoans },
      { count: openReports },
      { data: lowStockItems },
      { data: overdueLoans },
      { data: recentLoansData },
      { data: recentReportsData },
      { data: recentFoodData }
    ] = await Promise.all([
      sb.from('items').select('*', { count: 'exact', head: true }),
      sb.from('loans').select('*', { count: 'exact', head: true }).eq('status', 'active'),
      sb.from('reports').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      sb.from('items').select('id, quantity, min_quantity').eq('type', 'food'),
      sb.from('loans').select('id').eq('status', 'active').not('expected_return', 'is', null).lt('expected_return', new Date().toISOString().split('T')[0]),
      sb.from('loans').select('*, items!loans_item_id_fkey(name, image_url), profiles!loans_user_id_fkey_profiles(display_name)').order('loan_date', { ascending: false }).limit(5),
      sb.from('reports').select('*, items!reports_item_id_fkey(name, image_url), profiles!reports_user_id_fkey_profiles(display_name)').order('created_at', { ascending: false }).limit(5),
      sb.from('food_log').select('*, items!food_log_item_id_fkey(name, image_url), profiles!food_log_user_id_fkey_profiles(display_name)').order('created_at', { ascending: false }).limit(5)
    ]);

    // lowStockItems: client-side filter since Supabase can't compare two columns directly
    const lowStock = (lowStockItems || []).filter(i => i.quantity <= i.min_quantity).length;
    const overdueCount = (overdueLoans || []).length;

    const s = {
      total_items: totalItems || 0,
      active_loans: activeLoans || 0,
      open_reports: openReports || 0,
      low_stock: lowStock,
      overdue_loans: overdueCount
    };

    // Transform recent activity
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

    el.innerHTML = `
      <div class="page-body">
        <div class="welcome-banner">
          <h2>Velkommen, ${currentUser.display_name}!</h2>
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

        <h3 class="section-title">${icon('clock')} Seneste aktivitet</h3>
        <div class="activity-feed">
          ${renderActivityFeed({ recent_loans: recentLoans, recent_reports: recentReports, recent_food: recentFood })}
        </div>
      </div>`;
    lucide.createIcons({ nodes: [el] });
    updateNavBadges(s);
  } catch (err) {
    el.innerHTML = `<div class="page-body"><div class="empty-state">${icon('wifi-off')}<h3>Kunne ikke hente data</h3><p>${err.message}</p></div></div>`;
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
    </div>`;
  lucide.createIcons({ nodes: [el] });

  // Load filters
  const [categories, locations] = await Promise.all([
    loadCategories(), loadLocations()
  ]);
  const catSel = document.getElementById('items-cat-filter');
  const locSel = document.getElementById('items-loc-filter');
  categories.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.name; catSel.appendChild(o); });
  locations.forEach(l => { const o = document.createElement('option'); o.value = l.id; o.textContent = `${l.room_name}${l.shelf_name ? ' – ' + l.shelf_name : ''}`; locSel.appendChild(o); });

  // Filter handlers
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

    // Client-side category filter (since it's a junction table)
    let filtered = items || [];
    if (currentCat) {
      filtered = filtered.filter(item =>
        (item.item_categories || []).some(ic => ic.categories?.id === currentCat)
      );
    }

    // Transform items to flat format
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
    return `
      <div class="item-card" onclick="showItemDetail('${item.id}')">
        <div class="item-card-image">
          ${itemImage(item.image_url)}
          <div class="item-card-qty ${isLow ? 'low' : ''}">${item.quantity} stk</div>
        </div>
        <div class="item-card-body">
          <div class="item-card-name">${esc(item.name)}</div>
          ${loc ? `<div class="item-card-meta">${icon('map-pin')} ${esc(loc)}</div>` : ''}
          <div class="item-card-tags">
            ${item.type === 'food' ? `<span class="tag food">Madvare</span>` : ''}
            ${(item.categories || []).slice(0, 3).map(c => `<span class="tag">${esc(c.name)}</span>`).join('')}
          </div>
        </div>
      </div>`;
  }).join('');
  lucide.createIcons({ nodes: [grid] });
}

async function showItemDetail(id) {
  try {
    // Get item with location and categories
    const { data: item, error } = await sb
      .from('items')
      .select('*, locations(room_name, shelf_name), item_categories(categories(id, name, icon))')
      .eq('id', id)
      .single();
    if (error) throw error;

    // Flatten
    item.room_name = item.locations?.room_name || '';
    item.shelf_name = item.locations?.shelf_name || '';
    item.categories = (item.item_categories || []).map(ic => ic.categories).filter(Boolean);

    // Get active loans for this item
    const { data: activeLoans } = await sb
      .from('loans')
      .select('*, profiles!loans_user_id_fkey_profiles(display_name)')
      .eq('item_id', id)
      .eq('status', 'active');

    const loans = (activeLoans || []).map(l => ({
      ...l,
      user_name: l.profiles?.display_name || 'Ukendt'
    }));

    // Get reports for this item
    const { data: reportsData } = await sb
      .from('reports')
      .select('*, profiles!reports_user_id_fkey_profiles(display_name)')
      .eq('item_id', id)
      .order('created_at', { ascending: false });

    const reports = (reportsData || []).map(r => ({
      ...r,
      user_name: r.profiles?.display_name || 'Ukendt'
    }));

    const isLow = item.type === 'food' && item.quantity <= item.min_quantity;
    const loc = item.room_name ? `${item.room_name}${item.shelf_name ? ' – ' + item.shelf_name : ''}` : 'Ikke angivet';

    openModal(`
      <div class="modal-handle"></div>
      <div class="detail-image">${itemImage(item.image_url)}</div>
      <div class="detail-info">
        <h2>${esc(item.name)}</h2>
        ${item.description ? `<p class="detail-description">${esc(item.description)}</p>` : ''}
        <div class="detail-meta-grid">
          <div class="detail-meta-item">
            <div class="detail-meta-label">Antal</div>
            <div class="detail-meta-value" style="${isLow ? 'color:var(--red-500)' : ''}">${item.quantity} stk ${isLow ? '⚠️ Lavt lager' : ''}</div>
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
        </div>
        <div class="item-card-tags mb-4">
          ${(item.categories || []).map(c => `<span class="tag">${esc(c.name)}</span>`).join('')}
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

  // Image handler
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

  // Save handler
  document.getElementById('item-save-btn').onclick = async () => {
    const name = document.getElementById('item-name').value.trim();
    if (!name) { toast('Navn er påkrævet', 'error'); return; }
    const catCheckboxes = document.querySelectorAll('input[name="item-cats"]:checked');
    const catIds = Array.from(catCheckboxes).map(cb => cb.value);

    let imageUrl = item?.image_url || '';
    const oldImageUrl = item?.image_url || '';
    if (imageResult) {
      try {
        imageUrl = await uploadImage(imageResult.blob, 'item', imageResult.format, imageResult.ext);
        // Slet det gamle billede fra Storage hvis der var et
        if (oldImageUrl && oldImageUrl !== imageUrl) {
          deleteStorageImage(oldImageUrl); // fire-and-forget
        }
      } catch (err) {
        toast(err.message, 'error');
        return;
      }
    }

    const record = {
      name,
      description: document.getElementById('item-desc').value,
      type: document.getElementById('item-type').value,
      quantity: parseInt(document.getElementById('item-qty').value) || 0,
      min_quantity: parseInt(document.getElementById('item-minqty').value) || 0,
      barcode: document.getElementById('item-barcode').value.trim(),
      location_id: document.getElementById('item-location').value || null,
      image_url: imageUrl,
      updated_at: new Date().toISOString()
    };

    try {
      if (isEdit) {
        const { error } = await sb.from('items').update(record).eq('id', editId);
        if (error) throw error;

        // Update categories: delete old, insert new
        await sb.from('item_categories').delete().eq('item_id', editId);
        if (catIds.length > 0) {
          const catRows = catIds.map(cid => ({ item_id: editId, category_id: cid }));
          await sb.from('item_categories').insert(catRows);
        }
        toast('Genstand opdateret');
      } else {
        record.created_by = currentSession.user.id;
        const { data: newItem, error } = await sb.from('items').insert(record).select('id').single();
        if (error) throw error;

        if (catIds.length > 0) {
          const catRows = catIds.map(cid => ({ item_id: newItem.id, category_id: cid }));
          await sb.from('item_categories').insert(catRows);
        }
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
    // Hent billedets URL først så vi kan slette fra Storage
    const { data: item } = await sb.from('items').select('image_url').eq('id', id).single();
    // item_categories will cascade
    const { error } = await sb.from('items').delete().eq('id', id);
    if (error) throw error;
    // Slet billedet fra Storage (fire-and-forget)
    if (item?.image_url) deleteStorageImage(item.image_url);
    toast('Genstand slettet');
    closeModal();
    cachedData.items = null;
    navigate('items');
  } catch (err) { toast(err.message, 'error'); }
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
  // Load items for selection
  const { data: items, error } = await sb
    .from('items')
    .select('id, name, quantity')
    .order('name');
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
      const { error } = await sb.from('loans').insert({
        item_id: itemId,
        user_id: currentSession.user.id,
        quantity,
        purpose: document.getElementById('loan-purpose').value,
        trip_name: document.getElementById('loan-trip')?.value || '',
        expected_return: document.getElementById('loan-return').value || null
      });
      if (error) throw error;
      // Decrement item quantity
      await sb.rpc('decrement_item_quantity', { p_item_id: itemId, p_amount: quantity });
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
    // Increment item quantity back
    await sb.rpc('increment_item_quantity', { p_item_id: itemId, p_amount: quantity });
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
        <hr style="margin:16px 0;border:none;border-top:1px solid #e8e5de">
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

    // If retiring, set item quantity to 0
    if (status === 'retired' && itemId) {
      await sb.rpc('set_item_quantity_zero', { p_item_id: itemId });
    }
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
    area.innerHTML = `<div style="padding:20px;text-align:center"><span class="spinner" style="width:24px;height:24px;border-width:2px;display:inline-block"></span><p style="margin-top:8px;font-size:0.82rem;color:var(--text-3)">Optimerer billede...</p></div>`;
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
      const { error } = await sb.from('reports').insert({
        item_id: itemId,
        user_id: currentSession.user.id,
        type: document.getElementById('report-type').value,
        description: document.getElementById('report-desc').value,
        image_url: imageUrl
      });
      if (error) throw error;
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

  // Load food items
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
      return `
        <div class="food-list-item ${isLow ? 'low-stock' : 'ok'}">
          <div class="food-qty ${isLow ? 'low' : ''}">${i.quantity}</div>
          <div class="food-info">
            <h4>${esc(i.name)}</h4>
            <p>${i.locations?.room_name ? esc(i.locations.room_name) : ''}${i.locations?.shelf_name ? ' · ' + esc(i.locations.shelf_name) : ''}${i.barcode ? ' · ' + esc(i.barcode) : ''}</p>
          </div>
          ${isLow ? `<div class="food-warning">${icon('alert-triangle')} Lavt lager</div>` : ''}
          <div style="display:flex;gap:4px">
            <button class="btn btn-primary btn-sm" onclick="logFood('${i.id}','added')" title="Tilføj">+</button>
            <button class="btn btn-outline btn-sm" onclick="logFood('${i.id}','used')" title="Brugt">−</button>
            <button class="btn btn-danger btn-sm" onclick="logFood('${i.id}','empty')" title="Tom">0</button>
          </div>
        </div>`;
    }).join('');
  }
  lucide.createIcons({ nodes: [el] });

  // Scanner setup
  document.getElementById('start-scan-btn').onclick = () => startScanner();
}

async function startScanner() {
  const container = document.getElementById('scanner-container');
  if (!container) return;
  container.style.display = 'block';
  const scanBtn = document.getElementById('start-scan-btn');
  if (scanBtn) scanBtn.style.display = 'none';

  // First request camera permission explicitly
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    // Permission granted — stop the stream immediately, html5QrCode will open its own
    stream.getTracks().forEach(t => t.stop());
  } catch (permErr) {
    // Show user-friendly message with instructions
    let msg = 'Kamera-adgang blev afvist.';
    if (permErr.name === 'NotAllowedError') {
      msg = 'Du skal give tilladelse til kameraet.<br><br>'
        + '<strong>iPhone/Safari:</strong> Tryk på "Aa" i adresselinjen → Webstedsindstillinger → Kamera → Tillad<br><br>'
        + '<strong>Android/Chrome:</strong><br>'
        + '1. Tryk på de tre prikker (⋮) øverst til højre<br>'
        + '2. Vælg "Indstillinger" → "Webstedsindstillinger" → "Kamera"<br>'
        + '3. Sørg for at kamera er tilladt<br><br>'
        + 'Eller prøv: Tryk på ikonet til venstre i adresselinjen → "Tilladelser" → Kamera → Tillad';
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

  // Permission OK — start the barcode scanner
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
  try {
    const { data: item, error } = await sb
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
          </div>
        </div>`;
    } else {
      resultDiv.innerHTML = `
        <div class="scan-result" style="border-color:var(--amber-500);background:var(--amber-50)">
          <h4>${icon('help-circle')} Ukendt vare: ${esc(code)}</h4>
          <p>Denne stregkode er ikke registreret endnu.</p>
          <div class="scan-actions">
            ${isAdmin() ? `<button class="btn btn-primary btn-sm" onclick="closeModal();showItemFormWithBarcode('${esc(code)}')">Opret ny madvare</button>` : '<p>Bed en admin om at oprette varen.</p>'}
          </div>
        </div>`;
    }
    lucide.createIcons({ nodes: [resultDiv] });
  } catch (err) {
    resultDiv.innerHTML = `<p class="text-center" style="color:var(--red-500)">Fejl: ${err.message}</p>`;
  }
  // Show scan button again
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

    // Update item quantity via RPC
    if (action === 'added') {
      await sb.rpc('increment_item_quantity', { p_item_id: itemId, p_amount: 1 });
    } else if (action === 'used') {
      await sb.rpc('decrement_item_quantity', { p_item_id: itemId, p_amount: 1 });
    } else if (action === 'empty') {
      await sb.rpc('set_item_quantity_zero', { p_item_id: itemId });
    }

    const labels = { added: 'Tilføjet', used: 'Brugt', empty: 'Markeret tom' };
    toast(labels[action] || action);
    navigate('kitchen');
  } catch (err) { toast(err.message, 'error'); }
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

  // Get item counts per category
  const { data: catCounts } = await sb
    .from('item_categories')
    .select('category_id');

  const countMap = {};
  (catCounts || []).forEach(row => {
    countMap[row.category_id] = (countMap[row.category_id] || 0) + 1;
  });

  const list = document.getElementById('categories-list');
  if (cats.length === 0) {
    list.innerHTML = `<div class="empty-state">${icon('tags')}<h3>Ingen kategorier</h3></div>`;
  } else {
    list.innerHTML = `<div class="admin-list">${cats.map(c => `
      <div class="admin-list-item">
        <div class="admin-list-icon">${icon(c.icon || 'folder')}</div>
        <div class="admin-list-info">
          <h4>${esc(c.name)}</h4>
          <p>${esc(c.description || '')}${c.responsible_person ? ' · Ansvarlig: ' + esc(c.responsible_person) : ''}</p>
        </div>
        <div class="admin-list-meta">${countMap[c.id] || 0} genstande</div>
        <div class="admin-list-actions">
          <button class="btn btn-ghost btn-sm" onclick="showCategoryForm('${c.id}')">${icon('pencil')}</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteCategory('${c.id}')">${icon('trash-2')}</button>
        </div>
      </div>`).join('')}</div>`;
  }
  lucide.createIcons({ nodes: [el] });
}

async function showCategoryForm(editId) {
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
      <div class="form-group"><label>Ansvarlig person</label><input type="text" class="form-input" id="cat-resp" value="${esc(cat?.responsible_person || '')}"></div>
      <div class="form-group"><label>Ikon (Lucide-navn)</label><input type="text" class="form-input" id="cat-icon" value="${esc(cat?.icon || 'folder')}" placeholder="f.eks. tent, flame, wrench"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal()">Annullér</button>
      <button class="btn btn-primary" id="cat-save-btn">${cat ? 'Gem' : 'Opret'}</button>
    </div>`);

  document.getElementById('cat-save-btn').onclick = async () => {
    const body = {
      name: document.getElementById('cat-name').value.trim(),
      description: document.getElementById('cat-desc').value,
      responsible_person: document.getElementById('cat-resp').value,
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
    // item_categories will cascade via ON DELETE CASCADE on category_id
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

  // Get item counts per location
  const { data: locCounts } = await sb
    .from('items')
    .select('location_id');

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
    // Unlink items from this location first
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
    const { data: users, error } = await sb
      .from('profiles')
      .select('*')
      .order('display_name');
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
      <div class="form-group">
        <label>Navn</label>
        <input type="text" class="form-input" id="new-user-name" placeholder="F.eks. Anders Hansen" required>
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" class="form-input" id="new-user-email" placeholder="email@eksempel.dk" required>
      </div>
      <div class="form-group">
        <label>Adgangskode</label>
        <input type="password" class="form-input" id="new-user-pass" placeholder="Mindst 6 tegn" minlength="6" required>
      </div>
      <div class="form-group">
        <label>Rolle</label>
        <select class="form-input" id="new-user-role">
          <option value="leader">Leder</option>
          <option value="admin">Administrator</option>
        </select>
      </div>
      <div class="modal-actions">
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
    // Create user via Supabase Auth
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    const userId = data.user?.id;
    if (!userId) throw new Error('Brugeren blev ikke oprettet korrekt');

    // Wait for trigger to create profile, then update name and role
    await new Promise(r => setTimeout(r, 1500));
    const { error: upErr } = await sb.from('profiles').upsert({
      id: userId,
      username: email,
      display_name: name,
      role: role
    });
    if (upErr) throw upErr;

    // Re-auth as current admin (signUp may have switched session)
    // Restore admin session
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
    // Check for pre-configured Supabase credentials
    if (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url && window.SUPABASE_CONFIG.anonKey) {
      try {
        initSupabase(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);
        configReady = true;
        setupAuthListener();

        // Check for existing session
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

    // If config was set, setup auth listener (in case it wasn't set above)
    if (configReady) setupAuthListener();
  } catch (fatal) {
    // Fallback: ensure something always renders even on unexpected errors
    var app = document.getElementById('app');
    if (app) app.innerHTML = '<div style="padding:40px;text-align:center;font-family:sans-serif;"><h2>Noget gik galt</h2><p>' + (fatal.message || 'Ukendt fejl') + '</p><button onclick="location.reload()" style="padding:10px 20px;margin-top:16px;cursor:pointer;">Genindlæs</button></div>';
  }
})();
