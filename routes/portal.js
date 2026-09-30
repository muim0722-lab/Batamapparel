'use strict';
const express = require('express');
const { db, setting, settingLines } = require('../lib/db');
const portal = require('../lib/portal');
const auth = require('../lib/auth');
const util = require('../lib/util');
const router = express.Router();

router.use((req, res, next) => {
  res.locals.portalBase = res.locals.base + '/track';
  res.locals.purl = (p) => res.locals.portalBase + (p.startsWith('/') ? p : '/' + p);
  res.locals.customer = null;
  res.locals.portalGreeting = setting('portal_greeting', '');
  next();
});

router.get('/', (req, res) => {
  const c = portal.current(req);
  if (c) return res.redirect(res.locals.purl('/beranda'));
  res.render('portal/login', {
    title: 'Lacak Pesanan', error: !!req.query.err, open: req.query.kirim === '1'
  });
});

router.post('/', (req, res) => {
  const c = portal.authenticate(req.body.phone, req.body.code);
  if (!c) return res.redirect(res.locals.purl('/?err=1'));
  const token = portal.createSession(c.id);
  portal.setCookie(req, res, token, res.locals.base);
  res.redirect(res.locals.purl('/beranda'));
});

/** Tautan langsung dari admin ke customer: /track/<token> */
router.get('/l/:token', (req, res) => {
  const token = String(req.params.token || '');
  const c = db.prepare('SELECT * FROM customers WHERE portal_token = ?').get(token);
  if (!c || !c.portal_active) {
    return res.status(404).render('portal/error', {
      title: 'Tautan tidak berlaku', code: 404,
      message: 'Tautan lacak pesanan ini sudah tidak aktif. Silakan minta tautan baru ke admin Batam Apparel, atau masuk dengan No. HP dan No. Invoice Anda.'
    });
  }
  const s = portal.createSession(c.id);
  portal.setCookie(req, res, s, res.locals.base);
  res.redirect(res.locals.purl('/beranda'));
});

router.get('/beranda', portal.requireCustomer, (req, res) => {
  if (req.query.kirim === '1') {
    db.prepare('UPDATE customers SET portal_open = 0 WHERE id = ?').run(req.customer.id);
  }
  const projects = portal.customerProjects(req.customer.id).map(p => ({
    ...p,
    info: util.deadlineInfo(p.deadline, p.status, 9999),
    progress: p.total_stages ? Math.round((p.done_stages || 0) / p.total_stages * 100) : 0
  }));
  const sales = portal.customerSales(req.customer.id).slice(0, 20);
  res.render('portal/home', {
    title: 'Pesanan Saya', projects, sales,
    stats: {
      aktif: projects.filter(p => ['Baru', 'Proses', 'Revisi'].includes(p.status)).length,
      selesai: projects.filter(p => p.status === 'Selesai').length,
      piutang: sales.reduce((a, s) => a + (util.num(s.total) - util.num(s.paid)), 0)
    }
  });
});

router.get('/proyek/:id', portal.requireCustomer, (req, res) => {
  const p = portal.customerProject(req.customer.id, util.num(req.params.id));
  if (!p) {
    return res.status(404).render('portal/error', {
      title: 'Project tidak ditemukan', code: 404,
      message: 'Project ini bukan milik akun Anda atau sudah tidak ada.'
    });
  }
  p.info = util.deadlineInfo(p.deadline, p.status, 9999);
  res.render('portal/project', { title: 'Project ' + p.code, p });
});

router.get('/nota/:id', portal.requireCustomer, (req, res) => {
  const row = portal.saleDetail(req.customer.id, util.num(req.params.id));
  if (!row) {
    return res.status(404).render('portal/error', {
      title: 'Nota tidak ditemukan', code: 404, message: 'Nota ini bukan milik akun Anda.'
    });
  }
  const sisa = util.num(row.total) - util.num(row.paid);
  const pembayaran = row.payments.map(p => ({
    ...p,
    type: p.kind === 'DP' ? 'Down Payment' : p.kind
  }));
  res.render('portal/nota', { title: 'Invoice ' + row.number, row, sisa, pembayaran });
});

router.post('/keluar', (req, res) => {
  portal.destroySession(portal.parseCookies(req.headers.cookie)[portal.COOKIE]);
  portal.clearCookie(req, res, res.locals.base);
  res.redirect(res.locals.purl('/'));
});
router.get('/keluar', (req, res) => {
  portal.destroySession(portal.parseCookies(req.headers.cookie)[portal.COOKIE]);
  portal.clearCookie(req, res, res.locals.base);
  res.redirect(res.locals.purl('/'));
});

module.exports = router;
