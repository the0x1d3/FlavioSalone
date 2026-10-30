// Several salons on one database: the move from the single-salon version, sign-up, accounts, isolation, the salons
// panel. Real API handlers on an in-memory Postgres (PGlite). `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHmac } from 'node:crypto';

const fake = new URL('./fake-neon.mjs', import.meta.url).href;
registerHooks({ resolve: (s, c, next) => (s === '@neondatabase/serverless' ? { url: fake, shortCircuit: true } : next(s, c)) });
process.env.DATABASE_URL = 'pglite://memory';
process.env.ADMIN_PASSWORD = 'password-di-prova-123';
const sign = (v) => createHmac('sha256', process.env.ADMIN_PASSWORD).update(v).digest('base64url');

const { neon } = await import('./fake-neon.mjs');
const { romeNow } = await import('../api/_lib.js');
const wed = (() => { const d = new Date(romeNow().date + 'T12:00:00Z'); do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== 3); return d.toISOString().slice(0, 10); })();

// A database as the single-salon version left it, before any new code touches it.
const raw = neon();
await raw`CREATE TABLE docs (col text NOT NULL, id bigint NOT NULL, data jsonb NOT NULL, PRIMARY KEY (col, id))`;
await raw`CREATE INDEX docs_appt_date ON docs ((data->>'date')) WHERE col = 'appointments'`;
await raw`INSERT INTO docs (col, id, data) VALUES
  ('config', 1, '{"salonName":"Salone di Flavio","openTime":"09:00","closeTime":"19:00","slotMinutes":30,"closedDays":[0,1]}'),
  ('services', 1, '{"id":1,"name":"Piega Classica","cat":"PIEGA","price":18,"duration":30}'),
  ('auth', 1, '{"epoch":2}'),
  ('appointments', 500, ${JSON.stringify({ id: 500, clientName: 'Cliente Flavio', date: wed, time: '10:00', end: '10:30', duration: 30, services: ['Piega Classica'], price: 18 })})`;

const handlers = Object.fromEntries(await Promise.all(['login', 'signup', 'data', 'public', 'calendar', 'team', 'admin', 'notify', 'cron']
  .map(async (n) => [n, (await import(`../api/${n}.js`)).default])));
const { login, signup, data, public: pub, calendar, team, admin, notify, cron } = handlers;

function call(handler, { method = 'GET', query = {}, body, cookie, ip = '10.0.0.1', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      send(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    handler({ method, query, body, headers: { cookie, 'x-real-ip': ip, host: 'salone.test', ...headers } }, res);
  });
}
const cookieOf = (r) => r.headers['set-cookie'].split(';')[0];
let n = 0;
const enter = async (email, password) => cookieOf(await call(login, { method: 'POST', ip: `30.0.0.${n++}`, body: { email, password } }));

// Cookie of the single-salon version: expiry.epoch.signature, made with the shared password.
const oldPayload = `${Date.now() + 864e5}.2`;
const legacy = `sp_session=${oldPayload}.${sign(oldPayload)}`;

test('the single-salon database becomes salon 1: data, open sessions and links keep working', async () => {
  const r = await call(data, { cookie: legacy });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.salonName, 'Salone di Flavio');
  assert.deepEqual(r.body.appointments.map((a) => a.id), [500]);
  assert.equal(r.body.services.length, 1, 'the price list is not seeded again');
  assert.deepEqual([r.body.account.salon, r.body.account.role, r.body.account.status], [1, 'owner', 'active']);
  assert.equal((await call(calendar, { query: { k: sign('ics:2') } })).status, 200, 'calendar subscription made before');
  const page = await call(pub, { query: { date: wed } }); // plain /prenota
  assert.equal(page.body.config.salonName, 'Salone di Flavio');
  assert.deepEqual(page.body.busy, [{ time: '10:00', end: '10:30' }]);
  assert.equal((await call(login, { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } })).status, 200, 'the shared password still opens salon 1');
});

