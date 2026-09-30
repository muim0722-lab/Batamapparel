'use strict';
const crypto = require('crypto');
const { db, setting, setSetting } = require('./db');
const password = require('./password');

const COOKIE = 'ba_session';
const SESSION_DAYS = 7;

const ROLES = {
  owner: { label: 'Owner', desc: 'Akses penuh: semua laporan (termasuk Laba Rugi & Arus Kas), user & pengaturan' },
  leader: { label: 'Leader', desc: 'Input, edit, hapus, laporan operasional & pengaturan (tanpa Laba Rugi/Arus Kas/Ringkasan)' },
  admin: { label: 'Admin', desc: 'Input & edit transaksi, tanpa akses laporan keuangan' },
  staff: { label: 'Staff', desc: 'Hanya input transaksi baru (tanpa edit/hapus/laporan)' }
};

const PERMS = {
  // report     = boleh membuka menu Laporan (operasional)
  // reportFin  = boleh membuka laporan keuangan inti: Ringkasan, Laba Rugi, Arus Kas
  owner: { input: 1, edit: 1, del: 1, report: 1, reportFin: 1, master: 1, users: 1, settings: 1, stage: 1, project: 1 },
  leader: { input: 1, edit: 1, del: 1, report: 1, reportFin: 0, master: 1, users: 0, settings: 1, stage: 1, project: 1 },
  admin: { input: 1, edit: 1, del: 0, report: 0, reportFin: 0, master: 1, users: 0, settings: 0, stage: 0, project: 1 },
  staff: { input: 1, edit: 0, del: 0, report: 0, reportFin: 0, master: 0, users: 0, settings: 0, stage: 0, project: 1 }
};
const REPORT_ROLES = ['owner', 'leader'];
const REPORT_FIN_ROLES = ['owner'];
const USER_ROLES = ['owner'];

function perms(role) { return PERMS[role] || PERMS.staff; }
function can(role, key) { return !!(perms(role)[key]); }
function canReport(role) { return REPORT_ROLES.includes(role); }
function canReportFin(role) { return REPORT_FIN_ROLES.includes(role); }
function canManageUsers(role) { return USER_ROLES.includes(role); }
function roleLabel(role) { return (ROLES[role] || { label: role }).label; }

function hashPassword(pw) { return password.hashPassword(pw); }
function verifyPassword(pw, stored) { return password.verifyPassword(pw, stored); }

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions(token, user_id, expires_at, show_reminder) VALUES (?, ?, ?, 1)')
    .run(token, userId, expires.toISOString().slice(0, 19).replace('T', ' '));
  return token;
}
function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
function purgeSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now','localtime')`).run();
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function basePath(req) {
  const h = req.headers['x-public-base-path'];
  return typeof h === 'string' ? h.replace(/\/+$/, '') : '';
}

function setSessionCookie(req, res, token) {
  const base = basePath(req);
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_DAYS * 86400000,
    path: (base ? base : '') + '/'
  });
}
function clearSessionCookie(req, res) {
  const base = basePath(req);
  res.clearCookie(COOKIE, { path: (base ? base : '') + '/' });
  res.clearCookie(COOKIE, { path: '/' });
}

function setFlash(res, type, message) {
  if (!res.locals.sessionToken) return;
  try {
    db.prepare('UPDATE sessions SET flash = ? WHERE token = ?')
      .run(JSON.stringify({ t: type, m: message }), res.locals.sessionToken);
  } catch { /* ignore */ }
}
function takeFlash(req, res) {
  if (!res.locals.sessionToken) return null;
  const row = db.prepare('SELECT flash FROM sessions WHERE token = ?').get(res.locals.sessionToken);
  if (row && row.flash) {
    db.prepare('UPDATE sessions SET flash = ? WHERE token = ?').run('', res.locals.sessionToken);
    try { return JSON.parse(row.flash); } catch { return null; }
  }
  return null;
}

