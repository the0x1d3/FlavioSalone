import { handle, fail, db, requireAdmin, DAY } from './_lib.js';

// Salons panel for whoever runs the service (PLATFORM_ADMINS): payments are handled by hand, so here a salon is
// switched to 'active' when it pays, its trial extended, or suspended.
export default handle(async (req, res) => {
  const sql = await db();
  await requireAdmin(req, sql, { platform: true });

  if (req.method === 'GET') {
    const rows = await sql`SELECT s.id, s.slug, s.status, s.trial_end::text AS "trialEnd", s.created,
        c.data->>'salonName' AS name,
        (SELECT string_agg(u.email, ', ') FROM members m JOIN users u ON u.id = m.user_id WHERE m.salon = s.id AND m.role = 'owner') AS owner,
        (SELECT count(*)::int FROM members m WHERE m.salon = s.id) AS accounts,
        (SELECT count(*)::int FROM docs a WHERE a.salon = s.id AND a.col = 'appointments') AS appointments
      FROM salons s LEFT JOIN docs c ON c.salon = s.id AND c.col = 'config' AND c.id = 1 ORDER BY s.id DESC`;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ salons: rows.map((r) => ({ ...r, id: Number(r.id) })) });
  }

  if (req.method === 'POST') {
    const { id, status, trialEnd } = req.body || {};
    if (!Number.isSafeInteger(id) || !['trial', 'active', 'suspended'].includes(status)
      || (trialEnd != null && !DAY.test(trialEnd)) || (status === 'trial' && !trialEnd)) fail(400, 'Dati non validi');
    const [row] = await sql`UPDATE salons SET status = ${status}, trial_end = ${trialEnd ?? null} WHERE id = ${id} RETURNING id`;
    if (!row) fail(404, 'Salone non trovato');
    return res.json({ ok: true });
  }

  fail(405, 'Metodo non consentito');
});
