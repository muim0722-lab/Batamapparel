'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, setting, setSetting, settingList } = require('../lib/db');
const auth = require('../lib/auth');
const portal = require('../lib/portal');
const util = require('../lib/util');
const router = express.Router();

/* ---------- generic master CRUD ---------- */
function crud({ path, table, title, singular, fields, search = [], orderBy = 'name COLLATE NOCASE', refCheck = null, listExtra = null, makeFields = null }) {
  const cols = fields.filter(f => f.col !== false);
  const r = express.Router();

  r.get('/', auth.requireLogin, (req, res) => {
    const q = String(req.query.q || '').trim();
    let rows;
    if (q && search.length) {
      rows = db.prepare(`SELECT * FROM ${table} WHERE ${search.map(s => `${s} LIKE @q`).join(' OR ')} ORDER BY ${orderBy}`).all({ q: `%${q}%` });
    } else {
      rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    }
    const extra = listExtra ? listExtra(req, res) : {};
    res.render('master/list', { title, rows, cols, fields, base: '/master/' + path, singular, q, table, ...extra });
  });

  r.get('/baru', auth.requirePerm('input'), (req, res) => {
    res.render('master/form', { title: 'Tambah ' + singular, row: null, fields: makeFields ? makeFields(null) : fields, base: '/master/' + path, singular, table });
  });
  r.get('/:id/edit', auth.requirePerm('edit'), (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(util.num(req.params.id));
    if (!row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data tidak ada.' });
    res.render('master/form', { title: 'Edit ' + singular, row, fields: makeFields ? makeFields(row) : fields, base: '/master/' + path, singular, table });
  });

  r.post('/save', auth.requirePerm('input'), (req, res) => {
    const b = req.body; const id = util.num(b.id);
    if (id && !auth.can(req.user.role, 'edit')) {
      auth.setFlash(res, 'error', 'Role Anda tidak boleh mengedit data.');
      return res.redirect(res.locals.url('/master/' + path));
    }
    const values = {}; const errors = [];
    fields.forEach(f => {
      if (f.type === 'checkbox') values[f.name] = b[f.name] ? 1 : 0;
      else if (f.type === 'number') values[f.name] = util.num(b[f.name]);
      else values[f.name] = String(b[f.name] ?? '').trim();
      if (f.required && !String(values[f.name] ?? '').length) errors.push(f.label + ' wajib diisi.');
    });
    if (errors.length) {
      auth.setFlash(res, 'error', errors.join(' '));
      return res.redirect(res.locals.url('/master/' + path + (id ? `/${id}/edit` : '/baru')));
    }
    const names = Object.keys(values);
    try {
      if (id) {
        db.prepare(`UPDATE ${table} SET ${names.map(n => n + ' = ?').join(', ')} WHERE id = ?`).run(...names.map(n => values[n]), id);
        auth.setFlash(res, 'success', singular + ' berhasil diperbarui.');
      } else {
        db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map(n => values[n]));
        auth.setFlash(res, 'success', singular + ' berhasil ditambahkan.');
      }
    } catch (e) {
      auth.setFlash(res, 'error', 'Gagal menyimpan: ' + e.message);
    }
    res.redirect(res.locals.url('/master/' + path));
  });

  r.post('/:id/delete', auth.requirePerm('del'), (req, res) => {
    const id = util.num(req.params.id);
    if (refCheck) {
      const msg = refCheck(id);
      if (msg) { auth.setFlash(res, 'error', msg); return res.redirect(res.locals.url('/master/' + path)); }
    }
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    auth.setFlash(res, 'success', singular + ' dihapus.');
    res.redirect(res.locals.url('/master/' + path));
  });

  router.use('/' + path, r);
}

