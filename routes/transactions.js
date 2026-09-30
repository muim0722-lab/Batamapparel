'use strict';
const express = require('express');
const { db, setting } = require('../lib/db');
const auth = require('../lib/auth');
const util = require('../lib/util');
const router = express.Router();

const METHODS = ['Tunai', 'Transfer Bank', 'QRIS', 'E-Wallet', 'Tempo / Kredit'];
const PAY_STATUS = ['Lunas', 'Belum Lunas', 'Sebagian'];
const PROJECT_STATUS_ACTIVE = ['Baru', 'Proses', 'Revisi'];
const LIMIT = 1000;

/** Faktor konversi satuan → satuan stok bahan (dari Pengaturan) */
function convMap() {
  return {
    kg: util.num(setting('conv_kg_m', '3')),
    roll: util.num(setting('conv_roll_m', '')),
    yard: util.num(setting('conv_yard_m', ''))
  };
}
/** Daftar satuan untuk pilihan di pembelian (dari Pengaturan + satuan bahan itu sendiri) */
function purchaseUnits(matUnit) {
  const list = listOrCsv('purchase_units', 'kg, meter, roll, yard, pcs, lusin');
  const u = String(matUnit || '').trim();
  if (u && !list.some(x => x.toLowerCase() === u.toLowerCase())) list.unshift(u);
  return list;
}
/** Normalkan satuan dari form: 'base'/'alt' = kompatibilitas data lama */
function normalizeUnit(raw, mat) {
  const v = String(raw == null ? '' : raw).trim();
  if (!v || v === 'base') return mat ? mat.unit : '';
  if (v === 'alt') return (mat && mat.unit_alt) ? mat.unit_alt : (mat ? mat.unit : 'kg');
  return v;
}

function arr(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }
function listOrCsv(key, fallback = '') { return (setting(key, fallback) || '').split(',').map(s => s.trim()).filter(Boolean); }
function projects() {
  return db.prepare('SELECT id, code, name, status FROM projects ORDER BY (status IN (\'Selesai\',\'Batal\')) ASC, id DESC').all();
}
function customers() { return db.prepare('SELECT id, name, phone FROM customers ORDER BY name').all(); }
function suppliers() { return db.prepare('SELECT id, name FROM suppliers ORDER BY name').all(); }
function materials() { return db.prepare('SELECT * FROM materials ORDER BY name').all(); }
function addons(activeOnly = true) {
  return db.prepare(`SELECT * FROM addons ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`).all();
}

/* ============================================================
   STOK / MATERIAL FLOW
   ============================================================ */
