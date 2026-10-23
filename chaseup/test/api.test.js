import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { templateDraft, draftReminder, toneFor } from '../src/reminders.js';

async function start(nowIso = '2026-10-21T10:00:00Z') {
  const db = openDb();
  const server = createServer(createApp({ db, now: () => new Date(nowIso) }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body, raw) => {
      const res = await fetch(base + path, {
        method,
        headers: { ...(raw ? {} : { 'content-type': 'application/json' }), cookie },
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => null) };
    };
  };
  return { client, base, close: () => server.close() };
}

const signup = (api, email = 'a@x.com') =>
  api('POST', '/api/signup', { email, password: 'password123', name: 'Asha', business_name: 'Asha Studio' });

test('auth: signup, me, logout, login, bad password', async () => {
  const s = await start(); const api = s.client();
  assert.equal((await api('GET', '/api/me')).status, 401);
  assert.equal((await signup(api)).status, 201);
  assert.equal((await api('GET', '/api/me')).json.business_name, 'Asha Studio');
  assert.equal((await signup(s.client())).status, 409);
  await api('POST', '/api/logout', {});
  assert.equal((await api('GET', '/api/me')).status, 401);
  assert.equal((await api('POST', '/api/login', { email: 'a@x.com', password: 'nope-nope' })).status, 401);
  assert.equal((await api('POST', '/api/login', { email: 'a@x.com', password: 'password123' })).status, 200);
  assert.equal((await api('GET', '/api/me')).status, 200);
  s.close();
});

test('validation: weak password, non-JSON body, bad dates and amounts', async () => {
  const s = await start(); const api = s.client();
  assert.equal((await api('POST', '/api/signup', { email: 'a@x.com', password: 'short', name: 'A', business_name: 'B' })).status, 400);
  assert.equal((await api('POST', '/api/signup', 'x=1', true)).status, 415);
  await signup(api);
  const c = (await api('POST', '/api/clients', { name: 'Acme', email: 'pay@acme.com' })).json.id;
  const base = { client_id: c, number: 'INV-1', amount: 100, due_on: '2026-11-01' };
  assert.equal((await api('POST', '/api/invoices', { ...base, amount: -5 })).status, 400);
  assert.equal((await api('POST', '/api/invoices', { ...base, due_on: 'tomorrow' })).status, 400);
  assert.equal((await api('POST', '/api/invoices', { ...base, due_on: '2026-01-01', issued_on: '2026-02-01' })).status, 400);
  assert.equal((await api('POST', '/api/invoices', base)).status, 201);
  assert.equal((await api('POST', '/api/invoices', base)).status, 409);
  s.close();
});

test('backfilling an already-overdue invoice without an issue date works', async () => {
  const s = await start(); const api = s.client();
  await signup(api);
  const c = (await api('POST', '/api/clients', { name: 'Acme' })).json.id;
  const r = await api('POST', '/api/invoices', { client_id: c, number: 'OLD-1', amount: 10, due_on: '2026-01-01' });
  assert.equal(r.status, 201);
  assert.equal((await api('GET', '/api/invoices')).json[0].issued_on, '2026-01-01');
  s.close();
});

test('invoices, dashboard totals, mark paid', async () => {
  const s = await start(); const api = s.client();
  await signup(api);
  const c = (await api('POST', '/api/clients', { name: 'Acme', email: 'pay@acme.com' })).json.id;
  const mk = async (number, amount, due) =>
    (await api('POST', '/api/invoices', { client_id: c, number, amount, due_on: due, issued_on: '2026-09-01' })).json.id;
  const overdue = await mk('1', 1000.5, '2026-10-01');
  await mk('2', 200, '2026-12-01');
  const paid = await mk('3', 300, '2026-10-05');
  await api('POST', `/api/invoices/${paid}/paid`);
  let d = (await api('GET', '/api/dashboard')).json;
  assert.equal(d.outstanding_minor, 100050 + 20000);
  assert.equal(d.overdue_minor, 100050);
  assert.equal(d.overdue_count, 1);
  assert.equal(d.collected_month_minor, 30000);
  assert.equal(d.needs_chase[0].days_overdue, 20);
  assert.equal((await api('POST', `/api/invoices/${paid}/paid`)).status, 409);
  await api('POST', `/api/invoices/${overdue}/void`);
  d = (await api('GET', '/api/dashboard')).json;
  assert.equal(d.overdue_count, 0);
  assert.equal((await api('DELETE', `/api/clients/${c}`)).status, 409);
  s.close();
});