/** middleware: muat user dari session */
function middleware(req, res, next) {
  const base = basePath(req);
  res.locals.base = base;
  res.locals.user = null;
  res.locals.perm = perms('staff');
  res.locals.canReport = false;
  res.locals.canReportFin = false;
  res.locals.canManageUsers = false;
  res.locals.roles = ROLES;
  res.locals.permsAll = PERMS; // matriks hak akses untuk ditampilkan di halaman profil
  res.locals.roleLabel = roleLabel;
  res.locals.company = setting('company_name', 'Batam Apparel');
  res.locals.tagline = setting('company_tagline', '');
  res.locals.url = (p) => base + (p.startsWith('/') ? p : '/' + p);
  res.locals.flash = null;
  res.locals.warnDays = parseInt(setting('deadline_warning_days', '3'), 10) || 3;
  res.locals.active = req.path;

  const token = parseCookies(req.headers.cookie)[COOKIE];
  res.locals.sessionToken = token || '';
  req.sessionToken = token || '';
  if (token) {
    const row = db.prepare(`
      SELECT s.token, s.expires_at, u.id, u.name, u.username, u.role, u.active, u.phone
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);
    if (row && row.active && row.expires_at >= new Date().toISOString().slice(0, 19).replace('T', ' ')) {
      req.user = row;
      res.locals.user = row;
      res.locals.perm = perms(row.role);
      res.locals.canReport = canReport(row.role);
      res.locals.canReportFin = canReportFin(row.role);
      res.locals.canManageUsers = canManageUsers(row.role);
    } else {
      clearSessionCookie(req, res);
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.method === 'GET' && req.originalUrl && req.originalUrl !== '/') {
      return res.redirect(res.locals.url('/login?next=' + encodeURIComponent(req.originalUrl)));
    }
    return res.redirect(res.locals.url('/login'));
  }
  next();
}
function requirePerm(key) {
  return (req, res, next) => {
    if (!req.user) return res.redirect(res.locals.url('/login'));
    if (!can(req.user.role, key)) {
      return res.status(403).render('error', {
        title: 'Akses Ditolak',
        code: 403,
        message: 'Role ' + roleLabel(req.user.role) + ' tidak memiliki hak akses untuk halaman ini.'
      });
    }
    next();
  };
}
function requireReport(req, res, next) {
  if (!req.user) {
    return res.redirect(res.locals.url('/login?next=' + encodeURIComponent(req.originalUrl || '/laporan')));
  }
  if (!canReport(req.user.role)) {
    return res.status(403).render('error', {
      title: 'Akses Laporan Ditolak',
      code: 403,
      message: 'Laporan hanya dapat diakses oleh Leader dan Owner. Role Anda: ' + roleLabel(req.user.role) + '.'
    });
  }
  next();
}

/** Laporan keuangan inti (Ringkasan, Laba Rugi, Arus Kas) — khusus Owner */
function requireReportFin(req, res, next) {
  if (!req.user) {
    return res.redirect(res.locals.url('/login?next=' + encodeURIComponent(req.originalUrl || '/laporan')));
  }
  if (!canReportFin(req.user.role)) {
    // Leader diarahkan ke laporan yang memang boleh dibuka, bukan halaman error
    if (canReport(req.user.role)) return res.redirect(res.locals.url('/laporan/penjualan'));
    return res.status(403).render('error', {
      title: 'Akses Laporan Ditolak',
      code: 403,
      message: 'Laporan ini hanya dapat diakses oleh Owner. Role Anda: ' + roleLabel(req.user.role) + '.'
    });
  }
  next();
}

module.exports = {
  COOKIE, ROLES, PERMS, perms, can, canReport, canReportFin, canManageUsers, roleLabel,
  hashPassword, verifyPassword, createSession, destroySession, purgeSessions,
  middleware, requireLogin, requirePerm, requireReport, requireReportFin, setFlash, takeFlash,
  setSessionCookie, clearSessionCookie, parseCookies, basePath,
  markSetupDone: () => setSetting('setup_done', '1')
};
