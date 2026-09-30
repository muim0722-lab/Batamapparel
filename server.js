'use strict';
// Zona waktu usaha (WIB) agar "hari ini", periode laporan, dan alarm deadline akurat
process.env.TZ = process.env.TZ || 'Asia/Jakarta';

const path = require('path');
const express = require('express');
const auth = require('./lib/auth');
const portal = require('./lib/portal');
const util = require('./lib/util');
const { setting, db, settingList, settingLines, settingNum } = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use(express.urlencoded({ extended: false, limit: '3mb' }));
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.use(auth.middleware);

// helper umum untuk view
app.use((req, res, next) => {
  res.locals.util = util;
  res.locals.q = req.query || {};
  res.locals.path = req.path;
  res.locals.year = new Date().getFullYear();
  res.locals.companyAddress = setting('company_address', '');
  res.locals.companyPhone = setting('company_phone', '');
  res.locals.companyEmail = setting('company_email', '');
  res.locals.alarmCount = () => {
    const wd = parseInt(setting('deadline_warning_days', '3'), 10) || 3;
    try {
      return db.prepare(`
        SELECT COUNT(*) c FROM projects
        WHERE status NOT IN ('Selesai','Batal') AND deadline IS NOT NULL AND deadline != ''
          AND date(deadline) <= date('now','localtime', '+' || ? || ' days')
      `).get(wd).c;
    } catch { return 0; }
  };
  res.locals.addonList = () => db.prepare('SELECT * FROM addons WHERE active = 1 ORDER BY sort_order, id').all();
  res.locals.settingNum = settingNum;
  // daftar satuan pembelian: dari Pengaturan + satuan bahan itu sendiri
  res.locals.purchaseUnitsFor = (matUnit, base) => {
    const list = (base || settingList('purchase_units', 'kg, meter, roll, yard, pcs, lusin')).slice();
    const u = String(matUnit || '').trim();
    if (u && !list.some(x => x.toLowerCase() === u.toLowerCase())) list.unshift(u);
    return list;
  };
  res.locals.setting = setting;
  res.locals.settingList = settingList;
  res.locals.settingLines = settingLines;
  res.locals.waNumber = portal.waNumber;
  res.locals.logoUrl = setting('logo_url', '');
  // Logo bawaan (vektor) dipakai bila belum ada logo unggahan dari user
  res.locals.logoSrc = setting('logo_url', '') || (res.locals.base + '/img/logo.svg');
  res.locals.invoiceOpts = () => ({
    sports: settingList('sport_options'), fabrics: settingList('fabric_options'),
    prints: settingList('print_options'), positions: settingList('position_options')
  });
  /** Link tracking customer (path publik, aman untuk domain apa pun) */
  res.locals.trackPath = (customerId) => {
    try {
      const token = portal.ensureToken(customerId);
      return token ? res.locals.base + '/track/l/' + token : '';
    } catch { return ''; }
  };
  /** Versi absolut untuk dibagikan (WA / salin), memakai host permintaan */
  res.locals.absUrl = (p) => {
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    return proto + '://' + host + (p.startsWith('/') ? p : '/' + p);
  };
  res.locals.portalOpenCount = () => {
    try { return db.prepare('SELECT COUNT(*) c FROM customers WHERE portal_open = 1 AND portal_token != \'\'').get().c; }
    catch { return 0; }
  };
  res.locals.qs = (patch = {}) => {
    const sp = new URLSearchParams();
    Object.entries(req.query || {}).forEach(([k, v]) => { if (v !== undefined && v !== '') sp.set(k, v); });
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null || v === undefined || v === '') sp.delete(k);
      else sp.set(k, v);
    });
    const s = sp.toString();
    return s ? '?' + s : '';
  };
  res.locals.flash = auth.takeFlash(req, res);
  next();
});

auth.purgeSessions();
portal.purgeSessions();

app.use('/track', require('./routes/portal'));
app.use('/', require('./routes/auth'));
app.use('/dashboard', require('./routes/dashboard'));
app.use('/projects', require('./routes/projects'));
app.use('/transaksi', require('./routes/transactions'));
app.use('/master', require('./routes/master'));
app.use('/laporan', require('./routes/reports'));

app.get('/panduan', auth.requireLogin, (req, res) => {
  res.render('panduan', { title: 'Panduan Pemakaian' });
});

app.get('/', (req, res) => res.redirect(res.locals.url('/dashboard')));

app.use((req, res) => {
  res.status(404).render('error', {
    title: 'Halaman Tidak Ditemukan', code: 404,
    message: 'Halaman yang Anda tuju tidak ada atau sudah dipindahkan.'
  });
});

app.use((err, req, res, next) => {
  console.error('[error]', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).render('error', {
    title: 'Terjadi Kesalahan', code: 500,
    message: (err && err.message) ? err.message : 'Kesalahan tidak terduga pada server.'
  });
});

process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

const server = app.listen(PORT, () => {
  console.log(`Batam Apparel Finance running on port ${PORT} (${setting('company_name')})`);
});
module.exports = { app, server };
