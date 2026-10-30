import { handle, fail, db, checkPassword, checkUserPassword, requirePasswordSet, sessionCookie, sessionEpoch, bumpEpoch, requireAdmin, limit, hit, clientIp, CLEAR_COOKIE } from './_lib.js';

export default handle(async (req, res) => {
  const sql = await db();
  if (req.method === 'DELETE') {
    // ?all=1 logs out every device of the salon (lost or stolen tablet): old cookies stop matching the epoch.
    if (req.query.all) await bumpEpoch(sql, (await requireAdmin(req, sql, { owner: true })).salon);
    res.setHeader('Set-Cookie', CLEAR_COOKIE);
    return res.json({ ok: true });
  }
  if (req.method !== 'POST') fail(405, 'Metodo non consentito');
  requirePasswordSet();
  const key = 'login:' + clientIp(req);
  await limit(sql, key, 5, 15); // 5 wrong passwords per IP every 15 minutes
  const { email, password } = req.body || {};
  let who;
  if (email) {
    // shortcut: someone working in two salons enters the first one; add a salon switch when that happens.
    const [u] = await sql`SELECT u.id, u.pw, m.salon FROM users u JOIN members m ON m.user_id = u.id
      WHERE u.email = ${String(email).trim().toLowerCase()} ORDER BY m.salon LIMIT 1`;
    if (await checkUserPassword(password, u?.pw)) who = { user: Number(u.id), salon: Number(u.salon) };
  } else if (checkPassword(password)) {
    who = { user: 0, salon: 1 }; // the shared password of the single-salon install
  }
  if (!who) {
    await hit(sql, key);
    fail(401, email ? 'Email o password errata' : 'Password errata');
  }
  res.setHeader('Set-Cookie', sessionCookie(await sessionEpoch(sql, who.salon), who.user, who.salon));
  res.json({ ok: true, salon: who.salon });
});
