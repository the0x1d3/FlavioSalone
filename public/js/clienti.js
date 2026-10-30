// Admin app: client archive, selection and CSV, "Da richiamare", client card with photos.

// ---------- Clienti ----------
// ---------- Selezione multipla e filtro "senza telefono" ----------
let selClients = new Set(), noPhoneOnly = false;
const noPhone = (c) => !(c.phone || '').replace(/\D/g, '');
function visibleClients() {
  const q = $('cli-search').value.trim().toLowerCase();
  return sortedClients().filter((c) => (c.name.toLowerCase().includes(q) || (c.phone || '').includes(q)) && (!noPhoneOnly || noPhone(c)));
}
function toggleNoPhone() {
  noPhoneOnly = !noPhoneOnly;
  renderClients();
}
function selectAllClients(on) {
  if (on) visibleClients().forEach((c) => selClients.add(c.id));
  else selClients.clear();
  renderClients();
}
// Updates the row and the bar without redrawing the list, so the checkbox keeps keyboard focus.
function toggleClientSel(id, box) {
  if (box.checked) selClients.add(id);
  else selClients.delete(id);
  box.closest('.row').classList.toggle('selected', box.checked);
  updateClientBulk();
}
function updateClientBulk() {
  const vis = visibleClients(), n = selClients.size, all = vis.length > 0 && vis.every((c) => selClients.has(c.id));
  $('cli-bulk').hidden = !n;
  $('cli-bulk-n').textContent = n === 1 ? '1 selezionata' : `${n} selezionate`;
  $('cli-all').checked = all;
  $('cli-all').indeterminate = !all && vis.some((c) => selClients.has(c.id));
}
function deleteSelectedClients() {
  const list = db.clients.filter((c) => selClients.has(c.id));
  if (!list.length) return;
  // Names in the question: the selection can include clients hidden by the current search or filter.
  const names = list.slice(0, 5).map((c) => c.name).join(', ') + (list.length > 5 ? ` e altre ${list.length - 5}` : '');
  if (!confirm(`Eliminare ${list.length === 1 ? 'la scheda' : `${list.length} schede`} con le foto?\n${names}.\nGli appuntamenti restano in agenda.`)) return;
  db.clients = db.clients.filter((c) => !selClients.has(c.id));
  dropMany('clients', list.map((c) => c.id)).then((r) => r.every(Boolean) && toast(list.length === 1 ? 'Scheda eliminata' : `${list.length} schede eliminate`));
  selClients.clear();
  renderClients();
  renderGdpr();
  renderAgenda();
}

