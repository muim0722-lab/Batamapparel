'use strict';
const express = require('express');
const { db, setting, settingNum } = require('../lib/db');
const auth = require('../lib/auth');
const util = require('../lib/util');
const router = express.Router();

// Semua halaman laporan: Leader & Owner.
// Tiga laporan keuangan inti (Ringkasan, Laba Rugi, Arus Kas) dibatasi lagi ke Owner saja.
router.use(auth.requireReport);

function meta(req) {
  return {
    company: setting('company_name', 'Batam Apparel'),
    tagline: setting('company_tagline', ''),
    address: setting('company_address', ''),
    phone: setting('company_phone', ''),
    printedBy: req.user.name,
    printedAt: util.dmyLong(util.todayISO())
  };
}

/* ---------- HUB (khusus Owner: memuat ringkasan keuangan) ---------- */
router.get('/', auth.requireReportFin, (req, res) => {
  const p = util.period(req.query);
  const income = util.num(db.prepare('SELECT COALESCE(SUM(amount),0) v FROM incomes WHERE date BETWEEN ? AND ?').get(p.from, p.to).v);
  const expense = util.num(db.prepare('SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE date BETWEEN ? AND ?').get(p.from, p.to).v);
  const purchase = util.num(db.prepare('SELECT COALESCE(SUM(total),0) v FROM purchases WHERE date BETWEEN ? AND ?').get(p.from, p.to).v);
  const reject = util.num(db.prepare('SELECT COALESCE(SUM(loss_cost),0) v FROM rejects WHERE date BETWEEN ? AND ?').get(p.from, p.to).v);
  res.render('laporan/hub', {
    title: 'Laporan Keuangan', p, m: meta(req),
    kpi: { income, expense, purchase, reject, laba: income - expense - purchase }
  });
});

/* ---------- LABA RUGI (khusus Owner) ---------- */
router.get('/laba-rugi', auth.requireReportFin, (req, res) => {
  const p = util.period(req.query);
  const incomes = db.prepare('SELECT * FROM incomes WHERE date BETWEEN ? AND ?').all(p.from, p.to);
  const expenses = db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ?').all(p.from, p.to);
  const purchases = db.prepare(`SELECT pu.*, s.name AS supplier_name FROM purchases pu
    LEFT JOIN suppliers s ON s.id = pu.supplier_id WHERE pu.date BETWEEN ? AND ?`).all(p.from, p.to);
  const rejects = util.num(db.prepare('SELECT COALESCE(SUM(loss_cost),0) v FROM rejects WHERE date BETWEEN ? AND ?').get(p.from, p.to).v);

  const pendapatan = util.sum(incomes, 'amount');
  const hpp = util.sum(purchases, 'total');
  const biaya = util.sum(expenses, 'amount');
  const labaKotor = pendapatan - hpp;
  const labaBersih = labaKotor - biaya;
  const margin = pendapatan > 0 ? (labaBersih / pendapatan * 100) : 0;

  res.render('laporan/laba-rugi', {
    title: 'Laporan Laba Rugi', p, m: meta(req),
    byIncome: util.groupSum(incomes, 'category', 'amount'),
    byExpense: util.groupSum(expenses, 'category', 'amount'),
    pendapatan, hpp, biaya, labaKotor, labaBersih, margin, rejects,
    jmlTransaksi: incomes.length, jmlBiaya: expenses.length
  });
});

