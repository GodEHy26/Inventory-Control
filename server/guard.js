// v2 Import Guard: stage → review → commit → (undo).
//
// v1 wrote every parsed line straight into the ledger in one go. The ledger
// itself was strict — stock could never go negative — but it trusted
// whatever number the parser handed it. A misread quantity that was still
// positive went in silently, and the only way out was a manual adjustment
// someone had to notice was needed.
//
// v2 puts a review step between "the file says" and "the ledger records":
//   stage   parse + validate; store every line with its issues. No ledger writes.
//   decide  a person accepts warnings, edits or rejects lines, or overrides a
//           block with a written reason. Every decision is recorded.
//   commit  only resolved lines are posted, in one atomic transaction, each
//           ledger row tagged with the batch and line it came from.
//   undo    a committed batch can be reversed with compensating entries
//           (the ledger stays append-only; nothing is deleted).
// Clean files (every line OK) commit straight away, so the common case is
// no slower than v1.

const db = require('./db');
const ledger = require('./ledger');
const imports = require('./imports');
const { validateDoc } = require('./validate');

const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ---------- the validation context, backed by the live database ----------
function dbContext() {
  const itemStmt = db.prepare('SELECT sku, name, uom, unit_weight, category, item_type FROM items WHERE sku=?');
  const cache = new Map();
  let skuList = null;
  const histStmt = db.prepare(`SELECT qty FROM transactions
    WHERE sku=? AND type IN ('PO_PLACED','SHIPMENT_BOOKED','STOCK_IN','OPENING_BALANCE','SHIP')
      AND COALESCE(ref,'') != ? ORDER BY id DESC LIMIT 200`);
  const groupStmt = db.prepare(`SELECT t.qty FROM transactions t JOIN items i ON i.sku=t.sku
    WHERE i.category=? AND t.type IN ('PO_PLACED','SHIPMENT_BOOKED','STOCK_IN','OPENING_BALANCE','SHIP')
      AND COALESCE(t.ref,'') != ? ORDER BY t.id DESC LIMIT 2000`);
  const groupCache = new Map();
  return {
    item(sku) {
      if (!cache.has(sku)) cache.set(sku, itemStmt.get(sku) || null);
      return cache.get(sku);
    },
    skus() { return skuList || (skuList = db.prepare('SELECT sku FROM items WHERE active=1').all().map(r => r.sku)); },
    history(sku, ref) { return histStmt.all(sku, ref || '').map(r => r.qty); },
    groupHistory(cat, ref) {
      const k = cat + '|' + (ref || '');
      if (!groupCache.has(k)) groupCache.set(k, groupStmt.all(cat, ref || '').map(r => r.qty));
      return groupCache.get(k);
    },
    fileSeen(hash) {
      const b = db.prepare(`SELECT id, created_ts ts, json_extract(options,'$.ref') ref FROM import_batches
        WHERE file_hash=? AND status='committed' ORDER BY id DESC LIMIT 1`).get(hash);
      return b || null;
    },
    refExists(kind, ref) {
      if (!ref) return null;
      const t = kind === 'po' ? 'purchase_orders' : kind === 'so' ? 'sales_orders' : null;
      if (!t) return null;
      return db.prepare(`SELECT id, status FROM ${t} WHERE ref=? AND status != 'cancelled' LIMIT 1`).get(ref) || null;
    },
    similarDocs(kind, sig, ref) {
      if (!sig.length) return [];
      const mine = new Set(sig);
      const [head, line, open] = kind === 'po'
        ? ['purchase_orders', 'po_lines', "('ordered','in_transit','partial')"]
        : ['sales_orders', 'so_lines', "('draft','confirmed','partial')"];
      const fk = kind === 'po' ? 'po_id' : 'so_id';
      const docs = db.prepare(`SELECT id, ref FROM ${head} WHERE status IN ${open} ORDER BY id DESC LIMIT 300`).all();
      const out = [];
      const lines = db.prepare(`SELECT sku, qty FROM ${line} WHERE ${fk}=?`);
      for (const d of docs) {
        if (ref && d.ref === ref) continue; // exact ref is reported by refExists
        const theirs = new Set(lines.all(d.id).map(l => `${l.sku}|${l.qty}`));
        if (!theirs.size) continue;
        let inter = 0;
        for (const s of mine) if (theirs.has(s)) inter++;
        const sim = inter / (mine.size + theirs.size - inter);
        if (sim >= 0.8) out.push({ id: d.id, ref: d.ref, similarity: sim });
      }
      return out;
    },
    available(sku) { return ledger.availableAllWh(sku); },
  };
}

