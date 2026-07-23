// Load data/seed/seed.json (produced by extract_from_xlsx.py) into the
// database. Opening stock is posted through the ledger as OPENING_BALANCE
// transactions, so even migrated stock is fully auditable.
const path = require('path');
const fs = require('fs');
const db = require('../server/db');
const ledger = require('../server/ledger');

const seedPath = process.argv[2] || path.join(__dirname, '..', 'data', 'seed', 'seed_v2.json');
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

const already = db.prepare("SELECT COUNT(*) c FROM transactions WHERE type='OPENING_BALANCE'").get().c;
if (already && !process.argv.includes('--force')) {
  console.log('Database already seeded. Use --force to seed on top (not recommended).');
  process.exit(0);
}

const tx = db.transaction(() => {
  for (const w of seed.warehouses) {
    db.prepare('INSERT OR IGNORE INTO warehouses (id, name, address) VALUES (?,?,?)')
      .run(w.id, w.name, w.address);
  }
  const insItem = db.prepare(`INSERT OR IGNORE INTO items
    (sku, name, item_type, category, size, grade, coating, uom, unit_weight, active, attrs)
    VALUES (@sku,@name,@item_type,@category,@size,@grade,@coating,@uom,@unit_weight,@active,@attrs)`);
  for (const it of seed.items) {
    insItem.run({ grade: '', coating: '', uom: 'pcs', size: '', unit_weight: 0, active: 1,
      ...it, item_type: it.item_type === 'part' ? 'part' : it.item_type,
      attrs: JSON.stringify({ source: it.source }) });
  }
  for (const b of seed.boms) {
    for (const c of b.components) {
      db.prepare('INSERT OR IGNORE INTO bom (parent_sku, component_sku, qty) VALUES (?,?,?)')
        .run(b.parent, c.sku, c.qty);
    }
  }
  // Opening stock through the ledger.
  const entries = seed.stock.map(s => ({
    type: 'OPENING_BALANCE', sku: s.sku, wh: s.warehouse, qty: s.on_hand,
    d_on_hand: s.on_hand, ref: 'STOCK LIST 1 JUL 2026' }));
  for (let i = 0; i < entries.length; i += 200) ledger.post(entries.slice(i, i + 200), 'migration');

  // Incoming shipments -> purchase orders grouped by (ref, status).
  const groups = new Map();
  for (const s of seed.shipments) {
    const key = `${s.ref}|${s.status}|${s.party}|${s.eta || ''}`;
    if (!groups.has(key)) groups.set(key, { ...s, lines: [] });
    groups.get(key).lines.push({ sku: s.sku, qty: s.qty });
  }
  for (const g of groups.values()) {
    const r = db.prepare(`INSERT INTO purchase_orders (supplier, ref, eta, status, warehouse_id, note, created_by)
      VALUES (?,?,?,?,?,?,?)`)
      .run(g.party || '', g.ref, g.eta || null, g.status === 'in_transit' ? 'in_transit' : 'ordered',
           'WH-MAIN', `Migrated from sheet: ${g.source}`, 'migration');
    const poId = r.lastInsertRowid;
    const entries = [];
    for (const l of g.lines) {
      db.prepare('INSERT INTO po_lines (po_id, sku, qty) VALUES (?,?,?)').run(poId, l.sku, l.qty);
      entries.push({
        type: g.status === 'in_transit' ? 'SHIPMENT_BOOKED' : 'PO_PLACED',
        sku: l.sku, wh: 'WH-MAIN', qty: l.qty,
        d_in_transit: g.status === 'in_transit' ? l.qty : 0,
        d_on_order: g.status === 'in_transit' ? 0 : l.qty,
        ref: g.ref, counterparty: g.party });
    }
    ledger.post(entries, 'migration');
  }
});
tx();

const c = (q) => db.prepare(q).get().c;
console.log('Seed complete:',
  c('SELECT COUNT(*) c FROM items') + ' items,',
  c('SELECT COUNT(*) c FROM stock_levels WHERE on_hand>0') + ' stocked positions,',
  c('SELECT COUNT(*) c FROM purchase_orders') + ' incoming POs,',
  c('SELECT COUNT(*) c FROM bom') + ' BOM rows.');
if (seed.exceptions?.length) {
  console.log(`${seed.exceptions.length} migration notes — see data/seed/seed.json "exceptions".`);
}
