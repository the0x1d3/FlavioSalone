// Admin app: server calls, offline copy and change queue, error log, login, new web bookings.

// ---------- API ----------
let offline = false;
const isNetwork = (e) => e instanceof TypeError; // fetch rejects with TypeError when there is no connection
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    // Once per outage: the 20-second check would otherwise fill the log while offline.
    if (!offline) logError('Rete', 'Connessione internet assente o instabile: la richiesta non ha raggiunto il server. Le modifiche restano sul dispositivo e partono al ritorno della rete.', e.message);
    offline = true;
    updateOfflineBar();
    throw e;
  }
  offline = false;
  const data = await r.json().catch(() => ({}));
  const where = `${r.status} ${method} ${url.split('?')[0]}${data.error ? ': ' + data.error : ''}`;
  if (r.status === 401) {
    if (loaded) logError('Accesso', 'Sessione scaduta o revocata ("Esci da tutti i dispositivi"): serve di nuovo la password.', where);
    openModal('login');
    throw Object.assign(new Error('Sessione scaduta, accedi di nuovo'), { status: 401 });
  }
  if (!r.ok) {
    logError('Server', r.status >= 500 ? 'Il server o il database online ha avuto un errore imprevisto. Se succede ancora, i dettagli sono nei log del progetto su Vercel.'
      : r.status === 503 ? 'Vercel non è configurato del tutto: manca il database o la password.'
      : r.status === 429 ? 'Troppe richieste ravvicinate: il server ha bloccato le operazioni per qualche minuto.'
      : r.status === 400 ? 'I dati inviati non sono stati accettati dal server: la modifica non è stata salvata.'
      : 'Il server ha risposto con un errore.', where);
    throw Object.assign(new Error(data.error || 'Errore ' + r.status), { status: r.status, setup: data.setup });
  }
  return data;
}

// ---------- Offline: data copy + queue of changes ----------
// shortcut: copy and queue live in localStorage (about 5 MB), move them to IndexedDB if the archive grows past a few thousand appointments.
const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const forget = (k) => { try { localStorage.removeItem(k); } catch {} };

