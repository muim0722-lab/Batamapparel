'use strict';
const crypto = require('crypto');
const { db } = require('./db');

const COOKIE = 'ba_customer';
const SESSION_DAYS = 30;

/** Hanya angka — untuk mencocokkan nomor HP yang ditulis dengan format berbeda */
function phoneKey(v) {
  return String(v || '').replace(/\D/g, '');
}
function phoneMatch(a, b) {
  const x = phoneKey(a), y = phoneKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (y.length >= 8 && x.endsWith(y)) return true;
  if (x.length >= 8 && y.endsWith(x)) return true;
  return false;
}
/** 08xx… → 628xx… untuk tautan WhatsApp */
function waNumber(phone) {
  let d = phoneKey(phone);
  if (!d) return '';
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return d;
}

function regenerate(customerId) {
  const token = crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE customers SET portal_token = ?, portal_active = 1, portal_open = 1 WHERE id = ?')
    .run(token, customerId);
  return token;
}
function ensureToken(customerId) {
  const c = db.prepare('SELECT id, portal_token, portal_active FROM customers WHERE id = ?').get(customerId);
  if (!c) return null;
  if (!c.portal_token || !c.portal_active) return regenerate(customerId);
  return c.portal_token;
}
function closePortal(customerId) {
  db.prepare('UPDATE customers SET portal_active = 0, portal_last = ? WHERE id = ?')
    .run(new Date().toISOString().slice(0, 19).replace('T', ' '), customerId);
}
function openPortal(customerId) {
  db.prepare('UPDATE customers SET portal_active = 1 WHERE id = ?').run(customerId);
}

function createSession(customerId) {
  const token = crypto.randomBytes(28).toString('hex');
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO customer_sessions(token, customer_id, expires_at) VALUES (?, ?, ?)')
    .run(token, customerId, exp);
  db.prepare('UPDATE customers SET portal_last = ? WHERE id = ?')
    .run(new Date().toISOString().slice(0, 19).replace('T', ' '), customerId);
  return token;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM customer_sessions WHERE token = ?').run(token);
}
function purgeSessions() {
  db.prepare("DELETE FROM customer_sessions WHERE expires_at < datetime('now','localtime')").run();
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setCookie(req, res, token, base) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', maxAge: SESSION_DAYS * 86400000,
    path: (base || '') + '/'
  });
}
function clearCookie(req, res, base) {
  res.clearCookie(COOKIE, { path: (base || '') + '/' });
  res.clearCookie(COOKIE, { path: '/' });
}

/** Ambil customer yang sedang login dari cookie */
function current(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT cs.token, cs.expires_at, c.* FROM customer_sessions cs
    JOIN customers c ON c.id = cs.customer_id
    WHERE cs.token = ?
  `).get(token);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) {
    destroySession(token);
    return null;
  }
  if (!row.portal_active) return null;
  return row;
}

/** Login via No. HP + (No. Invoice / Kode Project) */
function authenticate(phone, code) {
  const key = phoneKey(phone);
  const needle = String(code || '').trim().toUpperCase();
  if (key.length < 8 || !needle) return null;
  const customers = db.prepare('SELECT * FROM customers').all()
    .filter(c => c.portal_active !== 0 && phoneMatch(c.phone, key));
  for (const c of customers) {
    const proj = db.prepare(`
      SELECT id FROM projects WHERE customer_id = ?
        AND (upper(code) = ? OR upper(name) = ?)
      LIMIT 1
    `).get(c.id, needle, needle);
    if (proj) return c;
    const sale = db.prepare(`
      SELECT id FROM sales WHERE customer_id = ? AND upper(number) = ? LIMIT 1
    `).get(c.id, needle);
    if (sale) return c;
  }
  return null;
}

/** Daftar project milik satu customer (hanya miliknya sendiri) */
function customerProjects(customerId) {
  return db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id AND pp.status = 'Selesai') AS done_stages,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id) AS total_stages,
      (SELECT st.name FROM project_progress pp JOIN stages st ON st.id = pp.stage_id
        WHERE pp.project_id = p.id AND pp.status = 'Proses' ORDER BY st.sort_order LIMIT 1) AS current_stage
    FROM projects p
    WHERE p.customer_id = ?
    ORDER BY CASE WHEN p.status IN ('Selesai','Batal') THEN 1 ELSE 0 END, p.order_date DESC, p.id DESC
  `).all(customerId);
}
function customerProject(customerId, projectId) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND customer_id = ?').get(projectId, customerId);
  if (!p) return null;
  p.stages = db.prepare(`
    SELECT pp.*, st.name AS stage_name, st.sort_order, us.name AS oleh
    FROM project_progress pp JOIN stages st ON st.id = pp.stage_id
    LEFT JOIN users us ON us.id = pp.user_id
    WHERE pp.project_id = ? ORDER BY st.sort_order, st.id
  `).all(projectId);
  p.logs = db.prepare(`
    SELECT l.*, u.name AS oleh FROM project_logs l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.project_id = ? AND l.status != 'Belum' ORDER BY l.id DESC LIMIT 12
  `).all(projectId);
  p.addons = db.prepare('SELECT * FROM addons WHERE active = 1 ORDER BY sort_order, id').all();
  const st = db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN status = \'Selesai\' THEN 1 ELSE 0 END) done FROM project_progress WHERE project_id = ?').get(projectId);
  p.doneStages = st.done || 0;
  p.totalStages = st.total || 0;
  p.progress = p.totalStages ? Math.round(p.doneStages / p.totalStages * 100) : 0;
  return p;
}
function customerSales(customerId) {
  return db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
           pr.code AS project_code, pr.name AS project_name, u.name AS oleh
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN projects pr ON pr.id = s.project_id LEFT JOIN users u ON u.id = s.user_id
    WHERE s.customer_id = ? ORDER BY s.date DESC, s.id DESC
  `).all(customerId);
}
function saleDetail(customerId, saleId) {
  const row = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
           pr.code AS project_code, pr.name AS project_name, u.name AS oleh
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN projects pr ON pr.id = s.project_id LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.customer_id = ?
  `).get(saleId, customerId);
  if (!row) return null;
  row.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId);
  row.payments = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY date, id').all(saleId);
  return row;
}
function requireCustomer(req, res, next) {
  const c = current(req);
  if (!c) return res.redirect(res.locals.url('/track'));
  req.customer = c;
  res.locals.customer = c;
  next();
}

module.exports = {
  COOKIE, phoneKey, phoneMatch, waNumber, ensureToken, regenerate, closePortal, openPortal,
  createSession, destroySession, purgeSessions, parseCookies, setCookie, clearCookie,
  current, authenticate, customerProjects, customerProject, customerSales, saleDetail, requireCustomer
};