// ---------- CSV clienti ----------
function exportClientsCsv() {
  if (!db.clients.length) return toast('Nessuna cliente da esportare', 'error');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv([CLIENT_CSV_HEAD, ...sortedClients().map(clientCsvRow)])], { type: 'text/csv;charset=utf-8' }));
  a.download = `clienti_${todayStr()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(db.clients.length === 1 ? '1 cliente esportata' : `${db.clients.length} clienti esportate`);
}
async function importClientsCsv(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  if (file.size > 5e6) return toast('File troppo grande (massimo 5 MB)', 'error');
  const buf = await file.arrayBuffer();
  let text, r;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1252').decode(buf); } // Excel's plain "CSV" is not UTF-8
  try { r = clientsFromCsv(text, db.clients); } catch (e) { return toast(e.message, 'error'); }
  const skipped = [r.noPhone && `${r.noPhone} senza telefono`, r.noName && `${r.noName} senza nome`].filter(Boolean).join(', ');
  const what = [r.added.length && `${r.added.length} ${r.added.length === 1 ? 'nuova' : 'nuove'}`, r.updated.length && `${r.updated.length} da aggiornare`].filter(Boolean).join(' e ');
  if (!what) return toast(`Nessuna cliente da importare${skipped ? ` (escluse: ${skipped})` : ''}`, 'error');
  if (!confirm(`Importare dal file ${what}?${skipped ? `\nEscluse: ${skipped}.` : ''}`)) return;
  const base = newId(), added = r.added.map((c, i) => ({ ...c, id: base + i })), changed = new Map(r.updated.map((c) => [c.id, c]));
  db.clients = [...db.clients.map((c) => changed.get(c.id) || c), ...added];
  persistMany('clients', [...added, ...r.updated]).then((res) => res.every(Boolean)
    && toast(`Importazione completata: ${[added.length && `${added.length} ${added.length === 1 ? 'nuova' : 'nuove'}`, r.updated.length && `${r.updated.length} ${r.updated.length === 1 ? 'aggiornata' : 'aggiornate'}`].filter(Boolean).join(', ')}`));
  renderClients();
  renderGdpr();
  renderAgenda();
}

function renderClients() {
  const q = $('cli-search').value.trim().toLowerCase(), list = visibleClients(), np = db.clients.filter(noPhone).length;
  selClients = new Set(db.clients.filter((c) => selClients.has(c.id)).map((c) => c.id)); // forget clients deleted meanwhile
  $('cli-count').textContent = db.clients.length === 1 ? '1 cliente' : `${db.clients.length} clienti`;
  $('cli-nophone').hidden = !np && !noPhoneOnly;
  $('cli-nophone').classList.toggle('on', noPhoneOnly);
  $('cli-nophone').setAttribute('aria-pressed', noPhoneOnly);
  $('cli-nophone').lastChild.textContent = `Senza telefono (${np})`;
  $('clients-list').innerHTML = list.map((c) => {
    const allergy = c.allergy && c.allergy.toLowerCase() !== 'nessuna', sel = selClients.has(c.id);
    return `
    <div class="row client${sel ? ' selected' : ''}">
      <label class="sel"><input type="checkbox" ${sel ? 'checked' : ''} data-change="toggleClientSel" data-id="${c.id}" aria-label="Seleziona ${esc(c.name)}"></label>
      <span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span>
      <div class="row-main">
        <div class="row-title"><button class="link" data-click="openClientCard" data-id="${c.id}">${esc(c.name)}</button>${c.phone ? `<a class="muted num" href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}</div>
        <div class="badges">
          ${allergy ? `<span class="badge badge-danger"><i class="ph ph-warning" aria-hidden="true"></i>${esc(c.allergy)}</span>` : ''}
          ${c.gdprConsent ? `<span class="badge badge-ok"><i class="ph ph-shield-check" aria-hidden="true"></i>GDPR ${esc(fmtDate(c.gdprDate))}</span>` : '<span class="badge badge-warn"><i class="ph ph-shield-warning" aria-hidden="true"></i>Consenso GDPR mancante</span>'}
          ${c.source === 'web' ? '<span class="badge badge-accent"><i class="ph ph-globe-simple" aria-hidden="true"></i>Web</span>' : ''}
        </div>
        <p class="note formula"><i class="ph ph-palette" aria-hidden="true"></i><span>${esc(c.formula || 'Nessuna formula registrata')}</span></p>
      </div>
      <div class="row-actions">
        ${c.phone ? `<button class="btn btn-outline btn-sm" data-click="contactClient" data-id="${c.id}"><i class="ph ph-megaphone" aria-hidden="true"></i>Scrivi</button>` : ''}
        <button class="btn btn-outline btn-sm" data-click="openClientCard" data-id="${c.id}"><i class="ph ph-identification-card" aria-hidden="true"></i>Scheda</button>
      </div>
    </div>`;
  }).join('') || (q ? empty('ph-magnifying-glass', 'Nessun risultato', `Nessuna cliente corrisponde a "${esc(q)}".`)
                    : noPhoneOnly ? empty('ph-phone', 'Nessuna cliente senza telefono', 'Tutte le clienti in archivio hanno un numero.')
                    : empty('ph-users', 'Archivio vuoto', 'Registra la prima cliente qui sopra, o importa un file CSV. Le clienti che prenotano online vengono aggiunte da sole.'));
  updateClientBulk();
  renderRecall();
}

