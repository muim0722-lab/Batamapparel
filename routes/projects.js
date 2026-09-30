'use strict';
const express = require('express');
const { db, setting } = require('../lib/db');
const auth = require('../lib/auth');
const util = require('../lib/util');
const router = express.Router();

const STATUS = ['Baru', 'Proses', 'Revisi', 'Selesai', 'Batal'];
const PRIORITY = ['Normal', 'Urgent'];
const STAGE_STATUS = ['Belum', 'Proses', 'Selesai'];

function warnDays() { return parseInt(setting('deadline_warning_days', '3'), 10) || 3; }

function projectRow(id) {
  const p = db.prepare(`
    SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, c.address AS customer_address,
           u.name AS dibuat_oleh
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?
  `).get(id);
  if (!p) return null;
  p.info = util.deadlineInfo(p.deadline, p.status, warnDays());
  p.stages = db.prepare(`
    SELECT pp.*, st.name AS stage_name, st.sort_order, us.name AS oleh
    FROM project_progress pp JOIN stages st ON st.id = pp.stage_id
    LEFT JOIN users us ON us.id = pp.user_id
    WHERE pp.project_id = ? ORDER BY st.sort_order, st.id
  `).all(id);
  p.doneStages = p.stages.filter(s => s.status === 'Selesai').length;
  p.progress = p.stages.length ? Math.round(p.doneStages / p.stages.length * 100) : 0;
  p.logs = db.prepare(`
    SELECT l.*, u.name AS oleh FROM project_logs l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.project_id = ? ORDER BY l.id DESC LIMIT 40
  `).all(id);
  p.revenue = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM incomes WHERE project_id = ?').get(id).v;
  p.salesTotal = db.prepare('SELECT COALESCE(SUM(total),0) v FROM sales WHERE project_id = ?').get(id).v;
  p.expenseTotal = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE project_id = ?').get(id).v;
  p.materialCost = db.prepare('SELECT COALESCE(SUM(total),0) v FROM material_flows WHERE project_id = ? AND type = ?').get(id, 'Keluar').v;
  p.margin = (p.revenue || p.salesTotal) - p.expenseTotal - p.materialCost;
  p.materials = db.prepare(`
    SELECT mf.*, m.name AS material_name, m.unit FROM material_flows mf
    LEFT JOIN materials m ON m.id = mf.material_id
    WHERE mf.project_id = ? ORDER BY mf.date DESC, mf.id DESC LIMIT 50
  `).all(id);
  p.expenses = db.prepare("SELECT * FROM expenses WHERE project_id = ? ORDER BY date DESC LIMIT 50").all(id);
  p.rejectRows = db.prepare('SELECT * FROM rejects WHERE project_id = ? ORDER BY date DESC LIMIT 50').all(id);
  p.linkable = { sales: [] };
  return p;
}

