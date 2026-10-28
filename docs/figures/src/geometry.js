// Dump what the v2 PDF reader "sees": every text item with its position, the
// detected header columns, and which column each number was assigned to.
// Also runs v1 and v2 on the same file. Used to draw fig1_pdf_geometry.png.
// Usage: node docs/figures/src/geometry.js <file.pdf> > out.json
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('os').tmpdir() + '/ic-fig-');
const quiet = f => (...a) => { if (!/polyfill|canvas|Require stack|^- /i.test(String(a[0]))) f(...a); };
console.warn = quiet(console.warn); console.log = quiet(console.log);
require('child_process').execFileSync(process.execPath, [require('path').join(__dirname, '../../../scripts/seed.js')], { env: process.env, stdio: 'ignore' });
const fs = require('fs');
const path = require('path');
const G = require('../../../eval/generate');
const imports = require('../../../server/imports');
const { validateDoc } = require('../../../server/validate');

(async () => {
  const file = process.argv[2];
  const buf = fs.readFileSync(file);
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const items = (await page.getTextContent()).items.filter(i => i.str.trim())
    .map(i => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || 8 }));
  const KNOWN = new Set(G.ITEMS.keys());
  const parsed = await imports.parseFile(path.basename(file), buf.toString('base64'),
    { kind: 'po', known: KNOWN, itemOf: s => G.ITEMS.get(s) });
  const seed = require('../../../data/seed/seed.json');
  const ctx = { item: s => G.ITEMS.get(s) || null, skus: () => [...KNOWN],
    history: (s, r) => seed.shipments.filter(x => x.sku === s && x.ref !== r).map(x => x.qty), groupHistory: () => [] };
  const v = validateDoc({ kind: 'po', rows: parsed.rows, doc: { ...parsed.doc, kind: 'po' }, ctx });
  // v1: last number on the line (reproduced from imports_v1.js)
  const v1 = require('../../../eval/baseline_v1/imports_v1');
  const r1 = await v1.parseFile(path.basename(file), buf.toString('base64'));
  // header columns as v2 builds them
  const { classifyHeader } = require('../../../server/pdfparse');
  const rows = {};
  for (const it of items) { const k = Math.round(it.y); (rows[k] = rows[k] || []).push(it); }
  let header = null;
  for (const y of Object.keys(rows).map(Number).sort((a, b) => b - a)) {
    const cols = rows[y].map(it => ({ key: classifyHeader(it.str), x0: it.x, label: it.str })).filter(c => c.key);
    if (cols.length >= 3 && cols.find(c => c.key === 'qty')) { header = { y, cols: cols.sort((a, b) => a.x0 - b.x0) }; break; }
  }
  process.stdout.write(JSON.stringify({ page: { w: vp.width, h: vp.height }, items, header,
    v2: v.lines.map(l => ({ text: l.row.text, sku: l.sku, qty_raw: l.row.qty_raw, price_raw: l.row.price_raw,
      amount_raw: l.row.amount_raw, qty: l.qty, status: l.status, verified: l.verified,
      issues: l.issues.filter(i => i.severity !== 'info').map(i => ({ code: i.code, msg: i.msg, suggest: i.suggest })) })),
    batch: v.batchIssues, v1: r1.rows }));
})();
