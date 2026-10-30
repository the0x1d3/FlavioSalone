import { handle, fail, db, romeNow, smsConfig, salonOpen } from './_lib.js';
import { getSecret, loadConfig, queueReminders, pendingSms, deliverSms, pushAll, addDays } from './_notify.js';

// Every morning (vercel.json "crons"), for every open salon: SMS reminders for tomorrow, retries of failed SMS,
// cleanup, morning summary push.
export default handle(async (req, res) => {
  // Vercel Cron sends "Authorization: Bearer <CRON_SECRET>". Without the variable the job refuses to run, so nobody
  // else can trigger it.
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) fail(401, 'Non autorizzato');
  const sql = await db();
  const salons = (await sql`SELECT id, status, trial_end::text AS trial_end FROM salons ORDER BY id`).filter(salonOpen);
  let queued = 0, pushed = 0;
  // shortcut: one salon after the other inside one function run; split into batches when there are hundreds of salons.
  for (const { id } of salons) {
    try {
      const r = await morning(sql, Number(id));
      queued += r.queued;
      pushed += r.pushed;
    } catch (e) {
      console.error(`Lavoro del mattino, salone ${id}`, e); // one salon's problem does not stop the others
    }
  }
  res.json({ ok: true, salons: salons.length, queued, pushed });
});

async function morning(sql, S) {
  const config = await loadConfig(sql, S), today = romeNow().date;

  const queued = await queueReminders(sql, S, config);
  const retry = (await pendingSms(sql, S, { failed: true })).filter((m) => m.status === 'pending' || m.attempts < 3);
  await deliverSms(sql, S, config, await getSecret(sql, S), retry);

  // Messages keep phone numbers: 30 days are enough to check what went out.
  const old = new Date(Date.now() - 30 * 864e5).toISOString();
  await sql`DELETE FROM docs WHERE salon = ${S} AND col = 'sms' AND data->>'createdAt' < ${old}`;

  let pushed = 0;
  if (config.notifications?.morning !== false) {
    const appts = (await sql`SELECT data FROM docs WHERE salon = ${S} AND col = 'appointments' AND data->>'date' = ${today} ORDER BY data->>'time'`).map((r) => r.data);
    const s = smsConfig(config);
    const [{ n: toRemind }] = s.enabled && s.reminder ? [{ n: 0 }] // reminders already go out by SMS
      : await sql`SELECT count(*)::int AS n FROM docs WHERE salon = ${S} AND col = 'appointments' AND data->>'date' > ${today} AND data->>'date' <= ${addDays(today, 2)}
                  AND COALESCE((data->>'reminderSent')::boolean, false) = false`;
    const parts = [appts.length ? `Oggi ${appts.length === 1 ? '1 appuntamento' : `${appts.length} appuntamenti`}, il primo alle ${appts[0].time}.` : '',
      toRemind ? `${toRemind === 1 ? '1 cliente' : `${toRemind} clienti`} da avvisare per i prossimi giorni.` : ''].filter(Boolean);
    if (parts.length) pushed = await pushAll(sql, S, { title: 'Buongiorno da Salone PRO', body: parts.join(' '), url: '/', tag: 'morning' });
  }
  return { queued: queued.length, pushed };
}