function applyFlow(f) {
  const mat = db.prepare('SELECT * FROM materials WHERE id = ?').get(f.material_id);
  if (!mat) return;
  const qty = util.num(f.qty);
  const unitCost = util.num(f.unit_cost);
  const total = f.total !== undefined ? util.num(f.total) : qty * unitCost;
  db.prepare(`INSERT INTO material_flows(material_id, date, type, qty, unit_cost, total, input_qty, input_unit, input_price, source, ref_table, ref_id, project_id, note, user_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    f.material_id, f.date || util.todayISO(), f.type, qty, unitCost, total,
    f.input_qty !== undefined ? util.num(f.input_qty) : qty,
    f.input_unit !== undefined ? String(f.input_unit) : mat.unit,
    f.input_price !== undefined ? util.num(f.input_price) : unitCost,
    f.source || '', f.ref_table || '', f.ref_id || null, f.project_id || null, f.note || '', f.user_id || null
  );
  if (f.type === 'Masuk') {
    const newStock = util.num(mat.stock) + qty;
    const newAvg = newStock > 0 ? ((util.num(mat.stock) * util.num(mat.avg_cost)) + (qty * unitCost)) / newStock : unitCost;
    db.prepare('UPDATE materials SET stock = ?, avg_cost = ? WHERE id = ?').run(newStock, Math.round(newAvg * 100) / 100, mat.id);
  } else if (f.type === 'Keluar') {
    db.prepare('UPDATE materials SET stock = ? WHERE id = ?').run(util.num(mat.stock) - qty, mat.id);
  } else { // Penyesuaian: qty = stok fisik hasil hitung
    db.prepare('UPDATE materials SET stock = ? WHERE id = ?').run(qty, mat.id);
  }
}
function reverseFlows(refTable, refId) {
  const rows = db.prepare('SELECT * FROM material_flows WHERE ref_table = ? AND ref_id = ?').all(refTable, refId);
  for (const r of rows) {
    const mat = db.prepare('SELECT * FROM materials WHERE id = ?').get(r.material_id);
    if (mat) {
      const stokBaru = r.type === 'Masuk' ? util.num(mat.stock) - util.num(r.qty) : util.num(mat.stock) + util.num(r.qty);
      db.prepare('UPDATE materials SET stock = ? WHERE id = ?').run(stokBaru, mat.id);
    }
    db.prepare('DELETE FROM material_flows WHERE id = ?').run(r.id);
  }
}

/* ============================================================
   PEMASUKAN
   ============================================================ */
router.get('/pemasukan', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const q = String(req.query.q || '').trim();
  const cat = String(req.query.kategori || '');
  const where = ['date BETWEEN @from AND @to']; const params = { from: p.from, to: p.to };
  if (q) { where.push('(description LIKE @q OR note LIKE @q OR method LIKE @q)'); params.q = `%${q}%`; }
  if (cat) { where.push('category = @cat'); params.cat = cat; }
  const rows = db.prepare(`
    SELECT i.*, pr.code AS project_code, pr.name AS project_name, u.name AS oleh
    FROM incomes i LEFT JOIN projects pr ON pr.id = i.project_id LEFT JOIN users u ON u.id = i.user_id
    WHERE ${where.join(' AND ')} ORDER BY i.date DESC, i.id DESC LIMIT ${LIMIT}
  `).all(params);
  res.render('transaksi/incomes', {
    title: 'Pemasukan', rows, p, filters: { q, kategori: cat }, categories: listOrCsv('income_categories'),
    total: util.sum(rows, 'amount'),
    byCategory: util.groupSum(rows, 'category', 'amount')
  });
});

function incomeForm(req, res, id) {
  let row = id ? db.prepare('SELECT * FROM incomes WHERE id = ?').get(id) : null;
  if (id && !row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data pemasukan tidak ada.' });
  if (!row) {
    row = {
      id: 0, date: util.todayISO(), category: 'Penjualan', description: '', amount: '',
      method: 'Transfer Bank', project_id: util.num(req.query.project_id) || null, note: ''
    };
  }
  res.render('transaksi/income-form', {
    title: id ? 'Edit Pemasukan' : 'Pemasukan Baru', row, METHODS,
    categories: listOrCsv('income_categories'), projects: projects()
  });
}
router.get('/pemasukan/baru', auth.requirePerm('input'), (req, res) => incomeForm(req, res, null));
router.get('/pemasukan/:id/edit', auth.requirePerm('edit'), (req, res) => incomeForm(req, res, util.num(req.params.id)));

router.post('/pemasukan/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  const data = [
    b.date || util.todayISO(), String(b.category || 'Penjualan').trim(), String(b.description || '').trim(),
    util.num(b.amount), String(b.method || 'Tunai'), b.project_id ? util.num(b.project_id) : null, String(b.note || '')
  ];
  if (id) {
    if (!auth.can(req.user.role, 'edit')) { auth.setFlash(res, 'error', 'Role Anda tidak boleh mengedit data.'); return res.redirect(res.locals.url('/transaksi/pemasukan')); }
    db.prepare('UPDATE incomes SET date=?, category=?, description=?, amount=?, method=?, project_id=?, note=? WHERE id=?').run(...data, id);
    auth.setFlash(res, 'success', 'Pemasukan diperbarui.');
  } else {
    db.prepare('INSERT INTO incomes(date, category, description, amount, method, project_id, note, user_id) VALUES (?,?,?,?,?,?,?,?)').run(...data, req.user.id);
    auth.setFlash(res, 'success', 'Pemasukan tersimpan.');
  }
  res.redirect(res.locals.url(req.body.back === '1' ? '/transaksi/pemasukan/baru' : '/transaksi/pemasukan'));
});

router.post('/pemasukan/:id/delete', auth.requirePerm('del'), (req, res) => {
  db.prepare('DELETE FROM incomes WHERE id = ?').run(util.num(req.params.id));
  auth.setFlash(res, 'success', 'Pemasukan dihapus.');
  res.redirect(res.locals.url('/transaksi/pemasukan'));
});

/* ============================================================
   PENGELUARAN
   ============================================================ */
router.get('/pengeluaran', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const q = String(req.query.q || '').trim();
  const cat = String(req.query.kategori || '');
  const where = ['e.date BETWEEN @from AND @to']; const params = { from: p.from, to: p.to };
  if (q) { where.push('(e.description LIKE @q OR e.note LIKE @q)'); params.q = `%${q}%`; }
  if (cat) { where.push('e.category = @cat'); params.cat = cat; }
  const rows = db.prepare(`
    SELECT e.*, pr.code AS project_code, pr.name AS project_name, u.name AS oleh
    FROM expenses e LEFT JOIN projects pr ON pr.id = e.project_id LEFT JOIN users u ON u.id = e.user_id
    WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC LIMIT ${LIMIT}
  `).all(params);
  res.render('transaksi/expenses', {
    title: 'Pengeluaran', rows, p, filters: { q, kategori: cat },
    categories: listOrCsv('expense_categories'), sources: ['Kas Utama', 'Petty Cash', 'Transfer Bank', 'Lainnya'],
    total: util.sum(rows, 'amount'), byCategory: util.groupSum(rows, 'category', 'amount')
  });
});

function expenseForm(req, res, id) {
  let row = id ? db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) : null;
  if (id && !row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data pengeluaran tidak ada.' });
  if (!row) {
    row = {
      id: 0, date: util.todayISO(), category: 'Operasional', description: '', amount: '',
      source: 'Kas Utama', project_id: util.num(req.query.project_id) || null, note: ''
    };
  }
  res.render('transaksi/expense-form', {
    title: id ? 'Edit Pengeluaran' : 'Pengeluaran Baru', row,
    categories: listOrCsv('expense_categories'), sources: ['Kas Utama', 'Petty Cash', 'Transfer Bank', 'Lainnya'],
    projects: projects()
  });
}
router.get('/pengeluaran/baru', auth.requirePerm('input'), (req, res) => expenseForm(req, res, null));
router.get('/pengeluaran/:id/edit', auth.requirePerm('edit'), (req, res) => expenseForm(req, res, util.num(req.params.id)));

router.post('/pengeluaran/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  const data = [
    b.date || util.todayISO(), String(b.category || 'Operasional').trim(), String(b.description || '').trim(),
    util.num(b.amount), String(b.source || 'Kas Utama'), b.project_id ? util.num(b.project_id) : null, String(b.note || '')
  ];
  if (id) {
    if (!auth.can(req.user.role, 'edit')) { auth.setFlash(res, 'error', 'Role Anda tidak boleh mengedit data.'); return res.redirect(res.locals.url('/transaksi/pengeluaran')); }
    db.prepare('UPDATE expenses SET date=?, category=?, description=?, amount=?, source=?, project_id=?, note=? WHERE id=?').run(...data, id);
    db.prepare('UPDATE petty SET amount = ?, date = ? WHERE expense_id = ?').run(util.num(b.amount), b.date || util.todayISO(), id);
    auth.setFlash(res, 'success', 'Pengeluaran diperbarui.');
  } else {
    db.prepare('INSERT INTO expenses(date, category, description, amount, source, project_id, note, user_id) VALUES (?,?,?,?,?,?,?,?)').run(...data, req.user.id);
    auth.setFlash(res, 'success', 'Pengeluaran tersimpan.');
  }
  res.redirect(res.locals.url(req.body.back === '1' ? '/transaksi/pengeluaran/baru' : '/transaksi/pengeluaran'));
});

router.post('/pengeluaran/:id/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM petty WHERE expense_id = ?').run(id);
    db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  })();
  auth.setFlash(res, 'success', 'Pengeluaran dihapus.');
  res.redirect(res.locals.url('/transaksi/pengeluaran'));
});

/* ============================================================
   PENJUALAN / INVOICE (dengan opsi tambahan harga & DP bertahap)
   ============================================================ */
const SPORT_KEY = 'sport_options', FABRIC_KEY = 'fabric_options', PRINT_KEY = 'print_options', POS_KEY = 'position_options';
function invoiceOptions() {
  return {
    sports: listOrCsv(SPORT_KEY), fabrics: listOrCsv(FABRIC_KEY),
    prints: listOrCsv(PRINT_KEY), positions: listOrCsv(POS_KEY)
  };
}
function csvHas(csv, label) {
  return String(csv || '').split(',').map(s => s.trim().toUpperCase()).includes(String(label).trim().toUpperCase());
}

/** Baris item dari form: harga satuan = harga dasar + total opsi tambahan */
function parseSaleItems(b) {
  const descs = arr(b.item_desc), qtys = arr(b.item_qty), prices = arr(b.item_price), picks = arr(b.item_addons);
  const map = new Map(addons().map(a => [String(a.id), a]));
  const items = [];
  descs.forEach((d, i) => {
    const qty = util.num(qtys[i]);
    const base = util.num(prices[i]);
    const ids = String(picks[i] == null ? '' : picks[i]).split(',').map(x => x.trim()).filter(Boolean);
    const chosen = ids.map(id => map.get(id)).filter(Boolean);
    const addonTotal = chosen.reduce((a, x) => a + util.num(x.amount), 0);
    const desc = String(d || '').trim();
    if (!desc && !qty && !base && !chosen.length) return;
    items.push({
      desc: desc || 'Item', qty, base, addonTotal,
      unit: base + addonTotal,
      subtotal: qty * (base + addonTotal),
      addons: chosen.map(x => `${x.name} (+${util.angka(x.amount)})`).join(', ')
    });
  });
  if (!items.length) items.push({ desc: 'Jersey Custom', qty: 1, base: 0, addonTotal: 0, unit: 0, subtotal: 0, addons: '' });
  return items;
}
function saveSaleItems(saleId, items) {
  db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(saleId);
  const ins = db.prepare(`INSERT INTO sale_items(sale_id, description, qty, unit_price, subtotal, base_price, addons, addon_total)
    VALUES (?,?,?,?,?,?,?,?)`);
  items.forEach(it => ins.run(saleId, it.desc, util.num(it.qty), util.num(it.unit), util.num(it.subtotal), util.num(it.base), it.addons || '', util.num(it.addonTotal)));
}
function saleSubtotal(saleId) {
  return db.prepare('SELECT COALESCE(SUM(subtotal),0) v FROM sale_items WHERE sale_id = ?').get(saleId).v;
}

/** Pemasukan otomatis mengikuti setiap pembayaran (DP / pelunasan) — tidak dobel */
function syncPaymentIncomes(sale, catat) {
  const pays = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY date, id').all(sale.id);
  for (const p of pays) {
    if (!catat) {
      if (p.income_id) {
        db.prepare('DELETE FROM incomes WHERE id = ?').run(p.income_id);
        db.prepare('UPDATE sale_payments SET income_id = NULL WHERE id = ?').run(p.id);
      }
      continue;
    }
    const isDp = p.kind === 'DP';
    const category = isDp ? 'DP / Uang Muka' : 'Pelunasan';
    const description = (isDp ? 'DP ' : 'Pembayaran ') + sale.number;
    const note = 'Otomatis dari invoice ' + sale.number + (p.note ? ' — ' + p.note : '');
    if (p.income_id && db.prepare('SELECT id FROM incomes WHERE id = ?').get(p.income_id)) {
      db.prepare(`UPDATE incomes SET date=?, category=?, description=?, amount=?, method=?, project_id=?, note=? WHERE id=?`)
        .run(p.date, category, description, util.num(p.amount), p.method, sale.project_id || null, note, p.income_id);
      continue;
    }
    const info = db.prepare(`INSERT INTO incomes(date, category, description, amount, method, project_id, sale_id, note, user_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      p.date, category, description, util.num(p.amount), p.method,
      sale.project_id || null, sale.id, note, sale.user_id || null
    );
    db.prepare('UPDATE sale_payments SET income_id = ? WHERE id = ?').run(Number(info.lastInsertRowid), p.id);
  }
  // bersihkan pemasukan yatim (tertaut ke invoice tapi tidak lagi punya pembayaran)
  const linked = db.prepare('SELECT income_id FROM sale_payments WHERE sale_id = ? AND income_id IS NOT NULL')
    .all(sale.id).map(r => r.income_id);
  db.prepare('SELECT id FROM incomes WHERE sale_id = ?').all(sale.id)
    .map(r => r.id).filter(id => !linked.includes(id))
    .forEach(id => db.prepare('DELETE FROM incomes WHERE id = ?').run(id));
}

