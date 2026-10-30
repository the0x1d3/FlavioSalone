import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { DEFAULT_CONFIG, romeNow, smsConfig } from './_lib.js';

// Everything here works on one salon, `S`.
// Server-only secrets (SMS gateway login, push keys): their own row, never in the app's data load, backups or restores.
export const getSecret = async (sql, S) => (await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'secret' AND id = 1`)[0]?.data || {};
export const setSecret = (sql, S, patch) => sql`INSERT INTO docs (salon, col, id, data) VALUES (${S}, 'secret', 1, ${JSON.stringify(patch)}::jsonb)
  ON CONFLICT (salon, col, id) DO UPDATE SET data = docs.data || EXCLUDED.data`;
export const loadConfig = async (sql, S) => ({ ...DEFAULT_CONFIG, ...(await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'config' AND id = 1`)[0]?.data });

export const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayIt = (date) => new Date(date + 'T12:00:00Z').toLocaleDateString('it-IT', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });

// ---------- SMS to clients ----------
// Same rule as waNumber in common.js: Italian numbers are written without prefix. '' when it cannot be a phone number.
export function normalizePhone(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D/g, '').replace(/^00/, '');
  if (!s.startsWith('+') && d.length <= 10) d = '39' + d;
  return d.length >= 9 && d.length <= 15 ? '+' + d : '';
}

export function smsText(template, appt, config) {
  const tags = {
    cliente: String(appt.clientName || '').trim().split(/\s+/)[0], salone: config.salonName, giorno: appt.date ? dayIt(appt.date) : '',
    ora: appt.time, servizi: (appt.services || []).join(' + '), telefono: config.ownerPhone,
  };
  return String(template).replace(/\{(\w+)\}/g, (tag, k) => (k in tags ? String(tags[k] ?? '') : tag)).replace(/[ \t]+/g, ' ').trim();
}

// One row per appointment and kind (id = appointment id * 10 + kind), so queuing twice never sends twice.
const KIND = { confirm: 1, reminder: 2 };
export async function queueSms(sql, S, config, appt, kind) {
  const to = normalizePhone(appt.phone), id = appt.id * 10 + KIND[kind];
  if (!to || !Number.isSafeInteger(id)) return null;
  const msg = {
    id, apptId: appt.id, kind, to, name: appt.clientName, date: appt.date, status: 'pending', attempts: 0, createdAt: new Date().toISOString(),
    text: smsText(smsConfig(config)[kind + 'Msg'], appt, config),
  };
  const [row] = await sql`INSERT INTO docs (salon, col, id, data) VALUES (${S}, 'sms', ${id}, ${JSON.stringify(msg)}::jsonb) ON CONFLICT DO NOTHING RETURNING data`;
  return row?.data || null;
}

// Tomorrow's appointments, except clients already reminded by hand (WhatsApp or SMS from the reminders panel).
export async function queueReminders(sql, S, config) {
  const s = smsConfig(config);
  if (!s.enabled || !s.reminder) return [];
  const rows = await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'appointments' AND data->>'date' = ${addDays(romeNow().date, 1)}`;
  const out = [];
  for (const { data: a } of rows) if (!a.reminderSent) out.push(await queueSms(sql, S, config, a, 'reminder'));
  return out.filter(Boolean);
}

// Waiting messages, oldest first. A reminder for an appointment already gone is never sent late.
export async function pendingSms(sql, S, { failed = false } = {}) {
  const rows = await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'sms' AND COALESCE(data->>'date', '9999') >= ${romeNow().date}
    AND (data->>'status' = 'pending' OR (${failed} AND data->>'status' = 'failed')) ORDER BY id LIMIT 50`;
  return rows.map((r) => r.data);
}

// Sent: the appointment shows it (a sent reminder counts as "Avvisata" in the reminders panel). Patches merge
// into the stored JSON, so a change made meanwhile on the appointment is kept.
export async function markSms(sql, S, m, patch) {
  await sql`UPDATE docs SET data = data || ${JSON.stringify(patch)}::jsonb WHERE salon = ${S} AND col = 'sms' AND id = ${m.id}`;
  if (patch.status !== 'sent' || !m.apptId) return;
  const appt = m.kind === 'reminder' ? { reminderSent: true, lastAttemptChannel: 'SMS automatico', smsReminderAt: patch.sentAt } : { smsConfirmAt: patch.sentAt };
  await sql`UPDATE docs SET data = data || ${JSON.stringify(appt)}::jsonb WHERE salon = ${S} AND col = 'appointments' AND id = ${m.apptId}`;
}

