/* Batam Apparel — UI helpers: nav, format uang, export Excel, cetak A4, baris dinamis */
(function () {
  'use strict';

  /* ---------- SIDEBAR (mobile) ---------- */
  window.toggleNav = function () { document.body.classList.toggle('nav-open'); };

  /* ---------- INPUT QTY DESIMAL (koma) ----------
     Dipakai untuk berat/jumlah bahan: 25,56 kg ; 1,5 roll ; 30,25 m.
     Titik otomatis diubah jadi koma supaya orang Indonesia bisa mengetik desimal. */
  function fmtQty(v) {
    let s = String(v == null ? '' : v).trim().replace(/[^\d.,]/g, '');
    if (!s) return '';
    // titik dianggap pemisah desimal (kebiasaan mengetik cepat) → jadikan koma
    if (s.includes('.') && !s.includes(',')) s = s.replace('.', ',');
    // hanya boleh satu koma
    const parts = s.split(',');
    if (parts.length > 2) s = parts[0] + ',' + parts.slice(1).join('');
    // maksimal 3 angka desimal
    const [a, b] = s.split(',');
    return b === undefined ? a : a + ',' + b.slice(0, 3);
  }
  function bindQty(root) {
    (root || document).querySelectorAll('input.qty:not([data-bound])').forEach(function (el) {
      el.setAttribute('data-bound', '1');
      el.type = 'text';
      el.setAttribute('inputmode', 'decimal');
      el.setAttribute('autocomplete', 'off');
      if (el.value) el.value = fmtQty(el.value);
      el.addEventListener('input', function () {
        el.value = fmtQty(el.value);
        el.dispatchEvent(new Event('qty-change', { bubbles: true }));
      });
    });
  }
  window.bindQty = bindQty;
  window.fmtQty = fmtQty;

  /* ---------- FORMAT UANG ---------- */
  function fmt(v) {
    let s = String(v == null ? '' : v).replace(/[^\d]/g, '');
    if (!s) return '';
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function bindMoney(root) {
    (root || document).querySelectorAll('input.money:not([data-bound])').forEach(function (el) {
      el.setAttribute('data-bound', '1');
      el.type = 'text';
      el.setAttribute('inputmode', 'numeric');
      el.setAttribute('autocomplete', 'off');
      if (el.value) el.value = fmt(el.value);
      el.addEventListener('input', function () { el.value = fmt(el.value); el.dispatchEvent(new Event('money-change', { bubbles: true })); });
    });
  }
  window.bindMoney = bindMoney;
  window.toNumber = function (v) {
    // Format Indonesia: koma = desimal, titik = pemisah ribuan
    let s = String(v == null ? '' : v).trim().replace(/\s|Rp/gi, '');
    if (!s) return 0;
    const hasComma = s.includes(','), hasDot = s.includes('.');
    if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.');
    else if (hasComma) s = s.replace(',', '.');
    else if (hasDot) {
      const parts = s.split('.');
      const last = parts[parts.length - 1];
      if (parts.length > 2 || last.length === 3) s = parts.join('');
    }
    const n = parseFloat(s.replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  };
  /** Versi pendek untuk qty: koma selalu desimal (25,56 → 25.56) */
  window.toQty = function (v) {
    let s = String(v == null ? '' : v).trim().replace(/[^\d.,]/g, '');
    if (!s) return 0;
    if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '');
    else if (s.includes('.')) s = s.replace('.', ',');
    const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? 0 : n;
  };
  window.fmtRp = function (n) { return 'Rp ' + Math.round(Number(n) || 0).toLocaleString('id-ID'); };
  window.angkaQty = function (n) {
    const v = Number(n) || 0;
    return (Number.isInteger(v) ? v : Math.round(v * 1000) / 1000).toLocaleString('id-ID');
  };

  /* ---------- MODAL ---------- */
  window.openModal = function (id) { const m = document.getElementById(id); if (m) m.classList.add('open'); };
  window.closeModal = function (id) { const m = document.getElementById(id); if (m) m.classList.remove('open'); };

  /* ---------- CETAK A4 / A5 (portrait, landscape, A5, 2-up) ---------- */
  const PRINT_RULES = {
    portrait: '@page { size: A4 portrait; margin: 12mm 10mm; }',
    landscape: '@page { size: A4 landscape; margin: 10mm 8mm; }',
    a5: '@page { size: A5 portrait; margin: 6mm; }',
    '2up': '@page { size: A4 landscape; margin: 6mm; }'
  };
  window.printDoc = function (mode) {
    let st = document.getElementById('print-orient');
    if (!st) { st = document.createElement('style'); st.id = 'print-orient'; document.head.appendChild(st); }
    st.textContent = PRINT_RULES[mode] || PRINT_RULES.portrait;
    document.body.classList.toggle('print-landscape', mode === 'landscape');
    document.body.classList.toggle('mode-2up', mode === '2up');
    document.body.classList.toggle('mode-a5', mode === 'a5');
    setTimeout(function () { window.print(); }, 60);
  };

  /* ---------- EXPORT EXCEL ---------- */
  // Pustaka Excel dimuat hanya saat dibutuhkan (agar halaman tetap ringan)
  function withXlsx(cb) {
    if (typeof XLSX !== 'undefined') return cb();
    if (window.__xlsxLoading) { window.__xlsxWaiting.push(cb); return; }
    window.__xlsxLoading = true;
    window.__xlsxWaiting = [cb];
    const s = document.createElement('script');
    s.src = window.__XLSX_URL || 'vendor/xlsx.full.min.js';
    s.onload = function () {
      const q = window.__xlsxWaiting || [];
      window.__xlsxWaiting = [];
      q.forEach(f => f());
    };
    s.onerror = function () {
      window.__xlsxLoading = false;
      alert('Gagal memuat pustaka Excel. Periksa koneksi lalu muat ulang halaman.');
    };
    document.head.appendChild(s);
  }

  window.exportExcel = function (tableId, filename, opt) {
    const tbl = document.getElementById(tableId);
    if (!tbl) { alert('Tabel tidak ditemukan.'); return; }
    withXlsx(function () { doExport(tbl, filename, opt || {}); });
  };

  function doExport(tbl, filename, opt) {
    const rows = [];
    const co = (opt.company || document.body.getAttribute('data-company') || '').trim();
    if (co) rows.push([co]);
    if (opt.title) rows.push([opt.title]);
    if (opt.period) rows.push(['Periode: ' + opt.period]);
    if (opt.extra) rows.push([opt.extra]);
    if (opt.by) rows.push(['Dicetak oleh: ' + opt.by + (opt.printedAt ? '  |  ' + opt.printedAt : '')]);
    rows.push([]);

    const head = [];
    tbl.querySelectorAll('thead tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('th').forEach(th => cells.push(th.innerText.trim()));
      if (cells.length) head.push(cells);
    });
    head.forEach(h => rows.push(h));
    if (!head.length) rows.pop();

    const body = [];
    tbl.querySelectorAll('tbody tr').forEach(tr => {
      if (tr.querySelector('.empty') || tr.classList.contains('no-export')) return;
      const cells = [];
      tr.querySelectorAll('td').forEach(td => {
        if (td.classList.contains('no-export')) return;
        let v = td.getAttribute('data-export');
        if (v === null) v = td.innerText.trim().replace(/\s+/g, ' ');
        const num = td.getAttribute('data-num');
        if (num !== null && num !== '') cells.push(Number(num));
        else cells.push(v);
      });
      body.push(cells);
    });
    body.forEach(b => rows.push(b));

    const foot = [];
    tbl.querySelectorAll('tfoot tr').forEach(tr => {
      const cells = [];
      tr.querySelectorAll('td').forEach(td => {
        const num = td.getAttribute('data-num');
        if (num !== null && num !== '') cells.push(Number(num));
        else cells.push(td.innerText.trim().replace(/\s+/g, ' '));
      });
      if (cells.length) foot.push(cells);
    });
    foot.forEach(f => rows.push(f));

    const ws = XLSX.utils.aoa_to_sheet(rows);
    const widths = [];
    rows.forEach(r => r.forEach((c, i) => {
      const len = c === undefined || c === null ? 0 : String(c).length;
      widths[i] = Math.max(widths[i] || 8, Math.min(len + 2, 42));
    }));
    ws['!cols'] = widths.map(w => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, (opt.sheet || 'Laporan').slice(0, 28).replace(/[\\/?*\[\]:]/g, ''));
    XLSX.writeFile(wb, (filename || 'export') + '.xlsx');
  }

  /* ---------- BARIS DINAMIS (form penjualan / pembelian) ---------- */
  function bodyOf(containerId) {
    const c = document.getElementById(containerId);
    if (!c) return null;
    return c.tagName === 'TBODY' ? c : c.querySelector('tbody');
  }
  window.addItemRow = function (containerId, tplId, cols) {
    const body = bodyOf(containerId);
    const tpl = document.getElementById(tplId);
    if (!body || !tpl) return;
    const idx = body.querySelectorAll('tr').length;
    const html = tpl.innerHTML.replace(/__IDX__/g, idx);
    const tr = document.createElement('tr');
    tr.innerHTML = html;
    body.appendChild(tr);
    bindMoney(tr);
    bindQty(tr);
    bindUnitSelects(tr);
    if (cols) recalcItems(containerId, cols);
  };
  window.removeItemRow = function (btn, containerId, cols) {
    const body = bodyOf(containerId);
    const tr = btn.closest('tr');
    if (!body || !tr) return;
    if (body.querySelectorAll('tr').length <= 1) {
      tr.querySelectorAll('input').forEach(i => { if (i.type !== 'hidden') i.value = ''; });
      if (cols) recalcItems(containerId, cols);
      return;
    }
    tr.remove();
    if (cols) recalcItems(containerId, cols);
  };
  function addonSum(tr) {
    let a = 0;
    tr.querySelectorAll('.addon-chk:checked').forEach(c => { a += toNumber(c.getAttribute('data-amount')); });
    return a;
  }
  function addonIds(tr) {
    const ids = [];
    tr.querySelectorAll('.addon-chk:checked').forEach(c => ids.push(c.getAttribute('data-id')));
    return ids.join(',');
  }
  function addonLabels(tr) {
    const out = [];
    tr.querySelectorAll('.addon-chk:checked').forEach(c => {
      const t = c.closest('label');
      const nm = t ? t.innerText.replace(/\s*\(\+.*$/, '').trim() : '';
      if (nm) out.push(nm);
    });
    return out;
  }
  /** Cari mode kolom harga: pembelian (.it-cost) atau penjualan (.it-price) */
  function itemsMode(containerId) {
    const body = bodyOf(containerId);
    if (!body) return 'price';
    return body.querySelector('.it-cost') ? 'cost' : 'price';
  }

  /* ---------- SATUAN BAHAN (kg / meter / roll) ---------- */
  /** Faktor konversi satuan → satuan stok bahan (aturan dari Pengaturan, dikirim lewat window.__CONV) */
  function unitFactor(unit, matUnit) {
    const u = String(unit || '').trim().toLowerCase();
    const m = String(matUnit || '').trim().toLowerCase();
    if (!u || !m || u === m) return 1;
    const f = Number((window.__CONV || {})[u] || 0);
    return f > 0 ? f : 1;
  }
  window.unitFactor = unitFactor;

  /** Info bahan pada satu baris pembelian (satuan & stok) */
  function rowMaterialInfo(tr) {
    const sel = tr.querySelector('select[name=item_material]');
    const opt = sel && sel.options[sel.selectedIndex];
    return {
      unit: opt ? (opt.getAttribute('data-unit') || '') : '',
      stock: opt ? toQty(opt.getAttribute('data-stock')) : 0
    };
  }

  /** Susun pilihan satuan pada baris pembelian sesuai bahan terpilih */
  function syncUnitSelect(tr) {
    const unitSel = tr.querySelector('select[name=item_unit]');
    if (!unitSel) return;
    const info = rowMaterialInfo(tr);
    const base = (window.__PURCHASE_UNITS || ['kg', 'meter', 'roll', 'yard', 'pcs', 'lusin']).slice();
    if (info.unit && !base.some(u => u.toLowerCase() === info.unit.toLowerCase())) base.unshift(info.unit);
    const prev = unitSel.value;
    const touched = tr.getAttribute('data-unit-touched') === '1';
    const desired = info.unit || base[0];
    unitSel.innerHTML = '';
    base.forEach(function (u) {
      const o = document.createElement('option');
      o.value = u;
      o.textContent = u;
      unitSel.appendChild(o);
    });
    unitSel.value = (touched && prev && base.some(u => u.toLowerCase() === prev.toLowerCase()))
      ? prev : (desired || base[0]);
  }

  function bindUnitSelects(root) {
    (root || document).querySelectorAll('[data-unit-row]').forEach(tr => {
      if (!tr.querySelector('select[name=item_unit]')) return;
      if (tr.getAttribute('data-unit-bound')) return;
      tr.setAttribute('data-unit-bound', '1');
      const matSel = tr.querySelector('select[name=item_material]');
      const unitSel = tr.querySelector('select[name=item_unit]');
      if (matSel) matSel.addEventListener('change', function () {
        tr.removeAttribute('data-unit-touched');
        syncUnitSelect(tr);
        recalcItems('itemsBody', 'cost');
      });
      if (unitSel) unitSel.addEventListener('change', function () {
        tr.setAttribute('data-unit-touched', '1');
        recalcItems('itemsBody', 'cost');
      });
    });
  }
  window.bindUnitSelects = bindUnitSelects;

  /* ---------- PEMAKAIAN BAHAN ---------- */
  function bindUsageReadout() {
    const sel = document.getElementById('usageMaterial');
    const out = document.getElementById('usageConv');
    if (!sel || !out) return;
    const upd = function () {
      const opt = sel.options[sel.selectedIndex];
      if (!opt || !opt.value) { out.textContent = ''; return; }
      const u = opt.getAttribute('data-unit') || '';
      const stok = toQty(opt.getAttribute('data-stock'));
      const avg = toNumber(opt.getAttribute('data-avg'));
      out.innerHTML = 'Stok saat ini: <b>' + angkaQty(stok) + ' ' + u + '</b> · harga rata-rata <b>' + fmtRp(avg) + '/' + u + '</b>';
      const lbl = document.getElementById('usageUnitLabel');
      if (lbl) lbl.textContent = u || 'satuan';
      if (window.recalcUsageHint) window.recalcUsageHint();
    };
    sel.addEventListener('change', upd);
    upd();
  }
  window.bindUsageReadout = bindUsageReadout;

  /** Petunjuk sisa stok saat mengisi pemakaian */
  window.recalcUsageHint = function () {
    const hint = document.getElementById('usageHint');
    const sel = document.getElementById('usageMaterial');
    const q = document.getElementById('usageQty');
    if (!hint || !sel || !q) return;
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) { hint.textContent = ''; return; }
    const u = opt.getAttribute('data-unit') || '';
    const stok = toQty(opt.getAttribute('data-stock'));
    const qty = toQty(q.value);
    if (!qty) { hint.textContent = ''; return; }
    const sisa = stok - qty;
    hint.innerHTML = angkaQty(qty) + ' ' + u + ' dipakai. Sisa stok setelah ini: <b>' + angkaQty(sisa) + ' ' + u + '</b>' +
      (sisa < 0 ? ' <span style="color:#b91c1c">— stok tidak cukup!</span>' : '');
  };

  window.recalcItems = function (containerId, cols) {
    const body = bodyOf(containerId);
    if (!body) return;
    const mode = cols === 'cost' ? 'cost' : (cols === 'price' ? 'price' : itemsMode(containerId));
    const priceCls = mode === 'cost' ? '.it-cost' : '.it-price';
    let sub = 0;

    body.querySelectorAll('tr').forEach(tr => {
      const qEl = tr.querySelector('.it-qty');
      const pEl = tr.querySelector(priceCls);
      const q = qEl ? toQty(qEl.value) : 0;
      const base = pEl ? toNumber(pEl.value) : 0;
      const extra = mode === 'price' ? addonSum(tr) : 0;
      const unit = base + extra;
      // Subtotal = Qty × Harga Satuan (angka yang diketik) — harus sama dengan nota
      const line = Math.round(q * unit);
      sub += line;

      if (mode === 'price') {
        const hidden = tr.querySelector('.it-addons');
        if (hidden) hidden.value = addonIds(tr);
        const summary = tr.querySelector('.addon-summary');
        if (summary) {
          const labels = addonLabels(tr);
          summary.textContent = labels.length ? 'Opsi: ' + labels.join(', ') : 'Opsi tambahan';
          summary.classList.toggle('on', labels.length > 0);
        }
        const unitCell = tr.querySelector('.it-unit');
        if (unitCell) unitCell.textContent = fmtRp(unit);
      }

      const cell = tr.querySelector('.it-sub');
      if (cell) cell.textContent = fmtRp(line);

      // Pembelian: tampilkan akibatnya ke stok + harga per satuan stok
      const convCell = tr.querySelector('.it-conv');
      if (convCell && mode === 'cost') {
        const info = rowMaterialInfo(tr);
        const unitSel = tr.querySelector('select[name=item_unit]');
        const chosen = unitSel ? unitSel.value : info.unit;
        const factor = unitFactor(chosen, info.unit);
        if (!q || !info.unit) { convCell.textContent = ''; }
        else if (chosen && chosen.toLowerCase() !== info.unit.toLowerCase() && factor === 1) {
          convCell.innerHTML = `<span style="color:#b45309">Belum ada aturan konversi dari ${chosen} ke ${info.unit} — dicatat apa adanya. Atur di Pengaturan → Konversi Satuan Bahan.</span>`;
        } else {
          const stockQty = q * factor;
          const parts = [`= ${angkaQty(stockQty)} ${info.unit} masuk stok`];
          if (factor > 1) {
            parts.push(`1 ${chosen} = ${angkaQty(factor)} ${info.unit}`);
            parts.push(`${fmtRp(base / factor)} / ${info.unit}`);
          }
          convCell.innerHTML = parts.join(' · ');
        }
      }
    });

    const discPct = toNumber((document.getElementById('inp-disc-pct') || {}).value || 0);
    let disc = toNumber((document.getElementById('inp-discount') || {}).value || 0);
    if (mode === 'price' && discPct > 0) disc = Math.round(sub * discPct / 100);
    const total = Math.max(sub - disc, 0);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('txt-subtotal', fmtRp(sub));
    set('txt-discount', '- ' + fmtRp(disc) + (discPct > 0 ? ' (' + discPct + '%)' : ''));
    set('txt-total', fmtRp(total));
    const paidEl = document.getElementById('inp-paid');
    if (paidEl) {
      const paid = toNumber(paidEl.value);
      const st = paid <= 0 ? 'Belum Lunas' : (paid >= total && total > 0 ? 'Lunas' : 'Sebagian');
      set('txt-status', st);
      const sel = document.getElementById('inp-status');
      if (sel) sel.value = st;
      const sisa = Math.max(total - paid, 0);
      set('txt-sisa', fmtRp(sisa));
      set('txt-sisa2', fmtRp(sisa));
      set('txt-dp', fmtRp(paid));
    }
  };

  /* ---------- INIT ---------- */  /* ---------- INIT ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    bindMoney(document);
    bindQty(document);
    bindUnitSelects(document);
    bindUsageReadout();

    /* Semua perubahan di tabel item otomatis menghitung ulang — termasuk baris yang
       ditambahkan belakangan (dulu baris baru tidak ikut dihitung → subtotal tidak sesuai nota). */
    document.addEventListener('input', function (e) {
      const t = e.target;
      if (t && t.closest && t.closest('#itemsBody')) {
        const mode = t.closest('#itemsBody').querySelector('.it-cost') ? 'cost' : 'price';
        recalcItems('itemsBody', mode);
      }
    });
    document.addEventListener('change', function (e) {
      const t = e.target;
      if (t && t.closest && t.closest('#itemsBody')) {
        const mode = t.closest('#itemsBody').querySelector('.it-cost') ? 'cost' : 'price';
        recalcItems('itemsBody', mode);
      }
    });
    document.querySelectorAll('[data-print]').forEach(b => {
      b.addEventListener('click', function (e) { e.preventDefault(); printDoc(b.getAttribute('data-print')); });
    });
    document.querySelectorAll('[data-modal-open]').forEach(b => {
      b.addEventListener('click', function (e) { e.preventDefault(); openModal(b.getAttribute('data-modal-open')); });
    });
    if (document.body.getAttribute('data-auto-reminder') === '1' || window.__autoReminder) openModal('modalReminder');

    document.querySelectorAll('form[data-confirm]').forEach(f => {
      f.addEventListener('submit', function (e) {
        if (!confirm(f.getAttribute('data-confirm'))) e.preventDefault();
      });
    });
    document.querySelectorAll('[data-table-search]').forEach(inp => {
      inp.addEventListener('keyup', function () {
        const q = inp.value.toLowerCase();
        const target = document.querySelector(inp.getAttribute('data-table-search'));
        if (!target) return;
        target.querySelectorAll('tbody tr').forEach(tr => {
          tr.style.display = tr.innerText.toLowerCase().indexOf(q) > -1 ? '' : 'none';
        });
      });
    });
  });
})();