crud({
  path: 'customer', table: 'customers', title: 'Data Customer', singular: 'Customer',
  search: ['name', 'phone'],
  fields: [
    { name: 'name', label: 'Nama Customer / Tim', type: 'text', required: true, col: true },
    { name: 'phone', label: 'No. HP / WA (untuk login tracking)', type: 'text', required: true, col: true, placeholder: '08xxxxxxxxxx' },
    { name: 'email', label: 'Email', type: 'text', col: false },
    { name: 'address', label: 'Alamat', type: 'textarea', col: false },
    { name: 'notes', label: 'Catatan', type: 'textarea', col: false }
  ],
  listExtra: (req, res) => {
    const id = util.num(req.query.link);
    const c = id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(id) : null;
    if (!c) return { linkPanel: null };
    const path = '/track/l/' + portal.ensureToken(c.id);
    const projects = db.prepare('SELECT COUNT(*) c FROM projects WHERE customer_id = ?').get(c.id).c;
    const sales = db.prepare('SELECT COUNT(*) c FROM sales WHERE customer_id = ?').get(c.id).c;
    return {
      linkPanel: {
        customer: c, path, projects, sales,
        abs: res.locals.absUrl(path),
        wa: portal.waNumber(c.phone),
        aktif: !!c.portal_active
      }
    };
  },
  refCheck: (id) => {
    const s = db.prepare('SELECT COUNT(*) c FROM sales WHERE customer_id = ?').get(id).c;
    const p = db.prepare('SELECT COUNT(*) c FROM projects WHERE customer_id = ?').get(id).c;
    return (s + p) > 0 ? `Customer tidak bisa dihapus: masih dipakai di ${p} project dan ${s} invoice.` : null;
  }
});

crud({
  path: 'supplier', table: 'suppliers', title: 'Data Supplier', singular: 'Supplier',
  search: ['name', 'phone'],
  fields: [
    { name: 'name', label: 'Nama Supplier', type: 'text', required: true, col: true },
    { name: 'phone', label: 'No. HP / WA', type: 'text', col: true },
    { name: 'address', label: 'Alamat', type: 'textarea', col: false },
    { name: 'notes', label: 'Catatan', type: 'textarea', col: false }
  ],
  refCheck: (id) => {
    const c = db.prepare('SELECT COUNT(*) c FROM purchases WHERE supplier_id = ?').get(id).c;
    return c > 0 ? `Supplier tidak bisa dihapus: masih dipakai di ${c} transaksi pembelian.` : null;
  }
});

crud({
  path: 'bahan', table: 'materials', title: 'Data Bahan & Stok', singular: 'Bahan',
  search: ['name', 'code'], orderBy: 'name COLLATE NOCASE',
  fields: [
    { name: 'code', label: 'Kode', type: 'text', col: true },
    { name: 'name', label: 'Nama Bahan', type: 'text', required: true, col: true },
    { name: 'unit', label: 'Satuan', type: 'text', required: true, col: true, placeholder: 'meter / pcs' },
    { name: 'min_stock', label: 'Stok Minimum', type: 'number', col: true },
    { name: 'notes', label: 'Catatan', type: 'textarea', col: false }
  ],
  refCheck: (id) => {
    const c = db.prepare('SELECT COUNT(*) c FROM material_flows WHERE material_id = ?').get(id).c;
    return c > 0 ? `Bahan tidak bisa dihapus: sudah ada ${c} riwayat mutasi stok. Hapus riwayatnya lebih dulu atau ubah nama saja.` : null;
  }
});

// kartu stok bahan
router.get('/bahan/:id/kartu-stok', auth.requireLogin, (req, res) => {
  const id = util.num(req.params.id);
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  if (!material) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Bahan tidak ada.' });
  const p = util.period(req.query);
  const rows = db.prepare(`
    SELECT f.*, pr.code AS project_code, u.name AS oleh FROM material_flows f
    LEFT JOIN projects pr ON pr.id = f.project_id LEFT JOIN users u ON u.id = f.user_id
    WHERE f.material_id = ? AND f.date BETWEEN ? AND ? ORDER BY f.date ASC, f.id ASC
  `).all(id, p.from, p.to);
  const masukSebelum = util.num(db.prepare("SELECT COALESCE(SUM(qty),0) v FROM material_flows WHERE material_id = ? AND type='Masuk' AND date < ?").get(id, p.from).v);
  const keluarSebelum = util.num(db.prepare("SELECT COALESCE(SUM(qty),0) v FROM material_flows WHERE material_id = ? AND type='Keluar' AND date < ?").get(id, p.from).v);
  let run = masukSebelum - keluarSebelum;
  const saldoAwal = run;
  const withRun = rows.map(r => {
    run += r.type === 'Masuk' ? util.num(r.qty) : -util.num(r.qty);
    return { ...r, saldo: run };
  });
  res.render('master/kartu-stok', {
    title: 'Kartu Stok ' + material.name, material, rows: withRun, p, saldoAwal,
    masukPeriode: util.sum(rows.filter(r => r.type === 'Masuk'), 'qty'),
    keluarPeriode: util.sum(rows.filter(r => r.type === 'Keluar'), 'qty')
  });
});