/* ---------- ARUS KAS (khusus Owner) ---------- */
router.get('/arus-kas', auth.requireReportFin, (req, res) => {
  const p = util.period(req.query);
  const incomes = db.prepare('SELECT * FROM incomes WHERE date BETWEEN ? AND ?').all(p.from, p.to);
  const expenses = db.prepare("SELECT * FROM expenses WHERE date BETWEEN ? AND ? AND source != 'Petty Cash'").all(p.from, p.to);
  const purchases = db.prepare('SELECT * FROM purchases WHERE date BETWEEN ? AND ?').all(p.from, p.to);
  const pettyRows = db.prepare('SELECT * FROM petty WHERE date BETWEEN ? AND ? ORDER BY date, id').all(p.from, p.to);

  const mainOpening = util.num(db.prepare('SELECT COALESCE(SUM(amount),0) v FROM incomes WHERE date < ?').get(p.from).v)
    - util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE source != 'Petty Cash' AND date < ?").get(p.from).v)
    - util.num(db.prepare('SELECT COALESCE(SUM(paid),0) v FROM purchases WHERE date < ?').get(p.from).v)
    - util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Masuk' AND date < ?").get(p.from).v);
  const pettyOpening = settingNum('petty_opening', 0)
    + util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Masuk' AND date < ?").get(p.from).v)
    - util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Keluar' AND date < ?").get(p.from).v);

  const masukKas = util.sum(incomes, 'amount');
  const keluarBiaya = util.sum(expenses, 'amount');
  const keluarPembelian = util.sum(purchases, 'paid');
  const isiPetty = util.sum(pettyRows.filter(r => r.type === 'Masuk'), 'amount');
  const pakaiPetty = util.sum(pettyRows.filter(r => r.type === 'Keluar'), 'amount');

  const mainClosing = mainOpening + masukKas - keluarBiaya - keluarPembelian - isiPetty;
  const pettyClosing = pettyOpening + isiPetty - pakaiPetty;

  res.render('laporan/arus-kas', {
    title: 'Laporan Arus Kas', p, m: meta(req),
    byMethod: util.groupSum(incomes, 'method', 'amount'),
    byExpenseCat: util.groupSum(expenses, 'category', 'amount'),
    masukKas, keluarBiaya, keluarPembelian, isiPetty, pakaiPetty,
    mainOpening, mainClosing, pettyOpening, pettyClosing,
    totalOpening: mainOpening + pettyOpening, totalClosing: mainClosing + pettyClosing,
    pettyRows, purchases: util.sum(purchases, 'paid') ? purchases : []
  });
});

/* ---------- PENJUALAN ---------- */
router.get('/penjualan', (req, res) => {
  const p = util.period(req.query);
  const rows = db.prepare(`
    SELECT s.*, c.name AS customer_name, pr.code AS project_code FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN projects pr ON pr.id = s.project_id
    WHERE s.date BETWEEN ? AND ? ORDER BY s.date, s.id
  `).all(p.from, p.to);
  const items = db.prepare(`
    SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.date BETWEEN ? AND ?
  `).all(p.from, p.to);
  res.render('laporan/penjualan', {
    title: 'Laporan Penjualan', p, m: meta(req), rows,
    total: util.sum(rows, 'total'), paid: util.sum(rows, 'paid'),
    unpaid: util.sum(rows, 'total') - util.sum(rows, 'paid'),
    byCustomer: util.groupSum(rows, 'customer_name', 'total'),
    topItems: util.groupSum(items, 'description', 'subtotal').slice(0, 10),
    totalQty: util.sum(items, 'qty')
  });
});

/* ---------- PEMBELIAN ---------- */
router.get('/pembelian', (req, res) => {
  const p = util.period(req.query);
  const rows = db.prepare(`
    SELECT pu.*, s.name AS supplier_name,
      (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS jml_item
    FROM purchases pu LEFT JOIN suppliers s ON s.id = pu.supplier_id
    WHERE pu.date BETWEEN ? AND ? ORDER BY pu.date, pu.id
  `).all(p.from, p.to);
  const items = db.prepare(`
    SELECT pi.*, m.name AS material_name, m.unit FROM purchase_items pi
    JOIN purchases pu ON pu.id = pi.purchase_id LEFT JOIN materials m ON m.id = pi.material_id
    WHERE pu.date BETWEEN ? AND ?`).all(p.from, p.to);
  res.render('laporan/pembelian', {
    title: 'Laporan Pembelian Bahan', p, m: meta(req), rows,
    total: util.sum(rows, 'total'), paid: util.sum(rows, 'paid'),
    unpaid: util.sum(rows, 'total') - util.sum(rows, 'paid'),
    bySupplier: util.groupSum(rows, 'supplier_name', 'total'),
    byMaterial: util.groupSum(items, 'material_name', 'subtotal')
  });
});

/* ---------- STOK BAHAN ---------- */
router.get('/bahan', (req, res) => {
  const p = util.period(req.query);
  const materials = db.prepare('SELECT * FROM materials ORDER BY name COLLATE NOCASE').all();
  const flows = db.prepare('SELECT * FROM material_flows WHERE date BETWEEN ? AND ?').all(p.from, p.to);
  const masuk = flows.filter(f => f.type === 'Masuk');
  const keluar = flows.filter(f => f.type === 'Keluar');
  const perBahan = materials.map(m => {
    const mIn = masuk.filter(f => f.material_id === m.id);
    const mOut = keluar.filter(f => f.material_id === m.id);
    return {
      ...m,
      qtyMasuk: util.sum(mIn, 'qty'), qtyKeluar: util.sum(mOut, 'qty'),
      nilaiMasuk: util.sum(mIn, 'total'), nilaiKeluar: util.sum(mOut, 'total'),
      nilaiStok: util.num(m.stock) * util.num(m.avg_cost),
      status: util.num(m.stock) <= util.num(m.min_stock) ? 'Menipis' : 'Aman'
    };
  });
  res.render('laporan/bahan', {
    title: 'Laporan Stok & Pemakaian Bahan', p, m: meta(req), perBahan,
    totalNilai: perBahan.reduce((a, b) => a + b.nilaiStok, 0),
    totalKeluar: util.sum(keluar, 'total'), totalMasuk: util.sum(masuk, 'total'),
    byMaterial: util.groupSum(keluar, 'material_id', 'total').map(x => {
      const mm = materials.find(z => String(z.id) === String(x.label));
      return { label: mm ? mm.name : x.label, value: x.value };
    }),
    menipis: perBahan.filter(b => b.status === 'Menipis').length
  });
});