// Android: the free SMS Gateway app (sms-gate.app) in "Cloud server" mode. Its cloud reaches the phone with a push and
// the phone sends from its SIM, so the phone needs no public address. iPhone: messages wait for the Shortcut (notify.js).
export const GATEWAY_URL = 'https://api.sms-gate.app/3rdparty/v1/messages';
export async function deliverSms(sql, S, config, secret, msgs) {
  const g = secret.gateway;
  if (smsConfig(config).channel !== 'android' || !g?.username) return;
  const auth = 'Basic ' + Buffer.from(`${g.username}:${g.password}`).toString('base64');
  for (const m of msgs) {
    let patch;
    try {
      const r = await fetch(GATEWAY_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ textMessage: { text: m.text }, phoneNumbers: [m.to] }), signal: AbortSignal.timeout(5000),
      });
      patch = r.ok ? { status: 'sent', via: 'android', sentAt: new Date().toISOString(), error: null }
        : { status: 'failed', error: r.status === 401 ? 'Nome utente o password del gateway sbagliati' : `Il gateway ha risposto con errore ${r.status}` };
    } catch {
      // shortcut: a timeout may hide a message the gateway did accept, so a later retry can send it twice; rare, and a reminder sent twice is harmless.
      patch = { status: 'failed', error: 'Gateway non raggiungibile' };
    }
    await markSms(sql, S, m, { ...patch, attempts: (m.attempts || 0) + 1 });
  }
}

// A new appointment: confirmation SMS to the client (if switched on) and, for online bookings, a push to the salon.
// Never throws: a booking must not fail because a phone or the gateway is offline. Unsent messages stay queued.
export async function afterNewAppointment(sql, S, appt, { push = false } = {}) {
  try {
    const config = await loadConfig(sql, S), s = smsConfig(config), today = romeNow();
    const future = appt.date > today.date || (appt.date === today.date && appt.time > today.time);
    const jobs = [];
    if (s.enabled && s.confirm && future) {
      jobs.push(queueSms(sql, S, config, appt, 'confirm').then(async (m) => m && deliverSms(sql, S, config, await getSecret(sql, S), [m])));
    }
    if (push && config.notifications?.bookings !== false) {
      jobs.push(pushAll(sql, S, { title: 'Nuova prenotazione online', body: `${appt.clientName}, ${dayIt(appt.date)} alle ${appt.time}: ${(appt.services || []).join(' + ')}`, url: '/', tag: 'booking' }));
    }
    await Promise.allSettled(jobs);
  } catch (e) {
    console.error('Avvisi dopo la prenotazione', e);
  }
}

// ---------- Push notifications on the salon's devices ----------
// Keys made once and kept in the database: no setup on Vercel. The subject is the site address, as Apple requires one.
export async function vapidKeys(sql, S, origin) {
  const fresh = { vapid: { ...webpush.generateVAPIDKeys(), subject: origin } };
  const [row] = await sql`INSERT INTO docs (salon, col, id, data) VALUES (${S}, 'secret', 1, ${JSON.stringify(fresh)}::jsonb)
    ON CONFLICT (salon, col, id) DO UPDATE SET data = CASE WHEN docs.data ? 'vapid' THEN docs.data ELSE docs.data || EXCLUDED.data END
    RETURNING data->'vapid' AS vapid`;
  return row.vapid; // two first calls at once: both get the keys that were actually stored
}

export const pushId = (endpoint) => parseInt(createHash('sha256').update(endpoint).digest('hex').slice(0, 13), 16);

// Sends to every subscribed device; devices that unsubscribed or reinstalled are forgotten. Returns how many got it.
export async function pushAll(sql, S, payload) {
  const { vapid } = await getSecret(sql, S);
  const subs = vapid ? await sql`SELECT id, data FROM docs WHERE salon = ${S} AND col = 'push'` : [];
  if (!subs.length) return 0;
  const gone = [];
  const sent = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s.data, JSON.stringify(payload), {
    vapidDetails: vapid, TTL: 12 * 3600,
  }).catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) gone.push(s.id); throw e; })));
  if (gone.length) await sql`DELETE FROM docs WHERE salon = ${S} AND col = 'push' AND id = ANY(${gone}::bigint[])`;
  return sent.filter((r) => r.status === 'fulfilled').length;
}
