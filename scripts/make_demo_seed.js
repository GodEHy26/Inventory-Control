// Writes data/seed/demo.json: a small, made-up catalog so the app, the tests
// and the screenshot tools run without the company's real data.
// Codes, names and weights are invented. The real data stays in data/private/.
//   node scripts/make_demo_seed.js
const fs = require('fs');
const path = require('path');

const DIAS = [12, 16, 20, 24, 30, 36];
const LENS = [30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160];
const pad = n => String(n).padStart(3, '0');
const r3 = x => +x.toFixed(3);
// Rough steel weights (kg): shank + head for bolts, simple solids for nuts and washers.
const boltKg = (d, l) => r3(7.85e-6 * Math.PI / 4 * d * d * l + 0.9e-5 * d ** 3);
const nutKg = d => r3(1.3e-5 * d ** 3);
const washerKg = d => r3(0.55e-5 * d ** 3);

const items = [], boms = [];
const item = (sku, name, type, category, size, w) =>
  items.push({ sku, name, item_type: type, category, size, grade: 'DEMO', coating: 'HDG', uom: 'pcs', unit_weight: w, active: 1, source: 'demo' });
for (const d of DIAS) {
  item(`NUT-M${d}`, `Demo heavy hex nut M${d}`, 'part', 'Nut', `M${d}`, nutKg(d));
  item(`WSH-M${d}`, `Demo hardened washer M${d}`, 'part', 'Washer', `M${d}`, washerKg(d));
  for (const l of LENS) {
    const size = `M${d}X${l}`;
    item(`BLT-M${d}X${pad(l)}`, `Demo heavy hex bolt ${size}`, 'part', 'Bolt', size, boltKg(d, l));
    item(`SET-M${d}X${pad(l)}`, `Demo bolt-nut-washer set ${size}`, 'assembly', 'Bolt-Nut-Washer Set', size,
      r3(boltKg(d, l) + nutKg(d) + washerKg(d)));
    boms.push({ parent: `SET-M${d}X${pad(l)}`, components: [
      { sku: `BLT-M${d}X${pad(l)}`, qty: 1 }, { sku: `NUT-M${d}`, qty: 1 }, { sku: `WSH-M${d}`, qty: 1 }] });
  }
}
const seed = {
  generated: '2026-01-01',
  source: 'Made-up demo catalog (scripts/make_demo_seed.js). Not real company data.',
  warehouses: [{ id: 'WH-MAIN', name: 'Main Warehouse', address: '' }, { id: 'WH-2', name: 'Second Warehouse', address: '' }],
  items, stock: [], shipments: [], boms, exceptions: [],
};
const out = path.join(__dirname, '..', 'data', 'seed', 'demo.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(seed, null, 1) + '\n');
console.log(`wrote ${path.relative(process.cwd(), out)}: ${items.length} items, ${boms.length} sets`);