/** Hitung ulang total & status invoice dari item + pembayaran */
function recalcSale(saleId) {
  const sub = saleSubtotal(saleId);
  const s = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!s) return null;
  let disc = util.num(s.disc_pct) > 0 ? Math.round(sub * util.num(s.disc_pct) / 100) : util.num(s.discount);
  if (disc > sub) disc = sub;
  const total = Math.max(sub - disc, 0);
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM sale_payments WHERE sale_id = ?').get(saleId).v;
  const status = paid <= 0 ? 'Belum Lunas' : (paid >= total && total > 0 ? 'Lunas' : (paid > total && total <= 0 ? 'Lunas' : 'Sebagian'));
  db.prepare('UPDATE sales SET subtotal = ?, discount = ?, total = ?, paid = ?, status = ? WHERE id = ?')
    .run(sub, disc, total, paid, status, saleId);
  return db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
}

function saleForm(req, res, id) {
  let row = null, items = [], pays = [];
  if (id) {
    row = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data penjualan tidak ada.' });
    items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
    pays = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY date, id').all(id);
    row.catat = pays.some(p => p.income_id) || db.prepare('SELECT COUNT(*) c FROM incomes WHERE sale_id = ?').get(id).c > 0;
  }
  const dp = pays.find(p => p.kind === 'DP') || null;
  res.render('transaksi/sale-form', {
    title: id ? 'Edit Invoice ' + row.number : 'Invoice Baru', row, items, collects: pays,
    dp, PAY_STATUS, METHODS, opts: invoiceOptions(), addonList: addons(),
    customers: customers(), projects: projects(),
    nextNumber: util.nextNumber('sales', 'number', setting('sale_prefix', 'BA'))
  });
}

