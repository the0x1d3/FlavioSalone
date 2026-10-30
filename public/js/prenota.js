// Client booking page (prenota.html). Needs common.js.
let cfg = {}, services = [], busy = [], now = { date: localDate(), time: '00:00' };
let month, maxDate, selDate = '', selTime = '';
const picked = new Set();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const price = (n) => '€ ' + (Number.isInteger(Number(n)) ? Number(n) : Number(n).toFixed(2).replace('.', ','));
const chosen = () => services.filter((s) => picked.has(s.id));
const step = () => Number(cfg.slotMinutes) || 30;
const duration = () => chosen().reduce((s, x) => s + (Number(x.duration) || 0), 0) || step();
const closureOn = (ds) => (cfg.closures || []).find((x) => ds >= x.from && ds <= x.to);
const isClosed = (ds) => (cfg.closedDays || []).includes(new Date(ds + 'T12:00').getDay()) || !!closureOn(ds);
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// /prenota/<slug> is one salon's page; plain /prenota is the first salon's (links shared before multi-salon).
const SALON = location.pathname.match(/^\/prenota\/([a-z0-9-]+)/)?.[1];
const publicApi = (params = {}) => '/api/public?' + new URLSearchParams({ ...(SALON && { salon: SALON }), ...params });

async function fetchDay(date) {
  const r = await fetch(publicApi(date ? { date } : {}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Prenotazione online non disponibile'), { setup: d.setup });
  ({ config: cfg, services, busy, now } = d);
}

async function init() {
  try {
    await fetchDay();
  } catch (e) {
    // Not configured yet on Vercel: clients get a plain message, the owner a pointer to the admin page that explains the fix.
    $('app').innerHTML = e.setup
      ? `<section class="block down" style="grid-column:1/-1"><i class="ph ph-calendar-blank" aria-hidden="true"></i><h2>Prenotazioni online non ancora attive</h2><p class="muted">Per prenotare contatta direttamente il salone. Torna a trovarci presto!</p><p class="muted small">Sei il titolare? <a href="/">Apri il gestionale</a> per completare la configurazione.</p></section>`
      : `<section class="block down" style="grid-column:1/-1"><i class="ph ph-cloud-slash" aria-hidden="true"></i><h2>Prenotazione online non disponibile</h2><p class="muted">${esc(e.message)}. Riprova tra poco.</p><button class="btn btn-outline" data-click="reloadPage"><i class="ph ph-arrow-clockwise" aria-hidden="true"></i>Riprova</button></section>`;
    return;
  }
  document.title = 'Prenota da ' + cfg.salonName;
  $('salon-title').textContent = cfg.salonName;
  $('salon-mark').textContent = (cfg.salonName || 'S').trim().charAt(0).toUpperCase();
  const names = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const closed = (cfg.closedDays || []).map((d) => names[d]);
  $('salon-meta').innerHTML = [
    cfg.address && `<span><i class="ph ph-map-pin" aria-hidden="true"></i>${esc(cfg.address)}</span>`,
    `<span><i class="ph ph-clock" aria-hidden="true"></i>${esc(cfg.openTime)} - ${esc(cfg.closeTime)}${(cfg.breaks || []).map((b) => `, pausa ${esc(b.from)} - ${esc(b.to)}`).join('')}${closed.length ? `, chiuso ${esc(closed.join(' e '))}` : ''}</span>`,
    nextClosure(),
  ].filter(Boolean).join('');
  $('btn-wa').hidden = !cfg.ownerPhone;
  $('legal-body').innerHTML = legalHtml(cfg);

  const max = new Date(now.date + 'T12:00');
  max.setFullYear(max.getFullYear() + 1);
  maxDate = localDate(max);
  selDate = firstOpenDay();
  month = new Date(selDate + 'T12:00');
  month.setDate(1);
  renderServices();
  renderCal();
  await loadSlots();
}

// Tells clients about holidays in the next 60 days, before they hunt for a free day.
function nextClosure() {
  const limit = new Date(now.date + 'T12:00');
  limit.setDate(limit.getDate() + 60);
  const c = (cfg.closures || []).filter((x) => x.to >= now.date && x.from <= localDate(limit)).sort((a, b) => a.from.localeCompare(b.from))[0];
  if (!c) return '';
  const when = c.from === c.to ? `il ${fmtDate(c.from)}` : `dal ${fmtDate(c.from)} al ${fmtDate(c.to)}`;
  return `<span class="closure-note"><i class="ph ph-calendar-x" aria-hidden="true"></i>Chiuso ${when}${c.note ? ` (${esc(c.note)})` : ''}</span>`;
}

function firstOpenDay() {
  const d = new Date(now.date + 'T12:00');
  for (let i = 0; i < 60; i++, d.setDate(d.getDate() + 1)) {
    const ds = localDate(d);
    if (isClosed(ds)) continue;
    if (ds === now.date && addMin(now.time, step()) > cfg.closeTime) continue;
    return ds;
  }
  return now.date;
}

// ---------- Services ----------
// One folder per category, in the salon's folder order; only the first starts open.
function renderServices() {
  const catOf = (s) => s.cat || 'ALTRO';
  const cats = [...new Set([...(cfg.serviceFolders || []), ...services.map(catOf)])].filter((c) => services.some((s) => catOf(s) === c));
  $('srv-list').innerHTML = cats.map((cat, i) => {
    const items = services.filter((s) => catOf(s) === cat);
    return `
    <details class="srv-group" ${i ? '' : 'open'}>
      <summary><span>${esc(cat)}</span><span class="muted small">${items.length} ${items.length === 1 ? 'servizio' : 'servizi'}<i class="ph ph-caret-down" aria-hidden="true"></i></span></summary>
      <div class="srv-items">${items.map((s) => `
        <label class="srv">
          <input type="checkbox" ${picked.has(s.id) ? 'checked' : ''} data-change="toggleService" data-id="${s.id}">
          <span class="srv-name">${esc(s.name)}<small><i class="ph ph-clock" aria-hidden="true"></i>${Number(s.duration) || 0} min</small></span>
          <strong class="num">${price(s.price)}</strong>
        </label>`).join('')}
      </div>
    </details>`;
  }).join('') || '<p class="muted">Il listino non è ancora disponibile.</p>';
}

function toggleService(id, on) {
  if (on) picked.add(id); else picked.delete(id);
  $('err-services').textContent = '';
  renderSlots();
}

// ---------- Calendar ----------
function navMonth(n) {
  month.setMonth(month.getMonth() + n);
  renderCal();
}

function renderCal() {
  const y = month.getFullYear(), m = month.getMonth();
  const today = new Date(now.date + 'T12:00');
  $('cal-title').textContent = cap(month.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }));
  $('cal-prev').disabled = y * 12 + m <= today.getFullYear() * 12 + today.getMonth();
  $('cal-next').disabled = `${y}-${pad(m + 1)}-31` >= maxDate;
  let html = ['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((l) => `<span class="cal-lbl" aria-hidden="true">${l}</span>`).join('');
  html += '<span></span>'.repeat((new Date(y, m, 1).getDay() + 6) % 7);
  for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const off = ds < now.date || ds > maxDate || isClosed(ds);
    const cls = 'day' + (ds === selDate ? ' active' : '') + (ds === now.date ? ' today' : '');
    html += `<button class="${cls}" ${off ? 'disabled' : `data-click="pickDate" data-arg="${ds}"`} aria-label="${dayLabel(ds)}" aria-pressed="${ds === selDate}">${d}</button>`;
  }
  $('cal-grid').innerHTML = html;
}

