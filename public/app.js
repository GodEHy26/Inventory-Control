/* Inventory Control v2 — SPA with live sync, SKU autocomplete, file imports,
   partial ship/receive, weights, data-quality flags, heat traceability. */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
const kg = (n) => n ? Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' kg' : '—';

let ME = null, WAREHOUSES = [], TAB = 'dashboard';

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
function toast(msg, cls = '', who = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + cls;
  t.innerHTML = (who ? `<div class="who">${esc(who)}</div>` : '') + esc(msg);
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

/* ---------- boot & auth ---------- */
async function boot() {
  const b = await api('/api/bootstrap');
  WAREHOUSES = b.warehouses;
  if (!b.user) { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); return; }
  ME = b.user;
  $('#login').classList.add('hidden'); $('#app').classList.remove('hidden');
  $('#whoami').textContent = `${ME.name || ME.username} · ${ME.role}`;
  render();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    location.reload();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.reload(); });

/* ---------- live sync ---------- */
const socket = io();
socket.on('connect', () => $('#liveDot').classList.remove('off'));
socket.on('disconnect', () => $('#liveDot').classList.add('off'));
socket.on('sync', (m) => {
  if (m.actor && ME && m.actor !== ME.username) toast(m.msg, '', m.actor);
  render();
  if (!$('#drawer').classList.contains('hidden') && drawerRefresh) drawerRefresh();
});

/* ---------- navigation ---------- */
$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  $$('#nav button').forEach(x => x.classList.toggle('active', x === b));
  TAB = b.dataset.tab; render();
});
function render() { ({ dashboard, stock, so, po, mfg, reports }[TAB] || dashboard)(); }

