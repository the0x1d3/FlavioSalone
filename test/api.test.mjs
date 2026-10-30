// Runs the real API handlers against an in-memory Postgres (PGlite). `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const fake = new URL('./fake-neon.mjs', import.meta.url).href;
registerHooks({ resolve: (s, c, next) => (s === '@neondatabase/serverless' ? { url: fake, shortCircuit: true } : next(s, c)) });
process.env.DATABASE_URL = 'pglite://memory';
process.env.ADMIN_PASSWORD = 'password-di-prova-123';

const { default: login } = await import('../api/login.js');
const { default: data } = await import('../api/data.js');
const { default: pub } = await import('../api/public.js');
const { default: calendar } = await import('../api/calendar.js');
const { romeNow } = await import('../api/_lib.js');

function call(handler, { method = 'GET', query = {}, body, cookie, ip = '10.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      send(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    handler({ method, query, body, headers: { cookie, 'x-real-ip': ip, host: 'salone.test' } }, res);
  });
}

function nextWeekday(day) {
  const d = new Date(romeNow().date + 'T12:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== day);
  return d.toISOString().slice(0, 10);
}

let cookie;
const wed = nextWeekday(3);
let n = 0; // every booking from its own IP so the per-IP limit does not interfere
const book = (o) => call(pub, { method: 'POST', ip: `10.1.0.${n++}`, body: { name: 'Mario Lanza', phone: '333 111 2222', serviceIds: [1], date: wed, privacy: true, ...o } });

test('admin API needs login', async () => {
  assert.equal((await call(data)).status, 401);
  assert.equal((await call(login, { method: 'POST', body: { password: 'sbagliata' } })).status, 401);
  const ok = await call(login, { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } });
  assert.equal(ok.status, 200);
  cookie = ok.headers['set-cookie'].split(';')[0];
  assert.equal((await call(data, { cookie: 'sp_session=9999999999999.0.forged' })).status, 401);
});