// penyesuaian / stok opname
router.post('/bahan/:id/adjust', auth.requirePerm('edit'), (req, res) => {
  const id = util.num(req.params.id);
  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  if (!material) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Bahan tidak ada.' });
  const fisik = util.num(req.body.stock_fisik);
  if (!(fisik >= 0)) {
    auth.setFlash(res, 'error', `Jumlah fisik tidak boleh kosong atau negatif. Isi jumlah nyata dalam satuan ${material.unit}.`);
    return res.redirect(res.locals.url('/master/bahan/' + id + '/kartu-stok'));
  }
  const note = String(req.body.note || 'Stok opname');
  db.transaction(() => {
    db.prepare(`INSERT INTO material_flows(material_id, date, type, qty, unit_cost, total, source, ref_table, note, user_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, req.body.date || util.todayISO(), 'Penyesuaian', fisik, util.num(material.avg_cost),
      fisik * util.num(material.avg_cost), 'Stok Opname', 'adjust', note, req.user.id);
    db.prepare('UPDATE materials SET stock = ? WHERE id = ?').run(fisik, id);
  })();
  auth.setFlash(res, 'success', `Stok ${material.name} disesuaikan menjadi ${util.angka(fisik)} ${material.unit}.`);
  res.redirect(res.locals.url('/master/bahan/' + id + '/kartu-stok'));
});

/* ---------- TAHAPAN PROJECT ---------- */
router.get('/tahapan', auth.requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM project_progress pp WHERE pp.stage_id = s.id) AS dipakai
    FROM stages s ORDER BY s.sort_order, s.id
  `).all();
  res.render('master/stages', { title: 'Tahapan Tracking Project', rows });
});

router.post('/tahapan/save', auth.requirePerm('settings'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  const name = String(b.name || '').trim();
  if (!name) { auth.setFlash(res, 'error', 'Nama tahapan wajib diisi.'); return res.redirect(res.locals.url('/master/tahapan')); }
  if (id) {
    db.prepare('UPDATE stages SET name = ?, sort_order = ?, active = ? WHERE id = ?')
      .run(name, util.num(b.sort_order), b.active ? 1 : 0, id);
    auth.setFlash(res, 'success', 'Tahapan diperbarui.');
  } else {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) v FROM stages').get().v;
    const info = db.prepare('INSERT INTO stages(name, sort_order, active) VALUES (?, ?, 1)').run(name, max + 1);
    // terapkan ke project yang masih berjalan
    const stageId = Number(info.lastInsertRowid);
    const projects = db.prepare("SELECT id FROM projects WHERE status IN ('Baru','Proses','Revisi')").all();
    const ins = db.prepare('INSERT INTO project_progress(project_id, stage_id, status, note, user_id) VALUES (?,?,?,?,?)');
    projects.forEach(p => ins.run(p.id, stageId, 'Belum', '', req.user.id));
    auth.setFlash(res, 'success', 'Tahapan baru ditambahkan ke ' + projects.length + ' project aktif.');
  }
  res.redirect(res.locals.url('/master/tahapan'));
});

router.post('/tahapan/:id/move', auth.requirePerm('settings'), (req, res) => {
  const id = util.num(req.params.id);
  const dir = req.body.dir === 'up' ? -1 : 1;
  const cur = db.prepare('SELECT * FROM stages WHERE id = ?').get(id);
  if (cur) {
    const swap = db.prepare(`SELECT * FROM stages WHERE ${dir < 0 ? 'sort_order < ?' : 'sort_order > ?'} ORDER BY sort_order ${dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`).get(cur.sort_order);
    if (swap) {
      db.transaction(() => {
        db.prepare('UPDATE stages SET sort_order = ? WHERE id = ?').run(swap.sort_order, cur.id);
        db.prepare('UPDATE stages SET sort_order = ? WHERE id = ?').run(cur.sort_order, swap.id);
      })();
    }
  }
  res.redirect(res.locals.url('/master/tahapan'));
});

router.post('/tahapan/:id/delete', auth.requirePerm('settings'), (req, res) => {
  const id = util.num(req.params.id);
  const dipakai = db.prepare('SELECT COUNT(*) c FROM project_progress WHERE stage_id = ?').get(id).c;
  if (dipakai > 0) {
    auth.setFlash(res, 'error', `Tahapan tidak bisa dihapus karena dipakai di ${dipakai} project. Non-aktifkan saja (hilang dari project baru).`);
  } else {
    db.prepare('DELETE FROM stages WHERE id = ?').run(id);
    auth.setFlash(res, 'success', 'Tahapan dihapus.');
  }
  res.redirect(res.locals.url('/master/tahapan'));
});

/* ---------- OPSI TAMBAHAN HARGA (XXL, lengan panjang, kerah, dll) ---------- */
router.get('/opsi-harga', auth.requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, (SELECT COUNT(*) FROM sale_items si WHERE si.addons LIKE '%' || a.name || '%') AS dipakai
    FROM addons a ORDER BY a.sort_order, a.id
  `).all();
  res.render('master/addons', {
    title: 'Opsi Tambahan Harga', rows, contoh: util.nextNumber('sales', 'number', setting('sale_prefix', 'BA'))
  });
});

router.post('/opsi-harga/save', auth.requirePerm('master'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  const name = String(b.name || '').trim();
  if (!name) { auth.setFlash(res, 'error', 'Nama opsi wajib diisi.'); return res.redirect(res.locals.url('/master/opsi-harga')); }
  const values = [name, util.num(b.amount), String(b.category || 'Umum').trim(), util.num(b.sort_order), b.active ? 1 : 0];
  if (id) {
    db.prepare('UPDATE addons SET name = ?, amount = ?, category = ?, sort_order = ?, active = ? WHERE id = ?').run(...values, id);
    auth.setFlash(res, 'success', 'Opsi tambahan diperbarui.');
  } else {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order),0) v FROM addons').get().v;
    db.prepare('INSERT INTO addons(name, amount, category, sort_order, active) VALUES (?,?,?,?,?)')
      .run(name, util.num(b.amount), String(b.category || 'Umum').trim(), util.num(b.sort_order) || max + 1, b.active ? 1 : 0);
    auth.setFlash(res, 'success', `Opsi "${name}" (${util.rp(b.amount)}) ditambahkan.`);
  }
  res.redirect(res.locals.url('/master/opsi-harga'));
});

router.post('/opsi-harga/:id/delete', auth.requirePerm('del'), (req, res) => {
  db.prepare('DELETE FROM addons WHERE id = ?').run(util.num(req.params.id));
  auth.setFlash(res, 'success', 'Opsi tambahan dihapus.');
  res.redirect(res.locals.url('/master/opsi-harga'));
});

/* ---------- PORTAL CUSTOMER (link tracking untuk customer) ---------- */
function linkCustomer(customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!c) return null;
  const token = portal.ensureToken(customerId);
  return { customer: db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId), token };
}
router.get('/customer/:id/portal', auth.requireLogin, (req, res) => {
  const data = linkCustomer(util.num(req.params.id));
  if (!data) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Customer tidak ada.' });
  auth.setFlash(res, 'info', 'Link tracking customer siap — salin atau kirim lewat WhatsApp.');
  res.redirect(res.locals.url('/master/customer?link=' + data.customer.id));
});
router.post('/customer/:id/portal/regenerate', auth.requirePerm('master'), (req, res) => {
  const id = util.num(req.params.id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (c) {
    portal.regenerate(id);
    auth.setFlash(res, 'warn', 'Link lama customer ini sudah dimatikan. Kirim ulang link baru ke ' + c.name + '.');
  }
  res.redirect(res.locals.url('/master/customer?link=' + id));
});
router.post('/customer/:id/portal/toggle', auth.requirePerm('master'), (req, res) => {
  const id = util.num(req.params.id);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (c) {
    if (c.portal_active) {
      portal.closePortal(id);
      auth.setFlash(res, 'warn', `Akses tracking ${c.name} dimatikan. Customer tidak bisa membuka link lagi.`);
    } else {
      portal.openPortal(id);
      auth.setFlash(res, 'success', `Akses tracking ${c.name} dibuka kembali.`);
    }
  }
  res.redirect(res.locals.url('/master/customer?link=' + id));
});

/* ---------- USER ---------- */
router.get('/user', auth.requirePerm('users'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sesi
    FROM users u ORDER BY CASE u.role WHEN 'owner' THEN 1 WHEN 'leader' THEN 2 WHEN 'admin' THEN 3 ELSE 4 END, u.name
  `).all();
  res.render('master/users', { title: 'Manajemen User & Hak Akses', rows });
});

