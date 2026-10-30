// Browser smoke test: the real pages in headless Chrome against test/server.mjs (API on PGlite, CSP from vercel.json).
// Uses the Chrome installed on the machine: playwright-core downloads no browser. `npm test`
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

process.env.ADMIN_PASSWORD = 'password-di-prova-123';
const { start } = await import('./server.mjs');
const { chromium } = await import('playwright-core');

const server = await start();
const base = `http://localhost:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome' });
after(() => Promise.all([browser.close(), new Promise((r) => server.close(r))]));

// Page errors, CSP violations (logged as console errors) and missing files fail the test. Failed API requests are
// part of the tests (the 401 before login, the offline step), so "Failed to load resource" is left out.
const problems = [];
async function open(path) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => problems.push(`${path}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !m.text().startsWith('Failed to load resource') && problems.push(`${path}: ${m.text()}`));
  page.on('response', (r) => r.status() === 404 && problems.push(`${path}: 404 ${r.url()}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(base + path);
  return page;
}

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const adminFiles = ['index.html', ...readdirSync(new URL('../public/js/', import.meta.url)).filter((f) => f !== 'prenota.js').map((f) => 'js/' + f)];
const bookingFiles = ['prenota.html', 'js/prenota.js'];
// Every data-click & co. in markup and templates must have its handler in `actions` (see common.js).
const missingActions = (page, files) => page.evaluate((used) => used.filter(([type, name]) => typeof actions[type][name] !== 'function'),
  files.flatMap((f) => [...read(f).matchAll(/data-(click|change|input|submit|toggle|focus)="(\w+)"/g)].map(([, type, name]) => [type, name])));

test('pages hold no inline script or handler', () => {
  for (const f of [...adminFiles, ...bookingFiles]) {
    assert.doesNotMatch(read(f), /\son[a-z]+="/, f);
    assert.doesNotMatch(read(f), /<script(?![^>]*\ssrc=)/, f);
  }
});

let admin;
test('login, guided setup, agenda', async () => {
  admin = await open('/');
  await admin.fill('#login-pw', 'password-sbagliata');
  await admin.getByRole('button', { name: 'Entra' }).click();
  await admin.locator('#login-err', { hasText: 'Password errata' }).waitFor();
  await admin.fill('#login-pw', process.env.ADMIN_PASSWORD);
  await admin.getByRole('button', { name: 'Entra' }).click();
  await admin.getByRole('button', { name: 'Lo faccio dopo' }).click(); // a new salon starts with the guided setup
  await admin.locator('#ob-modal').waitFor({ state: 'hidden' });
  assert.match(await admin.textContent('#wl-hello'), /^Buon/);
  await admin.locator('#agenda-list', { hasText: 'Nessun appuntamento' }).waitFor();
  assert.deepEqual(await missingActions(admin, adminFiles), []);
});

test('new appointment', async () => {
  await admin.locator('.topbar').getByRole('button', { name: 'Nuovo appuntamento' }).click();
  await admin.fill('#modal-new-client', 'Giulia Prova');
  await admin.fill('#modal-phone', '333 000 1111');
  await admin.fill('#modal-time', '10:00');
  await admin.locator('#modal-services-picker summary', { hasText: 'PIEGA' }).click();
  await admin.locator('#appt-modal').getByLabel('Piega Classica').check();
  assert.equal(await admin.inputValue('#modal-price'), '18');
  await admin.getByRole('button', { name: 'Salva in agenda' }).click();
  await admin.getByText('Appuntamento salvato').waitFor(); // toast after the server saved it
  await admin.locator('#agenda-list .appt', { hasText: 'Piega Classica, 30 min' }).waitFor();
});

test('client card', async () => {
  await admin.locator('#agenda-list').getByRole('button', { name: 'Giulia Prova' }).click();
  await admin.locator('#cli-modal').waitFor();
  assert.equal(await admin.textContent('#cm-title'), 'Giulia Prova');
  assert.equal(await admin.inputValue('#cm-phone'), '333 000 1111');
  await admin.locator('#cm-history', { hasText: 'In agenda, ore 10:00' }).waitFor();
  await admin.locator('#cm-photo-info', { hasText: 'ridotte a 480p' }).waitFor(); // photos fetched
  assert.equal(await admin.evaluate(() => document.querySelector('.app').inert), true); // keyboard stays in the dialog
  await admin.locator('#cli-modal').getByRole('button', { name: 'Chiudi' }).click();
  await admin.locator('#cli-modal').waitFor({ state: 'hidden' });
  assert.equal(await admin.evaluate(() => document.activeElement.textContent), 'Giulia Prova'); // focus back on the opener
});

test('settings with the error log', async () => {
  await admin.locator('.sidebar').getByRole('link', { name: 'Impostazioni & dati' }).click();
  await admin.locator('#tab-backup').waitFor();
  assert.equal(new URL(admin.url()).pathname, '/impostazioni');
  await admin.waitForFunction(() => document.getElementById('cal-link').value.includes('/api/calendar?k='));
  await admin.locator('#err-log', { hasText: 'Nessun problema recente' }).waitFor();
  // Saving without connection: the change waits on the device, the log says why, "Riprova" sends it.
  await admin.route('**/api/**', (r) => r.abort('internetdisconnected'));
  await admin.getByRole('button', { name: 'Salva impostazioni' }).click();
  await admin.locator('#offline-text', { hasText: '1 modifica salvata sul dispositivo' }).waitFor();
  await admin.locator('#err-log .err-row', { hasText: 'Connessione internet assente' }).waitFor();
  await admin.unroute('**/api/**');
  await admin.locator('#offline-bar').getByRole('button', { name: 'Riprova' }).click();
  await admin.locator('#offline-bar').waitFor({ state: 'hidden' });
  await admin.getByRole('button', { name: 'Svuota' }).click(); // confirm() accepted in open()
  await admin.locator('#err-log', { hasText: 'Nessun problema recente' }).waitFor();
});

test('public booking and confirmation', async () => {
  const page = await open('/prenota');
  await page.getByLabel('Piega Classica').check();
  await page.locator('.slot:not([disabled])').first().click();
  await page.fill('#c-name', 'Lucia Prova');
  await page.fill('#c-phone', '333 222 3333');
  await page.check('#c-gdpr');
  await page.locator('.book-inline').getByRole('button', { name: 'Prenota' }).click();
  await page.locator('#done-modal').waitFor();
  assert.match(await page.textContent('#done-text'), /Grazie Lucia Prova/);
  assert.match(await page.getAttribute('#btn-google-cal', 'href'), /^https:\/\/calendar\.google\.com\/calendar\/render\?action=TEMPLATE/);
  assert.deepEqual(await missingActions(page, bookingFiles), []);

  // The admin's 20-second check, without waiting for it: the notice opens the booking's day.
  await admin.evaluate(() => reload());
  await admin.locator('#booking-alert').getByRole('button', { name: 'Vedi' }).click();
  await admin.locator('#agenda-list .appt', { hasText: 'Lucia Prova' }).getByText('Web').waitFor();
});

test('sign-up: a second salon, empty, with its own booking page', async () => {
  const page = await open('/');
  await page.getByRole('button', { name: 'Crea il tuo salone' }).click();
  await page.fill('#su-salon', 'Barberia Prova');
  await page.fill('#su-name', 'Marco Prova');
  await page.fill('#su-email', 'marco@prova.it');
  await page.fill('#su-pw', 'password-marco');
  await page.getByRole('button', { name: 'Crea il salone' }).click();
  await page.getByRole('button', { name: 'Lo faccio dopo' }).click();
  await page.locator('#agenda-list', { hasText: 'Nessun appuntamento' }).waitFor(); // nothing from the first salon
  await page.locator('.sidebar').getByRole('link', { name: 'Prenotazione web' }).click();
  assert.equal(await page.inputValue('#public-link'), base + '/prenota/barberia-prova');
  await page.locator('.sidebar').getByRole('link', { name: 'Impostazioni & dati' }).click();
  await page.locator('#account-info', { hasText: 'Prova gratuita fino al' }).waitFor();
  await page.locator('#team-list', { hasText: 'Marco Prova' }).waitFor();
  assert.equal(await page.isVisible('#salons-list'), false, 'the salons panel is for PLATFORM_ADMINS only');

  const booking = await open('/prenota/barberia-prova');
  await booking.locator('#salon-title', { hasText: 'Barberia Prova' }).waitFor();
});

test('no page errors or CSP violations', () => {
  assert.deepEqual(problems, []);
});
