// Offline-mode helpers from public/offline.js, run in a sandbox like the browser does. `npm test`
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ctx = vm.createContext({ document: { addEventListener() {}, documentElement: { dataset: {} }, querySelectorAll: () => [] } });
for (const f of ['common.js', 'offline.js']) vm.runInContext(readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8'), ctx);
const { applyOp, clashes } = vm.runInContext('({ applyOp, clashes })', ctx);

test('applyOp replays queued changes on a fresh snapshot', () => {
  const data = { config: { salonName: 'A', openTime: '09:00' }, appointments: [{ id: 1, time: '10:00' }, { id: 2, time: '11:00' }] };
  applyOp(data, { method: 'PUT', col: 'appointments', item: { id: 3, time: '12:00' } }); // new
  applyOp(data, { method: 'PUT', col: 'appointments', item: { id: 1, time: '09:30' } }); // edit
  applyOp(data, { method: 'DELETE', col: 'appointments', id: 2 });
  applyOp(data, { method: 'DELETE', col: 'appointments', id: 99 }); // already gone: no-op
  applyOp(data, { method: 'PUT', col: 'config', item: { salonName: 'B' } });
  assert.deepEqual(data.appointments.map((a) => `${a.id}@${a.time}`), ['1@09:30', '3@12:00']);
  assert.equal(JSON.stringify(data.config), JSON.stringify({ salonName: 'B', openTime: '09:00' })); // sandbox objects: compare by value
  applyOp(data, { method: 'PUT', col: 'appointments', item: { id: 3, time: '12:00' } }); // replaying twice is harmless
  assert.equal(data.appointments.length, 2);
});

test('applyOp replays bulk changes (CSV import, bulk delete)', () => {
  const data = { clients: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }] };
  applyOp(data, { method: 'PUT', col: 'clients', items: [{ id: 2, name: 'B2' }, { id: 4, name: 'D' }] });
  applyOp(data, { method: 'DELETE', col: 'clients', ids: [1, 3, 99] });
  assert.equal(JSON.stringify(data.clients.map((c) => c.name)), JSON.stringify(['B2', 'D']));
});

test('clashes finds overlaps on the same day only', () => {
  const list = [
    { id: 1, date: '2026-10-20', time: '10:00', duration: 90 }, // 10:00-11:30
    { id: 2, date: '2026-10-20', time: '11:00', duration: 30 }, // overlaps 1
    { id: 3, date: '2026-10-20', time: '11:30', duration: 30 }, // starts when 1 ends: fine
    { id: 4, date: '2026-10-21', time: '10:00', duration: 30 }, // other day
    { id: 5, date: '2026-10-20', time: '15:00', duration: 30, end: '10:30' }, // stale end after an edit: ignored
  ];
  assert.deepEqual(clashes(list, list[0]).map((a) => a.id), [2]);
  assert.deepEqual(clashes(list, list[2]).map((a) => a.id), []);
  assert.deepEqual(clashes(list, list[3]).map((a) => a.id), []);
  assert.deepEqual(clashes(list, list[4]).map((a) => a.id), []);
});