// ---------- Registro errori ----------
// shortcut: kept on each device (last 100, localStorage); move it to the database if several devices need one shared log.
// Each entry: a category, a plain-language explanation for the salon and the technical detail for whoever helps.
const ERR_ICONS = { Rete: 'ph-wifi-slash', Server: 'ph-cloud-slash', Accesso: 'ph-lock-simple', Pagina: 'ph-bug' };
function logError(cat, msg, detail = '') {
  const log = readJSON('sp_errors') || [];
  log.unshift({ at: new Date().toISOString(), cat, msg: String(msg).slice(0, 300), detail: String(detail).slice(0, 300) });
  writeJSON('sp_errors', log.slice(0, 100));
  if ($('tab-backup').classList.contains('active')) renderErrorLog();
}
// "Script error." comes from scripts of other sites or extensions, with no details to show.
window.addEventListener('error', (e) => e.message !== 'Script error.' && logError('Pagina', "Errore imprevisto nella pagina: se qualcosa non funziona, ricarica l'app.", `${e.message} (${(e.filename || 'pagina').split('/').pop() || 'pagina'}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => logError('Pagina', "Un'operazione non è andata a buon fine.", e.reason?.message || String(e.reason)));
function renderErrorLog() {
  const when = (iso) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  $('err-log').innerHTML = (readJSON('sp_errors') || []).map((e) => `
    <div class="err-row">
      <i class="ph ${ERR_ICONS[e.cat] || 'ph-warning-circle'}" aria-hidden="true"></i>
      <div><div class="err-head"><strong>${esc(e.cat || 'Errore')}</strong><span class="muted small num">${esc(when(e.at))}</span></div>
      <span>${esc(e.msg)}</span>${e.detail ? `<span class="err-detail">${esc(e.detail)}</span>` : ''}</div>
    </div>`).join('')
    || '<p class="muted small"><i class="ph ph-check-circle" aria-hidden="true"></i>Nessun problema recente: il gestionale comunica regolarmente con il server.</p>';
}
function copyErrorLog() {
  const lines = (readJSON('sp_errors') || []).map((e) => `${e.at}  [${e.cat || 'Errore'}] ${e.msg}${e.detail ? '  |  ' + e.detail : ''}`);
  navigator.clipboard.writeText([`Salone PRO v${NEWS[0].v}, ${navigator.userAgent}`, ...lines].join('\n'))
    .then(() => toast(lines.length ? 'Registro copiato' : 'Registro vuoto copiato'))
    .catch(() => toast('Copia non riuscita', 'error'));
}
function clearErrorLog() {
  if (!confirm('Svuotare il registro degli errori di questo dispositivo?')) return;
  forget('sp_errors');
  renderErrorLog();
  toast('Registro svuotato');
}
let outbox = readJSON('sp_outbox') || [];
const saveCache = () => writeJSON('sp_cache', db);

// Optimistic UI: local state is already updated. Without connection (or with an expired session) the change waits in the queue.
const syncFail = (e) => { toast('Non salvato: ' + e.message, 'error'); reload(); };
function send(op) {
  saveCache();
  if (outbox.length) return enqueue(op); // keep the order behind changes already waiting
  return sendOp(op).catch((e) => (isNetwork(e) || e.status === 401 ? enqueue(op) : syncFail(e)));
}
function enqueue(op) {
  outbox.push(op);
  writeJSON('sp_outbox', outbox);
  updateOfflineBar();
  toast('Salvato sul dispositivo: lo invio appena torna la rete');
  return Promise.resolve(); // undefined: callers skip their "saved" toast
}
const persist = (col, item) => send({ method: 'PUT', col, item });
const drop = (col, id) => send({ method: 'DELETE', col, id });
// Many at once (CSV import, bulk delete), a few hundred per request: deleted ids travel in the URL.
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const persistMany = (col, items) => Promise.all(chunks(items, 500).map((part) => send({ method: 'PUT', col, items: part })));
const dropMany = (col, ids) => Promise.all(chunks(ids, 300).map((part) => send({ method: 'DELETE', col, ids: part })));
const sendOp = (op) => (op.method === 'PUT'
  ? api('PUT', '/api/data', { col: op.col, item: op.item, items: op.items })
  : api('DELETE', `/api/data?col=${op.col}&${op.ids ? 'ids=' + op.ids.join(',') : 'id=' + op.id}`));

// Sends queued changes in order and returns the ids of the appointments sent. Stops at the first connection or
// login problem; a change the server refuses is dropped with a warning so it cannot block the queue forever.
let flushing = false;
async function flush() {
  const synced = [];
  if (flushing || !outbox.length) return synced;
  flushing = true;
  try {
    while (outbox.length) {
      const op = outbox[0];
      try {
        await sendOp(op);
        if (op.method === 'PUT' && op.col === 'appointments') synced.push(op.item.id);
      } catch (e) {
        if (isNetwork(e) || e.status === 401) break;
        toast('Una modifica fatta offline non è stata accettata: ' + e.message, 'error');
      }
      outbox.shift();
      writeJSON('sp_outbox', outbox);
    }
  } finally {
    flushing = false;
    updateOfflineBar();
  }
  return synced;
}

// After a sync, flag appointments made offline that now overlap others (e.g. a web booking taken meanwhile).
function warnClashes(ids) {
  const found = ids.map((id) => db.appointments.find((a) => a.id === id)).filter((a) => a && clashes(db.appointments, a).length);
  if (!found.length) return toast('Modifiche fatte offline inviate');
  toast(`Attenzione: ${found.length === 1 ? 'un appuntamento inserito offline si sovrappone' : `${found.length} appuntamenti inseriti offline si sovrappongono`} ad altri (${found.map((a) => `${fmtDate(a.date).slice(0, 5)} ore ${a.time}`).join(', ')}). Controlla l'agenda.`, 'error');
  $('agenda-date').value = found[0].date;
  setView('day');
}

function updateOfflineBar() {
  const n = outbox.length, waiting = `${n} ${n === 1 ? 'modifica salvata' : 'modifiche salvate'} sul dispositivo`;
  $('offline-bar').hidden = !offline && !n;
  $('offline-text').textContent = offline
    ? `Sei offline. ${n ? `${waiting}: le invio appena torna la rete.` : 'Vedi gli ultimi dati scaricati e puoi continuare a lavorare.'}`
    : `${waiting}, in attesa di invio.`;
}

async function reload() {
  const synced = await flush();
  let fresh;
  try {
    fresh = await api('GET', '/api/data');
  } catch (e) {
    if (e.status === 401) forget('sp_cache'); // session ended or revoked: no data left readable on this device
    if (!loaded && isNetwork(e) && (fresh = readJSON('sp_cache'))) {
      // start offline from the copy saved on this device (queued changes are already inside it)
    } else {
      if (e.setup) return showSetup(e.setup, e.message);
      if (!loaded && !$('login').classList.contains('open')) {
        document.body.classList.add('ready'); // show the app only to explain the problem
        $('agenda-list').innerHTML = isNetwork(e)
          ? empty('ph-wifi-slash', 'Sei offline', 'Su questo dispositivo non ci sono ancora dati salvati: collegati a internet una volta per usarlo anche offline.', '<button class="btn btn-outline btn-sm" data-click="reload"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>Riprova</button>')
          : empty('ph-cloud-slash', 'Impossibile caricare i dati', esc(e.message), '<button class="btn btn-outline btn-sm" data-click="reload"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>Riprova</button>');
      }
      return;
    }
  }
  outbox.forEach((op) => applyOp(fresh, op));
  const known = loaded && new Set(db.appointments.map((a) => a.id));
  db = fresh;
  saveCache();
  const first = !loaded;
  if (first) { loaded = true; loadConfigUI(); }
  if (first && $('tab-backup').classList.contains('active')) { loadCalendarLink(); loadNotify(); loadTeam(); loadSalons(); }
  renderAll();
  // createdAt check: a restored backup full of old web bookings must not ring
  if (known) announce(db.appointments.filter((a) => a.source === 'web' && !known.has(a.id) && Date.now() - Date.parse(a.createdAt) < 864e5));
  document.body.classList.add('ready');
  updateOfflineBar();
  if (synced.length) warnClashes(synced);
  const onboarding = first && needsOnboarding();
  if (onboarding) openOnboarding();
  else if (first && newsSeen() !== NEWS[0].v) openNews();
  if (first && !onboarding) maybeInstallBanner();
}

// ---------- Setup missing on Vercel ----------
const SETUP = {
  database: {
    title: 'Collega il database',
    text: 'Il sito è online ma non ha ancora un database dove salvare agenda e clienti. Si collega gratis in un paio di minuti:',
    steps: [
      'Apri il progetto su <strong>vercel.com</strong> e vai nel tab <strong>Storage</strong>.',
      'Premi <strong>Create Database</strong> e scegli <strong>Neon</strong>, piano <strong>Free</strong>, regione <strong>Frankfurt</strong>.',
      'Collegalo a questo progetto per tutti gli ambienti: Vercel aggiunge da solo <code>DATABASE_URL</code>.',
      "Vai in <strong>Deployments</strong>, apri il menu dell'ultimo deploy e scegli <strong>Redeploy</strong>.",
    ],
  },
  password: {
    title: 'Imposta la password',
    text: 'Il gestionale non ha ancora una password di accesso. Si imposta su Vercel:',
    steps: [
      'Apri il progetto su <strong>vercel.com</strong>, poi <strong>Settings &gt; Environment Variables</strong>.',
      'Aggiungi <code>ADMIN_PASSWORD</code> con almeno 10 caratteri: meglio una frase lunga che solo tu conosci.',
      "Vai in <strong>Deployments</strong> e fai <strong>Redeploy</strong> dell'ultimo deploy.",
    ],
  },
  // Trial over or salon suspended (payments are handled by hand): nothing to fix on Vercel.
  closed: {
    title: 'Salone non attivo',
    text: (msg) => `${msg}. I tuoi dati restano salvati: per riattivare il salone contatta chi gestisce Salone PRO.`,
    steps: [],
  },
};
function showSetup(kind, message) {
  const s = SETUP[kind] || SETUP.database;
  $('setup-title').textContent = s.title;
  $('setup-text').textContent = typeof s.text === 'function' ? s.text(message) : s.text;
  $('setup-steps').innerHTML = s.steps.map((t) => `<li>${t}</li>`).join('');
  $('setup-vercel').hidden = kind === 'closed';
  $('setup-logout').hidden = kind !== 'closed';
  closeModal('login');
  closeModal('signup');
  openModal('setup');
}

// Another salon on this device: its offline copy and the changes still queued for it must not reach the new one.
// Copies saved before accounts existed belong to salon 1.
function enterSalon(salon) {
  const prev = readJSON('sp_cache');
  if ((!prev && !outbox.length) || (prev?.account?.salon ?? 1) === salon) return false;
  outbox = [];
  forget('sp_outbox');
  forget('sp_cache');
  location.reload();
  return true;
}
const switchAuth = (to) => {
  closeModal(to === 'signup' ? 'login' : 'signup');
  openModal(to);
};

async function login(e) {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('login-err').textContent = '';
  try {
    const body = { email: $('login-email').value.trim() || undefined, password: $('login-pw').value }; // no email: the salon's shared password
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (d.setup) return showSetup(d.setup);
    if (!r.ok) throw new Error(d.error || 'Accesso non riuscito');
    $('login-pw').value = '';
    if (enterSalon(d.salon)) return;
    closeModal('login');
    await reload();
  } catch (err) {
    $('login-err').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// "Crea il tuo salone": a new salon in free trial, already logged in.
async function signup(e) {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $('signup-err').textContent = '';
  try {
    const body = { salonName: $('su-salon').value, name: $('su-name').value, email: $('su-email').value, password: $('su-pw').value };
    const r = await fetch('/api/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (d.setup) return showSetup(d.setup);
    if (!r.ok) throw new Error(d.error || 'Registrazione non riuscita');
    $('su-pw').value = '';
    if (enterSalon(d.salon)) return;
    closeModal('signup');
    await reload();
  } catch (err) {
    $('signup-err').textContent = isNetwork(err) ? 'Serve la connessione a internet' : err.message;
  } finally {
    btn.disabled = false;
  }
}

async function logout(all) {
  if (all && !confirm('Scollegare TUTTI i dispositivi, compreso questo? Su ognuno servirà di nuovo la password.')) return;
  await flush();
  if (outbox.length && !confirm(`Ci sono ${outbox.length} modifiche fatte offline non ancora inviate: uscendo andranno perse. Uscire comunque?`)) return;
  try {
    await api('DELETE', '/api/login' + (all ? '?all=1' : ''));
  } catch (e) {
    return toast(isNetwork(e) ? 'Serve la connessione a internet per uscire' : e.message, 'error');
  }
  forget('sp_cache'); // the data copy (allergies included) does not stay on a device that logged out
  forget('sp_outbox');
  location.reload();
}

// shortcut: polling every 2 min keeps the tablet in sync with web bookings; switch to push if Neon compute hours run short.
setInterval(() => { if (loaded && !document.hidden && !anyModalOpen()) reload(); }, 120000);
document.addEventListener('visibilitychange', () => { if (loaded && !document.hidden && !anyModalOpen()) reload(); });


// ---------- Nuove prenotazioni online ----------
// While the app is on screen it asks every 20 s whether a web booking newer than its last one exists (a tiny query)
// and reloads only then, also with a dialog open. Hidden app: nothing runs, so Neon can sleep; it catches up on return.
const maxWebId = () => db.appointments.reduce((m, a) => (a.source === 'web' && a.id > m ? a.id : m), 0);
setInterval(async () => {
  if (!loaded || document.hidden || flushing || $('login').classList.contains('open')) return;
  const wasOffline = offline;
  try {
    if ((await api('GET', `/api/data?newweb=${maxWebId()}`)).n || wasOffline) reload(); // back online: send the queue now
  } catch {} // offline or session expired: the offline bar and the login already say so
}, 20000);

let newBookings = [], audio;
// Browsers play sound only after the first touch or click on the page.
document.addEventListener('pointerdown', () => { try { (audio ||= new AudioContext()).resume(); } catch {} }, { once: true });
function beep() {
  try {
    (audio ||= new AudioContext()).resume();
    [880, 1320].forEach((hz, i) => {
      const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime + i * 0.18;
      o.frequency.value = hz;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(audio.destination);
      o.start(t);
      o.stop(t + 0.42);
    });
  } catch {} // no sound on this device: the notice on screen is enough
  navigator.vibrate?.(200);
}
function announce(list) {
  if (!list.length) return;
  newBookings = [...newBookings, ...list].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const a = newBookings[0], more = newBookings.length - 1;
  $('ba-title').textContent = more ? `${more + 1} nuove prenotazioni online` : 'Nuova prenotazione online';
  $('ba-detail').textContent = `${a.clientName}, ${dayLabel(a.date)} alle ${a.time}${more ? ` e altre ${more}` : `: ${(a.services || []).join(' + ')}`}`;
  $('booking-alert').hidden = false;
  beep();
}
function dismissBookings() {
  newBookings = [];
  $('booking-alert').hidden = true;
}
function showNewBookings() {
  const a = newBookings[0];
  dismissBookings();
  if (!a) return;
  document.querySelectorAll('.modal-backdrop.open:not([data-locked])').forEach((m) => closeModal(m.id));
  showTab('agenda');
  $('agenda-date').value = a.date;
  setView('day');
}
window.addEventListener('online', () => { if (loaded) reload(); });
window.addEventListener('offline', () => { offline = true; updateOfflineBar(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ---------- Actions (data-click & co. in index.html and in the templates above, see common.js) ----------
Object.assign(actions.click, {
  reload, showNewBookings, dismissBookings, copyErrorLog, clearErrorLog,
  switchAuth: (el) => switchAuth(el.dataset.arg),
  logout: () => logout(),
  logoutAll: () => logout(true),
});
actions.submit.login = (el, e) => login(e);
actions.submit.signup = (el, e) => signup(e);
