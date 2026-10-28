// v2: column-aware PDF reading.
//
// v1 found a line containing a known SKU and took "the last number on the
// line" as the quantity. On a supplier PDF laid out as
//   SKU | Description | Qty | Unit | Unit price | Amount
// the last number is the Amount, so 5,000 bolts at 0.12 came in as 600 —
// with nothing on screen to say so.
//
// v2 reads the table the way a person does: find the header row, note
// where each column sits on the page, and put every number on a line into
// the column it is printed under. When there is no header it falls back to
// arithmetic (which number × which number = which number?) and only then
// to the old "last number" guess — marked low-confidence so the validator
// holds it for a person instead of committing it.

const { parseNumber } = require('./numbers');

const HEADER_RULES = [
  ['heat', /heat/],
  ['weight', /weight|^wt\b|^kgs?$|\(kg\)|^n\.?w|^g\.?w/],
  ['price', /price|rate|u\/p/],
  ['amount', /amount|line ?total|^total$|^value$|^ext/],
  ['qty', /^q(ua)?n?t(it)?y\b|^q'?ty|^pcs$|^nos$|^quantity/],
  ['unit', /^(unit|uom|u\/m|units)$/],
  ['sku', /^(sku|item ?code|code|article( ?no)?|part ?(no|number)|item ?no|product ?code)$/],
  ['desc', /desc|^item$|item ?name|product|particulars/],
  ['lineno', /^(#|no\.?|s\.? ?no\.?|sr\.?( ?no)?|sl\.?( ?no)?|line)$/],
];
function classifyHeader(str) {
  const s = str.toLowerCase().replace(/[:]/g, '').replace(/\s+/g, ' ').trim();
  for (const [k, re] of HEADER_RULES) if (re.test(s)) return k;
  return null;
}

const SKU_LIKE = /^[A-Z0-9][A-Z0-9\-\/.]{6,}$/;
function looksLikeSku(t) {
  const u = t.toUpperCase();
  return SKU_LIKE.test(u) && /[A-Z]/.test(u) && (u.match(/\d/g) || []).length >= 2;
}
const NUMERIC = /^\(?[-+]?[\d][\d.,' ]*\)?-?\s*[A-Za-z]{0,6}\.?$/;
const DATE_LIKE = /^\d{1,4}[-\/]\d{1,2}[-\/]\d{1,4}$/;
function isNumberToken(t) {
  if (!NUMERIC.test(t) || DATE_LIKE.test(t)) return false;
  if (/^M\d+X\d+/i.test(t)) return false; // a size like M12X30
  return parseNumber(t).value != null;
}

/** Group pdf.js text items into visual lines, keeping x geometry. */
function toLines(items) {
  const rows = [];
  const sorted = items.filter(i => i.str && i.str.trim())
    .map(i => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width || 0 }))
    .sort((a, b) => b.y - a.y || a.x - b.x);
  for (const it of sorted) {
    const row = rows.find(r => Math.abs(r.y - it.y) <= 2.5);
    if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

// Split a text item that holds several words into word tokens with
// approximate x positions (proportional to character offset).
function tokensOf(row) {
  const out = [];
  for (const it of row.items) {
    const words = it.str.split(/\s+/).filter(Boolean);
    // Keep "5,000 pcs" or "1 250" together if the whole item is one number.
    if (words.length > 1 && isNumberToken(it.str)) { out.push({ t: it.str, x0: it.x, x1: it.x + it.w, cx: it.x + it.w / 2, item: it }); continue; }
    let off = 0;
    const len = it.str.length || 1;
    for (const w of words) {
      const i = it.str.indexOf(w, off);
      const x0 = it.x + (it.w * i) / len, x1 = it.x + (it.w * (i + w.length)) / len;
      out.push({ t: w, x0, x1, cx: (x0 + x1) / 2, item: it });
      off = i + w.length;
    }
  }
  return out;
}

// A column runs from its header's left edge to the next header's left edge.
// Numbers are assigned to the column they overlap most. (v2 first used the
// midpoint between header centres, which failed on the commonest layout:
// left-aligned header text over right-aligned numbers — "5,000" sat closer
// to the "Unit" header than to "Qty". Left-edge extents fix that and still
// work for centred headers.)
function findHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cols = [];
    for (const it of rows[i].items) {
      const k = classifyHeader(it.str);
      if (k && !cols.find(c => c.key === k)) cols.push({ key: k, x0: it.x, x1: it.x + it.w, label: it.str });
    }
    if (cols.length >= 3 && cols.find(c => c.key === 'qty')) {
      cols.sort((a, b) => a.x0 - b.x0);
      cols.forEach((c, j) => {
        c.lo = j === 0 ? -Infinity : c.x0 - 2;
        c.hi = j === cols.length - 1 ? Infinity : cols[j + 1].x0 - 2;
      });
      return { index: i, cols };
    }
  }
  return null;
}
function columnAt(header, tok) {
  const x0 = tok.x0 ?? tok.cx, x1 = tok.x1 ?? tok.cx;
  let best = null, bestOv = -Infinity;
  for (const c of header.cols) {
    const ov = Math.min(x1, c.hi) - Math.max(x0, c.lo);
    if (ov > bestOv) { bestOv = ov; best = c.key; }
  }
  return best;
}

/**
 * Resolve qty from a bag of numbers when there is no header:
 *   1) a × b ≈ c with a an integer → a is qty, b price, c amount
 *   2) a × unit_weight ≈ c (±20%)   → a is qty, c weight
 *   3) otherwise: last number, LOW confidence.
 */
function resolveByArithmetic(nums, unitWeight) {
  const vals = nums.map(n => ({ raw: n, v: parseNumber(n).value })).filter(n => n.v != null && n.v > 0);
  const hits = [];
  for (let i = 0; i < vals.length; i++) for (let j = 0; j < vals.length; j++) for (let k = 0; k < vals.length; k++) {
    if (i === j || j === k || i === k) continue;
    const q = vals[i].v, p = vals[j].v, a = vals[k].v;
    if (!Number.isInteger(q) || q < 2) continue;
    // If both factors are whole numbers (2 × 15 = 30) either could be the
    // quantity; both readings are kept, which makes the line ambiguous below.
    if (Math.abs(q * p - a) <= Math.max(0.011, a * 0.002)) hits.push({ i, j, k });
  }
  const uniqQ = [...new Set(hits.map(h => h.i))];
  if (uniqQ.length === 1) {
    const h = hits[0];
    return { method: 'arithmetic', confidence: 'medium', qty_raw: vals[h.i].raw,
      price_raw: vals[h.j].raw, amount_raw: vals[h.k].raw };
  }
  if (unitWeight > 0) {
    const wh = [];
    for (let i = 0; i < vals.length; i++) for (let k = 0; k < vals.length; k++) {
      if (i === k || !Number.isInteger(vals[i].v)) continue;
      const r = vals[k].v / (vals[i].v * unitWeight);
      if (r > 0.8 && r < 1.2) wh.push({ i, k });
    }
    const uq = [...new Set(wh.map(h => h.i))];
    if (uq.length === 1) return { method: 'weight', confidence: 'medium',
      qty_raw: vals[wh[0].i].raw, weight_raw: vals[wh[0].k].raw };
  }
  return { method: 'last-number', confidence: 'low',
    qty_raw: nums.length ? nums[nums.length - 1] : '', candidates: nums.slice() };
}

/**
 * items: pdf.js text items from all pages (each with transform/width).
 * known: Set of SKUs; itemOf(sku) → item (for unit weights).
 */
function extractTable(pages, known, itemOf) {
  const lines = [], totals = [];
  let header = null, lineNo = 0;
  const rawNumbers = [];
  for (const items of pages) {
    const rows = toLines(items);
    const h = findHeader(rows);
    if (h) header = h;           // a new page may repeat the header
    const start = h ? h.index + 1 : 0;
    for (let r = start; r < rows.length; r++) {
      const toks = tokensOf(rows[r]);
      const text = toks.map(t => t.t).join(' ');
      const skuTok = toks.find(t => known.has(t.t.toUpperCase())) ||
        toks.find(t => looksLikeSku(t.t) && (!header || columnAt(header, t) === 'sku'));
      const numToks = toks.filter(t => t !== skuTok && isNumberToken(t.t));
      for (const t of numToks) rawNumbers.push(t.t);
      if (!skuTok) {
        if (/\btotal\b/i.test(text) && numToks.length) {
          totals.push({ text, numbers: numToks.map(t => ({ raw: t.t, col: header ? columnAt(header, t) : null })) });
        }
        continue;
      }
      if (!numToks.length) continue;
      lineNo++;
      const line = { line_no: lineNo, text, sku_raw: skuTok.t, notes: [] };
      if (header) {
        const byCol = {};
        for (const t of numToks) {
          const c = columnAt(header, t);
          if (c && byCol[c] == null) byCol[c] = t.t;
        }
        // Unit can be printed as its own column of words.
        const unitTok = toks.find(t => t !== skuTok && !isNumberToken(t.t) && columnAt(header, t) === 'unit');
        Object.assign(line, {
          qty_raw: byCol.qty ?? '', price_raw: byCol.price ?? '', amount_raw: byCol.amount ?? '',
          weight_raw: byCol.weight ?? '', unit_raw: unitTok ? unitTok.t : '',
          heat: (toks.find(t => columnAt(header, t) === 'heat') || {}).t || '',
          method: 'column', confidence: byCol.qty != null ? 'high' : 'low',
          candidates: numToks.filter(t => columnAt(header, t) !== 'lineno').map(t => t.t),
        });
        if (byCol.qty == null) line.notes.push('No number printed under the Qty column on this line.');
      } else {
        // Drop a leading small integer that is just the row number.
        let nums = numToks.map(t => t.t);
        if (numToks.length > 1 && toks.indexOf(numToks[0]) === 0 && /^\d{1,3}$/.test(nums[0])) nums = nums.slice(1);
        const it = itemOf(skuTok.t.toUpperCase());
        Object.assign(line, resolveByArithmetic(nums, it ? it.unit_weight : 0));
        const unitTok = toks.find(t => /^(pcs?|nos?|sets?|kgs?|boxe?s?|ctns?|bags?|each|ea)$/i.test(t.t));
        line.unit_raw = unitTok ? unitTok.t : '';
        line.candidates = line.candidates || nums;
      }
      lines.push(line);
    }
  }
  return { lines, totals, header: header ? header.cols.map(c => c.key) : null, rawNumbers };
}

async function readPdf(buf, known, itemOf) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    pages.push((await page.getTextContent()).items);
  }
  return extractTable(pages, known, itemOf);
}

module.exports = { readPdf, extractTable, classifyHeader, resolveByArithmetic };