router.post('/user/save', auth.requirePerm('users'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  const name = String(b.name || '').trim();
  const username = String(b.username || '').trim().toLowerCase();
  const role = auth.ROLES[b.role] ? b.role : 'staff';
  const phone = String(b.phone || '').trim();
  const active = b.active ? 1 : 0;
  const password = String(b.password || '');
  if (!name || !username) {
    auth.setFlash(res, 'error', 'Nama dan username wajib diisi.');
    return res.redirect(res.locals.url('/master/user'));
  }
  const dup = db.prepare('SELECT id FROM users WHERE lower(username) = ? AND id != ?').get(username, id);
  if (dup) {
    auth.setFlash(res, 'error', 'Username sudah dipakai user lain.');
    return res.redirect(res.locals.url('/master/user'));
  }
  try {
    if (id) {
      db.prepare('UPDATE users SET name = ?, username = ?, role = ?, phone = ?, active = ? WHERE id = ?').run(name, username, role, phone, active, id);
      if (password) {
        if (password.length < 6) throw new Error('Password minimal 6 karakter.');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      auth.setFlash(res, 'success', 'User diperbarui.' + (password ? ' Password direset, user harus login ulang.' : ''));
    } else {
      if (password.length < 6) throw new Error('Password minimal 6 karakter.');
      db.prepare('INSERT INTO users(name, username, password_hash, role, phone, active) VALUES (?,?,?,?,?,?)')
        .run(name, username, auth.hashPassword(password), role, phone, active);
      auth.setFlash(res, 'success', 'User baru berhasil dibuat.');
    }
  } catch (e) {
    auth.setFlash(res, 'error', 'Gagal menyimpan user: ' + e.message);
  }
  res.redirect(res.locals.url('/master/user'));
});

router.post('/user/:id/delete', auth.requirePerm('users'), (req, res) => {
  const id = util.num(req.params.id);
  if (id === req.user.id) {
    auth.setFlash(res, 'error', 'Tidak bisa menghapus akun yang sedang dipakai login.');
  } else {
    const owners = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'owner' AND active = 1").get().c;
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (target && target.role === 'owner' && owners <= 1) {
      auth.setFlash(res, 'error', 'Minimal harus ada 1 user Owner yang aktif.');
    } else {
      db.transaction(() => {
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      })();
      auth.setFlash(res, 'success', 'User dihapus.');
    }
  }
  res.redirect(res.locals.url('/master/user'));
});

/* ---------- PENGATURAN ---------- */
const SETTING_KEYS = ['company_name', 'company_tagline', 'company_address', 'company_phone', 'company_email',
  'deadline_warning_days', 'petty_opening', 'sale_prefix', 'purchase_prefix', 'project_prefix',
  'income_categories', 'expense_categories', 'petty_categories',
  'invoice_title', 'invoice_order_lines', 'invoice_banks', 'invoice_footer_note',
  'sport_options', 'fabric_options', 'print_options', 'position_options', 'portal_greeting',
  'purchase_units', 'conv_kg_m', 'conv_roll_m', 'conv_yard_m'];
// Kolom ini disimpan sebagai angka murni (tanpa titik pemisah ribuan),
// supaya perhitungan di dashboard & laporan tidak salah baca.
// Kolom angka yang boleh dikosongkan (mis. konversi roll kalau tidak dipakai)
const NUMERIC_KEYS = ['petty_opening', 'deadline_warning_days', 'conv_kg_m', 'conv_roll_m', 'conv_yard_m'];

router.get('/pengaturan', auth.requirePerm('settings'), (req, res) => {
  const values = {};
  SETTING_KEYS.forEach(k => { values[k] = setting(k, ''); });
  res.render('master/settings', { title: 'Pengaturan Aplikasi', values, logoUrl: setting('logo_url', '') });
});

router.post('/pengaturan/save', auth.requirePerm('settings'), (req, res) => {
  SETTING_KEYS.forEach(k => {
    if (req.body[k] === undefined) return;
    const raw = String(req.body[k]).trim();
    if (NUMERIC_KEYS.includes(k)) {
      // kolom konversi boleh dikosongkan; simpan angka murni
      if (raw === '' && k.startsWith('conv_')) { setSetting(k, ''); return; }
      let n = util.num(raw);
      if (k === 'deadline_warning_days') n = Math.min(Math.max(Math.round(n) || 3, 1), 60);
      setSetting(k, String(n));
    } else {
      setSetting(k, raw);
    }
  });
  auth.setFlash(res, 'success', 'Pengaturan disimpan.');
  res.redirect(res.locals.url('/master/pengaturan'));
});

/* ---------- UPLOAD LOGO (diteruskan ke penyimpanan media platform) ---------- */
// Token media: aplikasi Node membacanya dari environment (disediakan platform saat publish).
// File .vibecoder-media-token tetap didukung sebagai cadangan.
function mediaToken() {
  const fromEnv = process.env.APP_MEDIA_TOKEN;
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.vibecoder-media-token'), 'utf8').trim();
  } catch { return ''; }
}
const MEDIA_ENDPOINT = process.env.APP_MEDIA_ENDPOINT || 'http://127.0.0.1:4310/api/app-media/upload';

