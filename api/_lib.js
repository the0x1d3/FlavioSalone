import { neon } from '@neondatabase/serverless';
import { createHmac, timingSafeEqual, scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

export const COLS = ['config', 'services', 'clients', 'inventory', 'appointments'];

export const DEFAULT_CONFIG = {
  salonName: 'Il Mio Salone', ownerName: 'Titolare', address: '', vat: '', email: '', ownerPhone: '',
  openTime: '09:00', closeTime: '19:00', slotMinutes: 30, closedDays: [0, 1],
  breaks: [], closures: [], recallWeeks: 6,
  // Automatic SMS to clients, sent by the salon's own phone (see _notify.js). Tags: {cliente} {salone} {giorno} {ora} {servizi} {telefono}
  sms: {
    enabled: false, channel: 'android', confirm: true, reminder: true,
    confirmMsg: "Ciao {cliente}! Ti confermiamo l'appuntamento da {salone} per {giorno} alle {ora} ({servizi}). A presto!",
    reminderMsg: "Ciao {cliente}! Ti ricordiamo l'appuntamento di domani da {salone} alle {ora} ({servizi}). Per spostarlo o annullarlo: {telefono}",
  },
  // Push notifications on the salon's own devices.
  notifications: { bookings: true, morning: true },
};
// Older configs saved before a section existed get its defaults, field by field.
export const smsConfig = (config) => ({ ...DEFAULT_CONFIG.sms, ...config.sms });

// Starting price list for a new salon (same folders as salone_pro_v9).
export const DEFAULT_FOLDERS = ['PIEGA', 'TAGLIO', 'COLORE & TECNICI', 'TRATTAMENTI'];
export const DEFAULT_SERVICES = [
  { id: 1, name: 'Piega Classica', cat: 'PIEGA', price: 18, duration: 30 },
  { id: 2, name: 'Piega Onde / Glamour', cat: 'PIEGA', price: 22, duration: 40 },
  { id: 3, name: 'Taglio Donna', cat: 'TAGLIO', price: 22, duration: 30 },
  { id: 4, name: 'Taglio + Piega', cat: 'TAGLIO', price: 35, duration: 60 },
  { id: 5, name: 'Colore Ricrescita', cat: 'COLORE & TECNICI', price: 30, duration: 45 },
  { id: 6, name: 'Balayage / Schiariture', cat: 'COLORE & TECNICI', price: 65, duration: 90 },
  { id: 7, name: 'Tonalizzante / Gloss', cat: 'COLORE & TECNICI', price: 20, duration: 30 },
  { id: 8, name: 'Trattamento Cheratina', cat: 'TRATTAMENTI', price: 25, duration: 30 },
];

// `setup` ('database' | 'password') tells the pages that Vercel is not configured yet, so they can explain how to fix it.
export function fail(status, message, setup) {
  throw Object.assign(new Error(message), { status, setup });
}

// Wraps a Vercel handler: every thrown error becomes a JSON response, never an HTML crash page.
export const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (!e.status) console.error(e);
    const status = e.status || (e.code === '23505' ? 400 : 500);
    res.status(status).json({ error: e.status ? e.message : e.code === '23505' ? 'Dati duplicati (ID già presenti)' : 'Errore del server, riprova', setup: e.setup });
  }
};

let ready;
export async function db() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) fail(503, 'Database non collegato: aggiungi Neon dal tab Storage del progetto Vercel', 'database');
  const sql = neon(url);
  // Every salon's data lives in `docs`, keyed by salon: every query names its salon.
  ready ??= sql.transaction([
    sql`CREATE TABLE IF NOT EXISTS docs (salon bigint NOT NULL, col text NOT NULL, id bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (salon, col, id))`,
    // Databases from the single-salon version: their data becomes salon 1. No default left, so a query that forgets
    // its salon fails instead of writing into salon 1.
    sql`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'docs' AND column_name = 'salon') THEN
        ALTER TABLE docs ADD COLUMN salon bigint NOT NULL DEFAULT 1;
        ALTER TABLE docs ALTER COLUMN salon DROP DEFAULT;
        ALTER TABLE docs DROP CONSTRAINT docs_pkey;
        ALTER TABLE docs ADD PRIMARY KEY (salon, col, id);
        DROP INDEX IF EXISTS docs_appt_date;
      END IF;
    END $$`,
    sql`CREATE INDEX IF NOT EXISTS docs_appt_day ON docs (salon, (data->>'date')) WHERE col = 'appointments'`,
    sql`CREATE TABLE IF NOT EXISTS hits (key text NOT NULL, at timestamptz NOT NULL DEFAULT now())`,
    sql`CREATE INDEX IF NOT EXISTS hits_key_at ON hits (key, at)`,
    // status: 'trial' (open until trial_end), 'active' (paying, handled by hand for now), 'suspended'.
    sql`CREATE TABLE IF NOT EXISTS salons (id bigserial PRIMARY KEY, slug text UNIQUE NOT NULL, status text NOT NULL, trial_end date, created timestamptz NOT NULL DEFAULT now())`,
    sql`CREATE TABLE IF NOT EXISTS users (id bigserial PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL, pw text NOT NULL, created timestamptz NOT NULL DEFAULT now())`,
    sql`CREATE TABLE IF NOT EXISTS members (user_id bigint NOT NULL REFERENCES users ON DELETE CASCADE, salon bigint NOT NULL REFERENCES salons ON DELETE CASCADE,
        role text NOT NULL, PRIMARY KEY (user_id, salon))`,
    // Salon 1 = the salon of the single-salon install: ADMIN_PASSWORD login, /prenota, links made before.
    sql`INSERT INTO salons (id, slug, status) VALUES (1, 'salone', 'active') ON CONFLICT DO NOTHING`,
    sql`SELECT setval(pg_get_serial_sequence('salons', 'id'), GREATEST((SELECT max(id) FROM salons), 1))`,
    ...seedSalon(sql, 1),
  ]).catch((e) => { ready = undefined; throw e; });
  await ready;
  return sql;
}

