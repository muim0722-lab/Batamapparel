'use strict';
const express = require('express');
const { db, setting, settingNum } = require('../lib/db');
const auth = require('../lib/auth');
const util = require('../lib/util');
const router = express.Router();

const ACTIVE_STATUS = ['Baru', 'Proses', 'Revisi'];

function urgentProjects(warnDays) {
  const rows = db.prepare(`
    SELECT p.*, c.name AS customer_name,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id AND pp.status = 'Selesai') AS done_stages,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id) AS total_stages
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.status NOT IN ('Selesai','Batal') AND p.deadline IS NOT NULL AND p.deadline != ''
    ORDER BY p.deadline ASC
  `).all();
  return rows
    .map(p => ({ ...p, info: util.deadlineInfo(p.deadline, p.status, warnDays) }))
    .filter(p => ['overdue', 'urgent'].includes(p.info.level));
}

function dashboardData(warnDays) {
  const { from, to } = { from: util.monthStart(), to: util.monthEnd() };
  const incomeMonth = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM incomes WHERE date BETWEEN ? AND ?').get(from, to).v;
  const expenseMonth = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE date BETWEEN ? AND ?').get(from, to).v;
  const purchaseMonth = db.prepare('SELECT COALESCE(SUM(total),0) v FROM purchases WHERE date BETWEEN ? AND ?').get(from, to).v;
  const saleMonth = db.prepare('SELECT COALESCE(SUM(total),0) v FROM sales WHERE date BETWEEN ? AND ?').get(from, to).v;

  const totalIncome = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM incomes').get().v;
  const totalExpenseMain = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE source != 'Petty Cash'").get().v;
  const totalPurchasePaid = db.prepare('SELECT COALESCE(SUM(paid),0) v FROM purchases').get().v;
  const pettyOpening = settingNum('petty_opening', 0);
  const pettyIn = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Masuk'").get().v;
  const pettyOut = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM petty WHERE type = 'Keluar'").get().v;
  const pettyBalance = pettyOpening + pettyIn - pettyOut;
  const mainCash = totalIncome - totalExpenseMain - totalPurchasePaid;

  const receivable = db.prepare("SELECT COALESCE(SUM(total - paid),0) v FROM sales WHERE status != 'Lunas'").get().v;
  const payable = db.prepare("SELECT COALESCE(SUM(total - paid),0) v FROM purchases WHERE status != 'Lunas'").get().v;

  const projectStats = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('Baru','Proses','Revisi') THEN 1 ELSE 0 END) AS aktif,
      SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END) AS selesai,
      SUM(CASE WHEN priority = 'Urgent' AND status NOT IN ('Selesai','Batal') THEN 1 ELSE 0 END) AS urgent
    FROM projects
  `).get();

  const chart = util.lastMonths(6).map(m => {
    const inc = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM incomes WHERE strftime('%Y-%m', date) = ?").get(m.key).v;
    const exp = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE strftime('%Y-%m', date) = ?").get(m.key).v
      + db.prepare("SELECT COALESCE(SUM(total),0) v FROM purchases WHERE strftime('%Y-%m', date) = ?").get(m.key).v;
    return { ...m, inc, exp, profit: inc - exp };
  });

  const recent = db.prepare(`
    SELECT * FROM (
      SELECT 'Pemasukan' AS jenis, date, COALESCE(description, category) AS ket, amount, '+' AS sign FROM incomes
      UNION ALL
      SELECT 'Pengeluaran' AS jenis, date, COALESCE(description, category) AS ket, amount, '-' AS sign FROM expenses
    ) ORDER BY date DESC LIMIT 8
  `).all();

  const lowStock = db.prepare('SELECT * FROM materials WHERE stock <= min_stock ORDER BY (stock - min_stock) ASC, name ASC LIMIT 6').all();

  const projects = db.prepare(`
    SELECT p.*, c.name AS customer_name,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id AND pp.status = 'Selesai') AS done_stages,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id) AS total_stages
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
    WHERE p.status IN ('Baru','Proses','Revisi')
    ORDER BY CASE WHEN p.priority = 'Urgent' THEN 0 ELSE 1 END, p.deadline IS NULL, p.deadline ASC
    LIMIT 8
  `).all().map(p => ({ ...p, info: util.deadlineInfo(p.deadline, p.status, warnDays) }));

  return {
    incomeMonth, expenseMonth, purchaseMonth, saleMonth,
    profitMonth: incomeMonth - expenseMonth - purchaseMonth,
    mainCash, pettyBalance, pettyOpening, pettyIn, pettyOut, cashTotal: mainCash + pettyBalance,
    receivable, payable, projectStats, chart, recent, lowStock, projects
  };
}

router.get('/', auth.requireLogin, (req, res) => {
  const warnDays = parseInt(setting('deadline_warning_days', '3'), 10) || 3;
  const data = dashboardData(warnDays);

  // popup reminder: hanya sekali per login
  let reminder = null;
  if (req.sessionToken) {
    const s = db.prepare('SELECT show_reminder FROM sessions WHERE token = ?').get(req.sessionToken);
    if (s && s.show_reminder) {
      db.prepare('UPDATE sessions SET show_reminder = 0 WHERE token = ?').run(req.sessionToken);
      const list = urgentProjects(warnDays);
      if (list.length) reminder = list;
    }
  }

  res.render('dashboard', {
    title: 'Dashboard',
    data, warnDays, reminder,
    stageSummary: db.prepare(`
      SELECT st.name, st.id,
        (SELECT COUNT(*) FROM project_progress pp JOIN projects pr ON pr.id = pp.project_id
          WHERE pp.stage_id = st.id AND pp.status = 'Selesai' AND pr.status IN ('Baru','Proses','Revisi')) AS jumlah
      FROM stages st WHERE st.active = 1 ORDER BY st.sort_order
    `).all()
  });
});

module.exports = router;
module.exports.urgentProjects = urgentProjects;
module.exports.dashboardData = dashboardData;