router.get('/penjualan', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const q = String(req.query.q || '').trim();
  const st = String(req.query.st || '');
  const where = ['s.date BETWEEN @from AND @to']; const params = { from: p.from, to: p.to };
  if (q) { where.push('(s.number LIKE @q OR s.note LIKE @q OR s.to_name LIKE @q OR s.market LIKE @q OR c.name LIKE @q OR pr.code LIKE @q)'); params.q = `%${q}%`; }
  if (st) { where.push('s.status = @st'); params.st = st; }
  const rows = db.prepare(`
    SELECT s.*, c.name AS customer_name, pr.code AS project_code, pr.name AS project_name, u.name AS oleh,
      (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS jml_item
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN projects pr ON pr.id = s.project_id LEFT JOIN users u ON u.id = s.user_id
    WHERE ${where.join(' AND ')} ORDER BY s.date DESC, s.id DESC LIMIT ${LIMIT}
  `).all(params);
  res.render('transaksi/sales', {
    title: 'Invoice / Penjualan', rows, p, filters: { q, status: st }, PAY_STATUS,
    total: util.sum(rows, 'total'), paid: util.sum(rows, 'paid'),
    dpp: util.sum(rows, 'paid') - 0,
    unpaid: util.sum(rows, 'total') - util.sum(rows, 'paid')
  });
});

router.get('/penjualan/baru', auth.requirePerm('input'), (req, res) => saleForm(req, res, null));
router.get('/penjualan/:id/edit', auth.requirePerm('edit'), (req, res) => saleForm(req, res, util.num(req.params.id)));

