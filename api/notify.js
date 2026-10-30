import { handle, fail, db, requireAdmin, sessionEpoch, linkQuery, linkSalon, romeNow } from './_lib.js';
import { getSecret, setSecret, loadConfig, normalizePhone, queueReminders, pendingSms, markSms, deliverSms, vapidKeys, pushAll, pushId } from './_notify.js';

// SMS to clients and push notifications to the salon: settings panel (admin) and the iPhone Shortcut (secret link).
export default handle(async (req, res) => {
  const sql = await db();
  res.setHeader('Cache-Control', 'no-store');
  const origin = `https://${req.headers.host}`;

  // iPhone Shortcut: GET ?k=... returns the SMS to send (tomorrow's reminders are prepared here too, so it works
  // even if the daily job did not run), each with its ready-made `ack` link to open once it is sent.
  if (req.query.k !== undefined) {
    const S = await linkSalon(sql, 'sms', req.query);
    if (!S) fail(401, 'Link non valido: copialo di nuovo dalle Impostazioni di Salone PRO');
    if (req.query.ack !== undefined) {
      const [row] = await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'sms' AND id = ${Number(req.query.ack) || 0}`;
      if (row && row.data.status !== 'sent') await markSms(sql, S, row.data, { status: 'sent', via: 'iphone', sentAt: new Date().toISOString(), error: null });
      return res.json({ ok: true });
    }
    const config = await loadConfig(sql, S);
    await setSecret(sql, S, { iphoneSeen: new Date().toISOString() }); // the settings panel shows when the iPhone last checked
    if (config.sms?.enabled) await queueReminders(sql, S, config);
    const msgs = config.sms?.enabled && config.sms?.channel === 'iphone' ? await pendingSms(sql, S) : [];
    // A full link per message: the Shortcut only opens it, nothing to assemble (16-digit ids are easy to mangle there).
    const link = linkQuery('sms', S, await sessionEpoch(sql, S));
    const ack = (id) => `${origin}/api/notify?${link}&ack=${id}`;
    return res.json({ messages: msgs.map((m) => ({ id: m.id, to: m.to, text: m.text, ack: ack(m.id) })) });
  }

  // SMS settings, push devices and the iPhone link are the owner's: the panel is hidden from staff.
  const S = (await requireAdmin(req, sql, { owner: true })).salon;

  if (req.method === 'GET') {
    const [secret, recent, [{ n }]] = await Promise.all([
      getSecret(sql, S),
      sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'sms' ORDER BY data->>'createdAt' DESC LIMIT 15`,
      sql`SELECT count(*)::int AS n FROM docs WHERE salon = ${S} AND col = 'push'`,
    ]);
    return res.json({
      gateway: Boolean(secret.gateway?.username), // the gateway password never leaves the server
      shortcutUrl: `${origin}/api/notify?${linkQuery('sms', S, await sessionEpoch(sql, S))}`,
      iphoneSeen: secret.iphoneSeen || null, // last time the Shortcut asked for messages
      recent: recent.map((r) => r.data),
      pushKey: (await vapidKeys(sql, S, origin)).publicKey,
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
    await setSecret(sql, S, { gateway: username ? { username, password } : null });
    return res.json({ ok: true, gateway: Boolean(username) });
  }

  if (b.action === 'test-sms') {
    const config = await loadConfig(sql, S);
    const to = normalizePhone(b.to || config.ownerPhone);
    if (!to) fail(400, 'Numero non valido: scrivilo nel campo o salva il WhatsApp del salone in Impostazioni');
    const m = { id: Date.now() * 10 + 9, kind: 'test', to, name: 'Prova', status: 'pending', attempts: 0, createdAt: new Date().toISOString(),
      text: `SMS di prova da Salone PRO per ${config.salonName}: se lo ricevi, gli SMS automatici funzionano.` };
    await sql.transaction([ // a new test replaces one still waiting, so tapping twice does not send two
      sql`DELETE FROM docs WHERE salon = ${S} AND col = 'sms' AND data->>'kind' = 'test' AND data->>'status' <> 'sent'`,
      sql`INSERT INTO docs (salon, col, id, data) VALUES (${S}, 'sms', ${m.id}, ${JSON.stringify(m)}::jsonb)`,
    ]);
    await deliverSms(sql, S, config, await getSecret(sql, S), [m]);
    const [row] = await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'sms' AND id = ${m.id}`;
    return res.json({ ok: true, sms: row.data });
  }

  if (b.action === 'retry') {
    const config = await loadConfig(sql, S);
    const msgs = await pendingSms(sql, S, { failed: true });
    await deliverSms(sql, S, config, await getSecret(sql, S), msgs);
    return res.json({ ok: true, tried: msgs.length });
  }

  if (b.action === 'subscribe') {
    const s = b.subscription;
    if (typeof s?.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000
      || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string' || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) {
      fail(400, 'Iscrizione alle notifiche non valida');
    }
    const sub = { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: str(b.device ?? '', 80), since: romeNow().date };
    await sql`INSERT INTO docs (salon, col, id, data) VALUES (${S}, 'push', ${pushId(s.endpoint)}, ${JSON.stringify(sub)}::jsonb)
              ON CONFLICT (salon, col, id) DO UPDATE SET data = EXCLUDED.data`;
    return res.json({ ok: true });
  }

  if (b.action === 'unsubscribe') {
    await sql`DELETE FROM docs WHERE salon = ${S} AND col = 'push' AND id = ${pushId(str(b.endpoint, 1000))}`;
    return res.json({ ok: true });
  }

  if (b.action === 'test-push') {
    const n = await pushAll(sql, S, { title: 'Salone PRO', body: 'Notifiche attive: qui arriveranno le nuove prenotazioni e il riepilogo del mattino.', url: '/impostazioni', tag: 'test' });
    if (!n) fail(400, 'Nessun telefono ha ricevuto la prova: tocca prima "Attiva su questo dispositivo"');
    return res.json({ ok: true, devices: n });
  }

  fail(400, 'Azione non valida');
});