function logStage(projectId, stage, status, note, userId) {
  db.prepare(`INSERT INTO project_logs(project_id, stage_id, stage_name, status, note, user_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(projectId, stage.id, stage.stage_name || stage.name || '', status, note || '', userId);
}

// ---------- LIST ----------
router.get('/', auth.requireLogin, (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '');
  const priority = String(req.query.priority || '');
  const only = String(req.query.only || '');
  const wd = warnDays();

  const where = [];
  const params = {};
  if (q) { where.push('(p.name LIKE @q OR p.code LIKE @q OR c.name LIKE @q OR p.tracking_no LIKE @q)'); params.q = `%${q}%`; }
  if (status) { where.push('p.status = @status'); params.status = status; }
  if (priority) { where.push('p.priority = @priority'); params.priority = priority; }
  if (only === 'aktif') where.push("p.status IN ('Baru','Proses','Revisi')");

  const rows = db.prepare(`
    SELECT p.*, c.name AS customer_name,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id AND pp.status = 'Selesai') AS done_stages,
      (SELECT COUNT(*) FROM project_progress pp WHERE pp.project_id = p.id) AS total_stages,
      (SELECT st.name FROM project_progress pp JOIN stages st ON st.id = pp.stage_id
        WHERE pp.project_id = p.id AND pp.status = 'Proses' ORDER BY st.sort_order LIMIT 1) AS current_stage
    FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN p.status IN ('Selesai','Batal') THEN 1 ELSE 0 END,
             CASE WHEN p.priority = 'Urgent' THEN 0 ELSE 1 END,
             p.deadline IS NULL, p.deadline ASC, p.id DESC
  `).all(params).map(p => ({
    ...p,
    info: util.deadlineInfo(p.deadline, p.status, wd),
    progress: p.total_stages ? Math.round(p.done_stages / p.total_stages * 100) : 0
  }));

  const list = only === 'urgent' ? rows.filter(r => ['overdue', 'urgent'].includes(r.info.level)) : rows;

  res.render('projects/list', {
    title: 'Tracking Project', projects: list, filters: { q, status, priority, only },
    STATUS, PRIORITY, wd,
    stats: {
      total: rows.length,
      aktif: rows.filter(r => ['Baru', 'Proses', 'Revisi'].includes(r.status)).length,
      urgent: rows.filter(r => ['overdue', 'urgent'].includes(r.info.level)).length,
      selesai: rows.filter(r => r.status === 'Selesai').length
    }
  });
});

// ---------- FORM BARU ----------
router.get('/baru', auth.requirePerm('input'), (req, res) => {
  res.render('projects/form', {
    title: 'Project Baru', project: null, STATUS, PRIORITY,
    customers: db.prepare('SELECT id, name FROM customers ORDER BY name').all(),
    nextCode: util.nextNumber('projects', 'code', setting('project_prefix', 'PRJ'))
  });
});
router.post('/', auth.requirePerm('input'), (req, res) => {
  const b = req.body;
  const name = String(b.name || '').trim();
  if (!name) { auth.setFlash(res, 'error', 'Nama project wajib diisi.'); return res.redirect(res.locals.url('/projects/baru')); }

  const info = db.prepare(`INSERT INTO projects(code, name, customer_id, order_date, deadline, priority, qty, description, sport, fabrics, total_price, status, courier, tracking_no, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    String(b.code || util.nextNumber('projects', 'code', setting('project_prefix', 'PRJ'))).trim(),
    name,
    b.customer_id ? util.num(b.customer_id) : null,
    b.order_date || util.todayISO(),
    b.deadline || null,
    PRIORITY.includes(b.priority) ? b.priority : 'Normal',
    util.num(b.qty),
    String(b.description || ''),
    String(b.sport || ''), String(b.fabrics || ''),
    util.num(b.total_price),
    STATUS.includes(b.status) ? b.status : 'Baru',
    String(b.courier || ''), String(b.tracking_no || ''),
    req.user.id
  );
  const id = info.lastInsertRowid;
  const stages = db.prepare('SELECT * FROM stages WHERE active = 1 ORDER BY sort_order, id').all();
  const ins = db.prepare('INSERT INTO project_progress(project_id, stage_id, status, note, user_id) VALUES (?, ?, ?, ?, ?)');
  stages.forEach((s, i) => ins.run(id, s.id, i === 0 ? 'Proses' : 'Belum', '', req.user.id));
  db.prepare(`INSERT INTO project_logs(project_id, stage_name, status, note, user_id) VALUES (?,?,?,?,?)`)
    .run(id, '(Project dibuat)', 'Baru', 'Project dibuat dengan ' + stages.length + ' tahapan', req.user.id);

  auth.setFlash(res, 'success', 'Project berhasil dibuat.');
  res.redirect(res.locals.url('/projects/' + id));
});

// ---------- DETAIL ----------
router.get('/:id', auth.requireLogin, (req, res) => {
  const p = projectRow(util.num(req.params.id));
  if (!p) return res.status(404).render('error', { title: 'Project tidak ditemukan', code: 404, message: 'Data project tidak ada.' });
  res.render('projects/detail', {
    title: 'Project ' + p.code, project: p, STATUS, PRIORITY, STAGE_STATUS, wd: warnDays()
  });
});

// update progress semua tahapan
router.post('/:id/progress', auth.requirePerm('input'), (req, res) => {
  const id = util.num(req.params.id);
  const p = projectRow(id);
  if (!p) return res.redirect(res.locals.url('/projects'));

  let ids = req.body.stage_id || []; let sts = req.body.status || []; let notes = req.body.note || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(sts)) sts = [sts];
  if (!Array.isArray(notes)) notes = [notes];

  const update = db.prepare("UPDATE project_progress SET status = ?, note = ?, updated_at = datetime('now','localtime'), user_id = ? WHERE id = ?");
  const detail = String(req.body.detail_note || '').trim();
  db.transaction(() => {
    ids.forEach((rowId, i) => {
      const cur = p.stages.find(s => String(s.id) === String(rowId));
      if (!cur) return;
      let newStatus = STAGE_STATUS.includes(sts[i]) ? sts[i] : cur.status;
      const newNote = String(notes[i] ?? cur.note ?? '');
      // tidak boleh mundur ke belakang kalau bukan leader/owner
      if (newStatus !== cur.status || newNote !== (cur.note || '')) {
        update.run(newStatus, newNote, req.user.id, cur.id);
        if (newStatus !== cur.status) logStage(id, cur, newStatus, newNote, req.user.id);
      }
    });
    // status project otomatis
    const st = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END) done FROM project_progress WHERE project_id = ?").get(id);
    const newProjStatus = String(req.body.project_status || '');
    if (STATUS.includes(newProjStatus) && newProjStatus !== p.status) {
      db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(newProjStatus, id);
      db.prepare('INSERT INTO project_logs(project_id, stage_name, status, note, user_id) VALUES (?,?,?,?,?)')
        .run(id, '(Status project)', newProjStatus, 'Status project diubah', req.user.id);
    } else if (st.total > 0 && st.done === st.total && p.status !== 'Selesai' && p.status !== 'Batal') {
      db.prepare("UPDATE projects SET status = 'Selesai' WHERE id = ?").run(id);
      db.prepare('INSERT INTO project_logs(project_id, stage_name, status, note, user_id) VALUES (?,?,?,?,?)')
        .run(id, '(Status project)', 'Selesai', 'Semua tahapan selesai — project otomatis ditandai Selesai', req.user.id);
    }
    if (detail) logStage(id, { id: null, stage_name: '(Catatan)' }, p.status, detail, req.user.id);
  })();

  auth.setFlash(res, 'success', 'Progress project diperbarui.');
  res.redirect(res.locals.url('/projects/' + id));
});