let owner2, salon2;
test('sign-up: a salon in free trial, with its price list and booking address', async () => {
  const body = { salonName: 'Studio Bellèzza', name: 'Anna Neri', email: 'Anna@Esempio.it', password: 'password-anna' };
  assert.equal((await call(signup, { method: 'POST', ip: '20.0.0.1', body: { ...body, password: 'corta' } })).status, 400);
  assert.equal((await call(signup, { method: 'POST', ip: '20.0.0.1', body: { ...body, salonName: '' } })).status, 400);
  const r = await call(signup, { method: 'POST', ip: '20.0.0.1', body });
  assert.equal(r.status, 200);
  assert.equal(r.body.slug, 'studio-bellezza');
  owner2 = cookieOf(r);
  const all = (await call(data, { cookie: owner2 })).body;
  assert.equal(all.config.salonName, 'Studio Bellèzza');
  assert.equal(all.config.ownerName, 'Anna Neri');
  assert.equal(all.services.length, 8);
  assert.equal(all.appointments.length, 0, 'nothing from salon 1');
  assert.equal(all.config.onboarded, false, 'the guided setup opens');
  assert.equal(all.account.role, 'owner');
  assert.equal(all.account.status, 'trial');
  assert.ok(all.account.trialEnd > romeNow().date);
  salon2 = all.account.salon;
  assert.notEqual(salon2, 1);

  assert.equal((await call(signup, { method: 'POST', ip: '20.0.0.2', body })).status, 409, 'same email');
  const twin = await call(signup, { method: 'POST', ip: '20.0.0.2', body: { ...body, email: 'altro@esempio.it' } });
  assert.equal(twin.body.slug, 'studio-bellezza-2', 'same name, next address');
});

test('login with email and password', async () => {
  assert.equal((await call(login, { method: 'POST', ip: '20.0.1.1', body: { email: 'anna@esempio.it', password: 'sbagliata' } })).status, 401);
  assert.equal((await call(login, { method: 'POST', ip: '20.0.1.1', body: { email: 'nessuno@esempio.it', password: 'password-anna' } })).status, 401);
  const again = await enter(' ANNA@esempio.it ', 'password-anna');
  assert.equal((await call(data, { cookie: again })).body.account.salon, salon2);
  const forged = again.replace(/\.(\d+)\.([\w-]+)$/, '.1.$2'); // same signature, salon 1
  assert.equal((await call(data, { cookie: forged })).status, 401);
});

test('salons never see or touch each other\'s data', async () => {
  const item = { id: 500, clientName: 'Cliente Anna', date: wed, time: '15:00', duration: 30, services: [], price: 10 };
  assert.equal((await call(data, { method: 'PUT', cookie: owner2, body: { col: 'appointments', item } })).status, 200); // same id as salon 1's
  assert.equal((await call(data, { cookie: legacy })).body.appointments.find((a) => a.id === 500).clientName, 'Cliente Flavio');
  await call(data, { method: 'DELETE', cookie: owner2, query: { col: 'appointments', id: '500' } });
  assert.ok((await call(data, { cookie: legacy })).body.appointments.some((a) => a.id === 500), 'a delete stays in its salon');

  // Booking page /prenota/studio-bellezza: 10:00 is taken in salon 1, free in salon 2.
  const book = (salon) => call(pub, { method: 'POST', ip: `20.0.2.${n++}`, query: { salon }, body: { name: 'Lia Web', phone: '333 555 1111', serviceIds: [1], date: wed, time: '10:00', privacy: true } });
  assert.equal((await book(undefined)).status, 409);
  assert.equal((await book('studio-bellezza')).status, 200);
  assert.ok((await call(data, { cookie: owner2 })).body.appointments.some((a) => a.clientName === 'Lia Web'));
  assert.ok(!(await call(data, { cookie: legacy })).body.appointments.some((a) => a.clientName === 'Lia Web'));
  assert.equal((await call(data, { cookie: owner2, query: { newweb: '0' } })).body.n, 1);
  assert.equal((await call(pub, { query: { salon: 'non-esiste' } })).status, 404);
  assert.equal((await call(pub, { query: { salon: 'studio-bellezza' } })).body.config.salonName, 'Studio Bellèzza');

  const link = new URL((await call(data, { cookie: owner2, query: { calendar: '' } })).body.url);
  assert.equal(link.searchParams.get('s'), String(salon2));
  const feed = (await call(calendar, { query: Object.fromEntries(link.searchParams) })).body;
  assert.ok(feed.includes('Lia Web') && !feed.includes('Cliente Flavio'));
  assert.equal((await call(calendar, { query: { k: link.searchParams.get('k') } })).status, 401, 'salon 2\'s token does not open salon 1');
  assert.equal((await call(calendar, { query: { k: sign('ics:2'), s: String(salon2) } })).status, 401, 'salon 1\'s token does not open salon 2');
  const sms = new URL((await call(notify, { cookie: owner2 })).body.shortcutUrl);
  assert.equal(sms.searchParams.get('s'), String(salon2));
});

