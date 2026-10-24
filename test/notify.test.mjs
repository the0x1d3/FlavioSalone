// SMS to clients and push notifications, against an in-memory Postgres; the SMS gateway and the push service are fakes. `npm test`
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
const { default: notify } = await import('../api/notify.js');
const { default: cron } = await import('../api/cron.js');
const { normalizePhone, smsText, GATEWAY_URL } = await import('../api/_notify.js');
const { romeNow } = await import('../api/_lib.js');
const webpush = (await import('web-push')).default;

function call(handler, { method = 'GET', query = {}, body, cookie, ip = '10.0.0.1', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      status(c) { this.statusCode = c; return this; },
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    handler({ method, query, body, headers: { cookie, 'x-real-ip': ip, host: 'salone.test', ...headers } }, res);
  });
}

// Fake SMS gateway: records every request, answers with `gatewayStatus`.
const sent = [];
let gatewayStatus = 200;
globalThis.fetch = async (url, opts) => {
  sent.push({ url, auth: opts.headers.Authorization, body: JSON.parse(opts.body) });
  return { ok: gatewayStatus < 300, status: gatewayStatus };
};
const pushed = [];
webpush.sendNotification = async (sub, payload) => { pushed.push({ endpoint: sub.endpoint, ...JSON.parse(payload) }); return {}; };

const day = (n) => { const d = new Date(romeNow().date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const openDay = (() => { let n = 2; while ([0, 1].includes(new Date(day(n) + 'T12:00:00Z').getUTCDay())) n++; return day(n); })();
let cookie;
const admin = (opts) => call(opts.handler || data, { cookie, ...opts });
const smsRows = async () => (await call(notify, { cookie })).body.recent;
const config = async (patch) => {
  const c = (await admin({})).body.config;
  return admin({ method: 'PUT', body: { col: 'config', item: { ...c, id: 1, ...patch } } });
};

test('phone numbers and message text', () => {
  assert.equal(normalizePhone('333 123 4567'), '+393331234567');
  assert.equal(normalizePhone('0039 333 1234567'), '+393331234567');
  assert.equal(normalizePhone('+39 333-123-4567'), '+393331234567');
  assert.equal(normalizePhone('393331234567'), '+393331234567');
  assert.equal(normalizePhone('12'), '');
  const t = smsText('Ciao {cliente}! {giorno} alle {ora} da {salone}: {servizi}. {ignoto}', { clientName: 'Anna Bianchi', date: '2026-10-27', time: '10:00', services: ['Piega', 'Taglio'] }, { salonName: 'Salone X' });
  assert.equal(t, 'Ciao Anna! martedì 27 ottobre alle 10:00 da Salone X: Piega + Taglio. {ignoto}');
});

test('SMS off by default: bookings send nothing', async () => {
  cookie = (await call(login, { method: 'POST', body: { password: process.env.ADMIN_PASSWORD } })).headers['set-cookie'].split(';')[0];
  const r = await call(pub, { method: 'POST', ip: '2.0.0.1', body: { name: 'Anna Bianchi', phone: '333 111 0001', serviceIds: [1], date: openDay, time: '10:00', privacy: true } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 0);
  assert.equal((await smsRows()).length, 0);
});

test('Android gateway: confirmation SMS for online and salon bookings, once', async () => {
  assert.equal((await config({ ownerPhone: '393339990000', sms: { enabled: true, channel: 'android', confirm: true, reminder: true } })).status, 200);
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'gateway', username: 'utente', password: '' } })).status, 400);
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'gateway', username: 'utente', password: 'segreta' } })).status, 200);
  assert.equal((await call(notify, { cookie })).body.gateway, true);

  const subscription = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) } };
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'subscribe', subscription: { endpoint: 'http://x' } } })).status, 400);
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'subscribe', subscription, device: 'Telefono di prova' } })).status, 200);

  const r = await call(pub, { method: 'POST', ip: '2.0.0.2', body: { name: 'Bea Neri', phone: '333 111 0002', serviceIds: [1], date: openDay, time: '11:00', privacy: true } });
  assert.equal(r.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, GATEWAY_URL);
  assert.equal(sent[0].auth, 'Basic ' + Buffer.from('utente:segreta').toString('base64'));
  assert.deepEqual(sent[0].body.phoneNumbers, ['+393331110002']);
  assert.match(sent[0].body.textMessage.text, /^Ciao Bea! Ti confermiamo l'appuntamento/);
  assert.equal(pushed.length, 1, 'push to the salon');
  assert.match(pushed[0].body, /Bea Neri/);

  // Appointment made in the salon: confirmation once, not again on edits, never for past appointments
  const appt = { id: 9001, clientName: 'Carla Verdi', phone: '3331110003', date: openDay, time: '15:00', duration: 30, services: ['Piega'], price: 18 };
  await admin({ method: 'PUT', body: { col: 'appointments', item: appt } });
  await admin({ method: 'PUT', body: { col: 'appointments', item: { ...appt, notes: 'modificato' } } });
  await admin({ method: 'PUT', body: { col: 'appointments', item: { ...appt, id: 9002, date: day(-3) } } });
  assert.equal(sent.length, 2);
  const all = (await admin({})).body;
  assert.ok(all.appointments.find((a) => a.id === 9001).smsConfirmAt, 'appointment shows the SMS');
  assert.ok(!('sms' in all) && !JSON.stringify(all).includes('segreta'), 'no SMS rows or gateway password in the app data');
});