// A salon's starting data: config and price list, only if the salon has no config yet (sign-up writes its own).
function seedSalon(sql, salon) {
  return [
    sql`INSERT INTO docs (salon, col, id, data)
        SELECT ${salon}, 'services', (s->>'id')::bigint, s FROM jsonb_array_elements(${JSON.stringify(DEFAULT_SERVICES)}::jsonb) s
        WHERE NOT EXISTS (SELECT 1 FROM docs WHERE salon = ${salon} AND col = 'config')`,
    sql`INSERT INTO docs (salon, col, id, data) VALUES (${salon}, 'config', 1, ${JSON.stringify({ ...DEFAULT_CONFIG, serviceFolders: DEFAULT_FOLDERS })}::jsonb)
        ON CONFLICT DO NOTHING`,
  ];
}

// Open = can be used: paying (set by hand in the admin panel) or still in its free trial.
export const salonOpen = (s) => s.status === 'active' || (s.status === 'trial' && s.trial_end >= romeNow().date);
export const TRIAL_DAYS = 30;

export const addMin = (t, m) => {
  const x = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) + Number(m);
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

// Salon clock: Vercel runs in UTC, the salon lives in Italy.
export function romeNow() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

// Every stored appointment carries duration + end so overlap checks are plain string compares ("HH:MM").
export function withEnd(a, services = []) {
  if (!Number(a.duration)) {
    a.duration = (a.services || []).reduce((s, n) => s + (Number(services.find((x) => x.name === n)?.duration) || 0), 0) || 30;
  }
  if (/^\d\d:\d\d$/.test(a.time)) a.end = addMin(a.time, a.duration);
  return a;
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Booking length: sum of the chosen services, or one slot.
export const durationOf = (chosen, config) => chosen.reduce((s, x) => s + (Number(x.duration) || 0), 0) || Number(config.slotMinutes) || 30;

// iCalendar file for calendar apps (iPhone, Google, Outlook), in Italian time.
// events: [{ uid, date, time, end, summary, description?, location?, alarm? (minutes before) }]
const VTIMEZONE = [ // summer time from the last Sunday of March to the last Sunday of October
  'BEGIN:VTIMEZONE', 'TZID:Europe/Rome',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];
const icsText = (s) => String(s || '').replace(/[\\;,]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');
const icsAt = (date, time) => `${date.replace(/-/g, '')}T${time.replace(':', '')}00`;
export function icsFile(name, events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Salone PRO//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...(name ? [`X-WR-CALNAME:${icsText(name)}`, 'X-WR-TIMEZONE:Europe/Rome'] : []), ...VTIMEZONE,
    ...events.flatMap((e) => [
      'BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Rome:${icsAt(e.date, e.time)}`, `DTEND;TZID=Europe/Rome:${icsAt(e.date, e.end)}`,
      `SUMMARY:${icsText(e.summary)}`, e.description && `DESCRIPTION:${icsText(e.description)}`, e.location && `LOCATION:${icsText(e.location)}`,
      ...(e.alarm ? ['BEGIN:VALARM', `TRIGGER:-PT${e.alarm}M`, 'ACTION:DISPLAY', `DESCRIPTION:${icsText(e.summary)}`, 'END:VALARM'] : []),
      'END:VEVENT',
    ].filter(Boolean)),
    'END:VCALENDAR',
  ];
  return lines.map((l) => l.match(/.{1,74}/gu).join('\r\n ')).join('\r\n') + '\r\n'; // long lines continue after a space
}
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Closure covering a YYYY-MM-DD date, if any (string compare works on ISO dates).
export const closureOn = (config, date) => (config.closures || []).find((x) => date >= x.from && date <= x.to);
// Config reaches the public page, so it is validated here (it can also arrive from a restored backup file).
export function checkConfig(c) {
  if (!HHMM.test(c.openTime) || !HHMM.test(c.closeTime) || c.openTime >= c.closeTime
    || ![15, 20, 30, 45, 60].includes(Number(c.slotMinutes))
    || !Array.isArray(c.closedDays) || c.closedDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
    || (c.serviceFolders !== undefined && (!Array.isArray(c.serviceFolders) || c.serviceFolders.length > 100
      || c.serviceFolders.some((f) => typeof f !== 'string' || !f.trim() || f.length > 60)))) {
    fail(400, 'Impostazioni non valide (orari, intervallo, giorni di chiusura o cartelle)');
  }
  // Daily breaks (e.g. lunch) and closures (holidays) block online bookings; recallWeeks drives the "Da richiamare" list.
  const list = (v, max) => v === undefined || (Array.isArray(v) && v.length <= max);
  if (!list(c.breaks, 5) || (c.breaks || []).some((b) => !HHMM.test(b?.from) || !HHMM.test(b?.to) || b.from >= b.to)
    || !list(c.closures, 100) || (c.closures || []).some((x) => !DAY.test(x?.from) || !DAY.test(x?.to) || x.from > x.to
      || (x.note !== undefined && (typeof x.note !== 'string' || x.note.length > 60)))
    || (c.recallWeeks !== undefined && (!Number.isInteger(c.recallWeeks) || c.recallWeeks < 0 || c.recallWeeks > 52))) {
    fail(400, 'Impostazioni non valide (pause, chiusure o richiami)');
  }
  const bools = (o, keys) => keys.every((k) => o[k] === undefined || typeof o[k] === 'boolean');
  const s = c.sms, n = c.notifications;
  if ((s !== undefined && (typeof s !== 'object' || !s || !['android', 'iphone'].includes(s.channel ?? 'android')
      || !bools(s, ['enabled', 'confirm', 'reminder'])
      || ['confirmMsg', 'reminderMsg'].some((k) => s[k] !== undefined && (typeof s[k] !== 'string' || s[k].length > 480))))
    || (n !== undefined && (typeof n !== 'object' || !n || !bools(n, ['bookings', 'morning'])))) {
    fail(400, 'Impostazioni non valide (SMS o notifiche)');
  }
  return c;
}

// Vercel's edge sets these headers itself, clients cannot spoof them.
export const clientIp = (req) => String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();

// Fails with 429 once `max` hits for `key` fall inside the last `minutes`.
export async function limit(sql, key, max, minutes) {
  const [r] = await sql`SELECT count(*)::int AS n FROM hits WHERE key = ${key} AND at > now() - make_interval(mins => ${minutes})`;
  if (r.n >= max) fail(429, `Troppi tentativi, riprova tra ${minutes} minuti`);
}
export const hit = (sql, key) => sql.transaction([
  sql`INSERT INTO hits (key) VALUES (${key})`,
  sql`DELETE FROM hits WHERE at < now() - interval '1 day'`,
]);

// ADMIN_PASSWORD signs cookies and secret links, and is the login of salon 1 (the single-salon install).
const sign = (v) => createHmac('sha256', process.env.ADMIN_PASSWORD).update(v).digest('base64url');
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const COOKIE = 'sp_session';
const MAX_AGE = 30 * 86400;
export const CLEAR_COOKIE = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export const requirePasswordSet = () => {
  if ((process.env.ADMIN_PASSWORD || '').length < 10) fail(503, 'Imposta ADMIN_PASSWORD (almeno 10 caratteri) nelle variabili d\'ambiente Vercel', 'password');
};

export function checkPassword(pw) {
  requirePasswordSet();
  return typeof pw === 'string' && same(sign('pw:' + pw), sign('pw:' + process.env.ADMIN_PASSWORD));
}

// ---------- Accounts: one person (email) can work in a salon as 'owner' or 'staff' ----------
const scrypt = promisify(scryptCb);
const hashPassword = async (pw) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${(await scrypt(pw, salt, 32)).toString('hex')}`; };
// Always runs scrypt, also for an unknown email, so the answer time does not tell which emails exist.
export async function checkUserPassword(pw, stored = 'x:') {
  const [salt, hash] = stored.split(':');
  const got = (await scrypt(String(pw ?? ''), salt, 32)).toString('hex');
  return typeof pw === 'string' && same(got, hash);
}
// Name, email and password from a form, validated, password hashed.
export async function newUser(b) {
  const name = String(b.name || '').trim(), email = String(b.email || '').trim().toLowerCase(), pw = b.password;
  if (name.length < 2 || name.length > 80) fail(400, 'Scrivi nome e cognome');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) fail(400, 'Email non valida');
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) fail(400, 'La password deve avere almeno 8 caratteri');
  return { name, email, pw: await hashPassword(pw) };
}
// Whoever runs the service: emails in PLATFORM_ADMINS (comma separated) see the salons panel.
export const isPlatformAdmin = (email) => Boolean(email) && (process.env.PLATFORM_ADMINS || '').toLowerCase().split(',').map((s) => s.trim()).includes(email);

// The session epoch lives in the DB, one per salon: bumping it ("Esci da tutti i dispositivi") invalidates every
// cookie and secret link of that salon.
export const sessionEpoch = async (sql, salon) => Number((await sql`SELECT data->>'epoch' AS e FROM docs WHERE salon = ${salon} AND col = 'auth' AND id = 1`)[0]?.e || 0);
export const bumpEpoch = (sql, salon) => sql`INSERT INTO docs (salon, col, id, data) VALUES (${salon}, 'auth', 1, '{"epoch":1}')
  ON CONFLICT (salon, col, id) DO UPDATE SET data = jsonb_build_object('epoch', (docs.data->>'epoch')::int + 1)`;

// Secret links for apps that cannot log in. `purpose` keeps the links apart: 'ics' = calendar feed, 'sms' = the
// iPhone Shortcut that sends the SMS. Salon 1 keeps the single-salon token and no `s`, so links already in use work.
const linkSign = (purpose, salon, epoch) => { requirePasswordSet(); return sign(salon === 1 ? `${purpose}:${epoch}` : `${purpose}:${salon}:${epoch}`); };
export const linkQuery = (purpose, salon, epoch) => `k=${linkSign(purpose, salon, epoch)}${salon === 1 ? '' : `&s=${salon}`}`;
// The salon a secret link opens, or 0 when the link is wrong or revoked.
export async function linkSalon(sql, purpose, query) {
  const salon = Number(query.s ?? 1);
  if (!Number.isSafeInteger(salon) || salon < 1 || typeof query.k !== 'string') return 0;
  return same(query.k, linkSign(purpose, salon, await sessionEpoch(sql, salon))) ? salon : 0;
}

// Cookie: expiry.epoch.user.salon.signature. Cookies from the single-salon version (expiry.epoch.signature) are the
// shared password of salon 1, user 0.
export function sessionCookie(epoch, user = 0, salon = 1) {
  const payload = `${Date.now() + MAX_AGE * 1000}.${epoch}.${user}.${salon}`;
  return `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

// Who is calling: { salon, user, role, name, email, slug, status, trialEnd }. 401 without a valid session, 402 when
// the salon is closed (trial over or suspended), 403 for staff on owner-only actions.
// `platform`: the salons panel, only for PLATFORM_ADMINS, also while their own salon is closed.
export async function requireAdmin(req, sql, { owner = false, platform = false } = {}) {
  requirePasswordSet();
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([\\d.]+)\\.([\\w-]+)`).exec(req.headers.cookie || '');
  const p = m ? m[1].split('.').map(Number) : [];
  const [exp, epoch, user, salon] = p.length === 2 ? [...p, 0, 1] : p;
  if (!m || ![2, 4].includes(p.length) || exp < Date.now() || !same(m[2], sign(m[1]))) fail(401, 'Accesso richiesto');
  const [s] = await sql`SELECT s.slug, s.status, s.trial_end::text AS trial_end, u.name, u.email,
      (SELECT data->>'epoch' FROM docs WHERE salon = s.id AND col = 'auth' AND id = 1) AS epoch,
      (SELECT role FROM members WHERE user_id = ${user} AND salon = s.id) AS role
    FROM salons s LEFT JOIN users u ON u.id = ${user} WHERE s.id = ${salon}`;
  const role = user === 0 && salon === 1 ? 'owner' : s?.role; // a removed collaborator loses access at once
  if (!s || !role || Number(s.epoch || 0) !== epoch) fail(401, 'Accesso richiesto');
  const me = { salon, user, role, name: s.name, email: s.email, slug: s.slug, status: s.status, trialEnd: s.trial_end };
  if (platform) return isPlatformAdmin(s.email) ? me : fail(403, 'Riservato a chi gestisce Salone PRO');
  if (!salonOpen(s)) fail(402, s.status === 'suspended' ? 'Il salone è sospeso' : 'La prova gratuita è finita', 'closed');
  if (owner && role !== 'owner') fail(403, 'Solo il titolare può farlo');
  return me;
}