let staff;
test('collaborators: own login, no settings, removed at once', async () => {
  const add = (body) => call(team, { method: 'POST', cookie: owner2, body });
  assert.equal((await add({ name: 'Bea Rossi', email: 'bea@esempio.it', password: 'x' })).status, 400);
  assert.equal((await add({ name: 'Bea Rossi', email: 'bea@esempio.it', password: 'password-bea' })).status, 200);
  assert.equal((await add({ name: 'Bea Rossi', email: 'bea@esempio.it', password: 'password-bea' })).status, 409);
  staff = await enter('bea@esempio.it', 'password-bea');
  const all = (await call(data, { cookie: staff })).body;
  assert.deepEqual([all.account.salon, all.account.role], [salon2, 'staff']);
  assert.equal((await call(data, { method: 'PUT', cookie: staff, body: { col: 'appointments', item: { id: 600, clientName: 'Da Bea', date: wed, time: '12:00', services: [], price: 0 } } })).status, 200);
  for (const [h, opts] of [[data, { method: 'PUT', body: { col: 'config', item: all.config } }], [data, { method: 'POST', body: all }],
    [data, { query: { calendar: '' } }], [team, {}], [notify, {}], [login, { method: 'DELETE', query: { all: '1' } }], [admin, {}]]) {
    assert.equal((await call(h, { cookie: staff, ...opts })).status, 403);
  }
  const members = (await call(team, { cookie: owner2 })).body.members;
  assert.deepEqual(members.map((m) => [m.name, m.role]), [['Anna Neri', 'owner'], ['Bea Rossi', 'staff']]);
  assert.equal((await call(team, { method: 'DELETE', cookie: owner2, query: { id: String(members[0].id) } })).body.removed, 0, 'the owner stays');
  assert.equal((await call(team, { method: 'DELETE', cookie: owner2, query: { id: String(members[1].id) } })).body.removed, 1);
  assert.equal((await call(data, { cookie: staff })).status, 401);
  assert.equal((await call(login, { method: 'POST', ip: '20.0.3.2', body: { email: 'bea@esempio.it', password: 'password-bea' } })).status, 401);
});

test('salons panel: only for PLATFORM_ADMINS, payments by hand', async () => {
  assert.equal((await call(admin, { cookie: owner2 })).status, 403);
  process.env.PLATFORM_ADMINS = 'gestore@salonepro.it, anna@esempio.it';
  assert.equal((await call(data, { cookie: owner2 })).body.account.platformAdmin, true);
  const list = (await call(admin, { cookie: owner2 })).body.salons;
  const mine = list.find((s) => s.id === salon2), twin = list.find((s) => s.slug === 'studio-bellezza-2');
  assert.deepEqual([mine.name, mine.owner, mine.status, mine.accounts], ['Studio Bellèzza', 'anna@esempio.it', 'trial', 1]);
  assert.equal(list.find((s) => s.id === 1).name, 'Salone di Flavio');

  const set = (body) => call(admin, { method: 'POST', cookie: owner2, body });
  const owner3 = await enter('altro@esempio.it', 'password-anna');
  assert.equal((await set({ id: twin.id, status: 'boh' })).status, 400);
  assert.equal((await set({ id: twin.id, status: 'trial' })).status, 400, 'a trial needs its end');
  assert.equal((await set({ id: twin.id, status: 'suspended' })).status, 200);
  const closed = await call(data, { cookie: owner3 });
  assert.deepEqual([closed.status, closed.body.setup], [402, 'closed']);
  assert.equal((await call(pub, { query: { salon: 'studio-bellezza-2' } })).status, 404, 'no online bookings');
  assert.equal((await set({ id: twin.id, status: 'trial', trialEnd: '2020-01-01' })).status, 200);
  assert.equal((await call(data, { cookie: owner3 })).status, 402, 'trial over');

  process.env.CRON_SECRET = 'segreto-cron-di-prova';
  const morning = () => call(cron, { headers: { authorization: 'Bearer segreto-cron-di-prova' } });
  assert.equal((await morning()).body.salons, 2, 'closed salons skipped');
  assert.equal((await set({ id: twin.id, status: 'active', trialEnd: null })).status, 200);
  assert.equal((await call(data, { cookie: owner3 })).status, 200);
  assert.equal((await morning()).body.salons, 3);
});

test('logout from all devices stays inside its salon', async () => {
  assert.equal((await call(login, { method: 'DELETE', query: { all: '1' }, cookie: owner2 })).status, 200);
  assert.equal((await call(data, { cookie: owner2 })).status, 401);
  assert.equal((await call(data, { cookie: legacy })).status, 200);
});