// ---------- staging ----------
function docFor(kind, rows, parsedDoc, options) {
  const first = rows[0] || {};
  return {
    ...parsedDoc, kind,
    ref: options.ref || first.ref || null,
    party: kind === 'po' ? (options.supplier || first.supplier || '') : (options.customer || first.customer || ''),
  };
}

async function stage({ kind, filename, data_b64, options = {}, user }) {
  if (!['items', 'stock', 'so', 'po'].includes(kind)) throw new Error('Unknown import kind');
  const ctx = dbContext();
  const known = new Set(ctx.skus());
  const parsed = await imports.parseFile(filename, data_b64, { kind, known, itemOf: s => ctx.item(s) });
  const doc = docFor(kind, parsed.rows, parsed.doc, options);
  const v = validateDoc({ kind, rows: parsed.rows, doc, ctx, opts: { autocreate: !!options.autocreate } });
  const tx = db.transaction(() => {
    const b = db.prepare(`INSERT INTO import_batches (kind, filename, file_hash, options, doc, batch_issues, note, created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(kind, filename, doc.file_hash, JSON.stringify(options),
        JSON.stringify(doc), JSON.stringify(v.batchIssues), parsed.note || null, user);
    const id = b.lastInsertRowid;
    const ins = db.prepare(`INSERT INTO import_lines (batch_id, line_no, raw, row, sku, qty, orig_sku, orig_qty, status, issues, verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    v.lines.forEach((l, i) => ins.run(id, l.row.line_no || i + 1, JSON.stringify(l.row), JSON.stringify(l.row),
      l.sku, l.qty, l.sku, l.qty, l.status, JSON.stringify(l.issues), JSON.stringify(l.verified)));
    return id;
  });
  return tx();
}

function getBatch(id) {
  const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(id);
  if (!b) throw httpErr(404, 'Import batch not found');
  return b;
}
function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

function lineResolved(l) {
  if (l.decision === 'rejected' || l.decision === 'overridden') return true;
  if (l.status === 'ok') return true;
  if (l.status === 'warn') return l.decision === 'accepted';
  return false;
}

function view(id) {
  const b = getBatch(id);
  const lines = db.prepare('SELECT * FROM import_lines WHERE batch_id=? ORDER BY line_no, id').all(id).map(l => ({
    ...l, raw: J(l.raw, {}), row: J(l.row, {}), issues: J(l.issues, []), verified: J(l.verified, []),
    resolved: lineResolved(l),
  }));
  const batchIssues = J(b.batch_issues, []);
  const batchBlock = batchIssues.some(i => i.severity === 'block');
  const batchWarn = batchIssues.some(i => i.severity === 'warn');
  const counts = { ok: 0, warn: 0, block: 0, rejected: 0, unresolved: 0, total: lines.length };
  for (const l of lines) {
    if (l.decision === 'rejected') counts.rejected++; else counts[l.status]++;
    if (!l.resolved) counts.unresolved++;
  }
  const blockers = [];
  if (b.status !== 'staged') blockers.push(`Batch is ${b.status}.`);
  if (batchBlock && !b.override_note) blockers.push('Document-level problem must be resolved or overridden with a reason.');
  if (counts.unresolved) blockers.push(`${counts.unresolved} line(s) still need a decision.`);
  if (lines.length && counts.rejected === lines.length) blockers.push('Every line is rejected — discard the batch instead.');
  return {
    batch: { ...b, options: J(b.options, {}), doc: J(b.doc, {}), batch_issues: batchIssues, result: J(b.result, {}) },
    lines, counts, blockers, ready: blockers.length === 0,
    needsAck: batchWarn,
    clean: !batchBlock && !batchWarn && lines.every(l => l.status === 'ok'),
  };
}

// Re-run validation over the batch's current rows (after an edit) and update
// every line's issues, keeping decisions that are still valid.
function revalidate(id) {
  const b = getBatch(id);
  const opts = J(b.options, {}), doc = J(b.doc, {});
  const lines = db.prepare('SELECT * FROM import_lines WHERE batch_id=? ORDER BY line_no, id').all(id);
  const rows = lines.map(l => J(l.row, {}));
  const v = validateDoc({ kind: b.kind, rows, doc: { ...doc, file_hash: null, ref: null }, ctx: dbContext(),
    opts: { autocreate: !!opts.autocreate } });
  const up = db.prepare('UPDATE import_lines SET sku=?, qty=?, status=?, issues=?, verified=?, decision=? WHERE id=?');
  v.lines.forEach((r, i) => {
    const l = lines[i];
    let decision = l.decision;
    if (decision === 'accepted' && r.status === 'block') decision = 'pending';
    if (decision === 'edited' && r.status !== 'ok') decision = 'pending';
    up.run(r.sku, r.qty, r.status, JSON.stringify(r.issues), JSON.stringify(r.verified), decision, l.id);
  });
}

const OVERRIDE_ROLES = new Set(['admin', 'purchasing']);

function decide(batchId, lineId, { action, sku, qty, note }, user, role) {
  const b = getBatch(batchId);
  if (b.status !== 'staged') throw httpErr(400, `Batch is ${b.status}; it can no longer be changed.`);
  const l = db.prepare('SELECT * FROM import_lines WHERE id=? AND batch_id=?').get(lineId, batchId);
  if (!l) throw httpErr(404, 'Line not found');
  const stamp = db.prepare(`UPDATE import_lines SET decision=?, note=?, decided_by=?, decided_ts=datetime('now') WHERE id=?`);
  if (action === 'edit') {
    const row = J(l.row, {});
    if (sku != null && String(sku).trim()) row.sku_raw = String(sku).trim();
    if (qty != null && String(qty).trim() !== '') {
      const n = Number(qty);
      if (!Number.isFinite(n)) throw httpErr(400, 'Quantity must be a number');
      // A person typed this number into a number box: it is unambiguous and
      // already in the item's own unit.
      row.qty_raw = String(n); row.unit_raw = ''; row.method = 'human'; row.confidence = 'high';
    }
    db.prepare('UPDATE import_lines SET row=? WHERE id=?').run(JSON.stringify(row), l.id);
    revalidate(batchId);
    const now = db.prepare('SELECT status FROM import_lines WHERE id=?').get(l.id);
    stamp.run(now.status === 'ok' ? 'edited' : 'pending', note || null, user, l.id);
  } else if (action === 'accept') {
    if (l.status === 'block') throw httpErr(400, 'This line is blocked: edit it, reject it, or override it with a reason.');
    stamp.run('accepted', note || null, user, l.id);
  } else if (action === 'reject') {
    stamp.run('rejected', note || null, user, l.id);
  } else if (action === 'override') {
    if (!OVERRIDE_ROLES.has(role)) throw httpErr(403, 'Only admin or purchasing can override a blocked line.');
    if (!note || note.trim().length < 5) throw httpErr(400, 'Write a reason (at least a few words) to override a block.');
    stamp.run('overridden', note.trim(), user, l.id);
  } else if (action === 'reset') {
    stamp.run('pending', null, user, l.id);
  } else throw httpErr(400, 'Unknown action');
  return view(batchId);
}

function overrideBatch(batchId, note, user, role) {
  const b = getBatch(batchId);
  if (b.status !== 'staged') throw httpErr(400, `Batch is ${b.status}.`);
  if (!OVERRIDE_ROLES.has(role)) throw httpErr(403, 'Only admin or purchasing can override a document-level block.');
  if (!note || note.trim().length < 5) throw httpErr(400, 'Write a reason to override.');
  db.prepare('UPDATE import_batches SET override_note=?, override_by=? WHERE id=?').run(note.trim(), user, batchId);
  return view(batchId);
}

function discard(batchId, user) {
  const b = getBatch(batchId);
  if (b.status !== 'staged') throw httpErr(400, `Batch is ${b.status}.`);
  db.prepare("UPDATE import_batches SET status='discarded', undone_by=?, undone_ts=datetime('now') WHERE id=?").run(user, batchId);
  return view(batchId);
}

// ---------- commit ----------
function commit(batchId, user, { acknowledge = false } = {}) {
  const v = view(batchId);
  if (!v.ready) throw httpErr(400, 'Not ready to commit: ' + v.blockers.join(' '));
  if (v.needsAck && !acknowledge) throw httpErr(409, 'This document has warnings at the document level (see the top of the review). Tick "I have checked these" to commit.');
  const b = v.batch, o = b.options;
  const take = v.lines.filter(l => l.decision !== 'rejected');
  const meta = l => ({ import_batch: b.id, import_line: l.id, decision: l.decision,
    ...(l.orig_qty !== l.qty ? { file_qty: l.orig_qty } : {}), ...(l.orig_sku !== l.sku ? { file_sku: l.orig_sku } : {}),
    ...(l.row.heat ? { heat_no: l.row.heat } : {}) });
  const itemBySku = db.prepare('SELECT * FROM items WHERE sku=?');
  const ensureItem = (l) => {
    if (itemBySku.get(l.sku)) return;
    db.prepare("INSERT INTO items (sku, name, item_type) VALUES (?,?, 'part')").run(l.sku, l.row.name || l.sku);
  };
  const bestWh = (sku) => {
    const r = db.prepare('SELECT warehouse_id, on_hand - on_hold ats FROM stock_levels WHERE sku=? ORDER BY ats DESC LIMIT 1').get(sku);
    return r && r.ats > 0 ? r.warehouse_id : 'WH-MAIN';
  };
  const ref = o.ref || b.doc.ref || `IMPORT-${b.id}`;
  const result = {};

  const tx = db.transaction(() => {
    if (b.kind === 'po' || b.kind === 'so') {
      const pool = take.filter(l => l.qty > 0);
      if (!pool.length) throw httpErr(400, 'No lines with a quantity to commit.');
      for (const l of pool) ensureItem(l);
      if (b.kind === 'po') {
        const status = o.status === 'in_transit' ? 'in_transit' : 'ordered';
        const wh = o.warehouse_id || 'WH-MAIN';
        const r = db.prepare(`INSERT INTO purchase_orders (supplier, ref, eta, status, warehouse_id, note, created_by)
          VALUES (?,?,?,?,?,?,?)`).run(o.supplier || pool[0].row.supplier || '', ref, o.eta || pool[0].row.eta || null,
            status, wh, `Imported from ${b.filename} (batch #${b.id})`, user);
        result.po_id = r.lastInsertRowid;
        for (const l of pool) {
          db.prepare('INSERT INTO po_lines (po_id, sku, qty, in_transit_qty, heat_no) VALUES (?,?,?,?,?)')
            .run(result.po_id, l.sku, l.qty, status === 'in_transit' ? l.qty : 0, l.row.heat || null);
          ledger.post([{ type: status === 'in_transit' ? 'SHIPMENT_BOOKED' : 'PO_PLACED', sku: l.sku, wh, qty: l.qty,
            d_on_order: status === 'in_transit' ? 0 : l.qty, d_in_transit: status === 'in_transit' ? l.qty : 0,
            ref, counterparty: o.supplier || '', meta: meta(l) }], user);
        }
      } else {
        const r = db.prepare(`INSERT INTO sales_orders (customer, ref, required_date, note, created_by) VALUES (?,?,?,?,?)`)
          .run(o.customer || pool[0].row.customer || 'Imported customer', ref, o.required_date || pool[0].row.eta || null,
            `Imported from ${b.filename} (batch #${b.id})`, user);
        result.so_id = r.lastInsertRowid;
        for (const l of pool) db.prepare('INSERT INTO so_lines (so_id, sku, qty, warehouse_id) VALUES (?,?,?,?)')
          .run(result.so_id, l.sku, l.qty, l.row.warehouse || bestWh(l.sku));
      }
    } else {
      result.stock = [];
      result.items = { created: 0, updated: 0 };
      for (const l of take) {
        if (b.kind === 'items') {
          const exists = itemBySku.get(l.sku);
          const r = l.row;
          const uw = parseFloat(r.unit_weight_raw) || 0;
          db.prepare(`INSERT INTO items (sku, name, item_type, category, size, uom, unit_weight, min_stock)
            VALUES (@sku,@name,@item_type,@category,@size,@uom,@unit_weight,@min_stock)
            ON CONFLICT(sku) DO UPDATE SET name=COALESCE(NULLIF(@name,''), name),
              unit_weight=CASE WHEN @unit_weight>0 THEN @unit_weight ELSE unit_weight END,
              size=COALESCE(NULLIF(@size,''), size)`)
            .run({ sku: l.sku, name: r.name || l.sku,
              item_type: ['part', 'assembly', 'raw'].includes((r.item_type || '').toLowerCase()) ? r.item_type.toLowerCase() : 'part',
              category: r.category || '', size: r.size || '', uom: r.unit_raw || 'pcs', unit_weight: uw,
              min_stock: parseFloat(r.min_stock) || 0 });
          exists ? result.items.updated++ : result.items.created++;
        } else ensureItem(l);
        if (l.qty > 0) {
          const wh = l.row.warehouse || o.warehouse_id || 'WH-MAIN';
          const g = ledger.post([{ type: 'STOCK_IN', sku: l.sku, wh, qty: l.qty, d_on_hand: l.qty, ref, meta: meta(l) }], user);
          if (l.row.heat) db.prepare('INSERT INTO lots (sku, warehouse_id, qty, heat_no, origin_txn) VALUES (?,?,?,?,?)')
            .run(l.sku, wh, l.qty, l.row.heat, g);
          result.stock.push({ line: l.id, sku: l.sku, wh, qty: l.qty, group: g });
        }
      }
    }
    db.prepare(`UPDATE import_batches SET status='committed', committed_by=?, committed_ts=datetime('now'), result=? WHERE id=?`)
      .run(user, JSON.stringify(result), b.id);
  });
  tx();
  return view(batchId);
}

// ---------- undo / cancel ----------
function cancelPo(poId, user, reason) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(poId);
  if (!po) throw httpErr(404, 'PO not found');
  if (po.status === 'cancelled') throw httpErr(400, 'PO is already cancelled');
  const lines = db.prepare('SELECT * FROM po_lines WHERE po_id=?').all(poId);
  if (lines.some(l => l.received_qty > 0))
    throw httpErr(400, 'Goods have already been received against this PO — reverse the receipt with a stock adjustment instead.');
  const entries = [];
  for (const l of lines) {
    const onOrder = l.qty - l.received_qty - l.in_transit_qty;
    if (onOrder > 0 || l.in_transit_qty > 0)
      entries.push({ type: 'PO_CANCELLED', sku: l.sku, wh: po.warehouse_id, qty: onOrder + l.in_transit_qty,
        d_on_order: -onOrder, d_in_transit: -l.in_transit_qty, ref: po.ref || `PO-${po.id}`,
        meta: { reason: reason || null } });
  }
  const tx = db.transaction(() => {
    if (entries.length) ledger.post(entries, user);
    db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=?").run(poId);
    db.prepare('UPDATE po_lines SET in_transit_qty=0 WHERE po_id=?').run(poId);
  });
  tx();
}

function cancelSo(soId, user) {
  const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(soId);
  if (!so) throw httpErr(404, 'Sales order not found');
  if (so.status === 'shipped' || so.status === 'cancelled') throw httpErr(400, `Order is ${so.status}`);
  const shipped = db.prepare('SELECT COALESCE(SUM(shipped_qty),0) s FROM so_lines WHERE so_id=?').get(soId).s;
  const tx = db.transaction(() => {
    const held = db.prepare(`SELECT sku, warehouse_id wh, SUM(d_on_hold) held FROM transactions
      WHERE ref=? GROUP BY sku, warehouse_id HAVING held > 0`).all(`SO-${so.id}`);
    for (const h of held) ledger.post([{ type: 'RELEASE', sku: h.sku, wh: h.wh, qty: h.held, d_on_hold: -h.held, ref: `SO-${so.id}` }], user);
    db.prepare("UPDATE sales_orders SET status='cancelled' WHERE id=?").run(so.id);
    db.prepare("UPDATE so_lines SET mode='cancelled' WHERE so_id=? AND mode != 'shipped'").run(so.id);
  });
  if (shipped > 0) throw httpErr(400, 'Part of this order has shipped; it cannot be cancelled as a whole.');
  tx();
}

function undo(batchId, user) {
  const b = getBatch(batchId);
  if (b.status !== 'committed') throw httpErr(400, 'Only a committed batch can be undone.');
  const res = J(b.result, {});
  const tx = db.transaction(() => {
    if (res.po_id) cancelPo(res.po_id, user, `Undo of import batch #${b.id}`);
    if (res.so_id) cancelSo(res.so_id, user);
    if (res.stock?.length) {
      const entries = res.stock.map(s => ({ type: 'IMPORT_REVERSAL', sku: s.sku, wh: s.wh, qty: s.qty, d_on_hand: -s.qty,
        ref: `UNDO-IMPORT-${b.id}`, meta: { import_batch: b.id, reverses: s.group } }));
      try { ledger.post(entries, user); }
      catch (e) {
        throw httpErr(400, 'Some of this stock has already been used or moved, so the import cannot be reversed automatically. ' + e.message);
      }
      for (const s of res.stock) db.prepare('UPDATE lots SET qty=0 WHERE origin_txn=?').run(s.group);
    }
    db.prepare("UPDATE import_batches SET status='undone', undone_by=?, undone_ts=datetime('now') WHERE id=?").run(user, b.id);
  });
  tx();
  return view(batchId);
}

function list(limit = 50) {
  return db.prepare(`SELECT b.id, b.kind, b.filename, b.status, b.created_by, b.created_ts, b.committed_ts,
      json_extract(b.options,'$.ref') ref,
      (SELECT COUNT(*) FROM import_lines l WHERE l.batch_id=b.id) lines,
      (SELECT COUNT(*) FROM import_lines l WHERE l.batch_id=b.id AND l.status='block') blocked,
      (SELECT COUNT(*) FROM import_lines l WHERE l.batch_id=b.id AND l.status='warn') warned,
      (SELECT COUNT(*) FROM import_lines l WHERE l.batch_id=b.id AND l.decision IN ('edited','overridden','rejected')) changed
    FROM import_batches b ORDER BY b.id DESC LIMIT ?`).all(limit);
}

// Validate hand-typed lines (PO / SO forms). Same checks as a file, minus
// the ones that need a document (price/amount/weight cross-checks).
function validateManual(kind, lines, { ref, party } = {}) {
  const rows = lines.map((l, i) => ({ line_no: i + 1, sku_raw: l.sku, qty_raw: String(l.qty), method: 'human', confidence: 'high' }));
  const v = validateDoc({ kind, rows, doc: { kind, ref: ref || null, party, locale: 'us' }, ctx: dbContext() });
  const pick = sev => [
    ...v.batchIssues.filter(i => i.severity === sev).map(i => ({ line: null, ...i })),
    ...v.lines.flatMap((l, i) => l.issues.filter(x => x.severity === sev).map(x => ({ line: i + 1, sku: l.sku, ...x }))),
  ];
  return { blocks: pick('block'), warns: pick('warn') };
}

module.exports = { stage, view, decide, overrideBatch, discard, commit, undo, list, cancelPo, cancelSo,
  validateManual, dbContext, lineResolved };