test('first run seeds config and price list', async () => {
  const r = await call(data, { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.body.services.length, 8);
  assert.deepEqual(r.body.config.serviceFolders, ['PIEGA', 'TAGLIO', 'COLORE & TECNICI', 'TRATTAMENTI']);
  assert.equal(r.body.config.onboarded, undefined); // a new salon gets the guided setup
  assert.deepEqual(r.body.config.closedDays, [0, 1]);
});

test('public booking: overlaps, hours, closed days', async () => {
  assert.equal((await book({ time: '10:00', serviceIds: [6] })).status, 200); // Balayage, 90 min -> 11:30
  assert.equal((await book({ time: '11:00' })).status, 409);
  assert.equal((await book({ time: '09:30', serviceIds: [4] })).status, 409); // 09:30-10:30 overlaps
  assert.equal((await book({ time: '11:30' })).status, 200); // touching is fine
  assert.equal((await book({ time: '18:30', serviceIds: [4] })).status, 400); // ends after 19:00
  assert.equal((await book({ time: '10:00', date: nextWeekday(0) })).status, 400); // Sunday closed
  assert.equal((await book({ time: '10:00', date: '2020-01-01' })).status, 400);
  assert.equal((await book({ time: '15:00', privacy: false })).status, 400);
  assert.equal((await book({ time: '15:00', website: 'spam' })).status, 200); // honeypot: fake success

  const r = await call(pub, { query: { date: wed } });
  assert.deepEqual(r.body.busy.map((b) => b.time + '-' + b.end).sort(), ['10:00-11:30', '11:30-12:00']);
  assert.ok(!JSON.stringify(r.body).includes('Lanza'), 'public API must not leak names');

  const all = (await call(data, { cookie })).body;
  assert.equal(all.appointments.length, 2);
  assert.equal(all.clients.filter((c) => c.name === 'Mario Lanza').length, 1, 'same phone = same client');
  assert.equal(all.appointments[0].price, 65);
});

test('restore: bad backup changes nothing, v6 backup gets durations', async () => {
  assert.equal((await call(data, { method: 'POST', cookie, body: { config: {}, clients: [{ name: 'no id' }] } })).status, 400);
  assert.equal((await call(data, { cookie })).body.appointments.length, 2);

  const v6 = {
    config: { salonName: 'Salone Donna & Style', openTime: '09:00', closeTime: '19:00' },
    services: [{ id: 4, name: 'Colore Ricrescita', price: 30, duration: 45 }],
    clients: [{ id: 101, name: 'Elena Rizzo', phone: '3331122334' }],
    inventory: [],
    appointments: [{ id: 301, clientId: 101, clientName: 'Elena Rizzo', date: wed, time: '15:00', services: ['Colore Ricrescita'], price: 30 }],
  };
  assert.equal((await call(data, { method: 'POST', cookie, body: v6 })).status, 200);
  const all = (await call(data, { cookie })).body;
  assert.equal(all.config.salonName, 'Salone Donna & Style');
  assert.equal(all.config.slotMinutes, 30); // missing fields fall back to defaults
  assert.equal(all.appointments[0].end, '15:45');
  assert.equal((await book({ time: '15:30', serviceIds: [4] })).status, 409);
});

test('admin PUT and DELETE', async () => {
  const item = { id: 999, clientName: 'Test', date: wed, time: '17:00', duration: 60, services: [], price: 10 };
  const put = await call(data, { method: 'PUT', cookie, body: { col: 'appointments', item } });
  assert.equal(put.body.item.end, '18:00');
  assert.equal((await call(data, { method: 'PUT', cookie, body: { col: 'hack', item } })).status, 400);
  assert.equal((await call(data, { method: 'DELETE', cookie, query: { col: 'appointments', id: '999' } })).status, 200);
  assert.ok(!(await call(data, { cookie })).body.appointments.some((a) => a.id === 999));
});

test('settings are validated before reaching the public page', async () => {
  const bad = { ...(await call(data, { cookie })).body.config, openTime: '<img src=x onerror=alert(1)>' };
  assert.equal((await call(data, { method: 'PUT', cookie, body: { col: 'config', item: bad } })).status, 400);
  assert.equal((await call(data, { method: 'POST', cookie, body: { config: { closedDays: [9] } } })).status, 400);
});

test('login: 5 wrong passwords per IP, then blocked for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call(login, { method: 'POST', ip: '6.6.6.6', body: { password: 'x' + i } })).status, 401);
  assert.equal((await call(login, { method: 'POST', ip: '6.6.6.6', body: { password: process.env.ADMIN_PASSWORD } })).status, 429);
  assert.equal((await call(login, { method: 'POST', ip: '7.7.7.7', body: { password: process.env.ADMIN_PASSWORD } })).status, 200);
});

test('public bookings: max 10 attempts per IP per hour', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call(pub, { method: 'POST', ip: '8.8.8.8', body: { privacy: false } })).status, 400);
  assert.equal((await call(pub, { method: 'POST', ip: '8.8.8.8', body: { privacy: false } })).status, 429);
});

