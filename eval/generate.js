// Evaluation corpus: real purchase-order lines, rendered as the kinds of
// files that actually arrive, with known errors injected.
//
// WHAT IS REAL: every document's SKUs, quantities, supplier and grouping come
// from the 351 incoming-shipment lines (34 documents) on the company's
// "INVENTORY STOCK LIST AS ON 1 JULY 2026" workbook (data/seed/seed.json),
// and every unit weight comes from the Zoho item master (seed_v2.json).
//
// WHAT IS SYNTHETIC: unit prices (derived from unit weight, see priceOf),
// the visual layouts of the PDFs, and the injected errors. The error types
// are modelled on failures seen in the real data (negative cells such as
// -31,250 in the workbook) and on how v1's importer reads files.
//
// Everything is deterministic (seeded PRNG) so the numbers reproduce exactly.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const ROOT = path.join(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/seed.json'), 'utf8'));
const master = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/seed_v2.json'), 'utf8'));
const ITEMS = new Map(master.items.map(i => [i.sku, i]));

function rng(seedN) {
  let a = seedN >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// Synthetic but stable unit price: ~USD 1.6–2.4 per kg of steel, at least 1 cent.
function priceOf(sku) {
  const it = ITEMS.get(sku); const r = rng(hashStr(sku))();
  const p = Math.max(0.01, (it?.unit_weight || 0.05) * (1.6 + 0.8 * r));
  return p < 1 ? +p.toFixed(4) : +p.toFixed(2);
}

/** The 34 real documents, grouped exactly as v1's seed script groups them. */
function realDocs() {
  const g = new Map();
  for (const s of seed.shipments) {
    const key = `${s.ref}|${s.status}|${s.party}|${s.eta || ''}`;
    if (!g.has(key)) g.set(key, { ref: s.ref, supplier: s.party || 'Unknown', eta: s.eta, lines: [] });
    g.get(key).lines.push({ sku: s.sku, qty: s.qty });
  }
  // Two refs appear as two separate shipments each; give the second its own
  // document number so "same reference" isn't counted as an error.
  const seen = new Map();
  return [...g.values()].map((d, i) => {
    const n = (seen.get(d.ref) || 0) + 1; seen.set(d.ref, n);
    return { id: i + 1, ...d, ref: n > 1 ? `${d.ref}-S${n}` : d.ref };
  });
}

// ---------- error injection ----------
const ERROR_TYPES = ['NEG', 'X10', 'DIV10', 'SEP', 'KG', 'BOX', 'SKUTYPO', 'DUPLINE'];
const PACKS = [1000, 500, 250, 100];

function typo(sku, r) {
  const i = 3 + Math.floor(r() * (sku.length - 4));
  const mode = r();
  if (mode < 0.5) return sku.slice(0, i) + sku.slice(i + 1);                 // dropped character
  const pool = '0123456789';
  let c; do { c = pool[Math.floor(r() * pool.length)]; } while (c === sku[i]);
  return /\d/.test(sku[i]) ? sku.slice(0, i) + c + sku.slice(i + 1) : sku.slice(0, i) + sku.slice(i + 1);
}

/**
 * Produce printed lines from true lines. Each printed line records its truth.
 * printed: { sku, qtyText?, qty, unit, price, amount, weight, err, truthSku, truthQty, extra }
 */
function inject(doc, { rate, seedN, eu }) {
  const r = rng(seedN);
  const out = [];
  for (const l of doc.lines) {
    const it = ITEMS.get(l.sku);
    const price = priceOf(l.sku);
    const base = { sku: l.sku, qty: l.qty, unit: 'pcs', price, amount: +(l.qty * price).toFixed(2),
      weight: +(l.qty * it.unit_weight * (1 + 0.04 * r())).toFixed(1), // gross ≥ net (packaging)
      err: null, truthSku: l.sku, truthQty: l.qty };
    let err = null;
    if (r() < rate) {
      const choices = ERROR_TYPES.filter(e =>
        !(e === 'SEP' && (eu || l.qty < 1000)) &&
        !(e === 'DIV10' && l.qty % 10 !== 0) &&
        !(e === 'BOX' && !PACKS.some(p => l.qty % p === 0 && l.qty / p >= 2)));
      err = choices[Math.floor(r() * choices.length)];
    }
    const p = { ...base, err };
    if (err === 'NEG') p.qty = -l.qty;
    if (err === 'X10') p.qty = l.qty * 10;
    if (err === 'DIV10') p.qty = l.qty / 10;
    if (err === 'SEP') p.qtyText = fmtThousands(l.qty, '.');            // "31.250" in a 1,234.5 document
    if (err === 'KG') { p.unit = 'kg'; p.qty = +(l.qty * it.unit_weight).toFixed(1); p.price = +(price / it.unit_weight).toFixed(4); }
    if (err === 'BOX') { const pk = PACKS.find(q => l.qty % q === 0 && l.qty / q >= 2); p.unit = 'box'; p.qty = l.qty / pk; p.pack = pk; }
    if (err === 'SKUTYPO') { p.sku = typo(l.sku, r); p.typoIsRealSku = ITEMS.has(p.sku); }
    out.push(p);
    if (err === 'DUPLINE') out.push({ ...base, err: 'DUPLINE', extra: true, truthQty: 0 }); // copy-paste repeat
  }
  return out;
}

// ---------- number formatting ----------
function fmtThousands(n, sep) {
  const s = String(Math.trunc(Math.abs(n)));
  return (n < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
function fmtNum(n, dec, eu, group = true) {
  const neg = n < 0; n = Math.abs(n);
  let [i, f] = n.toFixed(dec).split('.');
  if (group) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, eu ? '.' : ',');
  return (neg ? '-' : '') + i + (f ? (eu ? ',' : '.') + f : '');
}
function decOf(x) { const s = String(x); return s.includes('.') ? s.split('.')[1].length : 0; }
function qtyCell(p, eu, group) {
  if (p.qtyText) return p.qtyText;
  const d = Number.isInteger(p.qty) ? 0 : decOf(p.qty);
  return fmtNum(p.qty, d, eu, group);
}

// ---------- renderers ----------
function renderCsv(doc, printed, { full, eu }) {
  const q = s => (/[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = full ? ['Supplier', 'Ref', 'SKU', 'Description', 'Qty', 'Unit', 'Unit Price', 'Amount', 'Weight KG']
                    : ['Supplier', 'Ref', 'SKU', 'Qty'];
  const rows = [head];
  for (const p of printed) {
    const qc = full ? qtyCell(p, eu, false) : qtyCell(p, eu, false) + (p.unit !== 'pcs' ? ' ' + p.unit : '');
    rows.push(full
      ? [doc.supplier, doc.ref, p.sku, (ITEMS.get(p.truthSku)?.name || '').slice(0, 40), qc, p.unit,
         fmtNum(p.price, decOf(p.price), eu, false), fmtNum(p.amount, 2, eu, false), fmtNum(p.weight, 1, eu, false)]
      : [doc.supplier, doc.ref, p.sku, qc]);
  }
  return Buffer.from(rows.map(r => r.map(c => q(String(c))).join(',')).join('\r\n') + '\r\n');
}

// PDF layouts. Columns: [key, label, x, width, align]
const LAYOUTS = {
  A: { name: 'Invoice: Qty · Unit price · Amount (amount last)', cols: [
    ['no', '#', 30, 18, 'left'], ['sku', 'Item Code', 50, 118, 'left'], ['desc', 'Description', 170, 170, 'left'],
    ['qty', 'Qty', 345, 60, 'right'], ['price', 'Unit Price', 410, 60, 'right'], ['amount', 'Amount', 475, 85, 'right']] },
  B: { name: 'Order: Unit price · Amount · Qty (qty last)', cols: [
    ['no', 'No.', 30, 18, 'left'], ['sku', 'Code', 50, 118, 'left'], ['desc', 'Description', 170, 170, 'left'],
    ['price', 'Rate', 345, 60, 'right'], ['amount', 'Value', 410, 75, 'right'], ['qty', 'Quantity', 490, 70, 'right']] },
  C: { name: 'Packing list: Qty · Unit · Net weight (weight last)', cols: [
    ['no', 'S.No', 30, 22, 'left'], ['sku', 'Part No', 55, 118, 'left'], ['desc', 'Description', 175, 180, 'left'],
    ['qty', 'Qty', 360, 65, 'right'], ['unit', 'Unit', 432, 40, 'left'], ['weight', 'Net Wt (kg)', 478, 82, 'right']] },
};

function renderPdf(doc, printed, { layout, eu, header = true, jitter = 0, seedN = 1 }) {
  const L = LAYOUTS[layout];
  const r = rng(seedN);
  const j = () => (jitter ? (r() * 2 - 1) * jitter : 0);
  return new Promise(resolve => {
    const pdf = new PDFDocument({ size: 'A4', margin: 30, info: { CreationDate: new Date(Date.UTC(2026, 6, 1)) } });
    const bufs = []; pdf.on('data', b => bufs.push(b)); pdf.on('end', () => resolve(Buffer.concat(bufs)));
    pdf.font('Helvetica').fontSize(13).text(layout === 'C' ? 'PACKING LIST' : 'COMMERCIAL INVOICE', 30, 30);
    pdf.fontSize(8).text(`Supplier: ${doc.supplier}    Document: ${doc.ref}    ETA: ${doc.eta || '-'}`, 30, 50);
    let y = 75;
    const drawHeader = () => {
      if (!header) return;
      pdf.font('Helvetica-Bold');
      for (const [, label, x, w] of L.cols) pdf.text(label, x + j(), y, { width: w, align: 'left', lineBreak: false });
      pdf.font('Helvetica'); y += 14;
    };
    drawHeader();
    const cell = (key, p, i) => {
      switch (key) {
        case 'no': return String(i + 1);
        case 'sku': return p.sku;
        case 'desc': return (ITEMS.get(p.truthSku)?.name || '').replace(/^.{33}.*/, m => m.slice(0, 33) + '…');
        case 'qty': return qtyCell(p, eu, true) + (layout !== 'C' && p.unit !== 'pcs' ? ' ' + p.unit : '');
        case 'unit': return p.unit === 'pcs' ? 'PCS' : p.unit.toUpperCase();
        case 'price': return fmtNum(p.price, decOf(p.price), eu);
        case 'amount': return fmtNum(p.amount, 2, eu);
        case 'weight': return fmtNum(p.weight, 1, eu);
      }
    };
    printed.forEach((p, i) => {
      if (y > 790) { pdf.addPage(); y = 40; drawHeader(); }
      for (const [key, , x, w, align] of L.cols)
        pdf.text(cell(key, p, i), x + j(), y, { width: w, align, lineBreak: false });
      y += 13;
    });
    // Printed total (from the document's own numbers, as a supplier's system would).
    y += 4;
    const tot = { qty: printed.reduce((a, p) => a + (p.unit === 'pcs' ? p.qty : 0), 0),
      amount: printed.reduce((a, p) => a + p.amount, 0), weight: printed.reduce((a, p) => a + p.weight, 0) };
    for (const [key, , x, w, align] of L.cols) {
      const t = key === 'desc' ? 'TOTAL' : key === 'amount' ? fmtNum(tot.amount, 2, eu) : key === 'weight' ? fmtNum(tot.weight, 1, eu) : null;
      if (t) pdf.font('Helvetica-Bold').text(t, x + j(), y, { width: w, align, lineBreak: false });
    }
    pdf.end();
  });
}

module.exports = { realDocs, inject, renderCsv, renderPdf, LAYOUTS, ITEMS, ERROR_TYPES, priceOf, rng, hashStr };