function pickDate(ds) {
  selDate = ds;
  selTime = '';
  renderCal();
  loadSlots();
}

// ---------- Slots ----------
async function loadSlots() {
  $('slots-title').textContent = 'Orari liberi ' + (selDate === now.date ? 'oggi' : dayLabel(selDate));
  $('slots-grid').innerHTML = '<div class="skeleton" style="height:44px;border-radius:999px"></div>'.repeat(6);
  try {
    await fetchDay(selDate);
  } catch (e) {
    $('slots-grid').innerHTML = `<p class="slots-empty">${esc(e.message)}</p>`;
    return;
  }
  renderSlots();
}

function renderSlots() {
  const dur = duration();
  const slots = [];
  // i < 300 guards against a malformed opening time looping forever
  for (let t = cfg.openTime, i = 0; i < 300 && t && addMin(t, dur) <= cfg.closeTime; t = addMin(t, step()), i++) {
    if (selDate === now.date && t <= now.time) continue;
    slots.push({ t, busy: busy.some((b) => t < b.end && b.time < addMin(t, dur)) });
  }
  if (selTime && !slots.some((s) => s.t === selTime && !s.busy)) selTime = '';
  $('slots-grid').innerHTML = slots.map((s) => s.busy
    ? `<button class="slot" disabled aria-label="${s.t} occupato">${s.t}</button>`
    : `<button class="slot${s.t === selTime ? ' active' : ''}" data-click="pickTime" data-arg="${s.t}" aria-pressed="${s.t === selTime}">${s.t}</button>`).join('')
    || `<p class="slots-empty">Nessun orario libero per ${dur} minuti in questo giorno. Prova un altro giorno.</p>`;
  updateSummary();
}

