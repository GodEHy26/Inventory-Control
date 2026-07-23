const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const ledger = require('./ledger');
const bom = require('./bom');
const mfg = require('./manufacturing');
const imports = require('./imports');

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server);

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- auth (signed-cookie sessions, no external deps) ----------
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
function hashPass(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPass(pw, stored) {
  const [salt, h] = stored.split(':');
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, salt, 32));
}
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + mac;
}
function unsign(token) {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expect.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
app.use((req, res, next) => { req.user = unsign(getCookie(req, 'ic_session')); next(); });

const CAN = {
  admin: new Set(['*']),
  purchasing: new Set(['po', 'import', 'items']),
  sales: new Set(['so', 'import', 'items']),
  warehouse: new Set(['receive', 'transfer', 'mfg', 'assemble', 'ship', 'adjust', 'items', 'import']),
  viewer: new Set([]),
};
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}
function can(area) {
  return (req, res, next) => {
    const set = CAN[req.user?.role] || new Set();
    if (set.has('*') || set.has(area)) return next();
    res.status(403).json({ error: `Your role (${req.user?.role}) can't do this. Ask an admin.` });
  };
}
function seedUsers() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n) return;
  for (const [u, role, name] of [
    ['admin', 'admin', 'Administrator'], ['sales', 'sales', 'Sales'],
    ['warehouse', 'warehouse', 'Warehouse'], ['purchasing', 'purchasing', 'Purchasing'],
  ]) {
    db.prepare('INSERT INTO users (username, pass_hash, role, display_name) VALUES (?,?,?,?)')
      .run(u, hashPass('change-me-' + u), role, name);
  }
  console.log('Seeded default users (password = "change-me-<username>"). Change them.');
}
seedUsers();

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username || '');
  if (!u || !verifyPass(password || '', u.pass_hash))
    return res.status(401).json({ error: 'Wrong username or password' });
  const token = sign({ id: u.id, username: u.username, role: u.role, name: u.display_name });
  res.setHeader('Set-Cookie', `ic_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
  res.json({ ok: true, user: { username: u.username, role: u.role, name: u.display_name } });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'ic_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.post('/api/password', requireAuth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPass(current || '', u.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || next.length < 8) return res.status(400).json({ error: 'New password needs at least 8 characters' });
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPass(next), u.id);
  res.json({ ok: true });
});

// ---------- live sync ----------
function broadcast(areas, msg, actor) { io.emit('sync', { areas, msg, actor, ts: Date.now() }); }

// ---------- helpers ----------
const itemBySku = db.prepare('SELECT * FROM items WHERE sku=?');
function weightOf(sku, qty) {
  const it = itemBySku.get(sku);
  return it ? (it.unit_weight || 0) * qty : 0;
}
// Warehouse with the most available stock for a SKU (total-first policy).
function bestWarehouse(sku) {
  const r = db.prepare(`SELECT warehouse_id, on_hand - on_hold ats FROM stock_levels
    WHERE sku=? ORDER BY ats DESC LIMIT 1`).get(sku);
  return r && r.ats > 0 ? r.warehouse_id : 'WH-MAIN';
}
// Consume lots FIFO when stock leaves (ships / manufacturing), so heat
// numbers travel with the goods. Returns list of {lot, heat_no, qty}.
function consumeLotsFifo(sku, wh, qty) {
  const lots = db.prepare(`SELECT * FROM lots WHERE sku=? AND warehouse_id=? AND qty>0
    ORDER BY created_ts, id`).all(sku, wh);
  const used = [];
  let left = qty;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(l.qty, left);
    db.prepare('UPDATE lots SET qty = qty - ? WHERE id=?').run(take, l.id);
    if (l.heat_no) used.push({ lot: l.id, heat_no: l.heat_no, qty: take });
    left -= take;
  }
  return used;
}

// ---------- bootstrap ----------
app.get('/api/bootstrap', (req, res) => {
  res.json({
    user: req.user || null,
    warehouses: db.prepare('SELECT * FROM warehouses ORDER BY id').all(),
    counts: {
      items: db.prepare('SELECT COUNT(*) c FROM items WHERE active=1').get().c,
      openSO: db.prepare("SELECT COUNT(*) c FROM sales_orders WHERE status IN ('draft','confirmed','partial')").get().c,
      openPO: db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status IN ('ordered','in_transit','partial')").get().c,
      flags: dataFlags().length,
    },
  });
});

// ---------- SKU autocomplete ----------
app.get('/api/sku-suggest', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const rows = db.prepare(`
    SELECT i.sku, i.name, i.item_type, COALESCE(SUM(s.on_hand - s.on_hold),0) ats
    FROM items i LEFT JOIN stock_levels s ON s.sku = i.sku
    WHERE i.active = 1 AND (i.sku LIKE @pre OR i.sku LIKE @mid OR i.name LIKE @mid OR i.size LIKE @pre)
    GROUP BY i.sku
    ORDER BY (i.sku LIKE @pre) DESC, ats DESC, i.sku LIMIT 8`)
    .all({ pre: q + '%', mid: '%' + q + '%' });
  res.json(rows);
});

// ---------- items & stock ----------
app.get('/api/items', requireAuth, (req, res) => {
  const { q = '', type = '', category = '', wh = '', stocked = '', limit = 100, offset = 0 } = req.query;
  const rows = db.prepare(`
    SELECT i.*, COALESCE(SUM(s.on_hand),0) on_hand, COALESCE(SUM(s.on_hold),0) on_hold,
      COALESCE(SUM(s.on_order),0) on_order, COALESCE(SUM(s.in_transit),0) in_transit,
      COALESCE(SUM(s.on_hand - s.on_hold),0) ats
    FROM items i LEFT JOIN stock_levels s
      ON s.sku = i.sku AND (@wh = '' OR s.warehouse_id = @wh)
    WHERE i.active = 1
      AND (@q = '' OR i.sku LIKE '%'||@q||'%' OR i.name LIKE '%'||@q||'%' OR i.size LIKE '%'||@q||'%')
      AND (@type = '' OR i.item_type = @type)
      AND (@category = '' OR i.category = @category)
    GROUP BY i.sku
    HAVING (@stocked = '' OR on_hand > 0 OR in_transit > 0 OR on_order > 0)
    ORDER BY on_hand DESC, i.sku LIMIT @limit OFFSET @offset`)
    .all({ q, type, category, wh, stocked, limit: +limit, offset: +offset });
  res.json(rows);
});
app.get('/api/categories', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT DISTINCT category FROM items WHERE active=1 ORDER BY 1').all().map(r => r.category));
});
app.post('/api/items', requireAuth, can('items'), (req, res) => {
  const it = req.body;
  if (!it.sku || !it.name) return res.status(400).json({ error: 'SKU and name are required' });
  db.prepare(`INSERT INTO items (sku, name, item_type, category, size, grade, coating, head_marking, uom, min_stock, unit_weight, attrs)
    VALUES (@sku,@name,@item_type,@category,@size,@grade,@coating,@head_marking,@uom,@min_stock,@unit_weight,@attrs)
    ON CONFLICT(sku) DO UPDATE SET name=@name, item_type=@item_type, category=@category,
      size=@size, grade=@grade, coating=@coating, head_marking=@head_marking,
      uom=@uom, min_stock=@min_stock, unit_weight=@unit_weight, attrs=@attrs`)
    .run({ item_type: 'part', category: '', size: '', grade: '', coating: '', head_marking: '',
           uom: 'pcs', min_stock: 0, unit_weight: 0, attrs: '{}', ...it });
  broadcast(['items'], `Item ${it.sku} saved`, req.user.username);
  res.json({ ok: true });
});
app.get('/api/item/:sku', requireAuth, (req, res) => {
  const item = itemBySku.get(req.params.sku);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({
    item,
    levels: ledger.levelsFor(item.sku),
    bom: bom.components(item.sku),
    usedIn: bom.parentsOf(item.sku),
    exposure: item.item_type !== 'assembly' ? bom.exposure(item.sku) : null,
    lots: db.prepare('SELECT * FROM lots WHERE sku=? AND qty>0 ORDER BY created_ts DESC LIMIT 100').all(item.sku),
    txns: db.prepare('SELECT * FROM transactions WHERE sku=? ORDER BY id DESC LIMIT 100').all(item.sku),
  });
});
app.post('/api/bom/:sku', requireAuth, can('items'), (req, res) => {
  const parent = req.params.sku;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM bom WHERE parent_sku=?').run(parent);
    for (const c of req.body.components || []) {
      db.prepare('INSERT INTO bom (parent_sku, component_sku, qty) VALUES (?,?,?)')
        .run(parent, c.sku, c.qty);
    }
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['items'], `BOM for ${parent} updated`, req.user.username);
  res.json({ ok: true });
});

// ---------- direct stock movements ----------
app.post('/api/txn/adjust', requireAuth, can('adjust'), (req, res) => {
  const { sku, wh, qty, direction, ref, reason, heat_no } = req.body;
  const tx = db.transaction(() => {
    const group = ledger.post([{ type: 'ADJUST', sku, wh, qty: Math.abs(qty),
      d_on_hand: direction === 'down' ? -Math.abs(qty) : Math.abs(qty),
      ref, meta: { reason, heat_no: heat_no || null } }], req.user.username);
    if (direction !== 'down' && heat_no) {
      db.prepare('INSERT INTO lots (sku, warehouse_id, qty, heat_no, origin_txn) VALUES (?,?,?,?,?)')
        .run(sku, wh, Math.abs(qty), heat_no, group);
    }
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['stock'], `Stock adjusted: ${sku}`, req.user.username);
  res.json({ ok: true });
});
app.post('/api/txn/transfer', requireAuth, can('transfer'), (req, res) => {
  const { sku, from, to, qty, ref } = req.body;
  if (from === to) return res.status(400).json({ error: 'Source and destination are the same warehouse' });
  const tx = db.transaction(() => {
    ledger.post([
      { type: 'TRANSFER_OUT', sku, wh: from, qty, d_on_hand: -qty, ref, meta: { to } },
      { type: 'TRANSFER_IN', sku, wh: to, qty, d_on_hand: qty, ref, meta: { from } },
    ], req.user.username);
    // lots travel with the goods
    const moved = consumeLotsFifo(sku, from, qty);
    for (const m of moved) {
      const src = db.prepare('SELECT * FROM lots WHERE id=?').get(m.lot);
      db.prepare('INSERT INTO lots (sku, warehouse_id, qty, length_mm, heat_no, parent_lot, origin_txn) VALUES (?,?,?,?,?,?,?)')
        .run(sku, to, m.qty, src.length_mm, m.heat_no, m.lot, ref || 'TRANSFER');
    }
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['stock'], `Transferred ${qty} × ${sku} ${from} → ${to}`, req.user.username);
  res.json({ ok: true });
});
app.post('/api/txn/assemble', requireAuth, can('assemble'), (req, res) => {
  const { sku, qty, wh, ref, mode } = req.body;
  try {
    if (mode === 'disassemble') bom.disassemble(sku, qty, wh, req.user.username, ref);
    else bom.assemble(sku, qty, wh, req.user.username, ref);
  } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['stock'], `${mode === 'disassemble' ? 'Disassembled' : 'Assembled'} ${qty} × ${sku}`, req.user.username);
  res.json({ ok: true });
});
app.post('/api/txn/cut', requireAuth, can('mfg'), (req, res) => {
  try { mfg.cut(req.body, req.user.username); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['stock', 'mfg'], `Cut job posted: ${req.body.sourceSku}`, req.user.username);
  res.json({ ok: true });
});
app.get('/api/scrap/:dia', requireAuth, (req, res) => {
  res.json(mfg.scrapPieces(req.params.dia, req.query.min ? +req.query.min : null));
});

// ---------- sales orders ----------
function soWithLines(o) {
  const lines = db.prepare(`SELECT l.*, i.name, i.unit_weight FROM so_lines l
    JOIN items i ON i.sku = l.sku WHERE so_id=?`).all(o.id);
  const total_weight = lines.reduce((a, l) => a + (l.unit_weight || 0) * l.qty, 0);
  return { ...o, lines, total_weight };
}
app.get('/api/so', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM sales_orders ORDER BY id DESC LIMIT 200').all().map(soWithLines));
});
app.post('/api/so', requireAuth, can('so'), (req, res) => {
  const { customer, ref, required_date, note, lines } = req.body;
  if (!customer || !lines?.length) return res.status(400).json({ error: 'Customer and at least one line are required' });
  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO sales_orders (customer, ref, required_date, note, created_by)
      VALUES (?,?,?,?,?)`).run(customer, ref || null, required_date || null, note || null, req.user.username);
    for (const l of lines) {
      const wh = l.warehouse_id && l.warehouse_id !== 'AUTO' ? l.warehouse_id : bestWarehouse(l.sku);
      db.prepare('INSERT INTO so_lines (so_id, sku, qty, warehouse_id) VALUES (?,?,?,?)')
        .run(r.lastInsertRowid, l.sku, l.qty, wh);
    }
    return r.lastInsertRowid;
  });
  let id;
  try { id = tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['so'], `Sales order #${id} created for ${customer}`, req.user.username);
  res.json({ ok: true, id });
});
// Confirm = spec 3.2 stock check per line; reserves stock ("Reserved for orders").
app.post('/api/so/:id/confirm', requireAuth, can('so'), (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!so || so.status !== 'draft') return res.status(400).json({ error: 'Order is not in draft' });
  const lines = db.prepare("SELECT * FROM so_lines WHERE so_id=? AND mode != 'cancelled'").all(so.id);
  const results = [];
  const tx = db.transaction(() => {
    for (const l of lines) {
      const check = bom.checkLine(l.sku, l.qty, l.warehouse_id);
      if (check.mode === 'stock') {
        ledger.post([{ type: 'RESERVE', sku: l.sku, wh: l.warehouse_id, qty: l.qty,
          d_on_hold: l.qty, ref: `SO-${so.id}` }], req.user.username);
      } else if (check.mode === 'kit') {
        if (check.fromStock > 0)
          ledger.post([{ type: 'RESERVE', sku: l.sku, wh: l.warehouse_id, qty: check.fromStock,
            d_on_hold: check.fromStock, ref: `SO-${so.id}` }], req.user.username);
        const compHolds = check.comps.map(c => ({
          type: 'RESERVE', sku: c.sku, wh: l.warehouse_id, qty: c.qty * check.toBuild,
          d_on_hold: c.qty * check.toBuild, ref: `SO-${so.id}`, meta: { kit_for: l.sku } }));
        ledger.post(compHolds, req.user.username);
      }
      db.prepare('UPDATE so_lines SET mode=?, suggestions=? WHERE id=?')
        .run(check.mode, JSON.stringify(check.suggestions || []), l.id);
      results.push({ line: l.id, sku: l.sku, ...check });
    }
    db.prepare("UPDATE sales_orders SET status='confirmed' WHERE id=?").run(so.id);
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['so', 'stock'], `Sales order #${so.id} confirmed — stock reserved`, req.user.username);
  res.json({ ok: true, results });
});
// Re-check short/pending lines after new stock arrives (order stays confirmed).
app.post('/api/so/:id/recheck', requireAuth, can('so'), (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!so || !['confirmed', 'partial'].includes(so.status))
    return res.status(400).json({ error: 'Only confirmed orders can be re-checked' });
  const lines = db.prepare("SELECT * FROM so_lines WHERE so_id=? AND mode IN ('short','pending')").all(so.id);
  if (!lines.length) return res.json({ ok: true, changed: 0 });
  let changed = 0;
  const tx = db.transaction(() => {
    for (const l of lines) {
      const check = bom.checkLine(l.sku, l.qty, l.warehouse_id);
      if (check.mode === 'stock') {
        ledger.post([{ type: 'RESERVE', sku: l.sku, wh: l.warehouse_id, qty: l.qty,
          d_on_hold: l.qty, ref: `SO-${so.id}` }], req.user.username);
        changed++;
      } else if (check.mode === 'kit') {
        if (check.fromStock > 0)
          ledger.post([{ type: 'RESERVE', sku: l.sku, wh: l.warehouse_id, qty: check.fromStock,
            d_on_hold: check.fromStock, ref: `SO-${so.id}` }], req.user.username);
        ledger.post(check.comps.map(c => ({ type: 'RESERVE', sku: c.sku, wh: l.warehouse_id,
          qty: c.qty * check.toBuild, d_on_hold: c.qty * check.toBuild,
          ref: `SO-${so.id}`, meta: { kit_for: l.sku } })), req.user.username);
        changed++;
      }
      db.prepare('UPDATE so_lines SET mode=?, suggestions=? WHERE id=?')
        .run(check.mode, JSON.stringify(check.suggestions || []), l.id);
    }
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (changed) broadcast(['so', 'stock'], `SO #${so.id}: ${changed} short line(s) now reserved`, req.user.username);
  res.json({ ok: true, changed });
});
// Pick & pack view — spec 3.4, with weights and shipped-so-far.
app.get('/api/so/:id/pick', requireAuth, (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!so) return res.status(404).json({ error: 'Not found' });
  const lines = db.prepare(`SELECT l.*, i.name, i.item_type, i.unit_weight
    FROM so_lines l JOIN items i ON i.sku=l.sku WHERE so_id=?`).all(so.id);
  res.json({
    so,
    total_weight: lines.reduce((a, l) => a + (l.unit_weight || 0) * l.qty, 0),
    lines: lines.map(l => ({
      ...l,
      remaining: l.qty - l.shipped_qty,
      line_weight: (l.unit_weight || 0) * l.qty,
      suggestions: JSON.parse(l.suggestions || '[]'),
      checklist: l.mode === 'kit'
        ? bom.components(l.sku).map(c => ({ ...c, need: c.qty * (l.qty - l.shipped_qty) }))
        : null,
    })),
  });
});
// Ship — full or partial. body.lines: [{line_id, qty}] (omit = ship all remaining).
app.post('/api/so/:id/ship', requireAuth, can('ship'), (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!so || !['confirmed', 'partial'].includes(so.status))
    return res.status(400).json({ error: 'Order must be confirmed first' });
  const all = db.prepare("SELECT * FROM so_lines WHERE so_id=? AND mode IN ('stock','kit')").all(so.id);
  const wanted = req.body?.lines?.length
    ? req.body.lines.map(w => ({ line: all.find(l => l.id === w.line_id), qty: +w.qty }))
        .filter(w => w.line && w.qty > 0)
    : all.map(l => ({ line: l, qty: l.qty - l.shipped_qty })).filter(w => w.qty > 0);
  if (!wanted.length) return res.status(400).json({ error: 'Nothing to ship' });
  const tx = db.transaction(() => {
    for (const { line: l, qty } of wanted) {
      const shipQty = Math.min(qty, l.qty - l.shipped_qty);
      if (shipQty <= 0) continue;
      if (l.mode === 'stock') {
        const heats = consumeLotsFifo(l.sku, l.warehouse_id, shipQty);
        ledger.post([{ type: 'SHIP', sku: l.sku, wh: l.warehouse_id, qty: shipQty,
          d_on_hand: -shipQty, d_on_hold: -shipQty, d_sold: shipQty,
          ref: `SO-${so.id}`, counterparty: so.customer, meta: { heats } }], req.user.username);
      } else {
        // Kit: use reserved finished sets first, then components per BOM.
        const parentHeld = db.prepare(`SELECT COALESCE(SUM(d_on_hold),0) h FROM transactions
          WHERE ref=? AND sku=? AND warehouse_id=?`).get(`SO-${so.id}`, l.sku, l.warehouse_id).h;
        const fromFinished = Math.min(shipQty, Math.max(parentHeld, 0));
        if (fromFinished > 0) {
          const heats = consumeLotsFifo(l.sku, l.warehouse_id, fromFinished);
          ledger.post([{ type: 'SHIP', sku: l.sku, wh: l.warehouse_id, qty: fromFinished,
            d_on_hand: -fromFinished, d_on_hold: -fromFinished, d_sold: fromFinished,
            ref: `SO-${so.id}`, counterparty: so.customer, meta: { heats } }], req.user.username);
        }
        const kitSets = shipQty - fromFinished;
        if (kitSets > 0) {
          for (const c of bom.components(l.sku)) {
            const q = c.qty * kitSets;
            const heats = consumeLotsFifo(c.sku, l.warehouse_id, q);
            ledger.post([{ type: 'SHIP', sku: c.sku, wh: l.warehouse_id, qty: q,
              d_on_hand: -q, d_on_hold: -q, d_sold: q,
              ref: `SO-${so.id}`, counterparty: so.customer,
              meta: { assembled_at_pack_for: l.sku, heats } }], req.user.username);
          }
          ledger.post([{ type: 'KIT_SHIP', sku: l.sku, wh: l.warehouse_id, qty: kitSets,
            d_sold: kitSets, ref: `SO-${so.id}`, counterparty: so.customer }], req.user.username);
        }
      }
      const newShipped = l.shipped_qty + shipQty;
      db.prepare('UPDATE so_lines SET shipped_qty=?, mode=? WHERE id=?')
        .run(newShipped, newShipped >= l.qty ? 'shipped' : l.mode, l.id);
    }
    const open = db.prepare(`SELECT COUNT(*) c FROM so_lines
      WHERE so_id=? AND mode IN ('pending','stock','kit','short') AND shipped_qty < qty`).get(so.id).c;
    const any = db.prepare('SELECT COALESCE(SUM(shipped_qty),0) s FROM so_lines WHERE so_id=?').get(so.id).s;
    db.prepare('UPDATE sales_orders SET status=? WHERE id=?')
      .run(open === 0 ? 'shipped' : (any > 0 ? 'partial' : so.status), so.id);
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['so', 'stock'], `Sales order #${so.id} shipped (full or partial)`, req.user.username);
  res.json({ ok: true });
});
app.post('/api/so/:id/cancel', requireAuth, can('so'), (req, res) => {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(req.params.id);
  if (!so || so.status === 'shipped') return res.status(400).json({ error: 'Cannot cancel' });
  const tx = db.transaction(() => {
    const held = db.prepare(`
      SELECT sku, warehouse_id wh, SUM(d_on_hold) held FROM transactions
      WHERE ref=? GROUP BY sku, warehouse_id HAVING held > 0`).all(`SO-${so.id}`);
    for (const h of held) {
      ledger.post([{ type: 'RELEASE', sku: h.sku, wh: h.wh, qty: h.held,
        d_on_hold: -h.held, ref: `SO-${so.id}` }], req.user.username);
    }
    db.prepare("UPDATE sales_orders SET status='cancelled' WHERE id=?").run(so.id);
    db.prepare("UPDATE so_lines SET mode='cancelled' WHERE so_id=?").run(so.id);
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['so', 'stock'], `Sales order #${so.id} cancelled — reservations released`, req.user.username);
  res.json({ ok: true });
});

// ---------- purchase orders / incoming ----------
function poWithLines(p) {
  const lines = db.prepare(`SELECT l.*, i.name, i.unit_weight FROM po_lines l
    JOIN items i ON i.sku = l.sku WHERE po_id=?`).all(p.id);
  return { ...p, lines,
    total_weight: lines.reduce((a, l) => a + (l.unit_weight || 0) * l.qty, 0),
    total_qty: lines.reduce((a, l) => a + l.qty, 0) };
}
app.get('/api/po', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM purchase_orders ORDER BY id DESC LIMIT 300').all().map(poWithLines));
});
app.get('/api/po/:id', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(poWithLines(p));
});
app.post('/api/po', requireAuth, can('po'), (req, res) => {
  const { supplier, ref, eta, warehouse_id = 'WH-MAIN', status = 'ordered', note, lines } = req.body;
  if (!lines?.length) return res.status(400).json({ error: 'At least one line is required' });
  const tx = db.transaction(() => {
    const r = db.prepare(`INSERT INTO purchase_orders (supplier, ref, eta, status, warehouse_id, note, created_by)
      VALUES (?,?,?,?,?,?,?)`).run(supplier || '', ref || '', eta || null, status, warehouse_id, note || null, req.user.username);
    const id = r.lastInsertRowid;
    for (const l of lines) {
      db.prepare('INSERT INTO po_lines (po_id, sku, qty, in_transit_qty, heat_no) VALUES (?,?,?,?,?)')
        .run(id, l.sku, l.qty, status === 'in_transit' ? l.qty : 0, l.heat_no || null);
      ledger.post([{ type: status === 'in_transit' ? 'SHIPMENT_BOOKED' : 'PO_PLACED',
        sku: l.sku, wh: warehouse_id, qty: l.qty,
        d_on_order: status === 'in_transit' ? 0 : l.qty,
        d_in_transit: status === 'in_transit' ? l.qty : 0,
        ref: ref || `PO-${id}`, counterparty: supplier }], req.user.username);
    }
    return id;
  });
  let id;
  try { id = tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['po', 'stock'], `Incoming ${ref || '#' + id} booked`, req.user.username);
  res.json({ ok: true, id });
});
// Dispatch — full or partial. body.lines: [{line_id, qty}] optional.
app.post('/api/po/:id/dispatch', requireAuth, can('po'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po || !['ordered', 'partial', 'in_transit'].includes(po.status))
    return res.status(400).json({ error: 'PO is not dispatchable' });
  const all = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id);
  const wanted = req.body?.lines?.length
    ? req.body.lines.map(w => ({ line: all.find(l => l.id === w.line_id), qty: +w.qty })).filter(w => w.line && w.qty > 0)
    : all.map(l => ({ line: l, qty: l.qty - l.received_qty - l.in_transit_qty })).filter(w => w.qty > 0);
  if (!wanted.length) return res.status(400).json({ error: 'Nothing left to mark in transit' });
  const tx = db.transaction(() => {
    for (const { line: l, qty } of wanted) {
      const q = Math.min(qty, l.qty - l.received_qty - l.in_transit_qty);
      if (q <= 0) continue;
      ledger.post([{ type: 'PO_DISPATCHED', sku: l.sku, wh: po.warehouse_id, qty: q,
        d_on_order: -q, d_in_transit: q, ref: po.ref || `PO-${po.id}` }], req.user.username);
      db.prepare('UPDATE po_lines SET in_transit_qty = in_transit_qty + ? WHERE id=?').run(q, l.id);
    }
    updatePoStatus(po.id);
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['po', 'stock'], `${po.ref || 'PO #' + po.id}: goods marked in transit`, req.user.username);
  res.json({ ok: true });
});
// Receive — full or partial. body.lines: [{line_id, qty, heat_no}] optional.
app.post('/api/po/:id/receive', requireAuth, can('receive'), (req, res) => {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(req.params.id);
  if (!po || !['ordered', 'in_transit', 'partial'].includes(po.status))
    return res.status(400).json({ error: 'PO is not receivable' });
  const all = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(po.id);
  const wanted = req.body?.lines?.length
    ? req.body.lines.map(w => ({ line: all.find(l => l.id === w.line_id), qty: +w.qty, heat: w.heat_no }))
        .filter(w => w.line && w.qty > 0)
    : all.map(l => ({ line: l, qty: l.qty - l.received_qty, heat: null })).filter(w => w.qty > 0);
  if (!wanted.length) return res.status(400).json({ error: 'Nothing left to receive' });
  const tx = db.transaction(() => {
    for (const { line: l, qty, heat } of wanted) {
      const q = Math.min(qty, l.qty - l.received_qty);
      if (q <= 0) continue;
      const fromTransit = Math.min(q, l.in_transit_qty);
      const fromOrder = q - fromTransit;
      const group = ledger.post([{ type: 'RECEIVE', sku: l.sku, wh: po.warehouse_id, qty: q,
        d_on_hand: q, d_in_transit: -fromTransit, d_on_order: -fromOrder,
        ref: po.ref || `PO-${po.id}`, counterparty: po.supplier,
        meta: { heat_no: heat || l.heat_no || null } }], req.user.username);
      db.prepare('UPDATE po_lines SET received_qty = received_qty + ?, in_transit_qty = in_transit_qty - ? WHERE id=?')
        .run(q, fromTransit, l.id);
      const hn = heat || l.heat_no;
      if (hn) {
        db.prepare('INSERT INTO lots (sku, warehouse_id, qty, heat_no, origin_txn) VALUES (?,?,?,?,?)')
          .run(l.sku, po.warehouse_id, q, hn, po.ref || `PO-${po.id}`);
      }
    }
    updatePoStatus(po.id);
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  broadcast(['po', 'stock'], `${po.ref || 'PO #' + po.id}: goods received`, req.user.username);
  res.json({ ok: true });
});
function updatePoStatus(poId) {
  const t = db.prepare(`SELECT SUM(qty) q, SUM(received_qty) r, SUM(in_transit_qty) it
    FROM po_lines WHERE po_id=?`).get(poId);
  let status = 'ordered';
  if (t.r >= t.q) status = 'received';
  else if (t.r > 0) status = 'partial';
  else if (t.it >= t.q) status = 'in_transit';
  else if (t.it > 0) status = 'partial';
  db.prepare('UPDATE purchase_orders SET status=? WHERE id=?').run(status, poId);
}

// ---------- file imports & templates ----------
app.get('/api/template/:kind', requireAuth, (req, res) => {
  const t = imports.template(req.params.kind, req.query.fmt === 'xlsx' ? 'xlsx' : 'csv');
  if (!t) return res.status(404).json({ error: 'Unknown template' });
  res.setHeader('Content-Type', t.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${t.filename}"`);
  res.send(t.buf);
});
// kind: items | stock | so | po. File as base64.
app.post('/api/import/file', requireAuth, can('import'), async (req, res) => {
  const { kind, filename, data_b64, options = {} } = req.body || {};
  if (!filename || !data_b64) return res.status(400).json({ error: 'No file received' });
  let parsed;
  try { parsed = await imports.parseFile(filename, data_b64); }
  catch (e) { return res.status(400).json({ error: 'Could not read file: ' + e.message }); }
  const { rows, note } = parsed;
  if (!rows.length) return res.status(400).json({ error: note || 'No data rows found in the file.' });
  const issues = [];
  const user = req.user.username;
  try {
    if (kind === 'items') {
      let created = 0, updated = 0, stocked = 0;
      const tx = db.transaction(() => {
        for (const r of rows) {
          if (!r.sku) { issues.push(`Row skipped (no SKU): ${r.name || ''}`); continue; }
          const exists = itemBySku.get(r.sku);
          db.prepare(`INSERT INTO items (sku, name, item_type, category, size, uom, unit_weight, min_stock)
            VALUES (@sku,@name,@item_type,@category,@size,@uom,@unit_weight,@min_stock)
            ON CONFLICT(sku) DO UPDATE SET
              name=COALESCE(NULLIF(@name,''), name),
              unit_weight=CASE WHEN @unit_weight>0 THEN @unit_weight ELSE unit_weight END,
              size=COALESCE(NULLIF(@size,''), size)`)
            .run({ sku: r.sku, name: r.name || r.sku,
              item_type: ['part', 'assembly', 'raw'].includes((r.item_type || '').toLowerCase()) ? r.item_type.toLowerCase() : 'part',
              category: r.category || '', size: r.size || '', uom: r.uom || 'pcs',
              unit_weight: r.weight || 0, min_stock: parseFloat(r.min_stock) || 0 });
          exists ? updated++ : created++;
          if (r.qty > 0) {
            const wh = r.warehouse || 'WH-MAIN';
            const g = ledger.post([{ type: 'STOCK_IN', sku: r.sku, wh, qty: r.qty,
              d_on_hand: r.qty, ref: options.ref || `IMPORT-${filename}`, meta: { heat_no: r.heat || null } }], user);
            if (r.heat) db.prepare('INSERT INTO lots (sku, warehouse_id, qty, heat_no, origin_txn) VALUES (?,?,?,?,?)')
              .run(r.sku, wh, r.qty, r.heat, g);
            stocked++;
          }
        }
      });
      tx();
      broadcast(['items', 'stock'], `Item import: ${created} new, ${updated} updated`, user);
      return res.json({ ok: true, created, updated, stocked, issues, note });
    }
    if (kind === 'stock') {
      let count = 0;
      const tx = db.transaction(() => {
        for (const r of rows) {
          if (!r.sku || !(r.qty > 0)) { issues.push(`Row skipped: ${r.sku || '(no sku)'}`); continue; }
          if (!itemBySku.get(r.sku)) {
            if (options.autocreate) db.prepare("INSERT INTO items (sku,name,item_type) VALUES (?,?, 'part')").run(r.sku, r.name || r.sku);
            else { issues.push(`Unknown SKU (not created): ${r.sku}`); continue; }
          }
          const wh = r.warehouse || 'WH-MAIN';
          const g = ledger.post([{ type: 'STOCK_IN', sku: r.sku, wh, qty: r.qty,
            d_on_hand: r.qty, ref: options.ref || `IMPORT-${filename}`, meta: { heat_no: r.heat || null } }], user);
          if (r.heat) db.prepare('INSERT INTO lots (sku, warehouse_id, qty, heat_no, origin_txn) VALUES (?,?,?,?,?)')
            .run(r.sku, wh, r.qty, r.heat, g);
          count++;
        }
      });
      tx();
      broadcast(['stock'], `Stock import: ${count} lines added`, user);
      return res.json({ ok: true, count, issues, note });
    }
    if (kind === 'so') {
      const valid = [];
      for (const r of rows) {
        if (!r.sku || !(r.qty > 0)) { issues.push(`Row skipped: ${r.sku || '(no sku)'}`); continue; }
        if (!itemBySku.get(r.sku)) {
          if (options.autocreate) db.prepare("INSERT INTO items (sku,name,item_type) VALUES (?,?, 'part')").run(r.sku, r.name || r.sku);
          else { issues.push(`Unknown SKU: ${r.sku}`); continue; }
        }
        valid.push(r);
      }
      if (!valid.length) return res.status(400).json({ error: 'No usable lines. ' + issues.slice(0, 5).join(' | '), issues });
      const customer = options.customer || valid[0].customer || 'Imported customer';
      const ref = options.ref || valid[0].ref || filename;
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO sales_orders (customer, ref, required_date, note, created_by)
          VALUES (?,?,?,?,?)`).run(customer, ref, options.required_date || valid[0].eta || null,
            `Imported from ${filename}`, user);
        for (const v of valid) {
          db.prepare('INSERT INTO so_lines (so_id, sku, qty, warehouse_id) VALUES (?,?,?,?)')
            .run(r.lastInsertRowid, v.sku, v.qty, v.warehouse || bestWarehouse(v.sku));
        }
        return r.lastInsertRowid;
      });
      const id = tx();
      broadcast(['so'], `Sales order #${id} imported from ${filename}`, user);
      return res.json({ ok: true, id, lines: valid.length, issues, note,
        hint: 'Draft created — open it and press Confirm to reserve the stock.' });
    }
    if (kind === 'po') {
      const valid = [];
      for (const r of rows) {
        if (!r.sku || !(r.qty > 0)) { issues.push(`Row skipped: ${r.sku || '(no sku)'}`); continue; }
        if (!itemBySku.get(r.sku)) {
          if (options.autocreate) db.prepare("INSERT INTO items (sku,name,item_type) VALUES (?,?, 'part')").run(r.sku, r.name || r.sku);
          else { issues.push(`Unknown SKU: ${r.sku}`); continue; }
        }
        valid.push(r);
      }
      if (!valid.length) return res.status(400).json({ error: 'No usable lines. ' + issues.slice(0, 5).join(' | '), issues });
      const status = options.status === 'in_transit' ? 'in_transit' : 'ordered';
      const tx = db.transaction(() => {
        const r = db.prepare(`INSERT INTO purchase_orders (supplier, ref, eta, status, warehouse_id, note, created_by)
          VALUES (?,?,?,?,?,?,?)`)
          .run(options.supplier || valid[0].supplier || '', options.ref || valid[0].ref || filename,
            options.eta || valid[0].eta || null, status, options.warehouse_id || 'WH-MAIN',
            `Imported from ${filename}`, user);
        const id = r.lastInsertRowid;
        for (const v of valid) {
          db.prepare('INSERT INTO po_lines (po_id, sku, qty, in_transit_qty, heat_no) VALUES (?,?,?,?,?)')
            .run(id, v.sku, v.qty, status === 'in_transit' ? v.qty : 0, v.heat || null);
          ledger.post([{ type: status === 'in_transit' ? 'SHIPMENT_BOOKED' : 'PO_PLACED',
            sku: v.sku, wh: options.warehouse_id || 'WH-MAIN', qty: v.qty,
            d_on_order: status === 'in_transit' ? 0 : v.qty,
            d_in_transit: status === 'in_transit' ? v.qty : 0,
            ref: options.ref || valid[0].ref || filename, counterparty: options.supplier || '' }], user);
        }
        return id;
      });
      const id = tx();
      broadcast(['po', 'stock'], `Purchase order #${id} imported from ${filename}`, user);
      return res.json({ ok: true, id, lines: valid.length, issues, note });
    }
    return res.status(400).json({ error: 'Unknown import kind' });
  } catch (e) { return res.status(400).json({ error: e.message, issues }); }
});

// ---------- data-quality flags ----------
function dataFlags() {
  const flags = [];
  for (const r of db.prepare(`
    SELECT i.sku, i.name FROM items i
    WHERE i.active=1 AND i.item_type='assembly'
      AND NOT EXISTS (SELECT 1 FROM bom b WHERE b.parent_sku=i.sku) LIMIT 100`).all())
    flags.push({ kind: 'assembly-no-bom', sku: r.sku,
      text: `${r.sku} is tagged as an assembly but has no BOM — add its components or fix the type.` });
  for (const r of db.prepare(`
    SELECT i.sku, i.name FROM items i
    WHERE i.active=1 AND i.item_type != 'assembly'
      AND (i.sku LIKE 'AA%' OR upper(i.name) LIKE '%BNW%' OR upper(i.name) LIKE '% SET%')
      AND NOT EXISTS (SELECT 1 FROM bom b WHERE b.parent_sku=i.sku) LIMIT 100`).all())
    flags.push({ kind: 'looks-like-assembly', sku: r.sku,
      text: `${r.sku} ("${r.name}") looks like an assembly (name/SKU pattern) but isn't tagged as one and has no BOM.` });
  for (const r of db.prepare(`
    SELECT DISTINCT b.component_sku FROM bom b
    LEFT JOIN items i ON i.sku = b.component_sku WHERE i.sku IS NULL LIMIT 50`).all())
    flags.push({ kind: 'bom-missing-component', sku: r.component_sku,
      text: `BOM references component ${r.component_sku} which doesn't exist in the item master.` });
  const noW = db.prepare(`SELECT COUNT(*) c FROM items WHERE active=1 AND (unit_weight IS NULL OR unit_weight=0)`).get().c;
  if (noW > 0) flags.push({ kind: 'missing-weight', sku: null,
    text: `${noW} active items have no unit weight — shipment weight totals will undercount until filled in.` });
  return flags;
}
app.get('/api/reports/flags', requireAuth, (req, res) => res.json(dataFlags()));

// ---------- heat number traceability ----------
app.get('/api/heat/:hn', requireAuth, (req, res) => {
  const hn = req.params.hn;
  const purchases = db.prepare(`
    SELECT p.ref, p.supplier, p.eta, p.status, p.warehouse_id, l.sku, l.qty, l.received_qty
    FROM po_lines l JOIN purchase_orders p ON p.id=l.po_id WHERE l.heat_no=?`).all(hn);
  const lots = db.prepare(`SELECT * FROM lots WHERE heat_no=? ORDER BY created_ts`).all(hn);
  const txns = db.prepare(`
    SELECT * FROM transactions
    WHERE json_extract(meta,'$.heat_no')=@hn
       OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(meta,'$.heats'),'[]'))
                  WHERE json_extract(value,'$.heat_no')=@hn)
    ORDER BY id`).all({ hn });
  res.json({ heat_no: hn, purchases, lots, txns });
});

// ---------- reports ----------
app.get('/api/reports/low-stock', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT i.sku, i.name, i.min_stock, COALESCE(SUM(s.on_hand),0) on_hand,
      COALESCE(SUM(s.in_transit),0) in_transit, COALESCE(SUM(s.on_order),0) on_order
    FROM items i LEFT JOIN stock_levels s ON s.sku=i.sku
    WHERE i.active=1 AND i.min_stock > 0
    GROUP BY i.sku HAVING on_hand < i.min_stock ORDER BY on_hand * 1.0 / i.min_stock`).all());
});
app.get('/api/reports/assembly-availability', requireAuth, (req, res) => {
  const wh = req.query.wh || 'WH-MAIN';
  const assemblies = db.prepare(`
    SELECT i.sku, i.name FROM items i WHERE i.item_type='assembly' AND i.active=1
      AND EXISTS (SELECT 1 FROM bom b WHERE b.parent_sku=i.sku)`).all();
  const out = [];
  for (const a of assemblies) {
    const finished = ledger.availableToSell(a.sku, wh);
    const b = bom.buildable(a.sku, wh);
    if (finished > 0 || b.buildable > 0)
      out.push({ ...a, finished, buildable: b.buildable, total: finished + b.buildable });
  }
  out.sort((x, y) => y.total - x.total);
  res.json(out.slice(0, 300));
});
app.get('/api/reports/exposure/:sku', requireAuth, (req, res) => {
  res.json(bom.exposure(req.params.sku));
});
app.get('/api/reports/mfg-yield', requireAuth, (req, res) => res.json(mfg.yieldReport()));
app.get('/api/reports/audit/:sku', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM transactions WHERE sku=? ORDER BY id DESC LIMIT 500').all(req.params.sku));
});
app.get('/api/reports/activity', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM transactions ORDER BY id DESC LIMIT 60').all());
});
app.post('/api/admin/rebuild', requireAuth, can('*'), (req, res) => {
  ledger.rebuild();
  broadcast(['stock'], 'Stock levels rebuilt from ledger', req.user.username);
  res.json({ ok: true });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check logs.' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Inventory Control running on http://localhost:${PORT}`));
