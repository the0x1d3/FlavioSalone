import { handle, fail, db, requireAdmin, newUser } from './_lib.js';

// The salon's accounts, managed by its owner: collaborators enter with their own email and password and can work in
// agenda, clients, price list and stock, but not change settings, restore backups or manage accounts.
export default handle(async (req, res) => {
  const sql = await db();
  const me = await requireAdmin(req, sql, { owner: true }), S = me.salon;

  if (req.method === 'GET') {
    const rows = await sql`SELECT u.id, u.name, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.salon = ${S} ORDER BY m.role = 'owner' DESC, u.name`; // the owner first
    return res.json({ members: rows.map((r) => ({ ...r, id: Number(r.id) })) });
  }

  if (req.method === 'POST') {
    const u = await newUser(req.body || {});
    // shortcut: a new email only; adding a person who already has an account (e.g. in another salon) comes with the salon switch.
    if ((await sql`SELECT 1 FROM users WHERE email = ${u.email}`).length) fail(409, 'Questa email ha già un account');
    const [row] = await sql`WITH u AS (INSERT INTO users (email, name, pw) VALUES (${u.email}, ${u.name}, ${u.pw}) RETURNING id)
      INSERT INTO members (user_id, salon, role) SELECT id, ${S}, 'staff' FROM u RETURNING user_id`;
    return res.json({ ok: true, id: Number(row.user_id) });
  }

  if (req.method === 'DELETE') {
    const id = Number(req.query.id);
    if (!Number.isSafeInteger(id)) fail(400, 'Dati non validi');
    // Only collaborators: the owner stays. Their account goes too, unless they work in another salon.
    const [gone] = await sql.transaction([
      sql`DELETE FROM members WHERE user_id = ${id} AND salon = ${S} AND role = 'staff' RETURNING user_id`,
      sql`DELETE FROM users WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM members WHERE user_id = ${id})`,
    ]);
    return res.json({ ok: true, removed: gone.length });
  }

  fail(405, 'Metodo non consentito');
});
