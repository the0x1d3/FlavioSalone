import { handle, fail, db, linkSalon, romeNow, addMin, icsFile, DAY, HHMM } from './_lib.js';

// Read-only feed of the agenda for Google Calendar and other calendar apps: from 30 days ago onwards.
export default handle(async (req, res) => {
  const sql = await db();
  const S = await linkSalon(sql, 'ics', req.query);
  if (!S) fail(401, 'Link del calendario non valido: copialo di nuovo dalle Impostazioni');
  const d = new Date(romeNow().date + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 30);
  const rows = await sql`SELECT col, data FROM docs
    WHERE salon = ${S} AND (col = 'config' OR (col = 'appointments' AND data->>'date' >= ${d.toISOString().slice(0, 10)}))`;
  const config = rows.find((r) => r.col === 'config')?.data || {};
  const events = rows
    .filter((r) => r.col === 'appointments' && DAY.test(r.data.date) && HHMM.test(r.data.time))
    .map(({ data: a }) => ({
      uid: `${a.id}@salone-pro`, date: a.date, time: a.time, end: a.end || addMin(a.time, a.duration || 30),
      summary: a.clientName + (a.services?.length ? ': ' + a.services.join(' + ') : ''),
      description: [a.phone && 'Tel. ' + a.phone, a.notes, a.source === 'web' && 'Prenotata online'].filter(Boolean).join('\n'),
    }));
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(icsFile(config.salonName || 'Salone PRO', events));
});