function pickTime(t) {
  selTime = t;
  $('err-slots').textContent = '';
  renderSlots();
}

function updateSummary() {
  const list = chosen();
  const tot = list.reduce((s, x) => s + (Number(x.price) || 0), 0);
  const when = selTime ? `${cap(dayLabel(selDate))}, ore ${selTime}` : 'Da scegliere';
  $('sum-services').textContent = list.length ? list.map((s) => s.name).join(', ') : 'Nessuno';
  $('sum-when').textContent = when;
  $('sum-total').textContent = price(tot);
  $('bar-total').textContent = price(tot);
  $('bar-when').textContent = selTime ? `${dayLabel(selDate, { weekday: 'short', day: 'numeric', month: 'short' })}, ${selTime}` : list.length ? 'Scegli un orario' : 'Scegli servizi e orario';
}

// ---------- Submit ----------
async function submitBooking(mode) {
  const name = $('c-name').value.trim(), phone = $('c-phone').value.trim(), list = chosen();
  const errs = {};
  if (!list.length) errs.services = 'Scegli almeno un servizio.';
  if (!selTime) errs.slots = 'Scegli un orario libero.';
  if (name.length < 2) errs.name = 'Inserisci nome e cognome.';
  if (phone.replace(/\D/g, '').length < 6) errs.phone = 'Inserisci un numero di telefono valido.';
  if (!$('c-gdpr').checked) errs.gdpr = "Per prenotare devi accettare l'informativa privacy.";
  ['services', 'slots', 'name', 'phone', 'gdpr'].forEach((k) => { $('err-' + k).textContent = errs[k] || ''; });
  ['name', 'phone', 'gdpr'].forEach((k) => $('c-' + k).setAttribute('aria-invalid', !!errs[k]));
  const first = Object.keys(errs)[0];
  if (first) {
    $('c-' + first)?.focus({ preventScroll: true }); // a field to fix gets the focus (services and times have none)
    return $('err-' + first).closest('.field, section').scrollIntoView({ behavior: smooth(), block: 'center' });
  }

  const tot = list.reduce((s, x) => s + (Number(x.price) || 0), 0);
  if (mode === 'wa') {
    const msg = `PRENOTAZIONE SALONE\nCliente: ${name}\nTel: ${phone}\nData: ${fmtDate(selDate)}\nOra: ${selTime}\nServizi: ${list.map((s) => s.name).join(', ')}\nTotale: ${tot}\nCanale: WhatsApp\nGDPR: Accettato (${now.date})`;
    window.open('https://wa.me/' + waNumber(cfg.ownerPhone) + '?text=' + encodeURIComponent(msg), '_blank', 'noopener');
    return;
  }

  document.querySelectorAll('.book-btn').forEach((b) => { b.disabled = true; });
  try {
    const r = await fetch(publicApi(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, serviceIds: list.map((s) => s.id), date: selDate, time: selTime, privacy: true, website: $('c-website').value }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409) {
      $('err-slots').textContent = d.error;
      $('sec-when').scrollIntoView({ behavior: smooth(), block: 'start' });
      return loadSlots();
    }
    if (!r.ok) return toast(d.error || 'Prenotazione non riuscita, riprova', 'error');
    $('done-text').textContent = `Grazie ${name}, ti aspettiamo da ${cfg.salonName}.`;
    $('done-summary').innerHTML = `
      <div class="sum-row"><span>Quando</span><span>${esc(cap(dayLabel(selDate)))}, ore ${esc(selTime)}</span></div>
      <div class="sum-row"><span>Servizi</span><span>${esc(list.map((s) => s.name).join(', '))}</span></div>
      ${cfg.address ? `<div class="sum-row"><span>Dove</span><span>${esc(cfg.address)}</span></div>` : ''}
      <div class="sum-row sum-total"><span>Totale indicativo</span><span class="num">${price(tot)}</span></div>`;
    // Plain sentence, no "Data:/Ora:" fields, so the salon can't import it twice: the booking is already in the agenda.
    const note = `Ciao! Sono ${name}, ho appena prenotato online ${list.map((s) => s.name).join(' + ')} per ${dayLabel(selDate)} alle ${selTime}. A presto!`;
    $('done-wa').href = 'https://wa.me/' + waNumber(cfg.ownerPhone) + '?text=' + encodeURIComponent(note);
    $('done-wa').hidden = !cfg.ownerPhone;
    const at =(t) => `${selDate.replace(/-/g, '')}T${t.replace(':', '')}00`, enc = encodeURIComponent;
    const details = `Servizi: ${list.map((s) => s.name).join(' + ')}\nTotale indicativo: ${price(tot)}${cfg.ownerPhone ? `\nPer spostarlo o annullarlo: ${cfg.ownerPhone}` : ''}`;
    const params = `action=TEMPLATE&text=${enc(`Appuntamento da ${cfg.salonName}`)}&dates=${at(selTime)}/${at(d.appointment.end)}&ctz=Europe/Rome&details=${enc(details)}&location=${enc(cfg.address || '')}`;
    const ua = navigator.userAgent, android = /android/i.test(ua), ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // iPad says "Macintosh"
    // Google's documented "add to calendar" link on every device: forcing the Android app (intent:// to r/eventedit)
    // opened it without the event. Android picks the app or the browser by itself.
    Object.assign($('btn-google-cal'), { href: `https://calendar.google.com/calendar/render?${params}`, target: '_blank' });
    // The .ics comes from the server (same text, reminder 2 hours before), so iPhone opens it straight in Calendar instead of
    // saving it to Files. Samsung Calendar opens it on Samsung phones (Google Calendar's app cannot), Outlook & co. on a computer.
    const [icon, label] = ios ? ['ph-apple-logo', 'Aggiungi su Calendario Apple'] : android ? ['ph-calendar-plus', 'Aggiungi su Calendario Samsung o altro'] : ['ph-download-simple', 'Scarica il file calendario (.ics)'];
    $('btn-apple-cal').href = publicApi({ ics: 1, date: selDate, time: selTime, s: list.map((s) => s.id).join(',') });
    $('btn-apple-cal').querySelector('i').className = 'ph ' + icon;
    $('btn-apple-cal').querySelector('span').textContent = label;
    openModal('done-modal');
  } catch {
    toast('Connessione assente, riprova', 'error');
  } finally {
    document.querySelectorAll('.book-btn').forEach((b) => { b.disabled = false; });
  }
}

function openLegal(e) {
  e.preventDefault();
  openModal('legal-modal');
}


// ---------- Actions (data-click & co. in prenota.html and in the templates above, see common.js) ----------
Object.assign(actions.click, {
  navMonth: (el) => navMonth(Number(el.dataset.arg)),
  pickDate: (el) => pickDate(el.dataset.arg),
  pickTime: (el) => pickTime(el.dataset.arg),
  submitBooking: (el) => submitBooking(el.dataset.arg),
  openLegal: (el, e) => openLegal(e),
});
actions.change.toggleService = (el) => toggleService(Number(el.dataset.id), el.checked);

init();