router.post('/penjualan/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  if (id && !auth.can(req.user.role, 'edit')) {
    auth.setFlash(res, 'error', 'Role Anda tidak boleh mengedit data.');
    return res.redirect(res.locals.url('/transaksi/penjualan'));
  }
  const items = parseSaleItems(b);
  const subtotal = items.reduce((a, it) => a + it.subtotal, 0);
  const discPct = Math.min(Math.max(util.num(b.disc_pct), 0), 100);
  let discount = discPct > 0 ? Math.round(subtotal * discPct / 100) : util.num(b.discount);
  if (discount > subtotal) discount = subtotal;
  const total = Math.max(subtotal - discount, 0);
  const dp = util.num(b.paid);
  const date = b.date || util.todayISO();
  const method = String(b.method || 'Transfer Bank');

  const header = [
    String(b.number || '').trim() || util.nextNumber('sales', 'number', setting('sale_prefix', 'BA')),
    date,
    b.customer_id ? util.num(b.customer_id) : null,
    b.project_id ? util.num(b.project_id) : null,
    subtotal, discount, total, 0, 'Belum Lunas', method,
    discPct,
    String(b.market || ''), String(b.to_name || ''), String(b.phone || ''), String(b.deadline || ''),
    csvJoin(b.sport), csvJoin(b.fabrics), csvJoin(b.prints), csvJoin(b.positions),
    String(b.invoice_note || ''), String(b.note || '')
  ];
  const catat = b.catat === '1';

  let saleId = id;
  db.transaction(() => {
    if (id) {
      db.prepare(`UPDATE sales SET number=?, date=?, customer_id=?, project_id=?, subtotal=?, discount=?, total=?, paid=?,
        status=?, method=?, disc_pct=?, market=?, to_name=?, phone=?, deadline=?, sport=?, fabrics=?, prints=?, positions=?,
        invoice_note=?, note=? WHERE id=?`).run(...header, id);
    } else {
      const info = db.prepare(`INSERT INTO sales(number, date, customer_id, project_id, subtotal, discount, total, paid,
        status, method, disc_pct, market, to_name, phone, deadline, sport, fabrics, prints, positions, invoice_note, note, user_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...header, req.user.id);
      saleId = Number(info.lastInsertRowid);
    }
    saveSaleItems(saleId, items);

    // DP: satu baris pembayaran bertipe DP yang dikelola dari form ini
    const existingDp = db.prepare("SELECT * FROM sale_payments WHERE sale_id = ? AND kind = 'DP' LIMIT 1").get(saleId);
    if (dp > 0) {
      if (existingDp) {
        db.prepare('UPDATE sale_payments SET date = ?, amount = ?, method = ?, note = ?, user_id = ? WHERE id = ?')
          .run(date, dp, method, 'DP awal', req.user.id, existingDp.id);
      } else {
        db.prepare('INSERT INTO sale_payments(sale_id, date, kind, amount, method, note, user_id) VALUES (?,?,?,?,?,?,?)')
          .run(saleId, date, 'DP', dp, method, 'DP awal', req.user.id);
      }
    } else if (existingDp) {
      if (existingDp.income_id) db.prepare('DELETE FROM incomes WHERE id = ?').run(existingDp.income_id);
      db.prepare('DELETE FROM sale_payments WHERE id = ?').run(existingDp.id);
    }

    const sale = recalcSale(saleId);
    syncPaymentIncomes(sale, catat);
    recalcSale(saleId);
  })();

  auth.setFlash(res, 'success', id ? 'Invoice diperbarui.' : 'Invoice tersimpan.');
  res.redirect(res.locals.url(req.body.back === '1' ? '/transaksi/penjualan/baru' : '/transaksi/penjualan/' + saleId));
});

function csvJoin(v) {
  const list = arr(v).join(',').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set(list)].join(', ');
}

/** Catat pembayaran tambahan (DP berikutnya / pelunasan) */
router.post('/penjualan/:id/bayar', auth.requirePerm('input'), (req, res) => {
  const id = util.num(req.params.id);
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  if (!sale) return res.redirect(res.locals.url('/transaksi/penjualan'));
  const amount = util.num(req.body.amount);
  const kind = req.body.kind === 'DP' ? 'DP' : 'Pelunasan';
  if (amount <= 0) {
    auth.setFlash(res, 'error', 'Nominal pembayaran harus lebih dari 0.');
    return res.redirect(res.locals.url('/transaksi/penjualan/' + id));
  }
  db.transaction(() => {
    const info = db.prepare('INSERT INTO sale_payments(sale_id, date, kind, amount, method, note, user_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.body.date || util.todayISO(), kind, amount, String(req.body.method || sale.method || 'Transfer Bank'),
        String(req.body.note || ''), req.user.id);
    const s = recalcSale(id);
    syncPaymentIncomes(s, req.body.catat !== '0');
    recalcSale(id);
  })();
  const s2 = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
  auth.setFlash(res, 'success', `Pembayaran ${util.rp(amount)} dicatat. Sisa tagihan ${util.rp(util.num(s2.total) - util.num(s2.paid))}.`);
  res.redirect(res.locals.url('/transaksi/penjualan/' + id));
});

router.post('/penjualan/:id/bayar/:payId/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id), payId = util.num(req.params.payId);
  db.transaction(() => {
    const p = db.prepare('SELECT * FROM sale_payments WHERE id = ? AND sale_id = ?').get(payId, id);
    if (p) {
      if (p.income_id) db.prepare('DELETE FROM incomes WHERE id = ?').run(p.income_id);
      db.prepare('DELETE FROM sale_payments WHERE id = ?').run(payId);
    }
    const s = recalcSale(id);
    if (s) syncPaymentIncomes(s, true);
    recalcSale(id);
  })();
  auth.setFlash(res, 'success', 'Catatan pembayaran dihapus.');
  res.redirect(res.locals.url('/transaksi/penjualan/' + id));
});

function saleRow(id) {
  const row = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
      pr.code AS project_code, pr.name AS project_name, u.name AS oleh
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN projects pr ON pr.id = s.project_id LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(id);
  if (!row) return null;
  row.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(id);
  row.payments = db.prepare('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY date, id').all(id);
  row.incomes = db.prepare('SELECT * FROM incomes WHERE sale_id = ? ORDER BY date, id').all(id);
  row.sisa = util.num(row.total) - util.num(row.paid);
  return row;
}

router.get('/penjualan/:id', auth.requireLogin, (req, res) => {
  const row = saleRow(util.num(req.params.id));
  if (!row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data penjualan tidak ada.' });
  res.render('transaksi/sale-detail', { title: 'Invoice ' + row.number, row, PAY_STATUS, METHODS });
});

/** Halaman invoice siap cetak (format nota toko, A4) */
router.get('/penjualan/:id/invoice', auth.requireLogin, (req, res) => {
  const row = saleRow(util.num(req.params.id));
  if (!row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data penjualan tidak ada.' });
  res.render('invoice-page', { title: 'Invoice ' + row.number, row, backTo: '/transaksi/penjualan/' + row.id, custView: false });
});

router.post('/penjualan/:id/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM incomes WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sale_payments WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sale_items WHERE sale_id = ?').run(id);
    db.prepare('DELETE FROM sales WHERE id = ?').run(id);
  })();
  auth.setFlash(res, 'success', 'Invoice dihapus.');
  res.redirect(res.locals.url('/transaksi/penjualan'));
});

/* ============================================================
   PEMBELIAN (BAHAN MASUK)
   ============================================================ */
function savePurchaseItems(purchaseId, date, items, userId) {
  const conv = convMap();
  for (const it of items) {
    const mid = it.material_id ? util.num(it.material_id) : null;
    const mat = mid ? db.prepare('SELECT * FROM materials WHERE id = ?').get(mid) : null;
    // qty & harga diisi sesuai nota (mis. 25,56 kg @56.000) — total = qty × harga, apa adanya.
    const inQty = util.num(it.qty), inCost = util.num(it.cost);
    const sub = Math.round(inQty * inCost);
    const unit = mat ? normalizeUnit(it.unit, mat) : String(it.unit || '');
    // Untuk stok: qty dikonversi ke satuan bahan (mis. 1 kg = 3 meter)
    const factor = mat ? util.unitFactor(unit, mat.unit, conv) : 1;
    const baseQty = Math.round(inQty * factor * 10000) / 10000;
    const baseCost = factor > 1 ? Math.round((inCost / factor) * 100) / 100 : inCost;
    db.prepare(`INSERT INTO purchase_items(purchase_id, material_id, description, qty, unit_cost, subtotal, input_unit, input_qty, input_price)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      purchaseId, mid, String(it.desc || ''), baseQty, baseCost, sub, unit, inQty, inCost
    );
    if (mid && mat) {
      applyFlow({
        material_id: mid, date, type: 'Masuk', qty: baseQty, unit_cost: baseCost, total: sub,
        input_qty: inQty, input_unit: unit, input_price: inCost,
        source: 'Pembelian', ref_table: 'purchases', ref_id: purchaseId, user_id: userId
      });
    }
  }
}

router.get('/pembelian', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const q = String(req.query.q || '').trim();
  const st = String(req.query.status || '');
  const where = ['pu.date BETWEEN @from AND @to']; const params = { from: p.from, to: p.to };
  if (q) { where.push('(pu.number LIKE @q OR pu.note LIKE @q OR s.name LIKE @q)'); params.q = `%${q}%`; }
  if (st) { where.push('pu.status = @st'); params.st = st; }
  const rows = db.prepare(`
    SELECT pu.*, s.name AS supplier_name, u.name AS oleh,
      (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS jml_item
    FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN users u ON u.id = pu.user_id
    WHERE ${where.join(' AND ')} ORDER BY pu.date DESC, pu.id DESC LIMIT ${LIMIT}
  `).all(params);
  res.render('transaksi/purchases', {
    title: 'Pembelian Bahan', rows, p, filters: { q, status: st }, PAY_STATUS,
    total: util.sum(rows, 'total'), paid: util.sum(rows, 'paid'),
    unpaid: util.sum(rows, 'total') - util.sum(rows, 'paid')
  });
});