/* ---------- PETTY CASH ---------- */
router.get('/petty-cash', (req, res) => {
  const p = util.period(req.query);
  const rows = db.prepare('SELECT * FROM petty WHERE date BETWEEN ? AND ? ORDER BY date, id').all(p.from, p.to);
  const opening = settingNum('petty_opening', 0)
    + util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Masuk' AND date < ?").get(p.from).v)
    - util.num(db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Keluar' AND date < ?").get(p.from).v);
  let run = opening;
  const withRun = rows.map(r => {
    run += r.type === 'Masuk' ? util.num(r.amount) : -util.num(r.amount);
    return { ...r, saldo: run };
  });
  res.render('laporan/petty-cash', {
    title: 'Laporan Petty Cash', p, m: meta(req), rows: withRun, opening, closing: run,
    masuk: util.sum(rows.filter(r => r.type === 'Masuk'), 'amount'),
    keluar: util.sum(rows.filter(r => r.type === 'Keluar'), 'amount'),
    byCategory: util.groupSum(rows.filter(r => r.type === 'Keluar'), 'category', 'amount')
  });
});

/* ---------- BARANG RIJEK ---------- */
router.get('/rijek', (req, res) => {
  const p = util.period(req.query);
  const rows = db.prepare(`
    SELECT r.*, pr.code AS project_code, pr.name AS project_name, m.name AS material_name
    FROM rejects r LEFT JOIN projects pr ON pr.id = r.project_id LEFT JOIN materials m ON m.id = r.material_id
    WHERE r.date BETWEEN ? AND ? ORDER BY r.date, r.id
  `).all(p.from, p.to);
  res.render('laporan/rijek', {
    title: 'Laporan Barang Rijek', p, m: meta(req), rows,
    total: util.sum(rows, 'loss_cost'), totalQty: util.sum(rows, 'qty'),
    byReason: util.groupSum(rows, 'reason', 'loss_cost'),
    byAction: util.groupSum(rows, 'action', 'loss_cost'),
    byProject: util.groupSum(rows, 'project_code', 'loss_cost')
  });
});

/* ---------- PROJECT ---------- */
router.get('/project', (req, res) => {
  const p = util.period(req.query);
  const wd = settingNum('deadline_warning_days', 3);
  const rows = db.prepare(`
    SELECT p.*, c.name AS customer_name,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id AND pp.status = 'Selesai') AS done_stages,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id) AS total_stages,
      (SELECT COALESCE(SUM(amount),0) FROM incomes i WHERE i.project_id = p.id) AS pendapatan,
      (SELECT COALESCE(SUM(amount),0) FROM expenses e WHERE e.project_id = p.id) AS biaya,
      (SELECT COALESCE(SUM(total),0) FROM material_flows f WHERE f.project_id = p.id AND f.type = 'Keluar') AS bahan
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.order_date BETWEEN ? AND ? ORDER BY p.order_date, p.id
  `).all(p.from, p.to).map(r => ({
    ...r,
    progress: r.total_stages ? Math.round(r.done_stages / r.total_stages * 100) : 0,
    info: util.deadlineInfo(r.deadline, r.status, wd)
  }));
  res.render('laporan/project', {
    title: 'Laporan Project', p, m: meta(req), rows,
    totalNilai: util.sum(rows, 'total_price'),
    pendapatan: util.sum(rows, 'pendapatan'),
    biaya: util.sum(rows, 'biaya') + util.sum(rows, 'bahan'),
    selesai: rows.filter(r => r.status === 'Selesai').length,
    aktif: rows.filter(r => ['Baru', 'Proses', 'Revisi'].includes(r.status)).length,
    urgent: rows.filter(r => ['overdue', 'urgent'].includes(r.info.level)).length,
    byStatus: util.groupSum(rows, 'status', 'total_price')
  });
});

module.exports = router;
