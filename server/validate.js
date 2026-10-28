// v2: the checks that decide whether an incoming line can be trusted.
//
// Design rules (see DESIGN.md for the reasoning behind each):
//  1. Never silently pick one reading of an ambiguous input. Either the
//     evidence settles it, or a person does.
//  2. Prefer cross-checks between independent numbers on the document
//     (qty × price = amount, qty × unit weight ≈ stated weight) over
//     "does this look normal" heuristics. Two sources agreeing is evidence;
//     one number looking unusual is only a hint.
//  3. Every flag says what was expected, what was found, and — when the
//     evidence points to one — what the right value probably is.
//  4. Severity is about consequence: BLOCK = committing this would almost
//     certainly put a wrong number in the ledger; WARN = plausible but
//     unusual, a person should glance at it; INFO = recorded, no action.
//
// Everything here is pure: the caller injects a context `ctx` so the same
// code runs against the live database and the offline evaluation.

const { parseNumber, unitKind, decimalsOf } = require('./numbers');

const SEV = { info: 0, warn: 1, block: 2 };
const T = {
  weightTol: 0.20,            // stated vs computed weight: galvanising, packaging, gross/net
  magnitudeSkuDex: 1.0,       // ≥10× from this SKU's own typical quantity
  magnitudeGroupDex: 2.0,     // ≥100× from its category's typical quantity (weaker evidence)
  minSkuHistory: 3,
  minGroupHistory: 10,
  maxLineKg: 50000,           // above the largest stock position on the 1 Jul 2026 list (40.6 t)
  fuzzyMaxDist: 2,
};

function issue(code, severity, msg, suggest) {
  const i = { code, severity, msg };
  if (suggest) i.suggest = suggest;
  return i;
}
const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 4 });