test('logout from all devices revokes every cookie, also after a restore', async () => {
  const other = (await call(login, { method: 'POST', ip: '9.9.9.9', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  assert.equal((await call(data, { cookie: other })).status, 200);
  assert.equal((await call(login, { method: 'DELETE', query: { all: '1' }, cookie })).status, 200);
  assert.equal((await call(data, { cookie })).status, 401);
  assert.equal((await call(data, { cookie: other })).status, 401);
  assert.equal((await call(login, { method: 'DELETE', query: { all: '1' } })).status, 401); // needs a valid session

  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.9', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const backup = (await call(data, { cookie: fresh })).body;
  assert.equal((await call(data, { method: 'POST', cookie: fresh, body: backup })).status, 200);
  assert.equal((await call(data, { cookie })).status, 401, 'restore must not bring old sessions back');
  assert.equal((await call(data, { cookie: fresh })).status, 200);
});

test('price-list folders: validated, public, restored from v9 backups', async () => {
  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.8', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const config = (await call(data, { cookie: fresh })).body.config;
  assert.equal((await call(data, { method: 'PUT', cookie: fresh, body: { col: 'config', item: { ...config, serviceFolders: ['PIEGA', 42] } } })).status, 400);
  assert.equal((await call(data, { method: 'PUT', cookie: fresh, body: { col: 'config', item: { ...config, serviceFolders: ['PIEGA', 'SPOSA'] } } })).status, 200);
  assert.deepEqual((await call(pub)).body.config.serviceFolders, ['PIEGA', 'SPOSA']);

  const v9 = { // shape of a salone_pro_v9.html backup
    config: { salonName: 'Salone v9', openTime: '09:00', closeTime: '19:00', slotMinutes: 30 },
    serviceFolders: ['PIEGA', 'TAGLIO', 'VUOTA'],
    services: [{ id: 1, name: 'Piega Classica', cat: 'PIEGA', price: 18, duration: 30 }],
    clients: [],
    inventory: [],
    appointments: [{ id: 5, clientName: 'Anna', date: wed, time: '10:00', services: ['Piega Classica'], price: 18, reminderSent: true, lastAttemptChannel: 'WhatsApp' }],
  };
  assert.equal((await call(data, { method: 'POST', cookie: fresh, body: v9 })).status, 200);
  const all = (await call(data, { cookie: fresh })).body;
  assert.deepEqual(all.config.serviceFolders, ['PIEGA', 'TAGLIO', 'VUOTA']);
  assert.equal(all.appointments[0].reminderSent, true);
  assert.equal(all.appointments[0].end, '10:30');
});

test('missing Vercel setup returns a hint, not a crash', async () => {
  const url = process.env.DATABASE_URL, pw = process.env.ADMIN_PASSWORD;
  delete process.env.DATABASE_URL;
  const noDb = await call(pub);
  assert.equal(noDb.status, 503);
  assert.equal(noDb.body.setup, 'database');
  process.env.DATABASE_URL = url;

  process.env.ADMIN_PASSWORD = 'corta';
  assert.equal((await call(data)).body.setup, 'password');
  assert.equal((await call(login, { method: 'POST', ip: '5.5.5.5', body: { password: 'corta' } })).body.setup, 'password');
  process.env.ADMIN_PASSWORD = pw;
});

test('daily breaks and closures block online bookings', async () => {
  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.7', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const config = (await call(data, { cookie: fresh })).body.config;
  assert.equal(config.recallWeeks, 6); // default for salons created before this setting existed
  const put = (item) => call(data, { method: 'PUT', cookie: fresh, body: { col: 'config', item } });
  assert.equal((await put({ ...config, breaks: [{ from: '15:00', to: '13:00' }] })).status, 400);
  assert.equal((await put({ ...config, closures: [{ from: '2026-08-20', to: '2026-08-10' }] })).status, 400);
  assert.equal((await put({ ...config, recallWeeks: 99 })).status, 400);

  const thu = nextWeekday(4);
  assert.equal((await put({ ...config, breaks: [{ from: '13:00', to: '15:00' }], closures: [{ from: thu, to: thu, note: 'Ferie' }] })).status, 200);
  const day = await call(pub, { query: { date: wed } });
  assert.ok(day.body.busy.some((b) => b.time === '13:00' && b.end === '15:00'), 'break sent as busy time');
  assert.equal(day.body.config.closures[0].note, 'Ferie');

  assert.equal((await book({ time: '12:45' })).status, 400); // 12:45-13:15 runs into the break
  const closed = await book({ time: '10:00', date: thu });
  assert.equal(closed.status, 400);
  assert.match(closed.body.error, /Ferie/);
  assert.equal((await book({ time: '15:00' })).status, 200); // right after the break
});

test('client photos: private, validated, outside the main load and the backup', async () => {
  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.6', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const img = 'data:image/jpeg;base64,' + 'A'.repeat(1000);
  const put = (item) => call(data, { method: 'PUT', cookie: fresh, body: { col: 'photos', item: { id: 1, clientId: 101, date: wed, img, ...item } } });
  assert.equal((await put({ img: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400); // only JPEG
  assert.equal((await put({ img: 'data:image/jpeg;base64,' + 'A'.repeat(300000) })).status, 400); // too big
  assert.equal((await put({ clientId: 'x' })).status, 400);
  assert.equal((await put({ note: 'Prima del colore' })).status, 200);
  assert.equal((await put({ id: 2 })).status, 200);
  assert.equal((await call(data, { query: { photos: '101' } })).status, 401);

  const got = (await call(data, { cookie: fresh, query: { photos: '101' } })).body.photos;
  assert.deepEqual(got.map((p) => p.id), [2, 1]); // newest first
  assert.equal(got[1].note, 'Prima del colore');
  const all = (await call(data, { cookie: fresh })).body;
  assert.ok(!JSON.stringify(all).includes(img), 'photos stay out of the main load');

  assert.equal((await call(data, { method: 'POST', cookie: fresh, body: all })).status, 200);
  assert.equal((await call(data, { cookie: fresh, query: { photos: '101' } })).body.photos.length, 2, 'restore keeps photos');
  assert.equal((await call(data, { method: 'DELETE', cookie: fresh, query: { col: 'photos', id: '2' } })).status, 200);
  assert.equal((await call(data, { cookie: fresh, query: { photos: '101' } })).body.photos.length, 1);
  assert.equal((await call(data, { method: 'DELETE', cookie: fresh, query: { col: 'clients', id: '999' } })).status, 200); // other client
  assert.equal((await call(data, { cookie: fresh, query: { photos: '101' } })).body.photos.length, 1);
  assert.equal((await call(data, { method: 'DELETE', cookie: fresh, query: { col: 'clients', id: '101' } })).status, 200);
  assert.equal((await call(data, { cookie: fresh, query: { photos: '101' } })).body.photos.length, 0, 'deleting the client deletes the photos');
});

test('new web bookings check: counts only web bookings after the given id', async () => {
  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.5', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const check = (newweb) => call(data, { cookie: fresh, query: { newweb } });
  assert.equal((await call(data, { query: { newweb: '0' } })).status, 401);
  assert.equal((await check('abc')).status, 400);
  const web = (await call(data, { cookie: fresh })).body.appointments.filter((a) => a.source === 'web');
  const last = Math.max(0, ...web.map((a) => a.id));
  assert.equal((await check(String(last))).body.n, 0);
  await call(data, { method: 'PUT', cookie: fresh, body: { col: 'appointments', item: { id: last + 10 ** 9, clientName: 'Banco', date: wed, time: '18:00', services: [], price: 0 } } });
  assert.equal((await check(String(last))).body.n, 0, 'bookings made in the salon do not count');
  assert.equal((await book({ time: '16:00' })).status, 200);
  assert.equal((await check(String(last))).body.n, 1);
});

test('calendar feed: secret link, Italian time, escaped text, revoked by logout-all', async () => {
  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.4', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  assert.equal((await call(data, { query: { calendar: '' } })).status, 401);
  const link = new URL((await call(data, { cookie: fresh, query: { calendar: '' } })).body.url);
  assert.equal(link.pathname, '/api/calendar');
  assert.equal(link.searchParams.get('s'), null, 'salon 1 keeps the links made before multi-salon');
  const token = link.searchParams.get('k');
  assert.equal((await call(calendar, { query: { k: 'sbagliato' } })).status, 401);
  assert.equal((await call(calendar, {})).status, 401);

  await call(data, { method: 'PUT', cookie: fresh, body: { col: 'appointments', item: { id: 777, clientName: 'Anna, Bianchi', phone: '333 1', date: wed, time: '09:30', duration: 45, services: ['Piega; Onde'], price: 20, notes: 'riga 1\nriga 2' } } });
  const ics = await call(calendar, { query: { k: token } });
  assert.equal(ics.status, 200);
  assert.match(ics.headers['content-type'], /text\/calendar/);
  const body = ics.body.replace(/\r\n /g, ''); // undo line folding
  assert.ok(ics.body.endsWith('END:VCALENDAR\r\n'));
  assert.ok(ics.body.split('\r\n').every((l) => l.length <= 75), 'lines folded');
  assert.ok(body.includes(`DTSTART;TZID=Europe/Rome:${wed.replace(/-/g, '')}T093000`));
  assert.ok(body.includes(`DTEND;TZID=Europe/Rome:${wed.replace(/-/g, '')}T101500`));
  assert.ok(body.includes('SUMMARY:Anna\\, Bianchi: Piega\\; Onde'));
  assert.ok(body.includes('DESCRIPTION:Tel. 333 1\\nriga 1\\nriga 2'));

  assert.equal((await call(login, { method: 'DELETE', query: { all: '1' }, cookie: fresh })).status, 200);
  assert.equal((await call(calendar, { query: { k: token } })).status, 401, 'old link stops working');
});

test('bulk save and bulk delete (CSV import, multiple selection)', async () => {
  const fresh = (await call(login, { method: 'POST', ip: '9.9.9.3', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const put = (body) => call(data, { method: 'PUT', cookie: fresh, body });
  const items = [1, 2, 3].map((i) => ({ id: 5000 + i, name: 'Import ' + i, phone: '' }));
  assert.equal((await put({ col: 'clients', items: [...items, items[0]] })).status, 400); // same id twice
  assert.equal((await put({ col: 'config', items: [{ id: 1 }] })).status, 400);
  assert.equal((await put({ col: 'clients', items: [] })).status, 400);
  assert.equal((await put({ col: 'clients', items })).body.count, 3);
  await put({ col: 'photos', item: { id: 9, clientId: 5001, date: wed, img: 'data:image/jpeg;base64,AAAA' } });

  const del = (query) => call(data, { method: 'DELETE', cookie: fresh, query: { col: 'clients', ...query } });
  assert.equal((await del({})).status, 400, 'no id: nothing deleted');
  assert.equal((await del({ ids: '5001,x' })).status, 400);
  assert.equal((await del({ ids: '5001,5002' })).status, 200);
  const names = (await call(data, { cookie: fresh })).body.clients.map((c) => c.name);
  assert.ok(names.includes('Import 3') && !names.includes('Import 1') && !names.includes('Import 2'));
  assert.equal((await call(data, { cookie: fresh, query: { photos: '5001' } })).body.photos.length, 0, 'their photos go too');
});

test('booking page: calendar file for the client, built from the price list', async () => {
  assert.equal((await call(pub, { query: { ics: '1', date: wed, time: '25:00', s: '4' } })).status, 400);
  assert.equal((await call(pub, { query: { ics: '1', date: wed, time: '10:00', s: '999' } })).status, 400); // unknown service
  const r = await call(pub, { query: { ics: '1', date: wed, time: '10:00', s: '1,999' } }); // the v9 restore left only "Piega Classica"
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/calendar/);
  const body = r.body.replace(/\r\n /g, '');
  assert.ok(body.includes(`DTEND;TZID=Europe/Rome:${wed.replace(/-/g, '')}T103000`)); // 30 min from the price list
  assert.ok(body.includes('SUMMARY:Appuntamento da '));
  assert.ok(body.includes('DESCRIPTION:Servizi: Piega Classica\\nTotale indicativo: € 18'));
  assert.ok(body.includes('BEGIN:VALARM\r\nTRIGGER:-PT120M'), 'reminder 2 hours before');
  assert.ok(!body.includes('X-WR-CALNAME'), 'a single event, not a calendar to subscribe');
});