function purchaseForm(req, res, id) {
  let row = null, items = [];
  if (id) {
    row = db.prepare('SELECT * FROM purchases WHERE id = ?').get(id);
    if (!row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data pembelian tidak ada.' });
    items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ? ORDER BY id').all(id);
  }
  res.render('transaksi/purchase-form', {
    title: id ? 'Edit Pembelian ' + row.number : 'Pembelian Baru', row, items, PAY_STATUS,
    suppliers: suppliers(), materials: materials(),
    units: purchaseUnits(''), conv: convMap(),
    nextNumber: util.nextNumber('purchases', 'number', setting('purchase_prefix', 'PO'))
  });
}
router.get('/pembelian/baru', auth.requirePerm('input'), (req, res) => purchaseForm(req, res, null));
router.get('/pembelian/:id/edit', auth.requirePerm('edit'), (req, res) => purchaseForm(req, res, util.num(req.params.id)));

router.post('/pembelian/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  if (id && !auth.can(req.user.role, 'edit')) {
    auth.setFlash(res, 'error', 'Role Anda tidak boleh mengedit data.');
    return res.redirect(res.locals.url('/transaksi/pembelian'));
  }
  const mids = arr(b.item_material), descs = arr(b.item_desc), qtys = arr(b.item_qty), costs = arr(b.item_cost);
  const unitValues = arr(b.item_unit);
  const items = qtys.map((q, i) => ({
    material_id: mids[i], desc: descs[i], qty: q, cost: costs[i],
    unit: unitValues[i]
  })).filter(it => util.num(it.qty) > 0);
  if (!items.length) {
    auth.setFlash(res, 'error', 'Minimal 1 item pembelian dengan qty > 0.');
    return res.redirect(res.locals.url(id ? '/transaksi/pembelian/' + id + '/edit' : '/transaksi/pembelian/baru'));
  }
  // subtotal dihitung dari angka yang diketik user (qty × harga) supaya sama persis dengan nota
  const subtotal = items.reduce((a, it) => a + Math.round(util.num(it.qty) * util.num(it.cost)), 0);
  const disc = util.num(b.discount);
  const total = Math.max(subtotal - disc, 0);
  const paid = util.num(b.paid);
  let status = paid >= total && total > 0 ? 'Lunas' : (paid > 0 ? 'Sebagian' : 'Belum Lunas');
  const date = b.date || util.todayISO();
  const header = [
    String(b.number || '').trim() || util.nextNumber('purchases', 'number', setting('purchase_prefix', 'PO')),
    date, b.supplier_id ? util.num(b.supplier_id) : null, subtotal, disc, total, paid, status, String(b.note || '')
  ];
  let newId = null;

  db.transaction(() => {
    if (id) {
      db.prepare('UPDATE purchases SET number=?, date=?, supplier_id=?, subtotal=?, discount=?, total=?, paid=?, status=?, note=? WHERE id=?').run(...header, id);
      reverseFlows('purchases', id);
      db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(id);
    } else {
      const info = db.prepare('INSERT INTO purchases(number, date, supplier_id, subtotal, discount, total, paid, status, note, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(...header, req.user.id);
      newId = Number(info.lastInsertRowid);
    }
    savePurchaseItems(id || newId, date, items, req.user.id);
  })();

  auth.setFlash(res, 'success', id ? 'Pembelian diperbarui (stok disesuaikan).' : 'Pembelian tersimpan & stok bahan bertambah.');
  res.redirect(res.locals.url('/transaksi/pembelian'));
});

router.get('/pembelian/:id', auth.requireLogin, (req, res) => {
  const id = util.num(req.params.id);
  const row = db.prepare(`SELECT pu.*, s.name AS supplier_name, s.phone AS supplier_phone, u.name AS oleh
    FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id LEFT JOIN users u ON u.id = pu.user_id WHERE pu.id = ?`).get(id);
  if (!row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data pembelian tidak ada.' });
  row.items = db.prepare(`SELECT pi.*, m.name AS material_name, m.unit FROM purchase_items pi
    LEFT JOIN materials m ON m.id = pi.material_id WHERE pi.purchase_id = ? ORDER BY pi.id`).all(id);
  res.render('transaksi/purchase-detail', { title: 'Pembelian ' + row.number, row });
});

router.post('/pembelian/:id/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id);
  db.transaction(() => {
    reverseFlows('purchases', id);
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(id);
    db.prepare('DELETE FROM purchases WHERE id = ?').run(id);
  })();
  auth.setFlash(res, 'success', 'Pembelian dihapus & stok dikembalikan.');
  res.redirect(res.locals.url('/transaksi/pembelian'));
});

