// BOM engine — spec sections 3.1–3.5.
const db = require('./db');
const ledger = require('./ledger');

function components(parentSku) {
  return db.prepare(`
    SELECT b.component_sku sku, b.qty, i.name FROM bom b
    JOIN items i ON i.sku = b.component_sku WHERE b.parent_sku = ?`).all(parentSku);
}
function parentsOf(componentSku) {
  return db.prepare(`
    SELECT b.parent_sku sku, b.qty, i.name FROM bom b
    JOIN items i ON i.sku = b.parent_sku WHERE b.component_sku = ?`).all(componentSku);
}

// How many kits could be built from loose components at a warehouse.
function buildable(parentSku, wh) {
  const comps = components(parentSku);
  if (!comps.length) return { buildable: 0, comps: [] };
  let n = Infinity;
  const detail = comps.map(c => {
    const ats = ledger.availableToSell(c.sku, wh);
    const possible = Math.floor(ats / c.qty);
    n = Math.min(n, possible);
    return { ...c, ats, possible };
  });
  return { buildable: n === Infinity ? 0 : n, comps: detail };
}

// Spec 3.3 — "available in assemblies": standalone units vs units locked
// inside finished assemblies, per component.
function exposure(componentSku) {
  const standalone = db.prepare(`
    SELECT warehouse_id, on_hand, on_hold FROM stock_levels WHERE sku=?`).all(componentSku);
  const inAssemblies = db.prepare(`
    SELECT b.parent_sku, i.name, b.qty per_set,
           COALESCE(SUM(s.on_hand),0) sets_on_hand,
           b.qty * COALESCE(SUM(s.on_hand),0) units_locked
    FROM bom b JOIN items i ON i.sku = b.parent_sku
    LEFT JOIN stock_levels s ON s.sku = b.parent_sku
    WHERE b.component_sku = ?
    GROUP BY b.parent_sku`).all(componentSku);
  const standaloneTotal = standalone.reduce((a, r) => a + r.on_hand, 0);
  const lockedTotal = inAssemblies.reduce((a, r) => a + r.units_locked, 0);
  return { standalone, standaloneTotal, inAssemblies, lockedTotal,
           totalExposure: standaloneTotal + lockedTotal };
}

// Spec 3.2 — stock check priority for a sales-order line, with the
// resolution suggestions required by resolved decision 8.7 and the
// disassembly-as-last-resort rule from decision 8.4.
function checkLine(sku, qty, wh) {
  const item = db.prepare('SELECT * FROM items WHERE sku=?').get(sku);
  if (!item) return { mode: 'short', reason: 'Unknown SKU', suggestions: [] };
  const ats = ledger.availableToSell(sku, wh);
  if (ats >= qty) return { mode: 'stock', ats };

  if (item.item_type === 'assembly') {
    const b = buildable(sku, wh);
    const fromStock = Math.max(ats, 0);
    if (fromStock + b.buildable >= qty) {
      return { mode: 'kit', ats, fromStock, toBuild: qty - fromStock, comps: b.comps };
    }
  }
  // Short — assemble the suggestion list.
  const suggestions = [];
  const others = db.prepare(`
    SELECT warehouse_id, on_hand - on_hold ats FROM stock_levels
    WHERE sku=? AND warehouse_id != ? AND on_hand - on_hold > 0`).all(sku, wh);
  for (const o of others)
    suggestions.push({ kind: 'transfer', text: `${o.ats} available in ${o.warehouse_id} — transfer in`, warehouse: o.warehouse_id, qty: o.ats });
  const incoming = db.prepare(`
    SELECT p.ref, p.eta, p.status, l.qty - l.received_qty pending FROM po_lines l
    JOIN purchase_orders p ON p.id = l.po_id
    WHERE l.sku=? AND p.status IN ('ordered','in_transit') AND l.qty > l.received_qty
    ORDER BY p.eta`).all(sku);
  for (const s of incoming)
    suggestions.push({ kind: 'incoming', text: `${s.pending} ${s.status === 'in_transit' ? 'in transit' : 'on order'} (${s.ref}${s.eta ? ', ETA ' + s.eta : ''})` });
  if (item.item_type !== 'assembly') {
    for (const p of parentsOf(sku)) {
      const sets = ledger.availableAllWh(p.sku);
      if (sets > 0)
        suggestions.push({ kind: 'disassemble', text: `Last resort: disassemble ${p.sku} (${sets} sets available, yields ${p.qty}/set)` });
    }
  }
  return { mode: 'short', ats, suggestions };
}

// Physical assembly: consume components, add finished sets. Spec 3.5 reverse.
function assemble(parentSku, qty, wh, user, ref) {
  const comps = components(parentSku);
  if (!comps.length) throw new Error(`${parentSku} has no BOM defined`);
  const entries = comps.map(c => ({
    type: 'ASSEMBLE_CONSUME', sku: c.sku, wh, qty: c.qty * qty,
    d_on_hand: -c.qty * qty, ref, meta: { parent: parentSku } }));
  entries.push({ type: 'ASSEMBLE_PRODUCE', sku: parentSku, wh, qty, d_on_hand: qty, ref });
  return ledger.post(entries, user);
}
function disassemble(parentSku, qty, wh, user, ref) {
  const comps = components(parentSku);
  if (!comps.length) throw new Error(`${parentSku} has no BOM defined`);
  const entries = [{ type: 'DISASSEMBLE_CONSUME', sku: parentSku, wh, qty, d_on_hand: -qty, ref }];
  for (const c of comps) entries.push({
    type: 'DISASSEMBLE_PRODUCE', sku: c.sku, wh, qty: c.qty * qty,
    d_on_hand: c.qty * qty, ref, meta: { parent: parentSku } });
  return ledger.post(entries, user);
}

module.exports = { components, parentsOf, buildable, exposure, checkLine, assemble, disassemble };
