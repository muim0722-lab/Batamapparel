'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.APP_DB_PATH || path.join(DATA_DIR, 'app.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  phone TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL,
  show_reminder INTEGER NOT NULL DEFAULT 0,
  flash TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  portal_token TEXT DEFAULT '',
  portal_active INTEGER NOT NULL DEFAULT 1,
  portal_open INTEGER NOT NULL DEFAULT 0,
  portal_last TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS customer_sessions (
  token TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  category TEXT NOT NULL DEFAULT 'Umum',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT DEFAULT '',
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  unit_alt TEXT DEFAULT '',
  conv REAL NOT NULL DEFAULT 1,
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  customer_id INTEGER,
  order_date TEXT NOT NULL,
  deadline TEXT,
  priority TEXT NOT NULL DEFAULT 'Normal',
  qty INTEGER NOT NULL DEFAULT 0,
  description TEXT DEFAULT '',
  total_price REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Proses',
  courier TEXT DEFAULT '',
  tracking_no TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS project_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  stage_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Belum',
  note TEXT DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS project_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  stage_id INTEGER,
  stage_name TEXT DEFAULT '',
  status TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  customer_id INTEGER,
  project_id INTEGER,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Belum Lunas',
  method TEXT NOT NULL DEFAULT 'Transfer Bank',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  base_price REAL NOT NULL DEFAULT 0,
  addons TEXT DEFAULT '',
  addon_total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sale_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'DP',
  amount REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'Transfer Bank',
  note TEXT DEFAULT '',
  income_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL,
  date TEXT NOT NULL,
  supplier_id INTEGER,
  subtotal REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Belum Lunas',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  material_id INTEGER,
  description TEXT DEFAULT '',
  qty REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL DEFAULT 0,
  input_unit TEXT DEFAULT '',
  input_qty REAL NOT NULL DEFAULT 0,
  input_price REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS material_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  input_qty REAL NOT NULL DEFAULT 0,
  input_unit TEXT DEFAULT '',
  input_price REAL NOT NULL DEFAULT 0,
  source TEXT DEFAULT '',
  ref_table TEXT DEFAULT '',
  ref_id INTEGER,
  project_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS incomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Penjualan',
  description TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT 'Transfer Bank',
  project_id INTEGER,
  sale_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Operasional',
  description TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'Kas Utama',
  project_id INTEGER,
  petty_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS petty (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'Keluar',
  category TEXT NOT NULL DEFAULT '',
  description TEXT DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  expense_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE TABLE IF NOT EXISTS rejects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  project_id INTEGER,
  material_id INTEGER,
  item_name TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  unit TEXT DEFAULT 'pcs',
  reason TEXT DEFAULT '',
  action TEXT NOT NULL DEFAULT 'Perbaikan Ulang',
  loss_cost REAL NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  user_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_flows_mat ON material_flows(material_id, date);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_inc_date ON incomes(date);
CREATE INDEX IF NOT EXISTS idx_proj_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_pay_sale ON sale_payments(sale_id);
`;

/* Kolom tambahan untuk database yang sudah berjalan (idempoten). */
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const DEFAULT_STAGES = [
  'Order Diterima', 'Desain & ACC', 'Printing', 'Jahit / Finishing',
  'Quality Control', 'Packing', 'Pengiriman', 'Selesai'
];

const DEFAULT_SETTINGS = {
  company_name: 'BATAM APPAREL',
  company_tagline: 'SPECIALIST JERSEY CUSTOM & PERSONAL BRAND',
  company_address: 'RUKO GESYA BLOK B1 NO 3 BATAM CENTRE',
  company_phone: '0823 6233 3071',
  company_email: '',
  currency: 'Rp',
  deadline_warning_days: '3',
  petty_opening: '0',
  sale_prefix: 'BA',
  purchase_prefix: 'PO',
  project_prefix: 'PRJ',
  setup_done: '0',
  income_categories: 'Penjualan Jersey,DP / Uang Muka,Pelunasan,Jasa Desain,Lain-lain',
  expense_categories: 'Gaji & Upah,Listrik & Air,Sewa Tempat,Transportasi,Konsumsi,ATK,Perawatan Mesin,Iklan & Promosi,Lain-lain',
  petty_categories: 'Operasional,Transport,Konsumsi,ATK,Lain-lain',
  // ---- satuan bahan (sederhana, tanpa pengaturan per bahan) ----
  purchase_units: 'kg, meter, roll, yard, pcs, lusin',
  conv_kg_m: '3',
  conv_roll_m: '',
  conv_yard_m: '',
  // ---- kop invoice ----
  invoice_title: 'INVOICE',
  invoice_order_lines: 'RUKO GESYA BLOK B1 NO 3 BATAM CENTRE\nADMIN 1 : 082362333071   ADMIN 2 : 08170044998\nIG : batam.apparel     TTKTOK : batamapparel',
  invoice_banks: 'BNI 0370777755\na/n MUSLIMIN\nMANDIRI 1090017234998\na/n MUSLIMIN\nBCA 3400228140\na/n MUSLIMIN',
  invoice_footer_note: 'Periksa kembali orderan anda sebelum keluar dari toko\nPastikan jumlah, size dan design sudah sesuai dengan yang anda order\nBARANG YANG SUDAH KELUAR DARI TOKO TIDAK DAPAT DI KEMBALIKAN/DI TUKAR',
  logo_url: '',
  sport_options: 'FUTSAL/SEPAK BOLA,VOLI,BASKET,GOWES/SEPEDA,BASEBALL,RACING,GAME,MANCING,BADMINTON,PADEL',
  fabric_options: 'DRYFIT MILANO,DRYFIT BINTIK/JARUM,DRYFIT PLATINUM,DRYFIT VERTICAL MESH,SERENA,EMBOSS,LOTTO,DLL',
  print_options: 'PRINTING/SUBLIMASI,POLYFLEX,DTF,BORDIR',
  position_options: 'DEPAN,BELAKANG,LENGAN KIRI/KANAN,DADA KIRI/KANAN',
  portal_greeting: 'Pantau proses produksi jersey Anda secara langsung di sini.'
};

// Opsi tambahan harga (bisa diubah sendiri dari menu Opsi Tambahan Harga)
const DEFAULT_ADDONS = [
  ['Ukuran XXL', 10000, 'Ukuran'],
  ['Lengan Panjang', 15000, 'Lengan'],
  ['Kerah Polo Vintage', 10000, 'Kerah'],
  ['Kerah Polo Kancing', 15000, 'Kerah'],
  ['Kerah Wangki / Shanghai', 15000, 'Kerah']
];

function bootstrap() {
  db.exec(SCHEMA);

  // ---- kolom tambahan untuk database lama (aman dijalankan berulang) ----
  ensureColumn('sales', 'disc_pct', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('sales', 'market', "TEXT DEFAULT ''");
  ensureColumn('sales', 'to_name', "TEXT DEFAULT ''");
  ensureColumn('sales', 'phone', "TEXT DEFAULT ''");
  ensureColumn('sales', 'deadline', "TEXT DEFAULT ''");
  ensureColumn('sales', 'sport', "TEXT DEFAULT ''");
  ensureColumn('sales', 'fabrics', "TEXT DEFAULT ''");
  ensureColumn('sales', 'prints', "TEXT DEFAULT ''");
  ensureColumn('sales', 'positions', "TEXT DEFAULT ''");
  ensureColumn('sales', 'invoice_note', "TEXT DEFAULT ''");
  ensureColumn('sale_items', 'base_price', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('sale_items', 'addons', "TEXT DEFAULT ''");
  ensureColumn('sale_items', 'addon_total', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('projects', 'portal_note', "TEXT DEFAULT ''");
  ensureColumn('projects', 'sport', "TEXT DEFAULT ''");
  ensureColumn('projects', 'fabrics', "TEXT DEFAULT ''");
  // Satuan ganda: beli per kg/roll, pakai per meter (1 kg = 3 m, dst.)
  ensureColumn('materials', 'unit_alt', "TEXT DEFAULT ''");
  ensureColumn('materials', 'conv', 'REAL NOT NULL DEFAULT 1');
  ensureColumn('material_flows', 'input_qty', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('material_flows', 'input_unit', "TEXT DEFAULT ''");
  ensureColumn('material_flows', 'input_price', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('purchase_items', 'input_unit', "TEXT DEFAULT ''");
  ensureColumn('purchase_items', 'input_qty', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('purchase_items', 'input_price', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('customers', 'portal_token', "TEXT DEFAULT ''");
  ensureColumn('customers', 'portal_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('customers', 'portal_open', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('customers', 'portal_last', "TEXT DEFAULT ''");

  const insSetting = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  // Migrasi sekali: prefix nota default lama 'INV' → 'BA' (mengikuti format nota toko)
  const prefix = db.prepare("SELECT value FROM settings WHERE key = 'sale_prefix'").get();
  const migrated = db.prepare("SELECT value FROM settings WHERE key = 'sale_prefix_migrated'").get();
  if (prefix && prefix.value === 'INV' && !migrated) setSetting('sale_prefix', 'BA');
  setSetting('sale_prefix_migrated', '1');

  // Migrasi sekali: identitas usaha disamakan dengan kop nota toko (hanya bila masih nilai bawaan lama)
  const brandFlag = db.prepare("SELECT value FROM settings WHERE key = 'brand_migrated'").get();
  if (!brandFlag) {
    const cur = (k) => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
      return row ? row.value : '';
    };
    if (cur('company_name') === 'Batam Apparel') setSetting('company_name', 'BATAM APPAREL');
    if (cur('company_tagline') === 'Custom Jersey Printing') setSetting('company_tagline', 'SPECIALIST JERSEY CUSTOM & PERSONAL BRAND');
    if (cur('company_address') === 'Batam, Kepulauan Riau') setSetting('company_address', 'RUKO GESYA BLOK B1 NO 3 BATAM CENTRE');
    if (!cur('company_phone')) setSetting('company_phone', '0823 6233 3071');
    setSetting('brand_migrated', '1');
  }

  // Migrasi sekali: nomor rekening dikoreksi sesuai data pemilik
  const banksFlag = db.prepare("SELECT value FROM settings WHERE key = 'banks_migrated'").get();
  if (!banksFlag) {
    const cur = db.prepare("SELECT value FROM settings WHERE key = 'invoice_banks'").get();
    const OLD = 'BCA 3400-22-6140 A/N MUSLIMIN\nMANDIRI 109-00-1723499-8 A/N MUSLIMIN\nBNI 0370-777-55 A/N MUSLIMIN';
    if (!cur || !cur.value || cur.value === OLD) {
      setSetting('invoice_banks', 'BNI 0370777755\na/n MUSLIMIN\nMANDIRI 1090017234998\na/n MUSLIMIN\nBCA 3400228140\na/n MUSLIMIN');
    }
    setSetting('banks_migrated', '1');
  }

  // Migrasi sekali: hapus watermark pada invoice (permintaan pemilik — invoice polos)
  const wmFlag = db.prepare("SELECT value FROM settings WHERE key = 'watermark_removed'").get();
  if (!wmFlag) {
    setSetting('invoice_watermark', '');
    setSetting('watermark_removed', '1');
  }

  const stageCount = db.prepare('SELECT COUNT(*) c FROM stages').get().c;
  if (stageCount === 0) {
    const ins = db.prepare('INSERT INTO stages(name, sort_order, active) VALUES (?, ?, 1)');
    DEFAULT_STAGES.forEach((name, i) => ins.run(name, i + 1));
  }

  if (db.prepare('SELECT COUNT(*) c FROM addons').get().c === 0) {
    const ins = db.prepare('INSERT INTO addons(name, amount, category, sort_order, active) VALUES (?, ?, ?, ?, 1)');
    DEFAULT_ADDONS.forEach(([name, amount, cat], i) => ins.run(name, amount, cat, i + 1));
  }

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const { hashPassword } = require('./password');
    const ins = db.prepare(
      'INSERT INTO users(name, username, password_hash, role, active) VALUES (?, ?, ?, ?, 1)'
    );
    ins.run('Owner Batam Apparel', 'owner', hashPassword('owner123'), 'owner');
    ins.run('Leader Produksi', 'leader', hashPassword('leader123'), 'leader');
    ins.run('Admin Keuangan', 'admin', hashPassword('admin123'), 'admin');
  }
}

const settingsCache = new Map();
function setting(key, fallback = '') {
  if (settingsCache.has(key)) return settingsCache.get(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const val = row ? row.value : fallback;
  settingsCache.set(key, val);
  return val;
}
function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value == null ? '' : value));
  settingsCache.set(key, String(value == null ? '' : value));
}
/** Baca angka gaya Indonesia: "500.000" -> 500000 ; "12,5" -> 12.5 */
function parseNumberID(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/\s|Rp/gi, '');
  if (!s) return NaN;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (hasComma) s = s.replace(',', '.');
  else if (hasDot) {
    const parts = s.split('.');
    const last = parts[parts.length - 1];
    if (parts.length > 2 || last.length === 3) s = parts.join('');
  }
  return parseFloat(s.replace(/[^0-9.\-]/g, ''));
}

function settingNum(key, fallback = 0) {
  const v = parseNumberID(setting(key, ''));
  return Number.isFinite(v) ? v : fallback;
}
function settingList(key, fallback = '') {
  return (setting(key, fallback) || '').split(',').map(s => s.trim()).filter(Boolean);
}
function settingLines(key, fallback = '') {
  return (setting(key, fallback) || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// Seluruh bootstrap dijalankan sekali dalam satu transaksi (idempoten).
// Dijalankan setelah helper settings siap karena bootstrap memakai setSetting().
db.transaction(bootstrap)();
db.pragma('optimize');

module.exports = {
  db, DB_PATH, setting, setSetting, settingNum, settingList, settingLines, ensureColumn
};
