// Ledger engine. Every stock movement in the system goes through post().
// Each call is one atomic SQLite transaction: ledger rows are appended and
// stock_levels is updated in the same commit. The CHECK constraints on
// stock_levels reject any movement that would take a quantity below zero
// (or hold more than is on hand), so the whole group rolls back and the
// caller gets a clean error. Stock can never go negative.
const db = require('./db');
const crypto = require('crypto');

const ensureLevel = db.prepare(`
  INSERT OR IGNORE INTO stock_levels (sku, warehouse_id) VALUES (?, ?)`);
const applyDelta = db.prepare(`
  UPDATE stock_levels SET
    on_hand = on_hand + @d_on_hand,
    on_hold = on_hold + @d_on_hold,
    on_order = on_order + @d_on_order,
    in_transit = in_transit + @d_in_transit,
    sold = sold + @d_sold
  WHERE sku = @sku AND warehouse_id = @wh`);
const insertTxn = db.prepare(`
  INSERT INTO transactions
    (group_id, type, sku, warehouse_id, qty, d_on_hand, d_on_hold, d_on_order,
     d_in_transit, d_sold, ref, counterparty, user, meta)
  VALUES (@group_id, @type, @sku, @wh, @qty, @d_on_hand, @d_on_hold, @d_on_order,
     @d_in_transit, @d_sold, @ref, @counterparty, @user, @meta)`);
const itemExists = db.prepare('SELECT 1 FROM items WHERE sku = ?');
const whExists = db.prepare('SELECT 1 FROM warehouses WHERE id = ? AND active = 1');

/**
 * entries: [{ type, sku, wh, qty, d_on_hand, d_on_hold, d_on_order,
 *             d_in_transit, d_sold, ref, counterparty, meta }]
 * Returns group_id. Throws with a readable message if any entry would
 * violate stock constraints; nothing is committed in that case.
 */
const post = db.transaction((entries, user) => {
  const group_id = crypto.randomBytes(5).toString('hex');
  for (const e of entries) {
    if (!itemExists.get(e.sku)) throw new Error(`Unknown SKU: ${e.sku}`);
    if (!whExists.get(e.wh)) throw new Error(`Unknown or inactive warehouse: ${e.wh}`);
    ensureLevel.run(e.sku, e.wh);
    const row = {
      group_id, type: e.type, sku: e.sku, wh: e.wh, qty: e.qty,
      d_on_hand: e.d_on_hand || 0, d_on_hold: e.d_on_hold || 0,
      d_on_order: e.d_on_order || 0, d_in_transit: e.d_in_transit || 0,
      d_sold: e.d_sold || 0, ref: e.ref || null, counterparty: e.counterparty || null,
      user: user || 'system', meta: JSON.stringify(e.meta || {}),
    };
    try {
      applyDelta.run(row);
    } catch (err) {
      const lvl = db.prepare('SELECT * FROM stock_levels WHERE sku=? AND warehouse_id=?').get(e.sku, e.wh);
      throw new Error(
        `Blocked: ${e.type} of ${e.qty} × ${e.sku} at ${e.wh} would make stock negative ` +
        `(on hand ${lvl ? lvl.on_hand : 0}, held ${lvl ? lvl.on_hold : 0}). Nothing was changed.`);
    }
    insertTxn.run(row);
  }
  return group_id;
});

function level(sku, wh) {
  return db.prepare('SELECT * FROM stock_levels WHERE sku=? AND warehouse_id=?').get(sku, wh) ||
    { sku, warehouse_id: wh, on_hand: 0, on_hold: 0, on_order: 0, in_transit: 0, sold: 0 };
}
function levelsFor(sku) {
  return db.prepare('SELECT * FROM stock_levels WHERE sku=?').all(sku);
}
function availableToSell(sku, wh) {
  const l = level(sku, wh);
  return l.on_hand - l.on_hold;
}
function availableAllWh(sku) {
  const r = db.prepare(
    'SELECT COALESCE(SUM(on_hand - on_hold),0) a FROM stock_levels WHERE sku=?').get(sku);
  return r.a;
}

// Rebuild stock_levels from the ledger — proof that levels are derived data.
function rebuild() {
  const tx = db.transaction(() => {
    db.exec('DELETE FROM stock_levels');
    const rows = db.prepare(`
      SELECT sku, warehouse_id wh, SUM(d_on_hand) h, SUM(d_on_hold) ho,
             SUM(d_on_order) oo, SUM(d_in_transit) it, SUM(d_sold) s
      FROM transactions GROUP BY sku, warehouse_id`).all();
    for (const r of rows) {
      db.prepare(`INSERT INTO stock_levels
        (sku, warehouse_id, on_hand, on_hold, on_order, in_transit, sold)
        VALUES (?,?,?,?,?,?,?)`).run(r.sku, r.wh, r.h, r.ho, r.oo, r.it, r.s);
    }
  });
  tx();
}

module.exports = { post, level, levelsFor, availableToSell, availableAllWh, rebuild };
