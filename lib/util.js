'use strict';

const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function pad(n, len = 2) { return String(n).padStart(len, '0'); }

/** Parse angka gaya Indonesia: "1.500.000" -> 1500000 ; "12,5" -> 12.5 */
function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim().replace(/\s|Rp/gi, '');
  if (!s) return 0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // format 1.500.000,50
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (hasComma) {
    s = s.replace(',', '.');
  } else if (hasDot) {
    const parts = s.split('.');
    const last = parts[parts.length - 1];
    // 1.500 -> ribuan ; 12.5 -> desimal
    if (parts.length > 2 || last.length === 3) s = parts.join('');
  }
  const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function rp(v) {
  const n = Math.round(num(v));
  const sign = n < 0 ? '-' : '';
  return sign + 'Rp ' + Math.abs(n).toLocaleString('id-ID');
}
function rpShort(v) {
  const n = num(v);
  const a = Math.abs(n);
  if (a >= 1e9) return 'Rp ' + (n / 1e9).toFixed(1).replace('.', ',') + ' M';
  if (a >= 1e6) return 'Rp ' + (n / 1e6).toFixed(1).replace('.', ',') + ' jt';
  if (a >= 1e3) return 'Rp ' + Math.round(n / 1e3) + ' rb';
  return rp(n);
}
function angka(v) {
  const n = num(v);
  return (Number.isInteger(n) ? n : Math.round(n * 100) / 100).toLocaleString('id-ID');
}