// ---------- SKU resolution ----------
function lev(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function nearestSkus(sku, all, max = T.fuzzyMaxDist) {
  const out = [];
  for (const s of all) {
    const d = lev(sku, s, max);
    if (d <= max) out.push({ sku: s, dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist || a.sku.localeCompare(b.sku)).slice(0, 3);
}
const compact = s => s.replace(/[\s\-_.\/]/g, '');

function resolveSku(raw, ctx, { creating = false, autocreate = false } = {}) {
  const issues = [];
  const sku = String(raw || '').trim().toUpperCase();
  if (!sku) return { sku: '', issues: [issue('SKU_MISSING', 'block', 'No SKU on this line.')] };
  if (ctx.item(sku)) {
    return { sku, issues: creating ? [issue('ITEM_UPDATE', 'info', 'Existing item — details will be updated.')] : [] };
  }
  const c = compact(sku);
  const byCompact = ctx.skus().find(s => compact(s) === c);
  if (byCompact) {
    return { sku: byCompact, issues: [issue('SKU_NORMALISED', 'info', `"${raw}" read as ${byCompact} (spacing/punctuation differs).`)] };
  }
  const near = nearestSkus(sku, ctx.skus());
  if (creating) {
    if (near.length && near[0].dist <= 1)
      issues.push(issue('NEAR_DUPLICATE_SKU', 'warn',
        `New SKU ${sku} is one character away from existing ${near[0].sku}. Creating it would split one product's stock across two records.`,
        { sku: near[0].sku }));
    return { sku, issues };
  }
  if (near.length) {
    const unique = near.length === 1 || near[0].dist < near[1].dist;
    issues.push(issue('SKU_UNKNOWN', autocreate && near[0].dist > 1 ? 'warn' : 'block',
      `${sku} is not in the item master. Closest match${near.length > 1 ? 'es' : ''}: ${near.map(n => n.sku).join(', ')}.` +
      (autocreate ? ' (Auto-create is on, but this looks like a typo.)' : ''),
      unique ? { sku: near[0].sku } : null));
  } else {
    issues.push(issue('SKU_UNKNOWN', autocreate ? 'warn' : 'block',
      `${sku} is not in the item master${autocreate ? ' — a new item will be created.' : ' and nothing similar exists.'}`));
  }
  return { sku, issues, unknown: true };
}

// ---------- statistics ----------
function robust(vals) {
  const l = vals.filter(v => v > 0).map(Math.log10).sort((a, b) => a - b);
  if (!l.length) return null;
  const median = a => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
  const med = median(l);
  const mad = median(l.map(x => Math.abs(x - med)).sort((a, b) => a - b));
  return { n: l.length, med, mad };
}

/**
 * Validate one line.
 * row:  { sku_raw, qty_raw, unit_raw, price_raw, amount_raw, weight_raw, method, confidence, candidates }
 * doc:  { locale, kind, ref, party }
 * ctx:  see top of file.
 * Returns { sku, qty, status, issues, verified[] }
 */
function validateLine(row, doc, ctx, opts = {}) {
  const issues = [];
  const verified = [];
  const kind = doc.kind;
  const creating = kind === 'items';
  const r = resolveSku(row.sku_raw, ctx, { creating, autocreate: !!opts.autocreate });
  issues.push(...r.issues);
  const sku = r.sku;
  const item = ctx.item(sku);
  const uw = item ? item.unit_weight || 0 : 0;
  const countUom = !item || /^(pcs?|each|ea|nos?|sets?|units?)$/i.test(item.uom || 'pcs');

  // ----- quantity -----
  const qtyBlankOk = kind === 'items';
  const pq = parseNumber(row.qty_raw, doc.locale);
  let qty = pq.value;
  if (qty == null) {
    if (!qtyBlankOk || String(row.qty_raw || '').trim())
      issues.push(issue('QTY_MISSING', 'block', `No readable quantity${row.qty_raw ? ` ("${row.qty_raw}")` : ''}.`));
    return finish({ sku, qty: null, issues, verified, row });
  }

  if (row.confidence === 'low') {
    issues.push(issue('QTY_COLUMN_UNCERTAIN', 'block',
      `Couldn't tell which number on this line is the quantity` +
      (row.candidates?.length ? ` (numbers found: ${row.candidates.join(', ')}).` : '.') +
      ` The old importer would have used ${row.qty_raw} without asking.`));
  } else if (row.method === 'arithmetic') {
    issues.push(issue('QTY_BY_ARITHMETIC', 'info', `No table header found; quantity identified because ${row.qty_raw} × ${row.price_raw} = ${row.amount_raw}.`));
  } else if (row.method === 'weight') {
    issues.push(issue('QTY_BY_WEIGHT', 'info', `No table header found; quantity identified because ${row.qty_raw} × ${uw} kg ≈ ${row.weight_raw} kg.`));
  }

  if (qty < 0) {
    issues.push(issue('QTY_NEGATIVE', 'block',
      `Quantity is negative (${row.qty_raw}). A document can't order or deliver a negative number of pieces — ` +
      `this is exactly how "-31,250 bolts" ended up in the old spreadsheet.`,
      { qty: Math.abs(qty) }));
  } else if (qty === 0) {
    issues.push(issue('QTY_ZERO', 'block', 'Quantity is zero.'));
  }

  if (pq.ambiguous) {
    issues.push(issue('QTY_AMBIGUOUS_FORMAT', 'warn',
      `"${row.qty_raw}" can be read as ${fmt(qty)} or ${pq.alternatives.map(fmt).join(' / ')} depending on whether "." is a ` +
      `thousands or decimal separator, and nothing else in the file settles it. Read as ${fmt(qty)}.`,
      { qty }));
  }

  // ----- units -----
  const uRaw = row.unit_raw || pq.unit;
  const uk = unitKind(uRaw);
  if (uk && uk.kind === 'mass') {
    const kgs = Math.abs(qty) * uk.toKg;
    const pcs = uw > 0 ? Math.round(kgs / uw) : null;
    issues.push(issue('UNIT_MASS', 'block',
      `Quantity is given in ${uRaw} (${fmt(kgs)} kg), but ${sku} is counted in ${item?.uom || 'pieces'}.` +
      (pcs ? ` At ${uw} kg each that is about ${fmt(pcs)} pcs.` : ' No unit weight on file to convert.'),
      pcs ? { qty: pcs } : null));
    qty = Math.abs(qty);
  } else if (uk && uk.kind === 'pack') {
    issues.push(issue('UNIT_PACK', 'block',
      `Quantity is in ${uRaw}, not pieces. ${fmt(qty)} ${uRaw} must be converted with the pack size before it can be booked.`));
  } else if (uk && uk.kind === 'length' && countUom) {
    issues.push(issue('UNIT_LENGTH', 'block', `Quantity is a length (${uRaw}) but ${sku} is counted in pieces.`));
  } else if (uk && uk.kind === 'unknown') {
    issues.push(issue('UNIT_UNKNOWN', 'warn', `Unrecognised unit "${uRaw}". Assumed ${item?.uom || 'pcs'}.`));
  }

  if (qty > 0 && countUom && !Number.isInteger(qty) && !(uk && uk.kind === 'mass')) {
    const intAlt = (pq.alternatives || []).find(v => Number.isInteger(v) && v > 0);
    issues.push(issue('QTY_FRACTIONAL', 'block',
      `${fmt(qty)} isn't a whole number of ${item?.uom || 'pieces'}.` + (intAlt ? ` Probably ${fmt(intAlt)} (thousands separator).` : ''),
      intAlt ? { qty: intAlt } : null));
  }

  // ----- arithmetic cross-check: qty × unit price = amount -----
  const pp = parseNumber(row.price_raw, doc.locale), pa = parseNumber(row.amount_raw, doc.locale);
  if (qty > 0 && pp.value > 0 && pa.value > 0) {
    // A price printed with d decimals is only known to ±0.5·10^-d, so the
    // amount is only checkable to qty × that, plus the amount's own rounding.
    const tol = qty * 0.5 * Math.pow(10, -decimalsOf(row.price_raw, doc.locale)) +
                0.5 * Math.pow(10, -decimalsOf(row.amount_raw, doc.locale)) + 1e-9;
    const expected = qty * pp.value;
    if (Math.abs(expected - pa.value) <= tol) {
      verified.push('arithmetic');
    } else {
      const implied = pa.value / pp.value;
      const near = Math.round(implied);
      const clean = Math.abs(implied - near) * pp.value <= tol && near > 0;
      issues.push(issue('ARITH_MISMATCH', 'block',
        `Quantity × unit price doesn't match the line amount: ${fmt(qty)} × ${row.price_raw} = ${fmt(expected)}, ` +
        `but the document says ${row.amount_raw}.` + (clean ? ` The amount implies ${fmt(near)}.` : ''),
        clean ? { qty: near } : null));
    }
  }

  // ----- weight cross-check: qty × unit weight ≈ stated weight -----
  const pw = parseNumber(row.weight_raw, doc.locale);
  if (qty > 0 && pw.value > 0 && uw > 0) {
    const expected = qty * uw;
    const ratio = pw.value / expected;
    if (Math.abs(ratio - 1) <= T.weightTol) {
      verified.push('weight');
    } else {
      const k = Math.round(Math.log10(ratio));
      const powerOf10 = k !== 0 && Math.abs(ratio / Math.pow(10, k) - 1) <= T.weightTol;
      const implied = Math.round(pw.value / uw);
      issues.push(issue('WEIGHT_MISMATCH', powerOf10 ? 'block' : 'warn',
        `Stated weight ${fmt(pw.value)} kg doesn't fit ${fmt(qty)} × ${uw} kg = ${fmt(expected)} kg ` +
        `(off by ×${fmt(+ratio.toFixed(2))}).` + (powerOf10 ? ` A factor of exactly 10^${k} usually means a zero was added or dropped; the weight implies about ${fmt(implied)}.` : ''),
        powerOf10 ? { qty: Math.round(qty * Math.pow(10, k)) } : null));
    }
  }

  // ----- plausibility against history (weaker evidence; never alone a block) -----
  if (qty > 0) {
    let stats = null, scope = null, thr = 0;
    const own = robust(ctx.history(sku, doc.ref) || []);
    if (own && own.n >= T.minSkuHistory) { stats = own; scope = 'sku'; thr = Math.max(T.magnitudeSkuDex, 3 * 1.4826 * own.mad); }
    else if (item?.category) {
      const g = robust(ctx.groupHistory(item.category, doc.ref) || []);
      if (g && g.n >= T.minGroupHistory) { stats = g; scope = 'category'; thr = Math.max(T.magnitudeGroupDex, 3 * 1.4826 * g.mad); }
    }
    if (stats) {
      const d = Math.log10(qty) - stats.med;
      if (Math.abs(d) >= thr) {
        const typical = Math.round(Math.pow(10, stats.med));
        const k = Math.round(d);
        const corrected = k !== 0 ? qty / Math.pow(10, k) : null;
        const confirmed = verified.length > 0;
        issues.push(issue('MAGNITUDE_OUTLIER', confirmed ? 'info' : 'warn',
          `${fmt(qty)} is about ${fmt(+Math.pow(10, Math.abs(d)).toFixed(0))}× ${d > 0 ? 'more' : 'less'} than usual for ` +
          `${scope === 'sku' ? 'this SKU' : `"${item.category}" items`} (typical ≈ ${fmt(typical)}, from ${stats.n} past lines).` +
          (confirmed ? ` But ${verified.join(' and ')} on the document agree with it, so it is probably real.` : ''),
          !confirmed && corrected && Number.isInteger(corrected) ? { qty: corrected } : null));
      }
    }
    if (uw > 0 && qty * uw > T.maxLineKg)
      issues.push(issue('PHYSICAL_WEIGHT', 'warn',
        `${fmt(qty)} × ${uw} kg = ${fmt(Math.round(qty * uw))} kg on one line — more than any stock position on record (${fmt(T.maxLineKg)} kg limit).`));
  }

  // ----- sales orders: availability is information, not an error -----
  if (kind === 'so' && qty > 0 && item && ctx.available) {
    const a = ctx.available(sku);
    if (a < qty) issues.push(issue('SO_SHORT', 'info', `Only ${fmt(a)} available now — the line will be short on confirm.`));
  }

  return finish({ sku, qty, issues, verified, row });
}

function finish({ sku, qty, issues, verified }) {
  const worst = issues.reduce((m, i) => Math.max(m, SEV[i.severity]), 0);
  return { sku, qty, issues, verified, status: ['ok', 'warn', 'block'][worst] };
}

/**
 * Validate a whole document. Adds the checks that only make sense across
 * lines: duplicate file, duplicate reference, near-duplicate document,
 * repeated SKU, and the document's own printed totals.
 */
function validateDoc({ kind, rows, doc, ctx, opts = {} }) {
  const lines = rows.map(row => ({ row, ...validateLine(row, { ...doc, kind }, ctx, opts) }));
  const batch = [];

  // Repeated SKU — v1 silently summed these on PDFs.
  const seen = new Map();
  for (const l of lines) {
    if (!l.sku) continue;
    if (seen.has(l.sku)) {
      const first = seen.get(l.sku);
      l.issues.push(issue('DUPLICATE_LINE', 'warn',
        `${l.sku} already appears on line ${first.row.line_no}${first.qty === l.qty ? ' with the same quantity' : ''}. ` +
        `Confirm both lines are real (a copy-paste repeat would double the order).`));
      Object.assign(l, finish(l));
    } else seen.set(l.sku, l);
  }

  if (doc.file_hash && ctx.fileSeen) {
    const prev = ctx.fileSeen(doc.file_hash);
    if (prev) batch.push(issue('DUPLICATE_FILE', 'block',
      `This exact file was already imported (batch #${prev.id}, ${prev.ts}${prev.ref ? `, ${prev.ref}` : ''}). Importing it again would double every line.`));
  }
  if (doc.ref && ctx.refExists) {
    const prev = ctx.refExists(kind, doc.ref);
    if (prev) batch.push(issue('DUPLICATE_REF', 'block',
      `A ${kind === 'po' ? 'purchase' : 'sales'} order with reference ${doc.ref} already exists (#${prev.id}, ${prev.status}).`));
  }
  if (ctx.similarDocs && (kind === 'po' || kind === 'so')) {
    const sig = lines.filter(l => l.sku && l.qty > 0).map(l => `${l.sku}|${l.qty}`);
    for (const s of ctx.similarDocs(kind, sig, doc.ref) || []) {
      if (s.similarity >= 0.8)
        batch.push(issue('NEAR_DUPLICATE_DOC', 'warn',
          `${Math.round(s.similarity * 100)}% of these lines (same SKU and quantity) match open order ${s.ref || '#' + s.id}. Is this the same order sent twice?`));
    }
  }

  // Printed totals: does any number on a "Total" line equal a column sum?
  if (doc.totals?.length) {
    const sums = {
      qty: lines.reduce((a, l) => a + (l.qty > 0 ? l.qty : 0), 0),
      amount: rows.reduce((a, r) => a + (parseNumber(r.amount_raw, doc.locale).value || 0), 0),
      weight: rows.reduce((a, r) => a + (parseNumber(r.weight_raw, doc.locale).value || 0), 0),
    };
    let matched = [], printed = [];
    for (const t of doc.totals) for (const n of t.numbers) {
      const v = parseNumber(n.raw, doc.locale).value;
      if (v == null) continue;
      printed.push(n.raw);
      for (const [k, s] of Object.entries(sums)) {
        // Any printed total equal to a column sum counts, whichever column it
        // appears under: totals rows are often offset from the columns above.
        if (s > 0 && Math.abs(v - s) <= Math.max(0.011, s * 0.0005))
          matched.push(k);
      }
    }
    if (printed.length && !matched.length) {
      batch.push(issue('DOC_TOTAL_MISMATCH', 'warn',
        `The document's printed total (${printed.join(', ')}) doesn't equal the sum of the lines read ` +
        `(qty ${fmt(sums.qty)}${sums.amount ? `, amount ${fmt(+sums.amount.toFixed(2))}` : ''}). A line may be missing or misread.`));
    } else if (matched.length) {
      batch.push(issue('DOC_TOTAL_OK', 'info', `Printed document total matches the sum of the lines (${[...new Set(matched)].join(', ')}).`));
    }
  }
  if (doc.localeConflict) batch.push(issue('LOCALE_CONFLICT', 'warn',
    'This file mixes 1,234.50-style and 1.234,50-style numbers. Check every quantity.'));
  if (!lines.length) batch.push(issue('NO_LINES', 'block', 'No item lines were found in this file.'));

  const worst = batch.reduce((m, i) => Math.max(m, SEV[i.severity]), 0);
  return { lines, batchIssues: batch, batchStatus: ['ok', 'warn', 'block'][worst] };
}

module.exports = { validateLine, validateDoc, resolveSku, nearestSkus, lev, robust, THRESHOLDS: T, SEV };
