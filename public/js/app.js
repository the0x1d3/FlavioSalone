// Admin app (index.html), loaded first of public/js: shared state, small helpers, navigation between sections.
// The files share their globals (classic scripts), so a name defined here is visible in the others.
let db = { config: {}, services: [], clients: [], inventory: [], appointments: [] };
let loaded = false;
const TITLES = { agenda: 'Agenda', listino: 'Listino servizi', clienti: 'Schede clienti', magazzino: 'Magazzino', webbooking: 'Prenotazione web', gdpr: 'Privacy & GDPR', backup: 'Impostazioni & dati' };
const DAYS = [[1, 'Lun'], [2, 'Mar'], [3, 'Mer'], [4, 'Gio'], [5, 'Ven'], [6, 'Sab'], [0, 'Dom']];
const todayStr = (offset = 0) => { const d = new Date(); d.setDate(d.getDate() + offset); return localDate(d); };
const newId = () => Date.now() * 100 + Math.floor(Math.random() * 100);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const initials = (n) => n.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const sortedClients = () => [...db.clients].sort((a, b) => a.name.localeCompare(b.name, 'it'));
const empty = (icon, title, text, cta = '') => `<div class="empty"><i class="ph ${icon}" aria-hidden="true"></i><p><strong>${title}</strong></p><p class="muted">${text}</p>${cta}</div>`;
const anyModalOpen = () => !!document.querySelector('.modal-backdrop.open');
// This salon's booking page: /prenota/<slug>; the first salon keeps plain /prenota (links already shared with clients).
const bookingPath = () => (!db.account || db.account.salon === 1 ? '/prenota' : '/prenota/' + db.account.slug);

// ---------- Navigation: one address per section (rewritten to this page in vercel.json) ----------
const ROUTES = { agenda: '/', listino: '/listino', clienti: '/clienti', magazzino: '/magazzino', webbooking: '/prenotazione-web', gdpr: '/privacy', backup: '/impostazioni' };
function tabFromPath() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  return Object.keys(ROUTES).find((t) => ROUTES[t] === path) || 'agenda'; // "/agenda" and unknown paths open the agenda
}

function showTab(tab, push = true) {
  document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + tab));
  document.querySelectorAll('.nav-item[data-tab], .tab[data-tab]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('more-btn').classList.toggle('active', ['webbooking', 'gdpr', 'backup'].includes(tab));
  $('page-title').textContent = TITLES[tab];
  document.title = tab === 'agenda' ? 'Salone PRO' : `${TITLES[tab]} · Salone PRO`;
  if (push && location.pathname !== ROUTES[tab]) history.pushState(null, '', ROUTES[tab]);
  closeModal('more-sheet');
  window.scrollTo(0, 0);
  if (tab === 'webbooking') $('preview-frame').src = bookingPath();
  if (tab === 'clienti') renderRecall(); // appointments may have changed since the last render
  if (tab === 'backup') { loadCalendarLink(); renderErrorLog(); loadNotify(); loadTeam(); loadSalons(); }
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; // let ctrl/cmd-click open the section in a new tab
  e.preventDefault();
  showTab(b.dataset.tab);
});
window.addEventListener('popstate', () => showTab(tabFromPath(), false));

function renderAll() {
  renderAgenda();
  renderServices();
  renderClients();
  renderInventory();
  renderGdpr();
  renderWebLink();
  renderAccount();
}