router.post('/pengaturan/logo', auth.requirePerm('settings'),
  express.raw({ type: '*/*', limit: '6mb' }),
  async (req, res) => {
    const filename = String(req.query.filename || 'logo.png').replace(/[^\w.\-]/g, '_');
    const token = mediaToken();
    if (!token) {
      return res.status(503).json({
        ok: false,
        error: 'Unggah logo belum aktif untuk aplikasi ini. Anda masih bisa mencetak invoice dengan tulisan nama usaha.'
      });
    }
    if (!req.body || !req.body.length) return res.status(400).json({ ok: false, error: 'Berkas kosong.' });
    try {
      const resp = await fetch(MEDIA_ENDPOINT + '?filename=' + encodeURIComponent(filename), {
        method: 'POST',
        headers: { 'X-App-Media-Token': token, 'Content-Type': 'application/octet-stream' },
        body: req.body
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || !data.ok || !data.url) {
        const msg = (data && (data.error || data.message)) || ('Unggah gagal (kode ' + resp.status + ').');
        return res.status(resp.status === 403 ? 403 : 502).json({ ok: false, error: msg });
      }
      setSetting('logo_url', data.url);
      return res.json({ ok: true, url: data.url });
    } catch (e) {
      return res.status(502).json({ ok: false, error: 'Gagal menghubungi penyimpanan media: ' + e.message });
    }
  });

router.post('/pengaturan/logo/hapus', auth.requirePerm('settings'), (req, res) => {
  setSetting('logo_url', '');
  auth.setFlash(res, 'success', 'Logo dihapus. Invoice akan memakai tulisan BATAM APPAREL.');
  res.redirect(res.locals.url('/master/pengaturan'));
});

module.exports = router;
