import { handle, fail, db, requireAdmin, withEnd, checkConfig, sessionEpoch, linkQuery, isPlatformAdmin, COLS, DAY, DEFAULT_CONFIG } from './_lib.js';
import { afterNewAppointment } from './_notify.js';

// Client photos are shrunk to 480p JPEG in the browser; they live in their own collection, outside the main load and the backup.
const PHOTO_MAX_CHARS = 220_000; // about 160 KB of JPEG: a 480p photo is usually 40-80 KB
const PHOTOS_PER_CLIENT = 40;
function checkPhoto(p) {
  if (!Number.isSafeInteger(p.clientId) || typeof p.img !== 'string' || p.img.length > PHOTO_MAX_CHARS
    || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(p.img) || !DAY.test(p.date)
    || (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 120))) {
    fail(400, 'Foto non valida: solo JPEG ridotte, massimo 160 KB');
  }
  return { id: p.id, clientId: p.clientId, date: p.date, note: p.note || '', img: p.img };
}

// Admin-only API. GET everything, PUT one item, DELETE one item, POST = restore a full backup.
export default handle(async (req, res) => {
  const sql = await db();
  const me = await requireAdmin(req, sql), S = me.salon;

  // Cheap check the open app runs every few seconds: web bookings newer than the last one it has (ids grow with time).
  if (req.method === 'GET' && req.query.newweb !== undefined) {
    const after = Number(req.query.newweb);
    if (!Number.isSafeInteger(after)) fail(400, 'Dati non validi');
    const [{ n }] = await sql`SELECT count(*)::int AS n FROM docs WHERE salon = ${S} AND col = 'appointments' AND id > ${after} AND data->>'source' = 'web'`;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ n });
  }

  if (req.method === 'GET' && req.query.calendar !== undefined) {
    // The feed shows every client's name and phone: the owner's link.
    if (me.role !== 'owner') fail(403, 'Solo il titolare può vedere il link del calendario');
    return res.json({ url: `https://${req.headers.host}/api/calendar?${linkQuery('ics', S, await sessionEpoch(sql, S))}` });
  }

  if (req.method === 'GET' && req.query.photos) {
    const rows = await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'photos' AND data->>'clientId' = ${String(Number(req.query.photos))} ORDER BY id DESC`;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ photos: rows.map((r) => r.data) });
  }

  if (req.method === 'GET') {
    // shortcut: loads every appointment ever, fine for a few thousand rows; filter by date range when it grows.
    // Only the app's own data: photos, SMS, push devices and secrets stay on the server.
    const rows = await sql`SELECT col, data FROM docs WHERE salon = ${S} AND col = ANY(${COLS}::text[]) ORDER BY id`;
    const out = { config: { ...DEFAULT_CONFIG }, services: [], clients: [], inventory: [], appointments: [] };
    for (const r of rows) {
      if (r.col === 'config') Object.assign(out.config, r.data);
      else out[r.col]?.push(r.data);
    }
    // Who is logged in, for the pages: role, booking link, trial. Not part of a backup.
    out.account = { salon: S, role: me.role, name: me.name, email: me.email, slug: me.slug, status: me.status, trialEnd: me.trialEnd,
      platformAdmin: isPlatformAdmin(me.email) };
    res.setHeader('Cache-Control', 'no-store');
    return res.json(out);
  }

  if (req.method === 'PUT') {
    const { col, item, items } = req.body || {};
    if (col === 'config' && me.role !== 'owner') fail(403, 'Solo il titolare può cambiare le impostazioni');
    const list = items === undefined ? [item] : items; // `items`: many at once (CSV import), never config or photos
    if (![...COLS, 'photos'].includes(col) || !Array.isArray(list) || !list.length || list.length > 1000
      || (items !== undefined && (col === 'config' || col === 'photos'))
      || list.some((x) => typeof x !== 'object' || !Number.isSafeInteger(x?.id)) || new Set(list.map((x) => x.id)).size < list.length) {
      fail(400, 'Dati non validi');
    }
    if (col === 'photos') {
      const [{ n }] = await sql`SELECT count(*)::int AS n FROM docs WHERE salon = ${S} AND col = 'photos' AND data->>'clientId' = ${String(item.clientId)} AND id <> ${item.id}`;
      if (n >= PHOTOS_PER_CLIENT) fail(400, `Massimo ${PHOTOS_PER_CLIENT} foto per cliente: eliminane qualcuna`);
    }
    // A single appointment the server has never seen (also one created offline) gets the confirmation SMS.
    const isNew = col === 'appointments' && items === undefined
      && !(await sql`SELECT 1 FROM docs WHERE salon = ${S} AND col = 'appointments' AND id = ${item.id}`).length;
    const data = list.map((x) => (col === 'config' ? checkConfig({ ...DEFAULT_CONFIG, ...x, id: 1 })
      : col === 'appointments' ? withEnd(x) : col === 'photos' ? checkPhoto(x) : x));
    await sql`INSERT INTO docs (salon, col, id, data)
              SELECT ${S}, ${col}, (r->>'id')::bigint, r FROM jsonb_array_elements(${JSON.stringify(data)}::jsonb) r
              ON CONFLICT (salon, col, id) DO UPDATE SET data = EXCLUDED.data
                || jsonb_strip_nulls(jsonb_build_object('smsConfirmAt', docs.data->'smsConfirmAt', 'smsReminderAt', docs.data->'smsReminderAt'))`;
    // ^ SMS times are written only by the server: a device saving an older copy of the appointment cannot wipe them.
    if (isNew) await afterNewAppointment(sql, S, data[0]);
    return res.json({ ok: true, item: data[0], count: data.length });
  }

  if (req.method === 'DELETE') {
    const { col, id, ids } = req.query;
    const raw = String(ids ?? id ?? ''), list = raw.split(',').map(Number); // `ids`: bulk delete, comma separated in the URL
    if (![...COLS, 'photos'].includes(col) || col === 'config' || !/^\d+(,\d+)*$/.test(raw) || list.length > 500
      || list.some((n) => !Number.isSafeInteger(n))) fail(400, 'Dati non validi');
    // Deleting client cards also deletes their photos, deleting appointments their SMS not sent yet
    // (this also works for deletes queued offline).
    await sql.transaction([
      sql`DELETE FROM docs WHERE salon = ${S} AND col = ${col} AND id = ANY(${list}::bigint[])`,
      sql`DELETE FROM docs WHERE ${col === 'clients'} AND salon = ${S} AND col = 'photos' AND (data->>'clientId')::bigint = ANY(${list}::bigint[])`,
      sql`DELETE FROM docs WHERE ${col === 'appointments'} AND salon = ${S} AND col = 'sms' AND data->>'status' <> 'sent'
          AND (data->>'apptId')::bigint = ANY(${list}::bigint[])`,
    ]);
    return res.json({ ok: true });
  }

  if (req.method === 'POST') {
    if (me.role !== 'owner') fail(403, 'Solo il titolare può ripristinare un backup');
    const b = req.body || {};
    if (typeof b.config !== 'object' || !b.config || COLS.slice(1).some((c) => b[c] !== undefined && !Array.isArray(b[c]))) {
      fail(400, 'Backup non valido');
    }
    // v9 backups keep the folder list next to config, not inside it
    const rows = [{ col: 'config', id: 1, data: checkConfig({ serviceFolders: b.serviceFolders, ...DEFAULT_CONFIG, ...b.config, id: 1 }) }];
    for (const col of COLS.slice(1)) {
      for (const item of b[col] || []) {
        if (!Number.isSafeInteger(item?.id)) fail(400, `Backup non valido: elemento senza id in "${col}"`);
        rows.push({ col, id: item.id, data: col === 'appointments' ? withEnd(item, b.services) : item });
      }
    }
    // One transaction: if any row is bad nothing is deleted. Only the app's data is replaced: session epoch, photos,
    // SMS, push devices and secrets survive a restore.
    await sql.transaction([
      sql`DELETE FROM docs WHERE salon = ${S} AND col = ANY(${COLS}::text[])`,
      sql`INSERT INTO docs (salon, col, id, data)
          SELECT ${S}, r->>'col', (r->>'id')::bigint, r->'data' FROM jsonb_array_elements(${JSON.stringify(rows)}::jsonb) r`,
    ]);
    return res.json({ ok: true, count: rows.length });
  }

  fail(405, 'Metodo non consentito');
});