function addClient() {
  const name = $('cli-name').value.trim();
  const allergy = $('cli-allergy').value.trim();
  if (!name) return toast('Inserisci il nome della cliente', 'error');
  if (allergy && !$('cli-gdpr-health').checked) return toast('Per annotare allergie serve il consenso art. 9', 'error');
  const c = {
    id: newId(), name, phone: $('cli-phone').value.trim(), allergy: allergy || 'Nessuna', formula: $('cli-formula').value.trim(),
    gdprConsent: $('cli-gdpr-base').checked, healthConsent: $('cli-gdpr-health').checked, gdprDate: todayStr(),
  };
  db.clients.push(c);
  persist('clients', c).then((r) => r && toast('Cliente registrata'));
  ['cli-name', 'cli-phone', 'cli-allergy', 'cli-formula'].forEach((id) => { $(id).value = ''; });
  $('cli-gdpr-health').checked = false;
  renderClients();
  renderGdpr();
}

function deleteClient(id) {
  const c = db.clients.find((x) => x.id === id);
  if (!c || !confirm(`Eliminare la scheda di ${c.name} e le sue foto? Gli appuntamenti restano in agenda.`)) return;
  db.clients = db.clients.filter((x) => x.id !== id);
  drop('clients', id); // the server deletes the client's photos too
  closeModal('cli-modal');
  renderClients();
  renderGdpr();
  renderAgenda();
}

// ---------- Da richiamare ----------
const weeksAgo = (ds) => Math.round((new Date(todayStr() + 'T12:00:00Z') - new Date(ds + 'T12:00:00Z')) / 6048e5);
const recallText = (c) => `Ciao ${c.name.split(' ')[0]}! È passato un po' di tempo dalla tua ultima visita da ${db.config.salonName}. Quando vuoi, puoi prenotare qui: ${location.origin}${bookingPath()}`;

