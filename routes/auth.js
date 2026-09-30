'use strict';
const express = require('express');
const { db, setting } = require('../lib/db');
const auth = require('../lib/auth');
const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(res.locals.url('/dashboard'));
  // Tampilkan akun awal selama password default belum diganti oleh pemiliknya
  const demoUsers = db.prepare('SELECT username, role, password_hash FROM users WHERE active = 1 ORDER BY id')
    .all()
    .filter(u => auth.verifyPassword(u.username + '123', u.password_hash))
    .map(u => ({ username: u.username, role: u.role }));
  res.render('login', {
    title: 'Masuk',
    error: req.query.err ? 'Username atau password salah.' : null,
    next: typeof req.query.next === 'string' ? req.query.next : '',
    demoUsers
  });
});

router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const back = res.locals.url('/login');
  if (!username || !password) return res.redirect(back + '?err=1');

  const user = db.prepare('SELECT * FROM users WHERE lower(username) = ?').get(username);
  if (!user || !user.active || !auth.verifyPassword(password, user.password_hash)) {
    return res.redirect(back + '?err=1');
  }
  auth.purgeSessions();
  const token = auth.createSession(user.id);
  auth.setSessionCookie(req, res, token);
  if (setting('setup_done', '0') !== '1') auth.markSetupDone();

  let next = String(req.body.next || '');
  if (!next || !next.startsWith('/') || next.startsWith('//')) next = '/dashboard';
  res.redirect(res.locals.url(next));
});

router.get('/logout', (req, res) => {
  auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(req, res);
  res.redirect(res.locals.url('/login'));
});

router.get('/profil', auth.requireLogin, (req, res) => {
  res.render('profil', { title: 'Profil & Password' });
});

router.post('/profil/password', auth.requireLogin, (req, res) => {
  const oldPw = String(req.body.old_password || '');
  const newPw = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(oldPw, row.password_hash)) {
    auth.setFlash(res, 'error', 'Password lama tidak sesuai.');
  } else if (newPw.length < 6) {
    auth.setFlash(res, 'error', 'Password baru minimal 6 karakter.');
  } else if (newPw !== confirm) {
    auth.setFlash(res, 'error', 'Konfirmasi password baru tidak sama.');
  } else {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(newPw), req.user.id);
    auth.setFlash(res, 'success', 'Password berhasil diperbarui.');
  }
  res.redirect(res.locals.url('/profil'));
});

router.post('/profil/info', auth.requireLogin, (req, res) => {
  const name = String(req.body.name || '').trim();
  const phone = String(req.body.phone || '').trim();
  if (!name) auth.setFlash(res, 'error', 'Nama tidak boleh kosong.');
  else {
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, phone, req.user.id);
    auth.setFlash(res, 'success', 'Data profil diperbarui.');
  }
  res.redirect(res.locals.url('/profil'));
});

module.exports = router;