/* ---------- drawer ---------- */
let drawerRefresh = null;
function openDrawer(html, refresh = null) {
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.remove('hidden');
  drawerRefresh = refresh;
}
function closeDrawer() { $('#drawer').classList.add('hidden'); drawerRefresh = null; }
$('#drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* ---------- shared bits ---------- */
function whOptions(sel, withAuto = false) {
  return (withAuto ? `<option value="AUTO" ${sel === 'AUTO' ? 'selected' : ''}>Auto (most stock)</option>` : '') +
    WAREHOUSES.map(w => `<option value="${w.id}" ${w.id === sel ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
}
function ribbon(r) {
  const total = r.on_hand + r.in_transit + r.on_order || 1;
  const free = Math.max(r.on_hand - r.on_hold, 0);
  const seg = (v, c) => v > 0 ? `<i class="${c}" style="width:${(v / total * 100).toFixed(1)}%"></i>` : '';
  return `<div class="ribbon" title="free ${fmt(free)} · reserved ${fmt(r.on_hold)} · in transit ${fmt(r.in_transit)} · on order ${fmt(r.on_order)}">
    ${seg(free, 'rh')}${seg(r.on_hold, 'rl')}${seg(r.in_transit, 'rt')}${seg(r.on_order, 'ro')}</div>`;
}
function typeTag(t) { return `<span class="tag ${t}">${t === 'raw' ? 'raw material' : t}</span>`; }

/* SKU autocomplete: attach to any input. Type ≥2 chars, pick from dropdown. */
function attachSkuAC(input, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'ac-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  let list = null, sel = -1, items = [], timer = null;
  const close = () => { list?.remove(); list = null; sel = -1; };
  const show = () => {
    close();
    if (!items.length) return;
    list = document.createElement('div');
    list.className = 'ac-list';
    list.innerHTML = items.map((it, i) => `<div class="ac-item" data-i="${i}">
      <span class="sku">${esc(it.sku)}</span><small>${esc(it.name)}</small>
      <span class="ats">${fmt(it.ats)}</span></div>`).join('');
    list.addEventListener('mousedown', (e) => {
      const d = e.target.closest('.ac-item'); if (!d) return;
      pick(items[+d.dataset.i]); e.preventDefault();
    });
    wrap.appendChild(list);
  };
  const pick = (it) => { input.value = it.sku; close(); onPick && onPick(it); };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      try { items = await api('/api/sku-suggest?q=' + encodeURIComponent(q)); show(); } catch {}
    }, 160);
  });
  input.addEventListener('keydown', (e) => {
    if (!list) return;
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); }
    else if (e.key === 'Enter' && sel >= 0) { pick(items[sel]); e.preventDefault(); return; }
    else if (e.key === 'Escape') { close(); return; }
    else return;
    e.preventDefault();
    $$('.ac-item', list).forEach((d, i) => d.classList.toggle('sel', i === sel));
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}
function wireSkuInputs(scope) { $$('.skuac', scope || document).forEach(i => { if (!i.dataset.ac) { i.dataset.ac = '1'; attachSkuAC(i); } }); }

/* File → base64 helper for imports */
function readFileB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = () => rej(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

/* Generic import dialog. kind: items|stock|so|po */
function importDialog(kind, title, extraFieldsHtml = '', getOptions = () => ({})) {
  openDrawer(`<h1>${esc(title)}</h1>
    <p class="sub">Accepted: CSV, XLS, XLSX${kind === 'so' || kind === 'po' ? ', PDF (best-effort)' : ''}.
      Column names are matched loosely — Zoho exports work too.
      <a href="/api/template/${kind}?fmt=csv" download>Download CSV template</a> ·
      <a href="/api/template/${kind}?fmt=xlsx" download>Download Excel template</a></p>
    <div class="panel">
      ${extraFieldsHtml}
      <div class="filedrop" id="fd">Drop a file here or <label style="color:var(--blue);cursor:pointer;display:inline">browse
        <input type="file" id="fd_input" class="hidden" accept=".csv,.xls,.xlsx,.pdf"></label></div>
      <p id="fd_name" class="muted"></p>
      <label style="display:flex;gap:6px;align-items:center;font-weight:600">
        <input type="checkbox" id="fd_auto" style="width:auto"> Create missing items automatically</label>
      <p class="err" id="fd_err"></p>
      <div id="fd_result"></div>
      <button class="btn primary" id="fd_go" disabled>Import</button>
    </div>`);
  let file = null;
  const setFile = (f) => { file = f; $('#fd_name').textContent = f ? f.name : ''; $('#fd_go').disabled = !f; };
  $('#fd_input').addEventListener('change', (e) => setFile(e.target.files[0]));
  const fd = $('#fd');
  fd.addEventListener('dragover', (e) => { e.preventDefault(); fd.classList.add('drag'); });
  fd.addEventListener('dragleave', () => fd.classList.remove('drag'));
  fd.addEventListener('drop', (e) => { e.preventDefault(); fd.classList.remove('drag'); setFile(e.dataTransfer.files[0]); });
  $('#fd_go').addEventListener('click', async () => {
    $('#fd_err').textContent = ''; $('#fd_go').disabled = true; $('#fd_go').textContent = 'Importing…';
    try {
      const data_b64 = await readFileB64(file);
      const r = await api('/api/import/file', { method: 'POST', body: {
        kind, filename: file.name, data_b64,
        options: { ...getOptions(), autocreate: $('#fd_auto').checked } } });
      let html = `<p style="color:var(--green)"><b>Imported.</b> ${r.created != null ? `${r.created} new, ${r.updated} updated items.` : ''}
        ${r.lines != null ? `${r.lines} lines.` : ''} ${r.count != null ? `${r.count} stock lines.` : ''}
        ${r.hint ? esc(r.hint) : ''}</p>`;
      if (r.note) html += `<p class="muted">${esc(r.note)}</p>`;
      if (r.issues?.length) html += `<div class="panel flagbox"><b>${r.issues.length} rows skipped:</b>
        <ul>${r.issues.slice(0, 12).map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`;
      $('#fd_result').innerHTML = html;
      toast('Import complete');
    } catch (e) { $('#fd_err').textContent = e.message; }
    $('#fd_go').disabled = false; $('#fd_go').textContent = 'Import';
  });
}

/* ================= DASHBOARD ================= */
async function dashboard() {
  const [b, act, low, flags] = await Promise.all([
    api('/api/bootstrap'), api('/api/reports/activity'), api('/api/reports/low-stock'),
    api('/api/reports/flags'),
  ]);
  $('#main').innerHTML = `
    <h1>Dashboard</h1>
    <p class="sub">Every number is ledger-derived and can never go negative. Stock opened at zero — build it up through purchases, imports and adjustments.</p>
    <div class="stats">
      <div class="stat"><b>${fmt(b.counts.items)}</b><span>Active SKUs</span></div>
      <div class="stat"><b>${fmt(b.counts.openSO)}</b><span>Open sales orders</span></div>
      <div class="stat"><b>${fmt(b.counts.openPO)}</b><span>Incoming shipments</span></div>
      <div class="stat"><b>${fmt(flags.length)}</b><span>Data flags</span></div>
    </div>
    ${flags.length ? `<div class="panel flagbox"><h2 style="margin-top:0">⚑ Things that look off</h2>
      <ul>${flags.slice(0, 10).map(f => `<li>${f.sku ? `<span class="sku">${esc(f.sku)}</span> ` : ''}${esc(f.text)}</li>`).join('')}</ul>
      ${flags.length > 10 ? `<p class="muted">…and ${flags.length - 10} more (Reports → Data flags).</p>` : ''}</div>` : ''}
    ${low.length ? `<div class="panel"><h2 style="margin-top:0">Low stock (below reorder level)</h2>
      <table><thead><tr><th>SKU</th><th>Name</th><th class="num">On hand</th><th class="num">Min</th><th class="num">Incoming</th></tr></thead>
      <tbody>${low.slice(0, 8).map(r => `<tr><td><span class="sku">${esc(r.sku)}</span></td><td>${esc(r.name)}</td>
        <td class="num">${fmt(r.on_hand)}</td><td class="num">${fmt(r.min_stock)}</td>
        <td class="num">${fmt(r.in_transit + r.on_order)}</td></tr>`).join('')}</tbody></table></div>` : ''}
    <div class="panel"><h2 style="margin-top:0">Latest activity (all users, live)</h2>
      <table><thead><tr><th>When</th><th>Type</th><th>SKU</th><th class="num">Qty</th><th>WH</th><th>Ref</th><th>By</th></tr></thead>
      <tbody>${act.map(t => `<tr>
        <td class="muted">${esc(t.ts)}</td><td>${esc(t.type)}</td>
        <td><span class="sku">${esc(t.sku)}</span></td><td class="num">${fmt(t.qty)}</td>
        <td>${esc(t.warehouse_id)}</td><td class="muted">${esc(t.ref || '')}</td><td>${esc(t.user)}</td></tr>`).join('') ||
        '<tr><td colspan="7" class="muted">No activity yet.</td></tr>'}
      </tbody></table></div>`;
}

/* ================= STOCK ================= */
let stockQ = { q: '', type: '', wh: '', stocked: '' };
async function stock() {
  const rows = await api('/api/items?' + new URLSearchParams({ ...stockQ, limit: 200 }));
  $('#main').innerHTML = `
    <h1>Stock</h1>
    <p class="sub">Totals across all warehouses first — click a row for the per-warehouse split, BOM and audit trail. Available = on hand − reserved for orders.</p>
    <div class="panel">
      <div class="toolbar">
        <input type="search" id="sq" class="skuac" placeholder="Search SKU / name / size…" value="${esc(stockQ.q)}" autocomplete="off">
        <select id="stype"><option value="">All types</option>
          <option value="part" ${stockQ.type === 'part' ? 'selected' : ''}>Individual parts</option>
          <option value="assembly" ${stockQ.type === 'assembly' ? 'selected' : ''}>Assemblies</option>
          <option value="raw" ${stockQ.type === 'raw' ? 'selected' : ''}>Raw material</option></select>
        <select id="swh"><option value="">All warehouses (total)</option>${whOptions(stockQ.wh)}</select>
        <label style="display:flex;gap:6px;align-items:center;font-weight:600">
          <input type="checkbox" id="sstocked" style="width:auto" ${stockQ.stocked ? 'checked' : ''}> With stock only</label>
        <button class="btn" id="newItem">+ New item</button>
        <button class="btn" id="impItems">Import items file</button>
        <button class="btn" id="impStock">Import stock file</button>
      </div>
      <table><thead><tr>
        <th>SKU</th><th>Name</th><th>Type</th><th class="num">Total avail.</th><th class="num">Reserved</th>
        <th class="num">In transit</th><th class="num">On order</th><th class="num">Unit wt</th><th>Position</th>
      </tr></thead><tbody>
      ${rows.map(r => `<tr class="click" data-sku="${esc(r.sku)}">
        <td><span class="sku">${esc(r.sku)}</span></td>
        <td>${esc(r.name)}<div class="muted" style="font-size:11.5px">${esc(r.category || '')} ${esc(r.size || '')}</div></td>
        <td>${typeTag(r.item_type)}</td>
        <td class="num"><b>${fmt(r.ats)}</b></td><td class="num">${fmt(r.on_hold)}</td>
        <td class="num">${fmt(r.in_transit)}</td><td class="num">${fmt(r.on_order)}</td>
        <td class="num wtag">${r.unit_weight ? r.unit_weight + ' kg' : '—'}</td>
        <td>${ribbon(r)}</td></tr>`).join('') ||
        '<tr><td colspan="9" class="muted">No items match.</td></tr>'}
      </tbody></table>
      ${rows.length === 200 ? '<p class="muted">Showing first 200 — narrow your search.</p>' : ''}
    </div>`;
  wireSkuInputs();
  $('#sq').addEventListener('change', e => { stockQ.q = e.target.value; stock(); });
  $('#stype').addEventListener('change', e => { stockQ.type = e.target.value; stock(); });
  $('#swh').addEventListener('change', e => { stockQ.wh = e.target.value; stock(); });
  $('#sstocked').addEventListener('change', e => { stockQ.stocked = e.target.checked ? '1' : ''; stock(); });
  $('#newItem').addEventListener('click', () => itemForm());
  $('#impItems').addEventListener('click', () => importDialog('items', 'Import items (with optional opening stock)'));
  $('#impStock').addEventListener('click', () => importDialog('stock', 'Import stock quantities'));
  $$('#main tr.click').forEach(tr => tr.addEventListener('click', () => itemDrawer(tr.dataset.sku)));
}

function itemForm(it = {}) {
  openDrawer(`
    <h1>${it.sku ? 'Edit item' : 'New item'}</h1>
    <div class="panel"><div class="grid2">
      <label>SKU <input id="f_sku" value="${esc(it.sku || '')}" ${it.sku ? 'readonly' : ''}></label>
      <label>Name <input id="f_name" value="${esc(it.name || '')}"></label>
      <label>Type <select id="f_type">
        <option value="part" ${it.item_type === 'part' ? 'selected' : ''}>Individual part</option>
        <option value="assembly" ${it.item_type === 'assembly' ? 'selected' : ''}>Assembly</option>
        <option value="raw" ${it.item_type === 'raw' ? 'selected' : ''}>Raw material</option></select></label>
      <label>Category <input id="f_cat" value="${esc(it.category || '')}"></label>
      <label>Size <input id="f_size" value="${esc(it.size || '')}"></label>
      <label>Grade <input id="f_grade" value="${esc(it.grade || '')}"></label>
      <label>Coating <input id="f_coat" value="${esc(it.coating || '')}"></label>
      <label>Head marking <input id="f_head" value="${esc(it.head_marking || '')}"></label>
      <label>Unit <input id="f_uom" value="${esc(it.uom || 'pcs')}"></label>
      <label>Unit weight (kg) <input id="f_wt" type="number" min="0" step="any" value="${it.unit_weight || 0}"></label>
      <label>Reorder level <input id="f_min" type="number" min="0" value="${it.min_stock || 0}"></label>
    </div>
    <label>Custom fields (JSON) <textarea id="f_attrs" rows="3">${esc(it.attrs || '{}')}</textarea></label>
    <p class="err" id="f_err"></p>
    <button class="btn primary" id="f_save">Save item</button></div>`);
  $('#f_save').addEventListener('click', async () => {
    try {
      JSON.parse($('#f_attrs').value || '{}');
      await api('/api/items', { method: 'POST', body: {
        sku: $('#f_sku').value.trim(), name: $('#f_name').value.trim(),
        item_type: $('#f_type').value, category: $('#f_cat').value,
        size: $('#f_size').value, grade: $('#f_grade').value, coating: $('#f_coat').value,
        head_marking: $('#f_head').value, uom: $('#f_uom').value,
        unit_weight: +$('#f_wt').value || 0,
        min_stock: +$('#f_min').value || 0, attrs: $('#f_attrs').value || '{}' } });
      toast('Item saved'); closeDrawer();
    } catch (e) { $('#f_err').textContent = e.message; }
  });
}

async function itemDrawer(sku) {
  const load = async () => {
    const d = await api('/api/item/' + encodeURIComponent(sku));
    const { item, levels, bom, usedIn, exposure, lots, txns } = d;
    const tot = { on_hand: 0, on_hold: 0, on_order: 0, in_transit: 0, sold: 0 };
    for (const l of levels) for (const k in tot) tot[k] += l[k];
    const lvlRow = (name, l, bold) => `<tr${bold ? ' style="font-weight:700;background:#f6f8fa"' : ''}>
      <td>${esc(name)}</td><td class="num"><b>${fmt(l.on_hand - l.on_hold)}</b></td>
      <td class="num">${fmt(l.on_hand)}</td><td class="num">${fmt(l.on_hold)}</td>
      <td class="num">${fmt(l.in_transit)}</td><td class="num">${fmt(l.on_order)}</td><td class="num">${fmt(l.sold)}</td></tr>`;
    openDrawer(`
      <h1><span class="sku">${esc(item.sku)}</span> ${typeTag(item.item_type)}
        ${item.unit_weight ? `<span class="wtag">${item.unit_weight} kg/unit</span>` : ''}</h1>
      <p class="sub">${esc(item.name)} · ${esc(item.category || '')} ${esc(item.size || '')} ${esc(item.grade || '')} ${esc(item.coating || '')}</p>
      <div class="panel"><h2 style="margin-top:0">Stock — total first, then per warehouse</h2>
        <table><thead><tr><th></th><th class="num">Available</th><th class="num">On hand</th>
          <th class="num">Reserved</th><th class="num">In transit</th><th class="num">On order</th><th class="num">Sold</th></tr></thead>
        <tbody>${lvlRow('TOTAL (all warehouses)', tot, true)}
        ${WAREHOUSES.map(w => lvlRow(w.name,
          levels.find(x => x.warehouse_id === w.id) || { on_hand: 0, on_hold: 0, on_order: 0, in_transit: 0, sold: 0 })).join('')}
        </tbody></table>
        <div class="toolbar" style="margin:14px 0 0">
          <button class="btn small" id="d_adjust">Adjust stock</button>
          <button class="btn small" id="d_transfer">Transfer</button>
          <button class="btn small" id="d_edit">Edit item</button>
        </div></div>
      ${exposure && exposure.inAssemblies.length ? `<div class="panel">
        <h2 style="margin-top:0">Component exposure — "available in assemblies"</h2>
        <p class="muted">Standalone <b>${fmt(exposure.standaloneTotal)}</b> + locked in assemblies <b>${fmt(exposure.lockedTotal)}</b>
          = total exposure <b>${fmt(exposure.totalExposure)}</b></p></div>` : ''}
      ${item.item_type === 'assembly' ? `<div class="panel"><h2 style="margin-top:0">Bill of materials</h2>
        ${bom.length ? `<table><thead><tr><th>Component</th><th></th><th class="num">Qty / set</th></tr></thead>
          <tbody>${bom.map(c => `<tr><td><span class="sku">${esc(c.sku)}</span></td><td>${esc(c.name)}</td><td class="num">${c.qty}</td></tr>`).join('')}</tbody></table>`
          : '<p class="err">⚑ No BOM defined for this assembly — this item is on the data-flags list.</p>'}
        <div class="toolbar" style="margin:12px 0 0">
          <button class="btn small" id="d_bom">Edit BOM</button>
          <button class="btn small" id="d_assemble">Assemble sets</button>
          <button class="btn small" id="d_disassemble">Disassemble (last resort)</button>
        </div></div>` : ''}
      ${usedIn.length ? `<div class="panel"><h2 style="margin-top:0">Used in assemblies</h2>
        ${usedIn.map(p => `<span class="sku" style="margin-right:6px">${esc(p.sku)} ×${p.qty}</span>`).join('')}</div>` : ''}
      ${lots.length ? `<div class="panel"><h2 style="margin-top:0">Lots / pieces (heat traceability)</h2>
        <table><thead><tr><th>Lot</th><th>WH</th><th class="num">Qty</th><th class="num">Length mm</th><th>Heat no</th><th>Origin</th></tr></thead>
        <tbody>${lots.map(l => `<tr><td>#${l.id}</td><td>${esc(l.warehouse_id)}</td><td class="num">${fmt(l.qty)}</td>
          <td class="num">${l.length_mm ? fmt(l.length_mm) : '—'}</td><td>${esc(l.heat_no || '—')}</td>
          <td class="muted">${esc(l.origin_txn || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="panel"><h2 style="margin-top:0">Audit trail (latest 100)</h2>
        <table><thead><tr><th>When</th><th>Type</th><th>WH</th><th class="num">Qty</th><th>Ref</th><th>By</th></tr></thead>
        <tbody>${txns.map(t => `<tr><td class="muted">${esc(t.ts)}</td><td>${esc(t.type)}</td>
          <td>${esc(t.warehouse_id)}</td><td class="num">${fmt(t.qty)}</td>
          <td class="muted">${esc(t.ref || '')}</td><td>${esc(t.user)}</td></tr>`).join('') ||
          '<tr><td colspan="6" class="muted">No transactions yet.</td></tr>'}</tbody></table></div>`,
      load);
    $('#d_edit')?.addEventListener('click', () => itemForm(item));
    $('#d_adjust')?.addEventListener('click', () => adjustForm(item));
    $('#d_transfer')?.addEventListener('click', () => transferForm(item));
    $('#d_bom')?.addEventListener('click', () => bomForm(item, bom));
    $('#d_assemble')?.addEventListener('click', () => assembleForm(item, 'assemble'));
    $('#d_disassemble')?.addEventListener('click', () => assembleForm(item, 'disassemble'));
  };
  load();
}

function adjustForm(item) {
  openDrawer(`<h1>Adjust stock — <span class="sku">${esc(item.sku)}</span></h1>
    <div class="panel"><div class="formrow">
      <label>Warehouse <select id="a_wh">${whOptions('WH-MAIN')}</select></label>
      <label>Direction <select id="a_dir"><option value="up">Count up (+)</option><option value="down">Count down (−)</option></select></label>
      <label>Quantity <input id="a_qty" type="number" min="1"></label>
      <label>Heat no (if adding) <input id="a_heat"></label>
    </div>
    <label>Reason <input id="a_reason" placeholder="e.g. physical count correction"></label>
    <p class="err" id="a_err"></p>
    <button class="btn primary" id="a_go">Post adjustment</button></div>`);
  $('#a_go').addEventListener('click', async () => {
    try {
      await api('/api/txn/adjust', { method: 'POST', body: {
        sku: item.sku, wh: $('#a_wh').value, qty: +$('#a_qty').value,
        direction: $('#a_dir').value, reason: $('#a_reason').value,
        heat_no: $('#a_heat').value.trim(), ref: 'ADJ' } });
      toast('Adjustment posted'); itemDrawer(item.sku);
    } catch (e) { $('#a_err').textContent = e.message; }
  });
}
function transferForm(item) {
  openDrawer(`<h1>Transfer — <span class="sku">${esc(item.sku)}</span></h1>
    <p class="sub">Transfer-out and transfer-in post as one atomic pair. Heat lots travel with the goods.</p>
    <div class="panel"><div class="formrow">
      <label>From <select id="t_from">${whOptions('WH-MAIN')}</select></label>
      <label>To <select id="t_to">${whOptions('WH-SAIF')}</select></label>
      <label>Quantity <input id="t_qty" type="number" min="1"></label>
    </div>
    <label>Reference <input id="t_ref" placeholder="e.g. TRF-0012"></label>
    <p class="err" id="t_err"></p>
    <button class="btn primary" id="t_go">Post transfer</button></div>`);
  $('#t_go').addEventListener('click', async () => {
    try {
      await api('/api/txn/transfer', { method: 'POST', body: {
        sku: item.sku, from: $('#t_from').value, to: $('#t_to').value,
        qty: +$('#t_qty').value, ref: $('#t_ref').value || 'TRANSFER' } });
      toast('Transfer posted'); itemDrawer(item.sku);
    } catch (e) { $('#t_err').textContent = e.message; }
  });
}
function bomForm(item, comps) {
  const row = (c = { sku: '', qty: 1 }) => `<div class="row">
    <input class="b_sku skuac" placeholder="Component SKU" value="${esc(c.sku)}" style="flex:2" autocomplete="off">
    <input class="b_qty" type="number" min="0.01" step="any" value="${c.qty}" style="width:90px">
    <button class="btn small b_del">✕</button></div>`;
  openDrawer(`<h1>BOM — <span class="sku">${esc(item.sku)}</span></h1>
    <div class="panel lines-editor" id="b_rows">${comps.map(row).join('') || row()}
      <button class="btn small" id="b_add">+ Add component</button>
      <p class="err" id="b_err"></p>
      <button class="btn primary" id="b_save">Save BOM</button></div>`);
  const wire = () => { $$('.b_del').forEach(b => b.onclick = () => b.closest('.row').remove()); wireSkuInputs(); };
  wire();
  $('#b_add').addEventListener('click', () => { $('#b_add').insertAdjacentHTML('beforebegin', row()); wire(); });
  $('#b_save').addEventListener('click', async () => {
    const components = $$('#b_rows .row').map(r => ({
      sku: $('.b_sku', r).value.trim(), qty: +$('.b_qty', r).value })).filter(c => c.sku && c.qty > 0);
    try {
      await api('/api/bom/' + encodeURIComponent(item.sku), { method: 'POST', body: { components } });
      toast('BOM saved'); itemDrawer(item.sku);
    } catch (e) { $('#b_err').textContent = e.message; }
  });
}
function assembleForm(item, mode) {
  openDrawer(`<h1>${mode === 'assemble' ? 'Assemble' : 'Disassemble'} — <span class="sku">${esc(item.sku)}</span></h1>
    ${mode === 'disassemble' ? '<p class="sub">Disassembly is a last-resort path — check finished stock and assembly-from-components first.</p>' : ''}
    <div class="panel"><div class="formrow">
      <label>Warehouse <select id="as_wh">${whOptions('WH-MAIN')}</select></label>
      <label>Sets <input id="as_qty" type="number" min="1"></label>
    </div>
    <p class="err" id="as_err"></p>
    <button class="btn primary" id="as_go">Post ${mode}</button></div>`);
  $('#as_go').addEventListener('click', async () => {
    try {
      await api('/api/txn/assemble', { method: 'POST', body: {
        sku: item.sku, qty: +$('#as_qty').value, wh: $('#as_wh').value, mode, ref: mode.toUpperCase() } });
      toast(mode === 'assemble' ? 'Sets assembled' : 'Sets disassembled'); itemDrawer(item.sku);
    } catch (e) { $('#as_err').textContent = e.message; }
  });
}

/* ================= SALES ORDERS ================= */
async function so() {
  const orders = await api('/api/so');
  $('#main').innerHTML = `
    <h1>Sales orders</h1>
    <p class="sub">Confirming reserves stock into "Reserved for orders". Ship in full or in partial quantities per line.</p>
    <div class="toolbar">
      <button class="btn primary" id="newSO">+ New sales order</button>
      <button class="btn" id="impSO">Upload sales order file (CSV / Excel / PDF)</button>
    </div>
    <div class="panel"><table><thead><tr>
      <th>#</th><th>Customer</th><th>Ref</th><th>Required</th><th>Status</th>
      <th class="num">Weight</th><th>Lines</th><th></th>
    </tr></thead><tbody>
    ${orders.map(o => `<tr class="click" data-id="${o.id}">
      <td>${o.id}</td><td>${esc(o.customer)}</td><td class="muted">${esc(o.ref || '')}</td>
      <td>${esc(o.required_date || '—')}</td><td><span class="tag ${o.status}">${o.status}</span></td>
      <td class="num wtag">${kg(o.total_weight)}</td>
      <td>${o.lines.slice(0, 3).map(l => `<span class="tag ${l.mode === 'pending' ? 'draft' : l.mode === 'stock' || l.mode === 'shipped' ? 'ok' : l.mode}">${esc(l.sku.slice(-10))} ${l.shipped_qty > 0 && l.shipped_qty < l.qty ? 'partial' : l.mode}</span>`).join(' ')}${o.lines.length > 3 ? ` +${o.lines.length - 3}` : ''}</td>
      <td><button class="btn small" data-pick="${o.id}">Open</button></td></tr>`).join('') ||
      '<tr><td colspan="8" class="muted">No sales orders yet.</td></tr>'}
    </tbody></table></div>`;
  $('#newSO').addEventListener('click', soForm);
  $('#impSO').addEventListener('click', () => importDialog('so', 'Upload sales order',
    `<div class="formrow">
      <label>Customer (overrides file) <input id="so_cust"></label>
      <label>Ref <input id="so_ref"></label>
      <label>Required date <input id="so_date" type="date"></label>
    </div>`,
    () => ({ customer: $('#so_cust').value.trim(), ref: $('#so_ref').value.trim(), required_date: $('#so_date').value })));
  $$('#main [data-pick]').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); soDrawer(+b.dataset.pick); }));
  $$('#main tr.click').forEach(tr => tr.addEventListener('click', () => soDrawer(+tr.dataset.id)));
}
function soForm() {
  const row = () => `<div class="row">
    <input class="l_sku skuac" placeholder="SKU — type to search" style="flex:2" autocomplete="off">
    <input class="l_qty" type="number" min="1" placeholder="Qty" style="width:100px">
    <select class="l_wh" style="width:auto">${whOptions('AUTO', true)}</select>
    <button class="btn small l_del">✕</button></div>`;
  openDrawer(`<h1>New sales order</h1>
    <div class="panel"><div class="formrow">
      <label>Customer <input id="s_cust" placeholder="e.g. MABANI"></label>
      <label>Your ref <input id="s_ref"></label>
      <label>Required date <input id="s_date" type="date"></label>
    </div>
    <h2>Lines</h2>
    <div class="lines-editor" id="s_rows">${row()}</div>
    <button class="btn small" id="s_add">+ Add line</button>
    <p class="err" id="s_err"></p>
    <div class="toolbar" style="margin-top:12px">
      <button class="btn primary" id="s_save">Create draft</button>
      <button class="btn" id="s_saveconf">Create + confirm (reserve stock)</button>
    </div></div>`);
  const wire = () => { $$('.l_del').forEach(b => b.onclick = () => b.closest('.row').remove()); wireSkuInputs(); };
  wire();
  $('#s_add').addEventListener('click', () => { $('#s_rows').insertAdjacentHTML('beforeend', row()); wire(); });
  const collect = () => $$('#s_rows .row').map(r => ({
    sku: $('.l_sku', r).value.trim(), qty: +$('.l_qty', r).value, warehouse_id: $('.l_wh', r).value }))
    .filter(l => l.sku && l.qty > 0);
  const create = async (confirm) => {
    try {
      const r = await api('/api/so', { method: 'POST', body: {
        customer: $('#s_cust').value.trim(), ref: $('#s_ref').value,
        required_date: $('#s_date').value, lines: collect() } });
      if (confirm) await api(`/api/so/${r.id}/confirm`, { method: 'POST' });
      toast(`Sales order #${r.id} ${confirm ? 'confirmed' : 'created'}`); soDrawer(r.id);
    } catch (e) { $('#s_err').textContent = e.message; }
  };
  $('#s_save').addEventListener('click', () => create(false));
  $('#s_saveconf').addEventListener('click', () => create(true));
}
async function soDrawer(id) {
  const load = async () => {
    const d = await api(`/api/so/${id}/pick`);
    const { so, lines, total_weight } = d;
    const canShip = ['confirmed', 'partial'].includes(so.status);
    openDrawer(`<h1>SO #${so.id} — ${esc(so.customer)} <span class="tag ${so.status}">${so.status}</span></h1>
      <p class="sub">${esc(so.ref || '')} ${so.required_date ? '· required ' + esc(so.required_date) : ''}
        · total weight <b>${kg(total_weight)}</b> · created by ${esc(so.created_by)}</p>
      <div class="panel"><h2 style="margin-top:0">Pick &amp; pack ${canShip ? '— enter ship qty per line for partial shipment' : ''}</h2>
      ${lines.map(l => `
        <div style="border-bottom:1px solid var(--line);padding:10px 0">
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <span class="sku">${esc(l.sku)}</span>
            <b>${fmt(l.qty)}</b> <span class="muted">(shipped ${fmt(l.shipped_qty)}, remaining ${fmt(l.remaining)})</span>
            from ${esc(l.warehouse_id)}
            <span class="tag ${l.mode === 'stock' || l.mode === 'shipped' ? 'ok' : l.mode === 'pending' ? 'draft' : l.mode}">${l.mode}</span>
            <span class="wtag">${kg(l.line_weight)}</span>
            ${canShip && ['stock', 'kit'].includes(l.mode) && l.remaining > 0
              ? `<input type="number" class="shipqty" data-line="${l.id}" min="1" max="${l.remaining}"
                  placeholder="ship qty" style="width:110px;margin-left:auto">` : ''}
          </div>
          <div class="muted">${esc(l.name)}</div>
          ${l.mode === 'stock' ? '<div class="muted">→ Pull pre-assembled / shelf stock.</div>' : ''}
          ${l.checklist ? `<div>→ Assemble at pack time. Checklist for remaining ${fmt(l.remaining)} sets:</div>
            <ul class="checklist">${l.checklist.map(c => `<li><span class="sku">${esc(c.sku)}</span> — pull <b>${fmt(c.need)}</b> (${c.qty}/set) · ${esc(c.name)}</li>`).join('')}</ul>` : ''}
          ${l.mode === 'short' && l.suggestions.length ? `<div style="color:var(--red)">Short. Options:</div>
            <ul class="sugg">${l.suggestions.map(s => `<li>${esc(s.text)}</li>`).join('')}</ul>` : ''}
        </div>`).join('')}
      <div class="toolbar" style="margin-top:14px">
        ${so.status === 'draft' ? `<button class="btn primary" id="so_confirm">Confirm (reserve stock)</button>` : ''}
        ${canShip ? `<button class="btn primary" id="so_shippart">Ship entered quantities</button>
                     <button class="btn" id="so_shipall">Ship all remaining</button>` : ''}
        ${canShip && lines.some(l => ['short','pending'].includes(l.mode)) ? `<button class="btn" id="so_recheck">Re-check short lines against stock</button>` : ''}
        ${!['shipped', 'cancelled'].includes(so.status) ? `<button class="btn danger" id="so_cancel">Cancel order</button>` : ''}
      </div><p class="err" id="so_err"></p></div>`, load);
    $('#so_confirm')?.addEventListener('click', async () => {
      try { await api(`/api/so/${so.id}/confirm`, { method: 'POST' }); toast('Confirmed — stock reserved'); load(); }
      catch (e) { $('#so_err').textContent = e.message; }
    });
    $('#so_recheck')?.addEventListener('click', async () => {
      try { const r = await api(`/api/so/${so.id}/recheck`, { method: 'POST' });
        toast(r.changed ? `${r.changed} line(s) now reserved` : 'Still short — no stock available yet'); load(); }
      catch (e) { $('#so_err').textContent = e.message; }
    });
    $('#so_shipall')?.addEventListener('click', async () => {
      try { await api(`/api/so/${so.id}/ship`, { method: 'POST', body: {} }); toast('Shipped all remaining'); load(); }
      catch (e) { $('#so_err').textContent = e.message; }
    });
    $('#so_shippart')?.addEventListener('click', async () => {
      const linesReq = $$('.shipqty').map(i => ({ line_id: +i.dataset.line, qty: +i.value }))
        .filter(x => x.qty > 0);
      if (!linesReq.length) return $('#so_err').textContent = 'Enter a ship quantity on at least one line.';
      try { await api(`/api/so/${so.id}/ship`, { method: 'POST', body: { lines: linesReq } }); toast('Partial shipment posted'); load(); }
      catch (e) { $('#so_err').textContent = e.message; }
    });
    $('#so_cancel')?.addEventListener('click', async () => {
      try { await api(`/api/so/${so.id}/cancel`, { method: 'POST' }); toast('Cancelled — reservations released'); load(); }
      catch (e) { $('#so_err').textContent = e.message; }
    });
  };
  load();
}

/* ================= INCOMING (PO) ================= */
async function po() {
  const pos = await api('/api/po');
  $('#main').innerHTML = `
    <h1>Incoming</h1>
    <p class="sub">Click an order to see its components and log partial in-transit or partial receipts, line by line.</p>
    <div class="toolbar">
      <button class="btn primary" id="newPO">+ New purchase order</button>
      <button class="btn" id="impPO">Upload PO / packing list file (CSV / Excel / PDF)</button>
    </div>
    <div class="panel"><table><thead><tr>
      <th>Ref</th><th>Supplier</th><th>ETA</th><th>To</th><th>Status</th>
      <th class="num">Lines</th><th class="num">Pieces</th><th class="num">Weight</th>
    </tr></thead><tbody>
    ${pos.map(p => `<tr class="click" data-id="${p.id}">
        <td><span class="sku">${esc(p.ref || 'PO-' + p.id)}</span></td>
        <td>${esc(p.supplier || '—')}</td><td>${esc(p.eta || '—')}</td><td>${esc(p.warehouse_id)}</td>
        <td><span class="tag ${p.status}">${p.status.replace('_', ' ')}</span></td>
        <td class="num">${p.lines.length}</td><td class="num">${fmt(p.total_qty)}</td>
        <td class="num wtag">${kg(p.total_weight)}</td></tr>`).join('') ||
      '<tr><td colspan="8" class="muted">No incoming shipments.</td></tr>'}
    </tbody></table></div>`;
  $('#newPO').addEventListener('click', () => poForm());
  $('#impPO').addEventListener('click', () => importDialog('po', 'Upload purchase order / packing list',
    `<div class="formrow">
      <label>Supplier <input id="po_sup"></label>
      <label>Ref / invoice no <input id="po_ref"></label>
      <label>ETA <input id="po_eta" type="date"></label>
      <label>Into <select id="po_wh">${whOptions('WH-MAIN')}</select></label>
      <label>Status <select id="po_st"><option value="ordered">Ordered</option><option value="in_transit">Already in transit</option></select></label>
    </div>`,
    () => ({ supplier: $('#po_sup').value.trim(), ref: $('#po_ref').value.trim(), eta: $('#po_eta').value,
             warehouse_id: $('#po_wh').value, status: $('#po_st').value })));
  $$('#main tr.click').forEach(tr => tr.addEventListener('click', () => poDrawer(+tr.dataset.id)));
}
function poForm() {
  const row = () => `<div class="row">
    <input class="p_sku skuac" placeholder="SKU — type to search" style="flex:2" autocomplete="off">
    <input class="p_qty" type="number" min="1" placeholder="Qty" style="width:100px">
    <input class="p_heat" placeholder="Heat no (opt.)" style="width:130px">
    <button class="btn small p_del">✕</button></div>`;
  openDrawer(`<h1>New purchase order</h1>
    <div class="panel"><div class="formrow">
      <label>Supplier <input id="p_sup" placeholder="e.g. Hahn INC."></label>
      <label>Ref / invoice no <input id="p_ref" placeholder="e.g. HN24C08O009"></label>
      <label>ETA <input id="p_eta" type="date"></label>
      <label>Receive into <select id="p_wh">${whOptions('WH-MAIN')}</select></label>
    </div>
    <h2>Lines</h2>
    <div class="lines-editor" id="p_rows">${row()}</div>
    <button class="btn small" id="p_add">+ Add line</button>
    <p class="err" id="p_err"></p>
    <button class="btn primary" id="p_save" style="margin-top:12px">Create PO (books on-order)</button></div>`);
  const wire = () => { $$('.p_del').forEach(b => b.onclick = () => b.closest('.row').remove()); wireSkuInputs(); };
  wire();
  $('#p_add').addEventListener('click', () => { $('#p_rows').insertAdjacentHTML('beforeend', row()); wire(); });
  $('#p_save').addEventListener('click', async () => {
    const lines = $$('#p_rows .row').map(r => ({
      sku: $('.p_sku', r).value.trim(), qty: +$('.p_qty', r).value, heat_no: $('.p_heat', r).value.trim() }))
      .filter(l => l.sku && l.qty > 0);
    try {
      await api('/api/po', { method: 'POST', body: {
        supplier: $('#p_sup').value, ref: $('#p_ref').value, eta: $('#p_eta').value,
        warehouse_id: $('#p_wh').value, lines } });
      toast('Purchase order created'); closeDrawer();
    } catch (e) { $('#p_err').textContent = e.message; }
  });
}
async function poDrawer(id) {
  const load = async () => {
    const p = await api('/api/po/' + id);
    const open = ['ordered', 'in_transit', 'partial'].includes(p.status);
    openDrawer(`<h1><span class="sku">${esc(p.ref || 'PO-' + p.id)}</span>
        <span class="tag ${p.status}">${p.status.replace('_', ' ')}</span></h1>
      <p class="sub">${esc(p.supplier || '')} ${p.eta ? '· ETA ' + esc(p.eta) : ''} · into ${esc(p.warehouse_id)}
        · ${fmt(p.total_qty)} pcs · total weight <b>${kg(p.total_weight)}</b></p>
      <div class="panel"><h2 style="margin-top:0">Components in this order</h2>
        <div class="partline" style="font-weight:700;font-size:11.5px;text-transform:uppercase;color:var(--ink-2)">
          <div>Item</div><div>Ordered</div><div>In transit</div><div>Received</div><div>${open ? 'Action qty' : ''}</div></div>
        ${p.lines.map(l => `<div class="partline">
          <div><span class="sku">${esc(l.sku)}</span><div class="muted" style="font-size:11.5px">${esc(l.name)}
            ${l.heat_no ? ` · heat <b>${esc(l.heat_no)}</b>` : ''} · ${kg((l.unit_weight || 0) * l.qty)}</div></div>
          <div class="num">${fmt(l.qty)}</div>
          <div class="num" style="color:var(--teal)">${fmt(l.in_transit_qty)}</div>
          <div class="num" style="color:var(--green)">${fmt(l.received_qty)}</div>
          <div>${open && l.received_qty < l.qty
            ? `<input type="number" class="actqty" data-line="${l.id}" min="1" max="${l.qty - l.received_qty}" placeholder="qty">
               <input type="text" class="actheat" data-line="${l.id}" placeholder="heat no" style="width:90px;margin-top:4px">` : ''}</div>
        </div>`).join('')}
      ${open ? `<div class="toolbar" style="margin-top:14px">
        <button class="btn" id="po_disp_part">Mark entered qty in transit</button>
        <button class="btn" id="po_disp_all">Mark ALL remaining in transit</button>
        <button class="btn primary" id="po_rec_part">Receive entered qty</button>
        <button class="btn primary" id="po_rec_all">Receive ALL remaining</button>
      </div>` : ''}
      <p class="err" id="po_err"></p></div>`, load);
    const gather = () => $$('.actqty').map(i => ({
      line_id: +i.dataset.line, qty: +i.value,
      heat_no: $(`.actheat[data-line="${i.dataset.line}"]`)?.value.trim() || undefined,
    })).filter(x => x.qty > 0);
    const act = async (path, body, msg) => {
      try { await api(`/api/po/${p.id}/${path}`, { method: 'POST', body }); toast(msg); load(); }
      catch (e) { $('#po_err').textContent = e.message; }
    };
    $('#po_disp_part')?.addEventListener('click', () => {
      const lines = gather();
      if (!lines.length) return $('#po_err').textContent = 'Enter a quantity on at least one line.';
      act('dispatch', { lines }, 'Marked in transit (partial)');
    });
    $('#po_disp_all')?.addEventListener('click', () => act('dispatch', {}, 'All remaining marked in transit'));
    $('#po_rec_part')?.addEventListener('click', () => {
      const lines = gather();
      if (!lines.length) return $('#po_err').textContent = 'Enter a quantity on at least one line.';
      act('receive', { lines }, 'Received (partial)');
    });
    $('#po_rec_all')?.addEventListener('click', () => act('receive', {}, 'All remaining received'));
  };
  load();
}

/* ================= MANUFACTURING ================= */
async function mfg() {
  const jobs = await api('/api/reports/mfg-yield');
  $('#main').innerHTML = `
    <h1>Manufacturing</h1>
    <p class="sub">Cut-to-length converts rod stock into shorter SKUs. Offcuts are kept as individual pieces with their own length and heat number.</p>
    <div class="toolbar">
      <button class="btn primary" id="newCut">+ Cut job</button>
      <span class="muted">Find scrap by length:</span>
      <input id="scrapDia" placeholder="Dia e.g. M20" style="width:110px">
      <input id="scrapMin" type="number" placeholder="Min mm" style="width:110px">
      <button class="btn" id="scrapGo">Search pieces</button>
    </div>
    <div id="scrapOut"></div>
    <div class="panel"><h2 style="margin-top:0">Job log (input vs output vs scrap)</h2>
      <table><thead><tr><th>Ref</th><th>When</th><th>WH</th><th>Sources</th><th class="num">Consumed</th>
        <th>Outputs</th><th class="num">Produced</th><th class="num">Scrap pcs</th><th>By</th></tr></thead>
      <tbody>${jobs.map(j => `<tr>
        <td><span class="sku">${esc(j.ref)}</span></td><td class="muted">${esc(j.ts)}</td><td>${esc(j.warehouse_id)}</td>
        <td>${esc(j.sources || '')}</td><td class="num">${fmt(j.consumed)}</td>
        <td>${esc(j.outputs || '')}</td><td class="num">${fmt(j.produced)}</td>
        <td class="num">${fmt(j.scrap)}</td><td>${esc(j.user)}</td></tr>`).join('') ||
        '<tr><td colspan="9" class="muted">No manufacturing jobs yet.</td></tr>'}</tbody></table></div>`;
  $('#newCut').addEventListener('click', cutForm);
  $('#scrapGo').addEventListener('click', async () => {
    const dia = $('#scrapDia').value.trim().toUpperCase();
    if (!dia) return;
    const pieces = await api(`/api/scrap/${dia}?min=${$('#scrapMin').value || ''}`);
    $('#scrapOut').innerHTML = `<div class="panel"><h2 style="margin-top:0">Scrap pieces — ${esc(dia)}</h2>
      <table><thead><tr><th>Lot</th><th>WH</th><th class="num">Pieces</th><th class="num">Length mm</th><th>Heat no</th></tr></thead>
      <tbody>${pieces.map(pc => `<tr><td>#${pc.id}</td><td>${esc(pc.warehouse_id)}</td>
        <td class="num">${fmt(pc.qty)}</td><td class="num">${fmt(pc.length_mm)}</td><td>${esc(pc.heat_no || '—')}</td></tr>`).join('') ||
        '<tr><td colspan="5" class="muted">No pieces at or above that length.</td></tr>'}</tbody></table></div>`;
  });
}
function cutForm() {
  const orow = () => `<div class="row"><input class="c_osku skuac" placeholder="Output SKU" style="flex:2" autocomplete="off">
    <input class="c_oqty" type="number" min="1" placeholder="Pcs" style="width:90px"><button class="btn small c_del">✕</button></div>`;
  const srow = () => `<div class="row"><input class="c_slen" type="number" min="1" placeholder="Length mm" style="width:130px">
    <input class="c_sqty" type="number" min="1" placeholder="Pieces" style="width:90px"><button class="btn small c_del">✕</button></div>`;
  openDrawer(`<h1>Cut job</h1>
    <div class="panel"><div class="formrow">
      <label>Source SKU (rod / long bolt) <input id="c_src" class="skuac" autocomplete="off"></label>
      <label>Bars consumed <input id="c_srcqty" type="number" min="1"></label>
      <label>Warehouse <select id="c_wh">${whOptions('WH-MAIN')}</select></label>
      <label>Heat no (optional) <input id="c_heat"></label>
    </div>
    <h2>Outputs (finished / shorter SKUs)</h2>
    <div class="lines-editor" id="c_outs">${orow()}</div>
    <button class="btn small" id="c_addo">+ Add output</button>
    <h2>Usable offcuts kept</h2>
    <div class="lines-editor" id="c_scrap">${srow()}</div>
    <button class="btn small" id="c_adds">+ Add offcut</button>
    <p class="err" id="c_err"></p>
    <button class="btn primary" id="c_go" style="margin-top:12px">Post cut job</button></div>`);
  const wire = () => { $$('.c_del').forEach(b => b.onclick = () => b.closest('.row').remove()); wireSkuInputs(); };
  wire();
  $('#c_addo').addEventListener('click', () => { $('#c_outs').insertAdjacentHTML('beforeend', orow()); wire(); });
  $('#c_adds').addEventListener('click', () => { $('#c_scrap').insertAdjacentHTML('beforeend', srow()); wire(); });
  $('#c_go').addEventListener('click', async () => {
    const outputs = $$('#c_outs .row').map(r => ({ sku: $('.c_osku', r).value.trim(), qty: +$('.c_oqty', r).value }))
      .filter(o => o.sku && o.qty > 0);
    const scrap = $$('#c_scrap .row').map(r => ({ length_mm: +$('.c_slen', r).value, qty: +$('.c_sqty', r).value }))
      .filter(s => s.length_mm > 0 && s.qty > 0);
    try {
      await api('/api/txn/cut', { method: 'POST', body: {
        sourceSku: $('#c_src').value.trim(), sourceQty: +$('#c_srcqty').value,
        wh: $('#c_wh').value, heat_no: $('#c_heat').value.trim(), outputs, scrap } });
      toast('Cut job posted'); closeDrawer();
    } catch (e) { $('#c_err').textContent = e.message; }
  });
}

/* ================= REPORTS ================= */
async function reports() {
  $('#main').innerHTML = `
    <h1>Reports</h1>
    <div class="toolbar">
      <select id="r_pick" style="width:auto">
        <option value="flags">⚑ Data flags (things that look off)</option>
        <option value="heat">Heat number trace (purchase → sale)</option>
        <option value="assembly">Assembly availability (finished + buildable)</option>
        <option value="low">Low stock / reorder</option>
        <option value="exposure">Component exposure</option>
        <option value="yield">Manufacturing yield</option>
        <option value="audit">Audit trail per SKU</option>
      </select>
      <select id="r_wh" style="width:auto">${whOptions('WH-MAIN')}</select>
      <input id="r_sku" class="skuac" placeholder="SKU / heat no" style="width:230px" autocomplete="off">
      <button class="btn primary" id="r_go">Run</button>
    </div>
    <div id="r_out" class="panel"><p class="muted">Pick a report and press Run.</p></div>`;
  wireSkuInputs();
  $('#r_go').addEventListener('click', async () => {
    const kind = $('#r_pick').value, wh = $('#r_wh').value, sku = $('#r_sku').value.trim();
    const out = $('#r_out');
    try {
      if (kind === 'flags') {
        const rows = await api('/api/reports/flags');
        out.innerHTML = rows.length ? `<ul>${rows.map(f =>
          `<li style="margin:6px 0">${f.sku ? `<span class="sku">${esc(f.sku)}</span> ` : ''}${esc(f.text)}</li>`).join('')}</ul>`
          : '<p style="color:var(--green)">No data-quality flags. Everything looks consistent.</p>';
      } else if (kind === 'heat') {
        if (!sku) return out.innerHTML = '<p class="err">Enter a heat number in the box.</p>';
        const h = await api('/api/heat/' + encodeURIComponent(sku));
        out.innerHTML = `<h2 style="margin-top:0">Heat ${esc(h.heat_no)} — full genealogy</h2>
          <div class="timeline">
          ${h.purchases.map(pu => `<div class="tl"><b>Purchased</b> — ${fmt(pu.qty)} × <span class="sku">${esc(pu.sku)}</span>
            from ${esc(pu.supplier || '?')} (${esc(pu.ref)}), received ${fmt(pu.received_qty)} into ${esc(pu.warehouse_id)}</div>`).join('')}
          ${h.lots.map(l => `<div class="tl"><b>Lot #${l.id}</b> — ${fmt(l.qty)} pcs of <span class="sku">${esc(l.sku)}</span>
            in ${esc(l.warehouse_id)}${l.length_mm ? `, ${fmt(l.length_mm)} mm` : ''} <span class="muted">(${esc(l.created_ts)})</span></div>`).join('')}
          ${h.txns.map(t => `<div class="tl"><b>${esc(t.type)}</b> — ${fmt(t.qty)} × <span class="sku">${esc(t.sku)}</span>
            at ${esc(t.warehouse_id)} ${t.counterparty ? '→ ' + esc(t.counterparty) : ''}
            <span class="muted">${esc(t.ref || '')} · ${esc(t.ts)} · by ${esc(t.user)}</span></div>`).join('')}
          </div>
          ${!h.purchases.length && !h.lots.length && !h.txns.length ? '<p class="muted">Nothing recorded under this heat number.</p>' : ''}`;
      } else if (kind === 'assembly') {
        const rows = await api('/api/reports/assembly-availability?wh=' + wh);
        out.innerHTML = `<table><thead><tr><th>Assembly</th><th>Name</th><th class="num">Finished avail.</th>
          <th class="num">Buildable from parts</th><th class="num">Total sellable</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td><span class="sku">${esc(r.sku)}</span></td><td>${esc(r.name)}</td>
          <td class="num">${fmt(r.finished)}</td><td class="num">${fmt(r.buildable)}</td>
          <td class="num"><b>${fmt(r.total)}</b></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nothing available.</td></tr>'}</tbody></table>`;
      } else if (kind === 'low') {
        const rows = await api('/api/reports/low-stock');
        out.innerHTML = `<table><thead><tr><th>SKU</th><th>Name</th><th class="num">On hand</th>
          <th class="num">Reorder level</th><th class="num">Incoming</th></tr></thead>
          <tbody>${rows.map(r => `<tr><td><span class="sku">${esc(r.sku)}</span></td><td>${esc(r.name)}</td>
          <td class="num">${fmt(r.on_hand)}</td><td class="num">${fmt(r.min_stock)}</td>
          <td class="num">${fmt(r.in_transit + r.on_order)}</td></tr>`).join('') ||
          '<tr><td colspan="5" class="muted">Nothing below its reorder level. Set reorder levels on items to feed this report.</td></tr>'}</tbody></table>`;
      } else if (kind === 'exposure') {
        if (!sku) return out.innerHTML = '<p class="err">Enter a component SKU.</p>';
        const e = await api('/api/reports/exposure/' + encodeURIComponent(sku));
        out.innerHTML = `<p>Standalone <b>${fmt(e.standaloneTotal)}</b> + locked in assemblies <b>${fmt(e.lockedTotal)}</b>
          = total exposure <b>${fmt(e.totalExposure)}</b></p>
          <table><thead><tr><th>Assembly</th><th class="num">Per set</th><th class="num">Sets on hand</th><th class="num">Units locked</th></tr></thead>
          <tbody>${e.inAssemblies.map(a => `<tr><td><span class="sku">${esc(a.parent_sku)}</span></td>
          <td class="num">${a.per_set}</td><td class="num">${fmt(a.sets_on_hand)}</td>
          <td class="num">${fmt(a.units_locked)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Not used in any BOM.</td></tr>'}</tbody></table>`;
      } else if (kind === 'yield') {
        const rows = await api('/api/reports/mfg-yield');
        out.innerHTML = `<table><thead><tr><th>Ref</th><th>When</th><th class="num">Consumed</th>
          <th class="num">Produced</th><th class="num">Scrap</th></tr></thead>
          <tbody>${rows.map(j => `<tr><td><span class="sku">${esc(j.ref)}</span></td><td class="muted">${esc(j.ts)}</td>
          <td class="num">${fmt(j.consumed)}</td><td class="num">${fmt(j.produced)}</td>
          <td class="num">${fmt(j.scrap)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No jobs yet.</td></tr>'}</tbody></table>`;
      } else if (kind === 'audit') {
        if (!sku) return out.innerHTML = '<p class="err">Enter a SKU.</p>';
        const rows = await api('/api/reports/audit/' + encodeURIComponent(sku));
        out.innerHTML = `<table><thead><tr><th>When</th><th>Type</th><th>WH</th><th class="num">Qty</th>
          <th class="num">Δ on hand</th><th class="num">Δ reserved</th><th>Ref</th><th>By</th></tr></thead>
          <tbody>${rows.map(t => `<tr><td class="muted">${esc(t.ts)}</td><td>${esc(t.type)}</td>
          <td>${esc(t.warehouse_id)}</td><td class="num">${fmt(t.qty)}</td>
          <td class="num">${fmt(t.d_on_hand)}</td><td class="num">${fmt(t.d_on_hold)}</td>
          <td class="muted">${esc(t.ref || '')}</td><td>${esc(t.user)}</td></tr>`).join('') ||
          '<tr><td colspan="8" class="muted">No transactions for that SKU.</td></tr>'}</tbody></table>`;
      }
    } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  });
}

boot();