function renderRecall() {
  const weeks = Number(db.config.recallWeeks ?? 6);
  const list = recallList(db.clients, db.appointments, todayStr(), weeks);
  $('recall').hidden = !list.length;
  $('recall-count').textContent = list.length;
  $('recall-hint').textContent = `Ultima visita da più di ${weeks} settimane e niente in agenda`;
  $('recall-list').innerHTML = list.map(({ client: c, last }) => `
    <div class="row rem">
      <span class="avatar" aria-hidden="true">${esc(initials(c.name))}</span>
      <div class="row-main">
        <div class="row-title"><button class="link" data-click="openClientCard" data-id="${c.id}">${esc(c.name)}</button></div>
        <span class="row-sub">Ultima visita ${esc(fmtDate(last.date))}, ${weeksAgo(last.date)} settimane fa${last.services?.length ? `: ${esc(last.services.join(' + '))}` : ''}</span>
      </div>
      <div class="row-actions">
        ${c.phone ? `<button class="btn btn-outline btn-sm" data-click="contactRecall" data-id="${c.id}"><i class="ph ph-whatsapp-logo" aria-hidden="true"></i>Scrivi</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-click="markRecalled" data-id="${c.id}"><i class="ph ph-check" aria-hidden="true"></i>Richiamata</button>
      </div>
    </div>`).join('');
}
// Hides the client from the list for another `recallWeeks` weeks (or until she books again).
function markRecalled(id) {
  const c = db.clients.find((x) => x.id === id);
  if (!c) return;
  c.recalledAt = todayStr();
  persist('clients', c);
  renderRecall();
}

// ---------- Scheda cliente ----------
let cardPhotos = [], openPhotoItem = null;
const cardId = () => Number($('cm-id').value);

function openClientCard(id) {
  const c = db.clients.find((x) => x.id === id);
  if (!c) return;
  const today = todayStr(), visits = visitsByClient(db.appointments, db.clients).get(id) || [];
  const past = visits.filter((a) => a.date < today), next = visits.filter((a) => a.date >= today).reverse();
  $('cm-id').value = id;
  $('cm-title').textContent = c.name;
  $('cm-avatar').textContent = initials(c.name);
  $('cm-since').textContent = c.gdprDate ? `Cliente dal ${fmtDate(c.gdprDate)}` : '';
  $('cm-stats').innerHTML = `
    <div><span class="metric-val num">${past.length}</span><span class="metric-lbl">${past.length === 1 ? 'visita' : 'visite'}</span></div>
    <div><span class="metric-val num">${euro(past.reduce((s, a) => s + (Number(a.price) || 0), 0))}</span><span class="metric-lbl">spesi in salone</span></div>
    <div><span class="metric-val num">${past[0] ? esc(fmtDate(past[0].date).slice(0, 6) + past[0].date.slice(2, 4)) : 'Mai'}</span><span class="metric-lbl">ultima visita</span></div>`;
  $('cm-name').value = c.name;
  $('cm-phone').value = c.phone || '';
  $('cm-allergy').value = c.allergy && c.allergy.toLowerCase() !== 'nessuna' ? c.allergy : '';
  $('cm-formula').value = c.formula || '';
  $('cm-notes').value = c.notes || '';
  $('cm-gdpr').checked = !!c.gdprConsent;
  $('cm-health').checked = !!c.healthConsent;
  const visit = (a, upcoming) => `
    <div class="visit${upcoming ? ' next' : ''}">
      <span class="num">${esc(fmtDate(a.date))}</span>
      <span>${upcoming ? `<span class="badge badge-accent">In agenda, ore ${esc(a.time)}</span> ` : ''}${esc((a.services || []).join(' + ') || 'Appuntamento')}</span>
      <span class="num">${euro(a.price)}</span>
      ${a.notes ? `<p class="note"><i class="ph ph-note" aria-hidden="true"></i><span>${esc(a.notes)}</span></p>` : ''}
    </div>`;
  $('cm-history').innerHTML = [...next.map((a) => visit(a, true)), ...past.map((a) => visit(a))].join('')
    || '<p class="muted small">Ancora nessuna visita registrata.</p>';
  // Photos are fetched only when the card opens, so the main load stays light.
  cardPhotos = [];
  renderPhotos('caricamento...');
  openModal('cli-modal');
  api('GET', `/api/data?photos=${id}`)
    .then((r) => { if (cardId() === id) { cardPhotos = r.photos; renderPhotos(); } })
    .catch((e) => { if (cardId() === id) renderPhotos(isNetwork(e) ? 'visibili solo con la connessione' : e.message); });
}

function saveClientCard() {
  const c = db.clients.find((x) => x.id === cardId());
  const name = $('cm-name').value.trim(), allergy = $('cm-allergy').value.trim(), gdpr = $('cm-gdpr').checked;
  if (!c) return;
  if (!name) return toast('Inserisci il nome della cliente', 'error');
  if (allergy && !$('cm-health').checked) return toast('Per annotare allergie serve il consenso art. 9', 'error');
  Object.assign(c, {
    name, phone: $('cm-phone').value.trim(), allergy: allergy || 'Nessuna', formula: $('cm-formula').value.trim(), notes: $('cm-notes').value.trim(),
    gdprConsent: gdpr, healthConsent: $('cm-health').checked, gdprDate: gdpr && !c.gdprConsent ? todayStr() : c.gdprDate,
  });
  persist('clients', c).then((r) => r && toast('Scheda salvata'));
  closeModal('cli-modal');
  renderClients();
  renderGdpr();
  renderAgenda();
}

// `status`: text shown instead of the photos (loading, offline, error).
function renderPhotos(status) {
  $('cm-photo-info').textContent = status || `${cardPhotos.length ? cardPhotos.length + ' foto, ' : ''}ridotte a 480p per occupare poco spazio`;
  $('cm-photos').innerHTML = status ? '' : `
    <label class="photo add"><input type="file" accept="image/*" multiple data-change="addPhotos"><i class="ph ph-camera-plus" aria-hidden="true"></i>Aggiungi</label>`
    + cardPhotos.map((p, i) => `
    <button class="photo" data-click="openPhoto" data-id="${i}" aria-label="Foto del ${esc(fmtDate(p.date))}${p.note ? ', ' + esc(p.note) : ''}"><img src="${esc(p.img)}" alt="" loading="lazy"><span>${esc(p.note || fmtDate(p.date))}</span></button>`).join('');
}

// Shrinks a photo on the device to 480p JPEG (usually 40-80 KB), so it costs little in Neon and Vercel traffic.
async function shrink(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Formato non supportato, scegli una foto JPEG o PNG'); }
  const k = Math.min(1, 480 / Math.min(bmp.width, bmp.height), 854 / Math.max(bmp.width, bmp.height));
  const cv = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs would turn black in JPEG
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  for (const q of [0.75, 0.6, 0.45]) {
    const url = cv.toDataURL('image/jpeg', q);
    if (url.length <= 200000) return url; // the server accepts up to 220000 characters
  }
  throw new Error('Foto troppo pesante anche dopo la riduzione');
}

// Photos go straight to the server, never into the offline queue: they would fill the device storage.
async function addPhotos(input) {
  const id = cardId(), files = [...input.files];
  input.value = '';
  for (const f of files) {
    try {
      const p = { id: newId(), clientId: id, date: todayStr(), note: '', img: await shrink(f) };
      await api('PUT', '/api/data', { col: 'photos', item: p });
      if (cardId() === id) { cardPhotos.unshift(p); renderPhotos(); }
    } catch (e) {
      return toast(isNetwork(e) ? 'Serve la connessione per caricare le foto' : e.message, 'error');
    }
  }
  if (files.length) toast(files.length === 1 ? 'Foto aggiunta' : `${files.length} foto aggiunte`);
}

function openPhoto(i) {
  openPhotoItem = cardPhotos[i];
  $('pv-img').src = openPhotoItem.img;
  $('pv-date').textContent = `Foto del ${fmtDate(openPhotoItem.date)}`;
  $('pv-note').value = openPhotoItem.note || '';
  openModal('photo-modal');
}
function closePhoto() {
  savePhotoNote();
  closeModal('photo-modal');
}
function savePhotoNote() {
  const p = openPhotoItem, note = $('pv-note').value.trim();
  if (!p || note === p.note) return;
  p.note = note;
  renderPhotos();
  api('PUT', '/api/data', { col: 'photos', item: p }).catch((e) => toast('Nota non salvata: ' + (isNetwork(e) ? 'manca la connessione' : e.message), 'error'));
}
function deletePhoto() {
  const p = openPhotoItem;
  if (!p || !confirm('Eliminare questa foto?')) return;
  api('DELETE', `/api/data?col=photos&id=${p.id}`)
    .then(() => {
      cardPhotos = cardPhotos.filter((x) => x !== p);
      openPhotoItem = null;
      closeModal('photo-modal');
      renderPhotos();
      toast('Foto eliminata');
    })
    .catch((e) => toast(isNetwork(e) ? 'Serve la connessione per eliminare le foto' : e.message, 'error'));
}

// ---------- Actions (data-click & co. in index.html and in the templates above, see common.js) ----------
Object.assign(actions.click, {
  addClient, toggleNoPhone, exportClientsCsv, deleteSelectedClients, saveClientCard, closePhoto, deletePhoto,
  pickCsv: () => $('cli-csv').click(),
  clearClientSel: () => selectAllClients(false),
  openClientCard: (el) => openClientCard(Number(el.dataset.id)),
  deleteCardClient: () => deleteClient(cardId()),
  contactClient: (el) => openContact(Number(el.dataset.id)),
  contactRecall: (el) => openContact(Number(el.dataset.id), null, true),
  markRecalled: (el) => markRecalled(Number(el.dataset.id)),
  openPhoto: (el) => openPhoto(Number(el.dataset.id)),
});
Object.assign(actions.change, {
  importClientsCsv, addPhotos, savePhotoNote,
  selectAllClients: (el) => selectAllClients(el.checked),
  toggleClientSel: (el) => toggleClientSel(Number(el.dataset.id), el),
});
actions.input.renderClients = renderClients;
