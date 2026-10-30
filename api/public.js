import { handle, fail, db, addMin, romeNow, limit, hit, clientIp, closureOn, durationOf, icsFile, salonOpen, DAY, HHMM, DEFAULT_CONFIG } from './_lib.js';
import { afterNewAppointment } from './_notify.js';

const PUBLIC_CONFIG = ['salonName', 'ownerName', 'address', 'vat', 'email', 'ownerPhone', 'openTime', 'closeTime', 'slotMinutes', 'closedDays', 'serviceFolders', 'breaks', 'closures'];
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// The page /prenota/<slug> asks with ?salon=<slug>; plain /prenota is salon 1 (links shared before multi-salon).
async function findSalon(sql, slug) {
  const [s] = slug ? await sql`SELECT id, status, trial_end::text AS trial_end FROM salons WHERE slug = ${String(slug)}`
    : await sql`SELECT id, status, trial_end::text AS trial_end FROM salons WHERE id = 1`;
  if (!s || !salonOpen(s)) fail(404, 'Questo salone non accetta prenotazioni online');
  return Number(s.id);
}

async function loadSalon(sql, S) {
  const rows = await sql`SELECT col, data FROM docs WHERE salon = ${S} AND col IN ('config', 'services') ORDER BY id`;
  return {
    config: { ...DEFAULT_CONFIG, ...rows.find((r) => r.col === 'config')?.data },
    services: rows.filter((r) => r.col === 'services').map((r) => pick(r.data, ['id', 'name', 'cat', 'price', 'duration'])),
  };
}