/* ============================================================
   BAHAN TERPAKAI
   ============================================================ */
router.get('/bahan-terpakai', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const q = String(req.query.q || '').trim();
  const pid = util.num(req.query.project_id);
  const where = ["f.type = 'Keluar'", 'f.date BETWEEN @from AND @to']; const params = { from: p.from, to: p.to };
  if (q) { where.push('(m.name LIKE @q OR f.note LIKE @q)'); params.q = `%${q}%`; }
  if (pid) { where.push('f.project_id = @pid'); params.pid = pid; }
  const rows = db.prepare(`
    SELECT f.*, m.name AS material_name, m.unit, pr.code AS project_code, pr.name AS project_name, u.name AS oleh
    FROM material_flows f LEFT JOIN materials m ON m.id = f.material_id
    LEFT JOIN projects pr ON pr.id = f.project_id LEFT JOIN users u ON u.id = f.user_id
    WHERE ${where.join(' AND ')} ORDER BY f.date DESC, f.id DESC LIMIT ${LIMIT}
  `).all(params);
  res.render('transaksi/usage', {
    title: 'Bahan Terpakai', rows, p, filters: { q, project_id: pid || '' },
    materials: materials(), projects: projects(),
    total: util.sum(rows, 'total'), byMaterial: util.groupSum(rows, 'material_name', 'total')
  });
});

router.post('/bahan-terpakai/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body;
  const mid = util.num(b.material_id);
  const inQty = util.num(b.qty);
  if (!mid || inQty <= 0) {
    auth.setFlash(res, 'error', 'Pilih bahan dan isi qty lebih dari 0.');
    return res.redirect(res.locals.url('/transaksi/bahan-terpakai'));
  }
  const mat = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
  // Pemakaian dicatat langsung dalam satuan bahan (mis. meter)
  const unitCost = b.unit_cost ? util.num(b.unit_cost) : util.num(mat.avg_cost);
  applyFlow({
    material_id: mid, date: b.date || util.todayISO(), type: 'Keluar', qty: inQty, unit_cost: unitCost,
    total: Math.round(inQty * unitCost),
    input_qty: inQty, input_unit: mat.unit, input_price: unitCost,
    source: 'Pemakaian Produksi', ref_table: 'usage', ref_id: null,
    project_id: b.project_id ? util.num(b.project_id) : null, note: String(b.note || ''), user_id: req.user.id
  });
  auth.setFlash(res, 'success', `Pemakaian ${util.angka(inQty)} ${mat.unit} ${mat.name} dicatat, stok berkurang.`);
  const back = String(b.redirect || '');
  res.redirect(res.locals.url(back.startsWith('/') ? back : '/transaksi/bahan-terpakai'));
});

router.post('/bahan-terpakai/:id/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id);
  const f = db.prepare('SELECT * FROM material_flows WHERE id = ?').get(id);
  if (f) {
    const mat = db.prepare('SELECT * FROM materials WHERE id = ?').get(f.material_id);
    if (mat) db.prepare('UPDATE materials SET stock = ? WHERE id = ?').run(util.num(mat.stock) + util.num(f.qty), mat.id);
    db.prepare('DELETE FROM material_flows WHERE id = ?').run(id);
  }
  auth.setFlash(res, 'success', 'Catatan pemakaian dihapus & stok dikembalikan.');
  res.redirect(res.locals.url('/transaksi/bahan-terpakai'));
});

/* ============================================================
   PETTY CASH
   ============================================================ */
function pettyBalance() {
  const opening = util.num(setting('petty_opening', '0'));
  const masuk = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Masuk'").get().v;
  const keluar = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Keluar'").get().v;
  return { opening, masuk, keluar, saldo: opening + masuk - keluar };
}

router.get('/petty-cash', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const rows = db.prepare(`
    SELECT pc.*, u.name AS oleh FROM petty pc LEFT JOIN users u ON u.id = pc.user_id
    WHERE pc.date BETWEEN ? AND ? ORDER BY pc.date ASC, pc.id ASC LIMIT ${LIMIT}
  `).all(p.from, p.to);
  const bal = pettyBalance();
  const masukSebelum = util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type='Masuk' AND date < ?").get(p.from).v);
  const keluarSebelum = util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type='Keluar' AND date < ?").get(p.from).v);
  let run = bal.opening + masukSebelum - keluarSebelum;
  const saldoAwal = run;
  const withRun = rows.map(r => {
    run += r.type === 'Masuk' ? util.num(r.amount) : -util.num(r.amount);
    return { ...r, saldo: run };
  });
  res.render('transaksi/petty', {
    title: 'Petty Cash', rows: withRun, p, balance: bal, saldoAwal,
    masukPeriode: util.sum(rows.filter(r => r.type === 'Masuk'), 'amount'),
    keluarPeriode: util.sum(rows.filter(r => r.type === 'Keluar'), 'amount'),
    categories: listOrCsv('petty_categories')
  });
});