function iso(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function todayISO() { return iso(new Date()); }
function nowStamp() {
  const d = new Date();
  return `${iso(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function dmy(v) {
  if (!v) return '-';
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(v);
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}
function dmyShort(v) {
  if (!v) return '-';
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(v);
  const [y, m, d] = s.split('-');
  return `${d} ${MONTHS_SHORT[Number(m) - 1]} ${y}`;
}
function dmyLong(v) {
  if (!v) return '-';
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(v);
  const [y, m, d] = s.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}
function addDays(dateISO, days) {
  const d = new Date(String(dateISO).slice(0, 10) + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return iso(d);
}
function daysBetween(fromISO, toISO) {
  const a = new Date(String(fromISO).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(toISO).slice(0, 10) + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
/** sisa hari menuju deadline dari hari ini (bisa negatif = lewat) */
function daysLeft(deadline) {
  if (!deadline) return null;
  return daysBetween(todayISO(), deadline);
}
function deadlineInfo(deadline, status, warnDays) {
  if (!deadline) return { level: 'none', text: 'Tanpa deadline', days: null };
  const days = daysLeft(deadline);
  const selesai = ['Selesai', 'Batal'].includes(status);
  if (selesai) return { level: 'done', text: 'Selesai', days };
  if (days < 0) return { level: 'overdue', text: `TERLAMBAT ${Math.abs(days)} hari`, days };
  if (days === 0) return { level: 'urgent', text: 'DEADLINE HARI INI', days };
  if (days <= warnDays) return { level: 'urgent', text: `${days} hari lagi`, days };
  if (days <= warnDays + 4) return { level: 'warning', text: `${days} hari lagi`, days };
  return { level: 'safe', text: `${days} hari lagi`, days };
}
function monthStart(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; }
function monthEnd(d = new Date()) {
  return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}
function monthLabel(v) {
  const s = String(v).slice(0, 7);
  const [y, m] = s.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}
function lastMonths(n = 6) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push({ key: `${x.getFullYear()}-${pad(x.getMonth() + 1)}`, label: MONTHS_SHORT[x.getMonth()], yearless: true, full: `${MONTHS[x.getMonth()]} ${x.getFullYear()}` });
  }
  return out;
}

/** Ambil periode dari query (?from=YYYY-MM-DD&to=...&preset=...) */
function period(query = {}) {
  const today = new Date();
  let preset = query.preset || '';
  let from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '';
  let to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '';
  if (!from && !to) preset = preset || 'bulan';
  if (preset === 'bulan') { from = monthStart(today); to = monthEnd(today); }
  else if (preset === 'lalu') {
    const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    from = monthStart(d); to = monthEnd(d);
  } else if (preset === 'tahun') { from = `${today.getFullYear()}-01-01`; to = `${today.getFullYear()}-12-31`; }
  else if (preset === '7') { from = addDays(todayISO(), -6); to = todayISO(); }
  else if (preset === '30') { from = addDays(todayISO(), -29); to = todayISO(); }
  else if (preset === 'custom') { /* pakai from/to apa adanya */ }
  else if (preset) { from = ''; to = ''; }
  if (!from) from = '0000-01-01';
  if (!to) to = '9999-12-31';
  const label = preset === 'bulan' ? monthLabel(from)
    : preset === 'lalu' ? monthLabel(from)
      : preset === 'tahun' ? `Tahun ${from.slice(0, 4)}`
        : preset === '7' ? '7 hari terakhir'
          : preset === '30' ? '30 hari terakhir'
            : preset === 'semua' ? 'Semua periode'
              : `${dmy(from)} s/d ${dmy(to)}`;
  return { from, to, preset: preset || 'custom', label, isAll: preset === 'semua' };
}

/* ==========================================================
   Konversi satuan bahan
   - Stok selalu disimpan dalam satuan bahan (materials.unit), mis. meter.
   - Saat pembelian/pemakaian, satuan yang dipilih user (kg / roll / meter)
     dikalikan faktor dari Pengaturan: "1 kg = 3 meter", "1 roll = N meter".
   - Satuan yang tidak punya faktor dianggap 1:1 (faktor 1).
   ========================================================== */

/** Faktor konversi dari satuan tertentu ke satuan stok bahan */
function unitFactor(unit, matUnit, conv) {
  const u = String(unit || '').trim().toLowerCase();
  const m = String(matUnit || '').trim().toLowerCase();
  if (!u || u === m) return 1;
  const f = num((conv || {})[u]);
  return f > 0 ? f : 1;
}
/** Apakah satuan ini butuh konversi tapi belum diatur? */
function needsConvSetup(unit, matUnit, conv) {
  const u = String(unit || '').trim().toLowerCase();
  const m = String(matUnit || '').trim().toLowerCase();
  if (!u || u === m) return false;
  return !(num((conv || {})[u]) > 0);
}
/** Label faktor: "1 kg = 3 meter" */
function factorLabel(unit, matUnit, factor) {
  const u = String(unit || '').trim();
  const m = String(matUnit || '').trim();
  if (!u || !m || u.toLowerCase() === m.toLowerCase() || !(num(factor) > 0)) return '';
  return `1 ${u} = ${angka(num(factor))} ${m}`;
}

function sum(rows, key) { return rows.reduce((a, r) => a + num(r[key]), 0); }
function groupSum(rows, key, valKey) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] || '(tanpa kategori)';
    m.set(k, (m.get(k) || 0) + num(r[valKey]));
  }
  return [...m.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}
function nextNumber(table, column, prefix) {
  const { setting } = require('./db');
  const ym = todayISO().slice(0, 7).replace('-', '');
  const pre = `${prefix}-${ym}-`;
  const row = require('./db').db.prepare(
    `SELECT ${column} AS v FROM ${table} WHERE ${column} LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(pre + '%');
  let n = 1;
  if (row && row.v) {
    const tail = parseInt(String(row.v).slice(pre.length), 10);
    if (Number.isFinite(tail)) n = tail + 1;
  }
  return pre + pad(n, 4);
}
function titleCase(s) { return String(s || '').replace(/\b\w/g, c => c.toUpperCase()); }
function truncated(s, n = 40) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

module.exports = {
  MONTHS, MONTHS_SHORT, pad, num, rp, rpShort, angka, iso, todayISO, nowStamp, dmy, dmyShort, dmyLong,
  addDays, daysBetween, daysLeft, deadlineInfo, monthStart, monthEnd, monthLabel, lastMonths,
  period, sum, groupSum, nextNumber, titleCase, truncated,
  unitFactor, needsConvSetup, factorLabel
};
