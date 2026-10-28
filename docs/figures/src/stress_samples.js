// Render one real document at three noise levels and record what v2 did with each.
process.env.DATA_DIR = require('fs').mkdtempSync(require('os').tmpdir() + '/ic-st-');
const quiet = f => (...a) => { if (!/polyfill|canvas|Require stack|^- /i.test(String(a[0]))) f(...a); };
console.warn = quiet(console.warn); console.log = quiet(console.log);
const fs = require('fs'), path = require('path');
const G = require('../../../eval/generate'); const imports = require('../../../server/imports');
const { validateDoc } = require('../../../server/validate');
const out = process.argv[2]; const KNOWN = new Set(G.ITEMS.keys());
const ctx = { item: s => G.ITEMS.get(s) || null, skus: () => [...KNOWN], history: () => [], groupHistory: () => [] };
(async () => {
  const doc = G.realDocs().find(d => d.lines.length === 11) || G.realDocs()[0];
  const printed = G.inject(doc, { rate: 0, seedN: 1, eu: false });
  const res = [];
  for (const sigma of [0, 20, 40]) {
    const buf = await G.renderPdf(doc, printed, { layout: 'A', eu: false, jitter: sigma, seedN: 21 * 7 + doc.id });
    fs.writeFileSync(path.join(out, `st_${sigma}.pdf`), buf);
    const p = await imports.parseFile('x.pdf', buf.toString('base64'), { kind: 'po', known: KNOWN, itemOf: s => G.ITEMS.get(s) });
    const v = validateDoc({ kind: 'po', rows: p.rows, doc: { ...p.doc, kind: 'po' }, ctx });
    const truth = printed.map(x => x.truthQty);
    let ok = 0, held = 0, silent = 0;
    v.lines.forEach((l, i) => { const right = l.qty === truth[i]; if (l.status !== 'ok') held++; else if (right) ok++; else silent++; });
    res.push({ sigma, n: v.lines.length, ok, held, silent, readOk: v.lines.filter((l, i) => l.qty === truth[i]).length });
  }
  fs.writeFileSync(path.join(out, 'st.json'), JSON.stringify({ ref: doc.ref, lines: doc.lines.length, res }));
})();