router.post('/petty-cash/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body;
  const amount = util.num(b.amount);
  const type = b.type === 'Masuk' ? 'Masuk' : 'Keluar';
  if (amount <= 0) {
    auth.setFlash(res, 'error', 'Nominal harus lebih dari 0.');
    return res.redirect(res.locals.url('/transaksi/petty-cash'));
  }
  const bal = pettyBalance();
  if (type === 'Keluar' && amount > bal.saldo) {
    auth.setFlash(res, 'error', `Saldo petty cash tidak cukup. Saldo saat ini ${util.rp(bal.saldo)}.`);
    return res.redirect(res.locals.url('/transaksi/petty-cash'));
  }
  db.transaction(() => {
    const info = db.prepare('INSERT INTO petty(date, type, category, description, amount, note, user_id) VALUES (?,?,?,?,?,?,?)').run(
      b.date || util.todayISO(), type, String(b.category || ''), String(b.description || ''), amount, String(b.note || ''), req.user.id
    );
    const pettyId = Number(info.lastInsertRowid);
    if (type === 'Keluar') {
      const e = db.prepare('INSERT INTO expenses(date, category, description, amount, source, note, petty_id, user_id) VALUES (?,?,?,?,?,?,?,?)').run(
        b.date || util.todayISO(), String(b.category || 'Operasional'), String(b.description || 'Pengeluaran petty cash'),
        amount, 'Petty Cash', 'Otomatis dari petty cash #' + pettyId, pettyId, req.user.id
      );
      db.prepare('UPDATE petty SET expense_id = ? WHERE id = ?').run(Number(e.lastInsertRowid), pettyId);
    }
  })();
  auth.setFlash(res, 'success', type === 'Masuk' ? 'Pengisian petty cash dicatat.' : 'Pengeluaran petty cash dicatat (otomatis masuk laporan pengeluaran).');
  res.redirect(res.locals.url('/transaksi/petty-cash'));
});

router.post('/petty-cash/:id/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM expenses WHERE petty_id = ?').run(id);
    db.prepare('DELETE FROM petty WHERE id = ?').run(id);
  })();
  auth.setFlash(res, 'success', 'Transaksi petty cash dihapus.');
  res.redirect(res.locals.url('/transaksi/petty-cash'));
});

/* ============================================================
   BARANG RIJEK
   ============================================================ */
const REJECT_ACTIONS = ['Perbaikan Ulang', 'Dibuang', 'Diskon ke Customer', 'Diganti Baru', 'Dijual Murah'];

router.get('/barang-rijek', auth.requireLogin, (req, res) => {
  const p = util.period(req.query);
  const q = String(req.query.q || '').trim();
  const where = ['r.date BETWEEN @from AND @to']; const params = { from: p.from, to: p.to };
  if (q) { where.push('(r.item_name LIKE @q OR r.reason LIKE @q OR r.note LIKE @q)'); params.q = `%${q}%`; }
  const rows = db.prepare(`
    SELECT r.*, pr.code AS project_code, pr.name AS project_name, c.name AS customer_name, m.name AS material_name, u.name AS oleh
    FROM rejects r LEFT JOIN projects pr ON pr.id = r.project_id
    LEFT JOIN customers c ON c.id = pr.customer_id
    LEFT JOIN materials m ON m.id = r.material_id LEFT JOIN users u ON u.id = r.user_id
    WHERE ${where.join(' AND ')} ORDER BY r.date DESC, r.id DESC LIMIT ${LIMIT}
  `).all(params);
  res.render('transaksi/rejects', {
    title: 'Laporan Barang Rijek', rows, p, filters: { q }, REJECT_ACTIONS,
    projects: projects(), materials: materials(),
    total: util.sum(rows, 'loss_cost'), totalQty: util.sum(rows, 'qty'),
    byReason: util.groupSum(rows, 'reason', 'loss_cost')
  });
});

function rejectForm(req, res, id) {
  const row = id ? db.prepare('SELECT * FROM rejects WHERE id = ?').get(id) : null;
  if (id && !row) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Data rijek tidak ada.' });
  res.render('transaksi/reject-form', {
    title: id ? 'Edit Barang Rijek' : 'Catat Barang Rijek', row, REJECT_ACTIONS,
    projects: projects(), materials: materials()
  });
}
router.get('/barang-rijek/baru', auth.requirePerm('input'), (req, res) => rejectForm(req, res, null));
router.get('/barang-rijek/:id/edit', auth.requirePerm('edit'), (req, res) => rejectForm(req, res, util.num(req.params.id)));

router.post('/barang-rijek/save', auth.requirePerm('input'), (req, res) => {
  const b = req.body; const id = util.num(b.id);
  const data = [
    b.date || util.todayISO(), b.project_id ? util.num(b.project_id) : null, b.material_id ? util.num(b.material_id) : null,
    String(b.item_name || '').trim(), util.num(b.qty), String(b.unit || 'pcs'), String(b.reason || ''),
    REJECT_ACTIONS.includes(b.action) ? b.action : 'Perbaikan Ulang', util.num(b.loss_cost), String(b.note || '')
  ];
  if (!data[3]) {
    auth.setFlash(res, 'error', 'Nama barang/item rijek wajib diisi.');
    return res.redirect(res.locals.url(id ? '/transaksi/barang-rijek/' + id + '/edit' : '/transaksi/barang-rijek/baru'));
  }
  if (id) {
    if (!auth.can(req.user.role, 'edit')) { auth.setFlash(res, 'error', 'Role Anda tidak boleh mengedit data.'); return res.redirect(res.locals.url('/transaksi/barang-rijek')); }
    db.prepare('UPDATE rejects SET date=?, project_id=?, material_id=?, item_name=?, qty=?, unit=?, reason=?, action=?, loss_cost=?, note=? WHERE id=?').run(...data, id);
    auth.setFlash(res, 'success', 'Data barang rijek diperbarui.');
  } else {
    db.prepare('INSERT INTO rejects(date, project_id, material_id, item_name, qty, unit, reason, action, loss_cost, note, user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...data, req.user.id);
    auth.setFlash(res, 'success', 'Barang rijek tercatat.');
  }
  res.redirect(res.locals.url('/transaksi/barang-rijek'));
});

router.post('/barang-rijek/:id/delete', auth.requirePerm('del'), (req, res) => {
  db.prepare('DELETE FROM rejects WHERE id = ?').run(util.num(req.params.id));
  auth.setFlash(res, 'success', 'Data rijek dihapus.');
  res.redirect(res.locals.url('/transaksi/barang-rijek'));
});

module.exports = router;