// Public API for the client booking page: no names or phone numbers ever leave through here.
export default handle(async (req, res) => {
  const sql = await db();
  const S = await findSalon(sql, req.query.salon);
  const { config, services } = await loadSalon(sql, S);
  const now = romeNow();

  // "Aggiungi al calendario" after booking (iPhone opens it straight in Calendar). Only date, time and service ids
  // travel in the link, never the client's name or phone; the event text is built here from the price list.
  if (req.method === 'GET' && req.query.ics !== undefined) {
    const { date, time } = req.query;
    const ids = String(req.query.s || '').split(',').map(Number);
    const chosen = services.filter((s) => ids.includes(s.id));
    if (!DAY.test(date) || !HHMM.test(time) || !chosen.length) fail(400, 'Dati non validi');
    const total = chosen.reduce((s, x) => s + (Number(x.price) || 0), 0);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="appuntamento.ics"');
    return res.send(icsFile(null, [{
      uid: `${date}T${time}-${chosen.map((s) => s.id).join('-')}@salone-pro`, date, time, end: addMin(time, durationOf(chosen, config)),
      summary: `Appuntamento da ${config.salonName}`, location: config.address, alarm: 120, // reminder 2 hours before
      description: `Servizi: ${chosen.map((s) => s.name).join(' + ')}\nTotale indicativo: € ${Number.isInteger(total) ? total : total.toFixed(2).replace('.', ',')}`
        + (config.ownerPhone ? `\nPer spostarlo o annullarlo: ${config.ownerPhone}` : ''),
    }]));
  }

  if (req.method === 'GET') {
    const date = String(req.query.date || '');
    // Daily breaks are sent as busy intervals, so the booking page needs no extra logic for them.
    const busy = DAY.test(date)
      ? [...await sql`SELECT data->>'time' AS time, data->>'end' AS "end" FROM docs
                  WHERE salon = ${S} AND col = 'appointments' AND data->>'date' = ${date} AND data->>'end' IS NOT NULL`,
        ...config.breaks.map((x) => ({ time: x.from, end: x.to }))]
      : [];
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ config: pick(config, PUBLIC_CONFIG), services, busy, now });
  }

  if (req.method !== 'POST') fail(405, 'Metodo non consentito');
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot field: only bots fill it
  const key = 'book:' + clientIp(req);
  await limit(sql, key, 10, 60); // max 10 booking attempts per IP per hour, so a bot cannot flood the agenda
  await hit(sql, key);

  const name = String(b.name || '').trim().slice(0, 80);
  const phone = String(b.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 20);
  const digits = phone.replace(/\D/g, '');
  if (name.length < 2) fail(400, 'Inserisci nome e cognome');
  if (digits.length < 6 || digits.length > 15) fail(400, 'Numero di telefono non valido');
  if (b.privacy !== true) fail(400, "Devi accettare l'informativa privacy");

  const ids = Array.isArray(b.serviceIds) ? b.serviceIds.slice(0, 15) : [];
  const chosen = services.filter((s) => ids.includes(s.id));
  if (!chosen.length) fail(400, 'Scegli almeno un servizio');

  const { date, time } = b;
  if (!DAY.test(date) || !/^\d{2}:\d{2}$/.test(time)) fail(400, 'Data o ora non valida');
  const d = new Date(date + 'T12:00:00Z');
  const max = new Date(now.date + 'T12:00:00Z');
  max.setUTCFullYear(max.getUTCFullYear() + 1);
  if (d.toISOString().slice(0, 10) !== date || date < now.date || d > max || (date === now.date && time <= now.time)) {
    fail(400, 'Questa data non è prenotabile');
  }
  if ((config.closedDays || []).includes(d.getUTCDay())) fail(400, 'Il salone è chiuso in questo giorno');
  const closure = closureOn(config, date);
  if (closure) fail(400, `Il salone è chiuso in questo periodo${closure.note ? ` (${closure.note})` : ''}`);

  const duration = durationOf(chosen, config);
  const end = addMin(time, duration);
  if (time < config.openTime || end > config.closeTime) fail(400, "L'orario scelto è fuori dall'apertura del salone");
  if (config.breaks.some((x) => time < x.to && x.from < end)) fail(400, "L'orario scelto cade nella pausa del salone");

  const [existing] = await sql`SELECT data->'id' AS id FROM docs
    WHERE salon = ${S} AND col = 'clients' AND right(regexp_replace(data->>'phone', '[^0-9]', '', 'g'), 10) = ${digits.slice(-10)} LIMIT 1`;
  const id = Date.now() * 100 + Math.floor(Math.random() * 100); // unique even for bookings in the same millisecond
  const clientId = existing ? Number(existing.id) : id + 1;
  const appt = {
    id, clientId, clientName: name, phone, date, time, end, duration,
    services: chosen.map((s) => s.name), price: chosen.reduce((s, x) => s + (Number(x.price) || 0), 0),
    notes: '', source: 'web', createdAt: new Date().toISOString(),
  };
  const client = { id: clientId, name, phone, allergy: 'Nessuna', formula: '', gdprConsent: true, gdprDate: now.date, source: 'web' };

  // The advisory lock serialises concurrent bookings of a salon, so two clients can never take the same slot.
  const [, [result]] = await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(4242, ${S}::int)`,
    sql`WITH a AS (
          INSERT INTO docs (salon, col, id, data)
          SELECT ${S}, 'appointments', ${id}, ${JSON.stringify(appt)}::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM docs WHERE salon = ${S} AND col = 'appointments' AND data->>'date' = ${date}
            AND data->>'time' < ${end} AND data->>'end' > ${time})
          RETURNING id),
        c AS (
          INSERT INTO docs (salon, col, id, data)
          SELECT ${S}, 'clients', ${clientId}, ${JSON.stringify(client)}::jsonb
          WHERE ${!existing} AND EXISTS (SELECT 1 FROM a)
          ON CONFLICT DO NOTHING
          RETURNING id)
        SELECT (SELECT count(*) FROM a)::int AS booked`,
  ]);
  if (!result.booked) fail(409, 'Questo orario è appena stato occupato, scegline un altro');
  await afterNewAppointment(sql, S, appt, { push: true }); // confirmation SMS to the client, push to the salon's phones
  res.json({ ok: true, appointment: { date, time, end, services: appt.services, price: appt.price } });
});
