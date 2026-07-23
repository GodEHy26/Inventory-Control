// Light manufacturing — spec section 4 + resolved decisions 9.1/9.2.
// Cut-to-length consumes source stock, produces the shorter SKU, and books
// every usable offcut as an individual lot instance (its own length +
// heat number) against a per-diameter scrap SKU.
const db = require('./db');
const ledger = require('./ledger');

function diaOf(size) {
  const m = /^(M\d+)/i.exec(size || '');
  return m ? m[1].toUpperCase() : null;
}

function ensureScrapSku(dia) {
  const sku = `SCRAP-ROD-${dia}`;
  const exists = db.prepare('SELECT 1 FROM items WHERE sku=?').get(sku);
  if (!exists) {
    db.prepare(`INSERT INTO items (sku, name, item_type, category, size, uom)
      VALUES (?, ?, 'raw', 'Rod Scrap', ?, 'piece')`)
      .run(sku, `Threaded Rod Scrap – ${dia} dia`, dia);
  }
  return sku;
}

/**
 * Cut job.
 * { sourceSku, sourceQty, wh, outputs: [{sku, qty}],
 *   scrap: [{length_mm, qty}], heat_no, ref }
 * One atomic ledger group: MFG_CONSUME + MFG_PRODUCE + MFG_SCRAP.
 */
function cut(job, user) {
  const src = db.prepare('SELECT * FROM items WHERE sku=?').get(job.sourceSku);
  if (!src) throw new Error(`Unknown source SKU ${job.sourceSku}`);
  if (!job.outputs || !job.outputs.length) throw new Error('At least one output is required');
  const dia = diaOf(src.size) || 'GEN';
  const ref = job.ref || `CUT-${Date.now().toString(36).toUpperCase()}`;

  const entries = [{
    type: 'MFG_CONSUME', sku: job.sourceSku, wh: job.wh, qty: job.sourceQty,
    d_on_hand: -job.sourceQty, ref,
    meta: { heat_no: job.heat_no || null, job: 'cut' } }];
  for (const o of job.outputs) {
    if (!db.prepare('SELECT 1 FROM items WHERE sku=?').get(o.sku))
      throw new Error(`Unknown output SKU ${o.sku}`);
    entries.push({ type: 'MFG_PRODUCE', sku: o.sku, wh: job.wh, qty: o.qty,
      d_on_hand: o.qty, ref, meta: { source: job.sourceSku, heat_no: job.heat_no || null } });
  }
  let scrapSku = null;
  const scrap = (job.scrap || []).filter(s => s.qty > 0 && s.length_mm > 0);
  if (scrap.length) {
    scrapSku = ensureScrapSku(dia);
    const total = scrap.reduce((a, s) => a + s.qty, 0);
    entries.push({ type: 'MFG_SCRAP', sku: scrapSku, wh: job.wh, qty: total,
      d_on_hand: total, ref, meta: { pieces: scrap } });
  }
  const tx = db.transaction(() => {
    const group = ledger.post(entries, user);
    for (const s of scrap) {
      db.prepare(`INSERT INTO lots (sku, warehouse_id, qty, length_mm, heat_no, origin_txn)
        VALUES (?,?,?,?,?,?)`)
        .run(scrapSku, job.wh, s.qty, s.length_mm, job.heat_no || null, group);
    }
    if (job.heat_no) {
      for (const o of job.outputs) {
        db.prepare(`INSERT INTO lots (sku, warehouse_id, qty, heat_no, origin_txn)
          VALUES (?,?,?,?,?)`).run(o.sku, job.wh, o.qty, job.heat_no, group);
      }
    }
    return group;
  });
  return tx();
}

// Spec 9.2 — a stock check for a required length queries pieces by
// length >= requirement, not a flat quantity.
function scrapPieces(dia, minLength) {
  return db.prepare(`
    SELECT l.*, i.name FROM lots l JOIN items i ON i.sku = l.sku
    WHERE l.sku = ? AND l.qty > 0 AND (@min IS NULL OR l.length_mm >= @min)
    ORDER BY l.length_mm`).all(`SCRAP-ROD-${dia}`, { min: minLength || null });
}

// Consume a scrap piece as the source of a further cut.
function consumeLot(lotId, qty, user, ref) {
  const lot = db.prepare('SELECT * FROM lots WHERE id=?').get(lotId);
  if (!lot) throw new Error('Unknown lot');
  if (lot.qty < qty) throw new Error(`Lot has only ${lot.qty} piece(s)`);
  const tx = db.transaction(() => {
    ledger.post([{ type: 'MFG_CONSUME', sku: lot.sku, wh: lot.warehouse_id, qty,
      d_on_hand: -qty, ref, meta: { lot: lotId, heat_no: lot.heat_no } }], user);
    db.prepare('UPDATE lots SET qty = qty - ? WHERE id=?').run(qty, lotId);
  });
  tx();
}

function yieldReport() {
  return db.prepare(`
    SELECT ref,
      MIN(ts) ts, MAX(user) user, MAX(warehouse_id) warehouse_id,
      SUM(CASE WHEN type='MFG_CONSUME' THEN qty ELSE 0 END) consumed,
      SUM(CASE WHEN type='MFG_PRODUCE' THEN qty ELSE 0 END) produced,
      SUM(CASE WHEN type='MFG_SCRAP' THEN qty ELSE 0 END) scrap,
      GROUP_CONCAT(DISTINCT CASE WHEN type='MFG_CONSUME' THEN sku END) sources,
      GROUP_CONCAT(DISTINCT CASE WHEN type='MFG_PRODUCE' THEN sku END) outputs
    FROM transactions WHERE type LIKE 'MFG_%'
    GROUP BY ref ORDER BY ts DESC LIMIT 200`).all();
}

module.exports = { cut, scrapPieces, consumeLot, yieldReport, ensureScrapSku, diaOf };