test('gateway errors are shown and retried, never marked as sent', async () => {
  gatewayStatus = 401;
  await admin({ method: 'PUT', body: { col: 'appointments', item: { id: 9003, clientName: 'Dora Gialli', phone: '3331110004', date: openDay, time: '16:00', services: [] } } });
  const failed = (await smsRows()).find((m) => m.apptId === 9003);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /password del gateway/);
  assert.ok(!(await admin({})).body.appointments.find((a) => a.id === 9003).smsConfirmAt);
  gatewayStatus = 200;
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'retry' } })).status, 200);
  assert.equal((await smsRows()).find((m) => m.apptId === 9003).status, 'sent');
});

test('daily job: protected, reminders for tomorrow once, deleted appointments cancel their SMS', async () => {
  assert.equal((await call(cron)).status, 401, 'no CRON_SECRET: the job never runs');
  process.env.CRON_SECRET = 'segreto-cron-di-prova';
  assert.equal((await call(cron, { headers: { authorization: 'Bearer sbagliato' } })).status, 401);
  const tomorrow = day(1);
  await config({ closedDays: [] });
  for (const [id, extra] of [[9101, {}], [9102, { reminderSent: true }], [9103, { phone: '' }]]) {
    await admin({ method: 'PUT', body: { col: 'appointments', item: { id, clientName: 'Elsa ' + id, phone: '3331119' + id, date: tomorrow, time: '09:30', services: ['Piega'], ...extra } } });
  }
  const before = sent.length;
  const r = await call(cron, { headers: { authorization: 'Bearer segreto-cron-di-prova' } });
  assert.equal(r.status, 200);
  const reminders = sent.slice(before).filter((s) => /ricordiamo/.test(s.body.textMessage.text));
  assert.equal(reminders.length, 1, 'only 9101: 9102 was already reminded by hand, 9103 has no phone');
  assert.equal((await admin({})).body.appointments.find((a) => a.id === 9101).reminderSent, true, '"Avvisata" in the reminders panel');
  await call(cron, { headers: { authorization: 'Bearer segreto-cron-di-prova' } });
  assert.equal(sent.slice(before).filter((s) => /ricordiamo/.test(s.body.textMessage.text)).length, 1, 'never twice');

  gatewayStatus = 500;
  await admin({ method: 'PUT', body: { col: 'appointments', item: { id: 9104, clientName: 'Fede Blu', phone: '3331110005', date: openDay, time: '17:00', services: [] } } });
  gatewayStatus = 200;
  await admin({ method: 'DELETE', query: { col: 'appointments', id: '9104' } });
  assert.ok(!(await smsRows()).some((m) => m.apptId === 9104), 'deleted appointment: its unsent SMS is gone');
});

test('iPhone: the Shortcut fetches the messages with its secret link and confirms each one', async () => {
  await config({ sms: { enabled: true, channel: 'iphone', confirm: true, reminder: true } });
  const before = sent.length;
  await admin({ method: 'PUT', body: { col: 'appointments', item: { id: 9201, clientName: 'Gaia Rosa', phone: '3331110006', date: openDay, time: '18:00', services: ['Taglio'] } } });
  assert.equal(sent.length, before, 'iPhone mode: nothing goes to the Android gateway');
  const panel = (await call(notify, { cookie })).body, url = new URL(panel.shortcutUrl);
  assert.equal(url.origin, 'https://salone.test');
  assert.equal(panel.iphoneSeen, null, 'the iPhone has not checked yet');
  assert.equal((await call(notify, { query: { k: 'sbagliato' } })).status, 401);
  const poll = await call(notify, { query: { k: url.searchParams.get('k') } });
  const m = poll.body.messages.find((x) => x.to === '+393331110006');
  assert.ok(m && /Gaia/.test(m.text));
  assert.ok(Date.now() - Date.parse((await call(notify, { cookie })).body.iphoneSeen) < 60000, 'the panel sees the check');
  const ack = new URL(m.ack); // the Shortcut opens this link as it is
  assert.equal(ack.origin + ack.pathname, 'https://salone.test/api/notify');
  assert.equal(ack.searchParams.get('k'), url.searchParams.get('k'));
  assert.equal(ack.searchParams.get('ack'), String(m.id));
  await call(notify, { query: Object.fromEntries(ack.searchParams) });
  assert.ok(!(await call(notify, { query: { k: url.searchParams.get('k') } })).body.messages.some((x) => x.id === m.id), 'confirmed: not sent again');
  assert.ok((await admin({})).body.appointments.find((a) => a.id === 9201).smsConfirmAt);
});

test('push: test notification, restore keeps devices, SMS and secrets', async () => {
  const before = pushed.length;
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'test-push' } })).body.devices, 1);
  assert.equal(pushed.length, before + 1);
  const key = (await call(notify, { cookie })).body.pushKey;
  const backup = (await admin({})).body;
  assert.equal((await admin({ method: 'POST', body: backup })).status, 200);
  const after = (await call(notify, { cookie })).body;
  assert.equal(after.pushKey, key, 'same keys: subscribed phones keep working');
  assert.equal(after.pushDevices, 1);
  assert.equal(after.gateway, true);
  assert.ok(after.recent.length > 0);
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'unsubscribe', endpoint: 'https://push.example/abc' } })).status, 200);
  assert.equal((await admin({ handler: notify, method: 'POST', body: { action: 'test-push' } })).status, 400);
});
