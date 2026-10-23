// Helpers shared by the admin app (index.html) and the client booking page (prenota.html).
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad = (n) => String(n).padStart(2, '0');
const addMin = (t, m) => {
  if (!/^\d\d:\d\d$/.test(t || '')) return '';
  const x = Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) + Number(m);
  return pad(Math.floor(x / 60)) + ':' + pad(x % 60);
};
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (s) => (s || '').split('-').reverse().join('/');
const dayLabel = (s, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => new Date(s + 'T12:00').toLocaleDateString('it-IT', opts);
const euro = (n) => '€ ' +Number(n || 0).toFixed(2).replace('.', ',');
// Italian numbers without prefix get +39; 10-digit mobiles starting with 39x (e.g. 393...) are still local numbers.
const waNumber = (p) => {
  const d = String(p || '').replace(/\D/g, '').replace(/^00/, '');
  return d.length > 10 ? d : '39' + d;
};

let toastTimer;
function toast(msg, kind) {
  let el = $('toast');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'toast', className: 'toast' });
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.innerHTML = `<i class="ph ${kind === 'error' ? 'ph-warning-circle' : 'ph-check-circle'}" aria-hidden="true"></i><span>${esc(msg)}</span>`;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 5000 : 2600);
}

// While a dialog is open the rest of the page is inert (Tab, clicks and screen readers stay inside it); closing it gives
// focus back to the control that opened it. The new-booking notice and the toast stay usable above everything.
const openers = {};
function syncInert() {
  const top = [...document.querySelectorAll('.modal-backdrop.open')].pop();
  for (const el of document.body.children) el.inert = !!top && el !== top && !el.matches('#booking-alert, .toast');
}
function openModal(id) {
  if (!$(id).classList.contains('open')) openers[id] = document.activeElement;
  $(id).classList.add('open');
  syncInert();
  document.body.style.overflow = 'hidden';
  // data-autofocus: dialogs mostly read (client card) focus the close button, so phones do not pop up the keyboard
  setTimeout(() => ($(id).querySelector('[data-autofocus]') || $(id).querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea'))?.focus(), 50);
}
function closeModal(id) {
  if (!$(id).classList.contains('open')) return;
  $(id).classList.remove('open');
  syncInert();
  if (!document.querySelector('.modal-backdrop.open')) document.body.style.overflow = '';
  if (openers[id]?.isConnected) openers[id].focus({ preventScroll: true });
  delete openers[id];
}
document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('modal-backdrop') && !e.target.dataset.locked) closeModal(e.target.id);
});

// No inline handlers, the CSP blocks them: an element names its action in data-click, data-change, data-input,
// data-submit, data-toggle or data-focus, with its argument in data-id (a number) or data-arg. Each page file adds
// its actions to `actions`; a handler gets the element and the event. Capture, since toggle and focus do not bubble.
const actions = { click: {}, change: {}, input: {}, submit: {}, toggle: {}, focus: {} };
Object.keys(actions).forEach((type) => document.addEventListener(type, (e) => {
  const el = e.target.closest?.(`[data-${type}]`);
  if (el) actions[type][el.dataset[type]](el, e);
}, true));
Object.assign(actions.click, {
  openModal: (el) => openModal(el.dataset.arg),
  closeModal: (el) => closeModal(el.dataset.arg),
  reloadPage: () => location.reload(),
});
actions.focus.select = (el) => el.select();

// Tema buttons (data-click="setTheme", data-arg auto | light | dark), on both pages: the choice stays on this device
// and theme.js applies it.
function markTheme() {
  const pick = document.documentElement.dataset.themePick || 'auto';
  document.querySelectorAll('[data-click="setTheme"]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.arg === pick));
}
actions.click.setTheme = (el) => {
  try {
    if (el.dataset.arg === 'auto') localStorage.removeItem('sp_theme');
    else localStorage.setItem('sp_theme', el.dataset.arg);
  } catch {}
  window.applyTheme?.();
  markTheme();
};
markTheme();
document.addEventListener('keydown', (e) => {
  const open = [...document.querySelectorAll('.modal-backdrop.open')].pop();
  if (e.key === 'Escape' && open && !open.dataset.locked) closeModal(open.id);
});

// shortcut: generic privacy notice template, have it reviewed before relying on it legally.
function legalHtml(c) {
  const phone = c.ownerPhone ? ` Tel. <strong>+${esc(waNumber(c.ownerPhone))}</strong>.` : '';
  const email = c.email ? ` Email <strong>${esc(c.email)}</strong>.` : '';
  return `
    <h4>1. Titolare del trattamento</h4>
    <p>Il Titolare è <strong>${esc(c.salonName)}</strong> (${esc(c.ownerName)})${c.address ? `, con sede in <strong>${esc(c.address)}</strong>` : ''}${c.vat ? `, P.IVA <strong>${esc(c.vat)}</strong>` : ''}.${phone}${email}</p>
    <h4>2. Dati trattati e finalità</h4>
    <p>Nome, telefono e servizi scelti sono trattati per prenotare e gestire gli appuntamenti e per inviarti comunicazioni di servizio (art. 6.1.b GDPR). Le eventuali note su allergie o sensibilità della cute sono annotate in salone solo con il tuo consenso esplicito, per la sicurezza dei trattamenti (art. 9.2.a GDPR). Le foto del lavoro (per esempio prima e dopo un colore) sono scattate solo con il tuo consenso, servono a ricordare i trattamenti eseguiti e non vengono pubblicate. Dopo qualche settimana dall'ultima visita potremmo scriverti per proporti un nuovo appuntamento: basta dirci che non vuoi e non lo faremo più.</p>
    <h4>3. Conservazione e fornitori</h4>
    <p>I dati sono conservati per il tempo necessario alla gestione del rapporto e agli obblighi di legge. Sono custoditi su server cloud nell'Unione Europea da fornitori che agiscono come responsabili del trattamento. Se il salone usa gli SMS automatici, conferme e promemoria partono dal telefono del salone e il servizio che li inoltra al telefono riceve il tuo numero e il testo del messaggio. Non sono venduti né ceduti a terzi per marketing.</p>
    <h4>4. I tuoi diritti</h4>
    <p>Puoi chiedere in qualsiasi momento accesso, rettifica, cancellazione, limitazione o portabilità dei tuoi dati e revocare il consenso, contattando il Titolare. Puoi anche presentare reclamo al Garante per la protezione dei dati personali.</p>
    <h4>5. Cookie</h4>
    <p>Questo sito non usa cookie di profilazione né strumenti di tracciamento pubblicitario. L'area riservata al salone usa solo un cookie tecnico di accesso.</p>`;
}