// update cepat satu tahapan
router.post('/:id/stage/:stageId', auth.requirePerm('input'), (req, res) => {
  const id = util.num(req.params.id), stageId = util.num(req.params.stageId);
  const p = projectRow(id);
  const cur = p && p.stages.find(s => s.stage_id === stageId);
  if (!cur) return res.redirect(res.locals.url('/projects/' + id));
  const target = String(req.body.status || 'Selesai');
  const status = STAGE_STATUS.includes(target) ? target : 'Selesai';
  db.prepare("UPDATE project_progress SET status = ?, updated_at = datetime('now','localtime'), user_id = ? WHERE id = ?")
    .run(status, req.user.id, cur.id);
  logStage(id, cur, status, req.body.note || '', req.user.id);

  const st = db.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status = 'Selesai' THEN 1 ELSE 0 END) done FROM project_progress WHERE project_id = ?").get(id);
  if (st.total > 0 && st.done === st.total && !['Selesai', 'Batal'].includes(p.status)) {
    db.prepare("UPDATE projects SET status = 'Selesai' WHERE id = ?").run(id);
    db.prepare('INSERT INTO project_logs(project_id, stage_name, status, note, user_id) VALUES (?,?,?,?,?)')
      .run(id, '(Status project)', 'Selesai', 'Semua tahapan selesai — project otomatis Selesai', req.user.id);
  }
  auth.setFlash(res, 'success', `Tahap ${cur.stage_name} → ${status}.`);
  res.redirect(res.locals.url('/projects/' + id));
});

// ---------- EDIT ----------
router.get('/:id/edit', auth.requirePerm('edit'), (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(util.num(req.params.id));
  if (!project) return res.status(404).render('error', { title: 'Tidak ditemukan', code: 404, message: 'Project tidak ada.' });
  res.render('projects/form', {
    title: 'Edit Project ' + project.code, project, STATUS, PRIORITY,
    customers: db.prepare('SELECT id, name FROM customers ORDER BY name').all(),
    nextCode: project.code
  });
});

router.post('/:id/edit', auth.requirePerm('edit'), (req, res) => {
  const id = util.num(req.params.id);
  const b = req.body;
  db.prepare(`UPDATE projects SET code=?, name=?, customer_id=?, order_date=?, deadline=?, priority=?, qty=?,
      description=?, sport=?, fabrics=?, total_price=?, status=?, courier=?, tracking_no=? WHERE id=?`).run(
    String(b.code || '').trim(), String(b.name || '').trim(),
    b.customer_id ? util.num(b.customer_id) : null,
    b.order_date || util.todayISO(), b.deadline || null,
    PRIORITY.includes(b.priority) ? b.priority : 'Normal',
    util.num(b.qty), String(b.description || ''), String(b.sport || ''), String(b.fabrics || ''),
    util.num(b.total_price),
    STATUS.includes(b.status) ? b.status : 'Proses',
    String(b.courier || ''), String(b.tracking_no || ''), id
  );
  db.prepare('INSERT INTO project_logs(project_id, stage_name, status, note, user_id) VALUES (?,?,?,?,?)')
    .run(id, '(Project)', String(b.status || ''), 'Data project diperbarui', req.user.id);
  auth.setFlash(res, 'success', 'Project diperbarui.');
  res.redirect(res.locals.url('/projects/' + id));
});

router.post('/:id/delete', auth.requirePerm('del'), (req, res) => {
  const id = util.num(req.params.id);
  db.transaction(() => {
    db.prepare('DELETE FROM project_progress WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM project_logs WHERE project_id = ?').run(id);
    db.prepare('UPDATE incomes SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('UPDATE expenses SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('UPDATE sales SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('UPDATE material_flows SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('UPDATE rejects SET project_id = NULL WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  })();
  auth.setFlash(res, 'success', 'Project dihapus.');
  res.redirect(res.locals.url('/projects'));
});

module.exports = router;
