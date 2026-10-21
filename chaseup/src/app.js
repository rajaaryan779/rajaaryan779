import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword, verifyPassword, newToken, hashToken } from './auth.js';
import { draftReminder, daysBetween } from './reminders.js';

const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const SESSION_DAYS = 30;
const MAX_BODY = 64 * 1024;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const str = (v, field, max = 200) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${field} is required (max ${max} chars)`);
  return v.trim();
};
const date = (v, field) => {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) throw bad(`${field} must be YYYY-MM-DD`);
  return v;
};

export function createApp({ db, now = () => new Date(), draft = draftReminder, secureCookie = false }) {
  const today = () => now().toISOString().slice(0, 10);
  const loginFails = new Map(); // ip -> { count, resetAt }

  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const run = (sql, ...p) => db.prepare(sql).run(...p);

  function createSession(userId, res) {
    const token = newToken();
    const expires = new Date(now().getTime() + SESSION_DAYS * 86400000);
    run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', hashToken(token), userId, expires.toISOString());
    res.setHeader('Set-Cookie',
      `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secureCookie ? '; Secure' : ''}`);
  }

  function currentUser(req) {
    const m = /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.cookie || '');
    if (!m) return null;
    return one(
      `SELECT u.id, u.email, u.name, u.business_name, u.currency FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      hashToken(m[1]), now().toISOString()) || null;
  }

  async function readJson(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'JSON required');
    let size = 0; const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Body too large');
      chunks.push(c);
    }
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw 0;
      return v;
    } catch { throw bad('Invalid JSON'); }
  }

  const invoiceSelect = `SELECT i.id, i.client_id, c.name AS client_name, c.email AS client_email, i.number,
      i.amount_minor, i.issued_on, i.due_on, i.status, i.paid_on,
      (SELECT COUNT(*) FROM reminders r WHERE r.invoice_id = i.id) AS reminders_sent
    FROM invoices i JOIN clients c ON c.id = i.client_id`;
  const withOverdue = (inv) => ({
    ...inv,
    days_overdue: inv.status === 'open' ? Math.max(0, daysBetween(inv.due_on, today())) : 0,
  });

  const routes = [];
  const route = (method, path, auth, handler) =>
    routes.push({ method, re: new RegExp(`^${path.replace(/:id/g, '(\\d+)')}$`), auth, handler });

  route('POST', '/api/signup', false, async (req, res) => {
    const b = await readJson(req);
    const email = str(b.email, 'email', 254).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad('Invalid email');
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) throw bad('Password must be 8+ characters');
    const currency = (b.currency ?? 'INR').toString().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw bad('Invalid currency');
    if (one('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'Email already registered');
    const r = run('INSERT INTO users (email,name,business_name,currency,password_hash,created_at) VALUES (?,?,?,?,?,?)',
      email, str(b.name, 'name', 100), str(b.business_name, 'business_name', 100), currency, hashPassword(b.password), now().toISOString());
    createSession(Number(r.lastInsertRowid), res);
    return [201, { id: Number(r.lastInsertRowid), email }];
  });

  route('POST', '/api/login', false, async (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    const f = loginFails.get(ip);
    if (f && f.count >= 10 && f.resetAt > Date.now()) throw new HttpError(429, 'Too many attempts, try later');
    const b = await readJson(req);
    const user = typeof b.email === 'string' ? one('SELECT * FROM users WHERE email = ?', b.email.toLowerCase()) : null;
    if (!user || typeof b.password !== 'string' || !verifyPassword(b.password, user.password_hash)) {
      const cur = f && f.resetAt > Date.now() ? f : { count: 0, resetAt: Date.now() + 15 * 60000 };
      cur.count++; loginFails.set(ip, cur);
      throw new HttpError(401, 'Wrong email or password');
    }
    loginFails.delete(ip);
    createSession(user.id, res);
    return [200, { ok: true }];
  });

  route('POST', '/api/logout', true, async (req, res) => {
    const m = /sid=([0-9a-f]{64})/.exec(req.headers.cookie || '');
    if (m) run('DELETE FROM sessions WHERE token_hash = ?', hashToken(m[1]));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return [200, { ok: true }];
  });

  route('GET', '/api/me', true, async (req, res, user) => [200, user]);

  route('GET', '/api/clients', true, async (req, res, user) => [200, q(
    `SELECT c.id, c.name, c.email,
       COALESCE(SUM(CASE WHEN i.status='open' THEN i.amount_minor END),0) AS outstanding_minor
     FROM clients c LEFT JOIN invoices i ON i.client_id = c.id WHERE c.user_id = ? GROUP BY c.id ORDER BY c.name`, user.id)]);

  route('POST', '/api/clients', true, async (req, res, user) => {
    const b = await readJson(req);
    const email = b.email ? str(b.email, 'email', 254) : '';
    const r = run('INSERT INTO clients (user_id,name,email,created_at) VALUES (?,?,?,?)',
      user.id, str(b.name, 'name', 100), email, now().toISOString());
    return [201, { id: Number(r.lastInsertRowid) }];
  });

  route('DELETE', '/api/clients/:id', true, async (req, res, user, id) => {
    const c = one('SELECT id FROM clients WHERE id = ? AND user_id = ?', id, user.id);
    if (!c) throw new HttpError(404, 'Not found');
    if (one('SELECT 1 FROM invoices WHERE client_id = ?', id)) throw new HttpError(409, 'Client has invoices');
    run('DELETE FROM clients WHERE id = ?', id);
    return [200, { ok: true }];
  });

  route('GET', '/api/invoices', true, async (req, res, user) =>
    [200, q(`${invoiceSelect} WHERE i.user_id = ? ORDER BY i.due_on DESC, i.id DESC`, user.id).map(withOverdue)]);

  route('POST', '/api/invoices', true, async (req, res, user) => {
    const b = await readJson(req);
    const clientId = Number.isInteger(b.client_id) ? b.client_id : 0;
    if (!one('SELECT 1 FROM clients WHERE id = ? AND user_id = ?', clientId, user.id)) throw bad('Unknown client');
    const amount = Math.round(Number(b.amount) * 100);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw bad('amount must be a positive number');
    const due = date(b.due_on, 'due_on');
    // Backfilled invoices are usually already overdue, so don't default the issue date past the due date.
    const issued = b.issued_on ? date(b.issued_on, 'issued_on') : (due < today() ? due : today());
    if (due < issued) throw bad('due_on cannot be before issued_on');
    const number = str(b.number, 'number', 50);
    if (one('SELECT 1 FROM invoices WHERE user_id = ? AND number = ?', user.id, number)) throw new HttpError(409, 'Invoice number already used');
    const r = run('INSERT INTO invoices (user_id,client_id,number,amount_minor,issued_on,due_on) VALUES (?,?,?,?,?,?)',
      user.id, clientId, number, amount, issued, due);
    return [201, { id: Number(r.lastInsertRowid) }];
  });

  const ownedOpenInvoice = (id, user) => {
    const inv = one(`${invoiceSelect} WHERE i.id = ? AND i.user_id = ?`, id, user.id);
    if (!inv) throw new HttpError(404, 'Not found');
    return inv;
  };

  route('POST', '/api/invoices/:id/paid', true, async (req, res, user, id) => {
    const inv = ownedOpenInvoice(id, user);
    if (inv.status !== 'open') throw new HttpError(409, `Invoice is ${inv.status}`);
    run("UPDATE invoices SET status='paid', paid_on=? WHERE id=?", today(), id);
    return [200, { ok: true }];
  });

  route('POST', '/api/invoices/:id/void', true, async (req, res, user, id) => {
    const inv = ownedOpenInvoice(id, user);
    if (inv.status !== 'open') throw new HttpError(409, `Invoice is ${inv.status}`);
    run("UPDATE invoices SET status='void' WHERE id=?", id);
    return [200, { ok: true }];
  });

  route('POST', '/api/invoices/:id/reminder/draft', true, async (req, res, user, id) => {
    const inv = withOverdue(ownedOpenInvoice(id, user));
    if (inv.status !== 'open') throw new HttpError(409, `Invoice is ${inv.status}`);
    const d = await draft({
      user, client: { name: inv.client_name, email: inv.client_email },
      invoice: inv, daysOverdue: daysBetween(inv.due_on, today()),
    });
    return [200, { ...d, to: inv.client_email }];
  });

  route('POST', '/api/invoices/:id/reminder/log', true, async (req, res, user, id) => {
    const inv = ownedOpenInvoice(id, user);
    if (inv.status !== 'open') throw new HttpError(409, `Invoice is ${inv.status}`);
    const b = await readJson(req);
    run('INSERT INTO reminders (invoice_id,user_id,tone,subject,body,sent_at) VALUES (?,?,?,?,?,?)',
      id, user.id, str(b.tone, 'tone', 20), str(b.subject, 'subject', 300), str(b.body, 'body', 5000), now().toISOString());
    return [201, { ok: true }];
  });

  route('GET', '/api/dashboard', true, async (req, res, user) => {
    const t = today();
    const s = one(
      `SELECT
         COALESCE(SUM(CASE WHEN status='open' THEN amount_minor END),0) AS outstanding_minor,
         COALESCE(SUM(CASE WHEN status='open' AND due_on < ? THEN amount_minor END),0) AS overdue_minor,
         COALESCE(SUM(CASE WHEN status='open' AND due_on < ? THEN 1 END),0) AS overdue_count,
         COALESCE(SUM(CASE WHEN status='paid' AND substr(paid_on,1,7)=? THEN amount_minor END),0) AS collected_month_minor
       FROM invoices WHERE user_id = ?`, t, t, t.slice(0, 7), user.id);
    const needsChase = q(`${invoiceSelect} WHERE i.user_id = ? AND i.status='open' AND i.due_on < ? ORDER BY i.due_on LIMIT 10`, user.id, t).map(withOverdue);
    return [200, { currency: user.currency, ...s, needs_chase: needsChase }];
  });

  async function serveStatic(req, res) {
    const url = new URL(req.url, 'http://x');
    const rel = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !MIME[extname(file)]) throw new HttpError(404, 'Not found');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)], 'x-content-type-options': 'nosniff' });
      res.end(data);
    } catch { throw new HttpError(404, 'Not found'); }
  }

  return async function handler(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, 'http://x').pathname;
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
        return await serveStatic(req, res);
      }
      for (const r of routes) {
        const m = r.re.exec(path);
        if (!m || r.method !== req.method) continue;
        let user = null;
        if (r.auth) { user = currentUser(req); if (!user) throw new HttpError(401, 'Not signed in'); }
        const [status, body] = await r.handler(req, res, user, ...m.slice(1).map(Number));
        return send(status, body);
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      return send(500, { error: 'Internal error' });
    }
  };
}
