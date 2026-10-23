import { handle, fail, db, requireAdmin, sessionEpoch, linkToken, checkLinkToken, romeNow } from './_lib.js';
import { getSecret, setSecret, loadConfig, normalizePhone, queueReminders, pendingSms, markSms, deliverSms, vapidKeys, pushAll, pushId } from './_notify.js';

// SMS to clients and push notifications to the salon: settings panel (admin) and the iPhone Shortcut (secret link).
export default handle(async (req, res) => {
  const sql = await db();
  res.setHeader('Cache-Control', 'no-store');
  const origin = `https://${req.headers.host}`;

  // iPhone Shortcut: GET ?k=... returns the SMS to send (tomorrow's reminders are prepared here too, so it works
  // even if the daily job did not run); GET ?k=...&ack=ID after each one is sent.
  if (req.query.k !== undefined) {
    if (!checkLinkToken('sms', req.query.k, await sessionEpoch(sql))) fail(401, 'Link non valido: copialo di nuovo dalle Impostazioni di Salone PRO');
    if (req.query.ack !== undefined) {
      const [row] = await sql`SELECT data FROM docs WHERE col = 'sms' AND id = ${Number(req.query.ack) || 0}`;
      if (row && row.data.status !== 'sent') await markSms(sql, row.data, { status: 'sent', via: 'iphone', sentAt: new Date().toISOString(), error: null });
      return res.json({ ok: true });
    }
    const config = await loadConfig(sql);
    if (config.sms?.enabled) await queueReminders(sql, config);
    const msgs = config.sms?.enabled && config.sms?.channel === 'iphone' ? await pendingSms(sql) : [];
    return res.json({ messages: msgs.map((m) => ({ id: m.id, to: m.to, text: m.text })) });
  }

  await requireAdmin(req, sql);

  if (req.method === 'GET') {
    const [secret, recent, [{ n }]] = await Promise.all([
      getSecret(sql),
      sql`SELECT data FROM docs WHERE col = 'sms' ORDER BY data->>'createdAt' DESC LIMIT 15`,
      sql`SELECT count(*)::int AS n FROM docs WHERE col = 'push'`,
    ]);
    return res.json({
      gateway: Boolean(secret.gateway?.username), // the gateway password never leaves the server
      shortcutUrl: `${origin}/api/notify?k=${linkToken('sms', await sessionEpoch(sql))}`,
      recent: recent.map((r) => r.data),
      pushKey: (await vapidKeys(sql, origin)).publicKey,
      pushDevices: n,
      cron: Boolean(process.env.CRON_SECRET), // without it the morning job (reminders, summary) never runs
    });
  }

  if (req.method !== 'POST') fail(405, 'Metodo non consentito');
  const b = req.body || {};
  const str = (v, max) => typeof v === 'string' && v.trim().length <= max ? v.trim() : fail(400, 'Dati non validi');

  if (b.action === 'gateway') { // empty username = disconnect
    const username = str(b.username ?? '', 100), password = str(b.password ?? '', 200);
    if (username && !password) fail(400, 'Inserisci anche la password del gateway');
    await setSecret(sql, { gateway: username ? { username, password } : null });
    return res.json({ ok: true, gateway: Boolean(username) });
  }

  if (b.action === 'test-sms') {
    const config = await loadConfig(sql);
    const to = normalizePhone(b.to || config.ownerPhone);
    if (!to) fail(400, 'Numero non valido: scrivilo nel campo o salva il WhatsApp del salone in Impostazioni');
    const m = { id: Date.now() * 10 + 9, kind: 'test', to, name: 'Prova', status: 'pending', attempts: 0, createdAt: new Date().toISOString(),
      text: `SMS di prova da Salone PRO per ${config.salonName}: se lo ricevi, gli SMS automatici funzionano.` };
    await sql.transaction([ // a new test replaces one still waiting, so tapping twice does not send two
      sql`DELETE FROM docs WHERE col = 'sms' AND data->>'kind' = 'test' AND data->>'status' <> 'sent'`,
      sql`INSERT INTO docs (col, id, data) VALUES ('sms', ${m.id}, ${JSON.stringify(m)}::jsonb)`,
    ]);
    await deliverSms(sql, config, await getSecret(sql), [m]);
    const [row] = await sql`SELECT data FROM docs WHERE col = 'sms' AND id = ${m.id}`;
    return res.json({ ok: true, sms: row.data });
  }

  if (b.action === 'retry') {
    const config = await loadConfig(sql);
    const msgs = await pendingSms(sql, { failed: true });
    await deliverSms(sql, config, await getSecret(sql), msgs);
    return res.json({ ok: true, tried: msgs.length });
  }

  if (b.action === 'subscribe') {
    const s = b.subscription;
    if (typeof s?.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000
      || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string' || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) {
      fail(400, 'Iscrizione alle notifiche non valida');
    }
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: str(b.device ?? '', 80), since: romeNow().date };
    await sql`INSERT INTO docs (col, id, data) VALUES ('push', ${pushId(s.endpoint)}, ${JSON.stringify(sub)}::jsonb)
              ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data`;
    return res.json({ ok: true });
  }

  if (b.action === 'unsubscribe') {
    await sql`DELETE FROM docs WHERE col = 'push' AND id = ${pushId(str(b.endpoint, 1000))}`;
    return res.json({ ok: true });
  }

  if (b.action === 'test-push') {
    const n = await pushAll(sql, { title: 'Salone PRO', body: 'Notifiche attive: qui arriveranno le nuove prenotazioni e il riepilogo del mattino.', url: '/impostazioni', tag: 'test' });
    if (!n) fail(400, 'Nessun telefono ha ricevuto la prova: tocca prima "Attiva su questo dispositivo"');
    return res.json({ ok: true, devices: n });
  }

  fail(400, 'Azione non valida');
});