test('tenant isolation: other users cannot see or touch my data', async () => {
  const s = await start(); const a = s.client(); const b = s.client();
  await signup(a, 'a@x.com'); await signup(b, 'b@x.com');
  const c = (await a('POST', '/api/clients', { name: 'Acme' })).json.id;
  const inv = (await a('POST', '/api/invoices', { client_id: c, number: '1', amount: 5, due_on: '2026-10-01' })).json.id;
  assert.deepEqual((await b('GET', '/api/invoices')).json, []);
  assert.equal((await b('POST', `/api/invoices/${inv}/paid`)).status, 404);
  assert.equal((await b('POST', `/api/invoices/${inv}/reminder/draft`)).status, 404);
  assert.equal((await b('DELETE', `/api/clients/${c}`)).status, 404);
  assert.equal((await b('POST', '/api/invoices', { client_id: c, number: '9', amount: 5, due_on: '2026-10-01' })).status, 400);
  s.close();
});

test('reminder draft + log', async () => {
  const s = await start(); const api = s.client();
  await signup(api);
  const c = (await api('POST', '/api/clients', { name: 'Acme', email: 'pay@acme.com' })).json.id;
  const inv = (await api('POST', '/api/invoices', { client_id: c, number: 'INV-7', amount: 5000, due_on: '2026-09-01', issued_on: '2026-08-01' })).json.id;
  const d = (await api('POST', `/api/invoices/${inv}/reminder/draft`, {})).json;
  assert.equal(d.tone, 'final');
  assert.equal(d.to, 'pay@acme.com');
  assert.match(d.body, /INV-7/);
  assert.equal((await api('POST', `/api/invoices/${inv}/reminder/log`, d)).status, 201);
  const list = (await api('GET', '/api/invoices')).json;
  assert.equal(list[0].reminders_sent, 1);
  s.close();
});

test('reminder templates and AI fallback', async () => {
  assert.equal(toneFor(-3), 'friendly'); assert.equal(toneFor(5), 'firm'); assert.equal(toneFor(30), 'final');
  const ctx = {
    user: { name: 'Asha', business_name: 'Studio', currency: 'INR' },
    client: { name: 'Acme' }, invoice: { number: '1', amount_minor: 10000, due_on: '2026-10-01' }, daysOverdue: 3,
  };
  assert.equal(templateDraft(ctx).tone, 'firm');
  assert.equal((await draftReminder(ctx, { apiKey: undefined })).source, 'template');
  const failing = async () => { throw new Error('network'); };
  assert.equal((await draftReminder(ctx, { apiKey: 'k', fetchImpl: failing })).source, 'template');
  const ok = async () => ({ ok: true, json: async () => ({ content: [{ text: 'Polished body' }] }) });
  const r = await draftReminder(ctx, { apiKey: 'k', fetchImpl: ok });
  assert.equal(r.source, 'ai'); assert.equal(r.body, 'Polished body');
});

test('static files served; path traversal blocked', async () => {
  const s = await start();
  const home = await fetch(s.base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /ChaseUp/);
  assert.equal((await fetch(s.base + '/app.js')).status, 200);
  assert.equal((await fetch(s.base + '/..%2fsrc%2fdb.js')).status, 404);
  assert.equal((await fetch(s.base + '/..%2fpackage.json')).status, 404);
  s.close();
});
