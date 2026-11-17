// Writes a made-up supplier invoice PDF (Qty · Unit price · Amount) using the
// demo catalog, with two planted errors: line 2 is line 1 pasted twice, and
// line 4 says 16 where its own amount implies 160. Nothing in it is real.
//   node scripts/sample_invoice.js out.pdf
const fs = require('fs');
const path = require('path');
const G = require('../eval/generate');

const LINES = [            // sku, qty printed, unit price, true qty
  ['BLT-M12X035', 40000, 0.095, 40000],
  ['BLT-M12X035', 40000, 0.095, 0],        // pasted twice
  ['BLT-M12X050', 8000, 0.16, 8000],
  ['BLT-M20X060', 16, 0.45, 160],          // dropped zero: amount says 72.00
  ['BLT-M20X090', 30000, 0.7, 30000],
  ['BLT-M24X080', 12000, 0.86, 12000],
  ['BLT-M24X110', 7500, 0.99, 7500],
  ['BLT-M36X140', 2000, 3.4, 2000],
];

async function write(out) {
  const demo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'seed', 'demo.json'), 'utf8'));
  G.useItems(demo.items);
  const printed = LINES.map(([sku, qty, price, truth]) => {
    const it = G.ITEMS.get(sku);
    const realQty = truth || qty;
    return { sku, qty, unit: 'pcs', price, amount: +(realQty * price).toFixed(2),
      weight: +(realQty * it.unit_weight).toFixed(1), truthSku: sku, truthQty: truth };
  });
  const doc = { supplier: 'Example Supplier Ltd', ref: 'INV-1001', eta: '2026-09-01' };
  const buf = await G.renderPdf(doc, printed, { layout: 'A', eu: false });
  fs.writeFileSync(out, buf);
  return out;
}
module.exports = { write };
if (require.main === module) write(process.argv[2] || 'sample_invoice.pdf').then(f => console.log('wrote', f));
