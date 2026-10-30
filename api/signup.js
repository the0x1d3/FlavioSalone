import { handle, fail, db, newUser, sessionCookie, limit, hit, clientIp, requirePasswordSet, DEFAULT_CONFIG, DEFAULT_FOLDERS, DEFAULT_SERVICES, TRIAL_DAYS } from './_lib.js';

// "Crea il tuo salone": a new salon in free trial, its owner's account, the starting price list. Then logged in.
export default handle(async (req, res) => {
  if (req.method !== 'POST') fail(405, 'Metodo non consentito');
  requirePasswordSet();
  const sql = await db();
  const key = 'signup:' + clientIp(req);
  await limit(sql, key, 5, 60); // a bot cannot fill the database with salons
  await hit(sql, key);

  const b = req.body || {};
  const salonName = String(b.salonName || '').trim();
  if (salonName.length < 2 || salonName.length > 80) fail(400, 'Scrivi il nome del salone');
  const u = await newUser(b);
  if ((await sql`SELECT 1 FROM users WHERE email = ${u.email}`).length) fail(409, 'Esiste già un account con questa email: accedi');

  // Booking page address: /prenota/<slug>, from the salon's name, numbered when taken.
  const base = salonName.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'salone';
  const taken = new Set((await sql`SELECT slug FROM salons WHERE slug = ${base} OR slug LIKE ${base + '-%'}`).map((r) => r.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;

  const config = { ...DEFAULT_CONFIG, serviceFolders: DEFAULT_FOLDERS, salonName, ownerName: u.name, email: u.email, onboarded: false };
  // One statement, so a half-made salon never exists. Two signups racing for the same email or slug: one gets 23505.
  let row;
  try {
    [row] = await sql`WITH
      s AS (INSERT INTO salons (slug, status, trial_end)
            VALUES (${slug}, 'trial', (now() AT TIME ZONE 'Europe/Rome')::date + ${TRIAL_DAYS}::int) RETURNING id),
      u AS (INSERT INTO users (email, name, pw) VALUES (${u.email}, ${u.name}, ${u.pw}) RETURNING id),
      m AS (INSERT INTO members (user_id, salon, role) SELECT u.id, s.id, 'owner' FROM u, s),
      d AS (INSERT INTO docs (salon, col, id, data)
            SELECT s.id, 'config', 1, ${JSON.stringify(config)}::jsonb FROM s
            UNION ALL SELECT s.id, 'services', (x->>'id')::bigint, x FROM s, jsonb_array_elements(${JSON.stringify(DEFAULT_SERVICES)}::jsonb) x)
      SELECT u.id AS "user", s.id AS salon FROM u, s`;
  } catch (e) {
    if (e.code === '23505') fail(409, 'Email o nome già usati in questo momento: riprova');
    throw e;
  }
  res.setHeader('Set-Cookie', sessionCookie(0, Number(row.user), Number(row.salon)));
  res.json({ ok: true, slug, salon: Number(row.salon) });
});
