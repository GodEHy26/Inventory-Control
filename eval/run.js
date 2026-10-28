// v1 vs v2 on the same files. Usage: node eval/run.js  (≈1–2 min)
// Writes eval/results/results.json, eval/results/REPORT.md and sample files.
//
// The question being measured is the one that matters to the business:
//   "After importing this file, which stock lines are wrong, and did
//    anything warn us?"
// A wrong line that came with a warning costs someone a minute. A wrong line
// with no warning costs a short shipment or a phantom order weeks later.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'results');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-eval-'));
process.env.DATA_DIR = TMP;
execFileSync(process.execPath, [path.join(ROOT, 'scripts/seed.js')], { env: { ...process.env, DATA_DIR: TMP }, stdio: 'ignore' });

// Silence pdf.js's canvas warnings (it only needs text, not rendering).
const warn = console.warn, log = console.log;
const quiet = (f) => (...a) => { if (!/polyfill|canvas|Require stack|^- /i.test(String(a[0]))) f(...a); };
console.warn = quiet(warn); console.log = quiet(log);

const v1 = require('./baseline_v1/imports_v1');
const imports = require('../server/imports');
const { validateDoc, nearestSkus } = require('../server/validate');
const G = require('./generate');

const seedData = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/seed/seed.json'), 'utf8'));
const ALL_SKUS = [...G.ITEMS.keys()];
const KNOWN = new Set(ALL_SKUS);

// ---------- the validation context for the offline run ----------
// "History" = the other real documents (leave-one-document-out), i.e. what the
// system would have seen from earlier orders. Duplicate detection uses what has
// been committed earlier in the same run.
function makeCtx() {
  const byRefSku = seedData.shipments;
  const committedHashes = new Map(), committedRefs = new Map(), committedSigs = [];
  return {
    item: s => G.ITEMS.get(s) || null,
    skus: () => ALL_SKUS,
    history: (sku, ref) => byRefSku.filter(s => s.sku === sku && s.ref !== baseRef(ref)).map(s => s.qty),
    groupHistory: (cat, ref) => byRefSku.filter(s => G.ITEMS.get(s.sku)?.category === cat && s.ref !== baseRef(ref)).map(s => s.qty),
    fileSeen: h => committedHashes.get(h) || null,
    refExists: (k, ref) => committedRefs.get(ref) || null,
    similarDocs: (k, sig, ref) => committedSigs.filter(d => d.ref !== ref).map(d => {
      const a = new Set(sig); let inter = 0; for (const s of a) if (d.sig.has(s)) inter++;
      return { ref: d.ref, similarity: inter / (a.size + d.sig.size - inter) };
    }).filter(x => x.similarity >= 0.8),
    _commit(hash, ref, sig) {
      const id = committedHashes.size + 1;
      committedHashes.set(hash, { id, ts: 'earlier in this run', ref });
      committedRefs.set(ref, { id, status: 'ordered' });
      committedSigs.push({ ref, sig: new Set(sig) });
    },
  };
}
const baseRef = r => String(r || '').replace(/-S\d+$/, '');

// ---------- run one file through v1 ----------
async function runV1(filename, buf) {
  const parsed = await v1.parseFile(filename, buf.toString('base64'));
  const written = new Map(), reported = new Set();
  for (const r of parsed.rows) {
    const sku = (r.sku || '').toUpperCase();
    if (!sku || !(r.qty > 0)) { reported.add(sku); continue; }            // "Row skipped"
    if (!KNOWN.has(sku)) { reported.add(sku); continue; }                  // "Unknown SKU"
    written.set(sku, (written.get(sku) || 0) + r.qty);
  }
  return { written, reported };
}

// ---------- run one file through v2 ----------
async function runV2(filename, buf, doc, ctx) {
  const parsed = await imports.parseFile(filename, buf.toString('base64'),
    { kind: 'po', known: KNOWN, itemOf: s => G.ITEMS.get(s) });
  const d = { ...parsed.doc, kind: 'po', ref: doc.ref, party: doc.supplier };
  const v = validateDoc({ kind: 'po', rows: parsed.rows, doc: d, ctx });
  const batchFlag = v.batchIssues.some(i => i.severity !== 'info');
  return { v, batchFlag, hash: parsed.doc.file_hash, parsed };
}

// ---------- scoring ----------
// unit = (import event, SKU). truth[sku] is what should be booked.
function score(event, printed, sys, kind) {
  const truth = new Map();
  if (!event.duplicate) for (const p of printed) if (!p.extra) truth.set(p.truthSku, (truth.get(p.truthSku) || 0) + p.truthQty);
  const units = new Set([...truth.keys(), ...sys.written.keys()]);
  const out = [];
  for (const sku of units) {
    const T = truth.get(sku) || 0, W = sys.written.get(sku) || 0;
    const related = printed.filter(p => p.truthSku === sku || p.sku === sku);
    // "Something was wrong" = an injected error, a duplicate import, or the
    // file being read wrongly (e.g. a misread PDF column) — even with no
    // injected error. A flag on a line where none of these hold is a false alarm.
    const asRead = sys.asRead(sku);
    const errored = event.duplicate || related.some(p => p.err) || asRead !== T;
    const flagged = sys.flagged(sku, related);
    let outcome;
    if (flagged) {
      if (errored) outcome = 'caught';
      // A clean line inside a document that is held as a whole (for a document-level
      // reason). If that document really has a problem elsewhere, holding it is right;
      // if the document is entirely clean, it's a false alarm.
      else if (!sys.lineFlag(sku, related)) outcome = event.docHasError ? 'held_with_doc' : 'false_alarm';
      else outcome = 'false_alarm';
    } else outcome = W === T ? 'correct' : 'silent';
    out.push({ sku, T, W, outcome, errs: [...new Set(related.map(p => p.err).filter(Boolean))], duplicate: !!event.duplicate });
  }
  return out;
}

function v2System(res, printed) {
  const written = new Map();
  if (!res.batchFlag) for (const l of res.v.lines) if (l.status === 'ok' && l.qty > 0)
    written.set(l.sku, (written.get(l.sku) || 0) + l.qty);
  // Map parsed lines back to printed lines (same order, matched by printed SKU text).
  const statusOf = new Map();
  let j = 0;
  for (const l of res.v.lines) {
    while (j < printed.length && printed[j].sku.toUpperCase() !== String(l.row.sku_raw || '').toUpperCase()) j++;
    if (j < printed.length) { statusOf.set(printed[j], l); j++; }
  }
  const read = new Map();
  for (const l of res.v.lines) if (l.qty > 0) read.set(l.sku, (read.get(l.sku) || 0) + l.qty);
  return {
    written, asRead: sku => read.get(sku) || 0,
    flagged: (sku, related) => res.batchFlag || related.some(p => statusOf.get(p) && statusOf.get(p).status !== 'ok') ||
      res.v.lines.some(l => l.sku === sku && l.status !== 'ok'),
    lineFlag: (sku, related) => related.some(p => statusOf.get(p) && statusOf.get(p).status !== 'ok') ||
      res.v.lines.some(l => l.sku === sku && l.status !== 'ok'),
    statusOf,
  };
}
function v1System(res) {
  return { written: res.written, asRead: sku => res.written.get(sku) || 0, lineFlag: () => true, flagged: (sku, related) => related.some(p => res.reported.has(p.sku.toUpperCase())) };
}

const FORMATS = [
  { id: 'csv-min', label: 'CSV, quantity only', kind: 'csv', full: false },
  { id: 'csv-full', label: 'CSV with price, amount, weight', kind: 'csv', full: true },
  { id: 'pdf-A', label: 'PDF invoice (Qty · Price · Amount)', kind: 'pdf', layout: 'A' },
  { id: 'pdf-B', label: 'PDF order (Price · Amount · Qty)', kind: 'pdf', layout: 'B' },
  { id: 'pdf-C', label: 'PDF packing list (Qty · Unit · Weight)', kind: 'pdf', layout: 'C' },
  { id: 'pdf-A-nohdr', label: 'PDF invoice, no header row', kind: 'pdf', layout: 'A', header: false },
];

async function render(fmt, doc, printed, eu, jitter = 0, seedN = 1) {
  if (fmt.kind === 'csv') return { name: `${doc.ref}.csv`, buf: G.renderCsv(doc, printed, { full: fmt.full, eu }) };
  return { name: `${doc.ref}.pdf`, buf: await G.renderPdf(doc, printed, { layout: fmt.layout, eu, header: fmt.header !== false, jitter, seedN }) };
}

async function scenario(fmt, { rate, euShare, dupShare, seedN, jitter = 0 }) {
  const docs = G.realDocs();
  const r = G.rng(seedN);
  const ctx = makeCtx();
  const plan = docs.map(d => ({ doc: d, eu: r() < euShare, dup: r() < dupShare }));
  const events = [];
  for (const p of plan) events.push({ ...p, duplicate: false });
  for (const p of plan) if (p.dup) events.push({ ...p, duplicate: true });
  const units = { v1: [], v2: [] }, lines = [];
  let docsAuto = 0, docsCleanAuto = 0, docsClean = 0, docsTotal = 0;
  const cache = new Map();
  for (const ev of events) {
    const key = ev.doc.id;
    if (!cache.has(key)) {
      const printed = G.inject(ev.doc, { rate, seedN: seedN * 1000 + ev.doc.id, eu: ev.eu });
      cache.set(key, { printed, file: await render(fmt, ev.doc, printed, ev.eu, jitter, seedN * 7 + ev.doc.id) });
    }
    const { printed, file } = cache.get(key);
    const event = { duplicate: ev.duplicate, docHasError: ev.duplicate || printed.some(p => p.err) };
    const r1 = await runV1(file.name, file.buf);
    const r2 = await runV2(file.name, file.buf, ev.doc, ctx);
    const s2 = v2System(r2, printed);
    units.v1.push(...score(event, printed, v1System(r1)).map(u => ({ ...u, eu: ev.eu })));
    units.v2.push(...score(event, printed, s2).map(u => ({ ...u, eu: ev.eu })));
    // line-level detail for v2
    for (const p of printed) {
      const l = s2.statusOf.get(p);
      if (p.err === 'DUPLINE' && !p.extra && !ev.duplicate) continue; // count the repeated copy, not the original
      lines.push({ err: ev.duplicate ? 'DUPFILE' : p.err, eu: ev.eu, status: l ? l.status : 'missing',
        batchFlag: r2.batchFlag, read: l ? { sku: l.sku, qty: l.qty } : null, truth: { sku: p.truthSku, qty: ev.duplicate ? 0 : p.truthQty },
        suggestOk: l ? l.issues.some(i => i.suggest && ((i.suggest.qty != null && i.suggest.qty === p.truthQty) || (i.suggest.sku && i.suggest.sku === p.truthSku))) : false,
        codes: l ? l.issues.filter(i => i.severity !== 'info').map(i => i.code) : [] });
    }
    docsTotal++;
    const clean = !ev.duplicate && printed.every(p => !p.err);
    const auto = !r2.batchFlag && r2.v.lines.every(l => l.status === 'ok');
    if (auto) docsAuto++;
    if (clean) { docsClean++; if (auto) docsCleanAuto++; }
    if (!ev.duplicate) ctx._commit(r2.hash, ev.doc.ref, printed.filter(p => !p.extra).map(p => `${p.truthSku}|${p.truthQty}`));
  }
  return { units, lines, docs: { total: docsTotal, auto: docsAuto, clean: docsClean, cleanAuto: docsCleanAuto } };
}

function tally(units) {
  const t = { correct: 0, caught: 0, silent: 0, false_alarm: 0, held_with_doc: 0, n: units.length };
  for (const u of units) t[u.outcome]++;
  return t;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const results = { generated: new Date().toISOString(), config: {}, formats: {}, clean: {}, byError: {}, jitter: {}, examples: [] };

  // ---- 1. Clean real documents: how often does v2 bother a person for nothing? ----
  for (const f of FORMATS) {
    const s = await scenario(f, { rate: 0, euShare: 0, dupShare: 0, seedN: 11 });
    results.clean[f.id] = { label: f.label, v1: tally(s.units.v1), v2: tally(s.units.v2), docs: s.docs,
      flaggedLines: s.lines.filter(l => l.status !== 'ok').length, lines: s.lines.length,
      flagCodes: s.lines.flatMap(l => l.codes).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}) };
  }

  // ---- 2. Realistic mix: 20% of lines carry an injected error, 20% of documents
  //         use 1.234,5 number style, 15% of documents get imported twice. ----
  const cfg = { rate: 0.2, euShare: 0.2, dupShare: 0.15 };
  results.config = { ...cfg, seeds: [1, 2, 3, 4, 5], documents: G.realDocs().length,
    lines: G.realDocs().reduce((a, d) => a + d.lines.length, 0) };
  const allLines = [];
  for (const f of FORMATS) {
    const agg = { v1: [], v2: [], docs: { total: 0, auto: 0, clean: 0, cleanAuto: 0 } };
    for (const seedN of results.config.seeds) {
      const s = await scenario(f, { ...cfg, seedN });
      agg.v1.push(...s.units.v1); agg.v2.push(...s.units.v2);
      for (const k in agg.docs) agg.docs[k] += s.docs[k];
      allLines.push(...s.lines.map(l => ({ ...l, fmt: f.id })));
    }
    const erroneous = u => u.outcome !== 'false_alarm' && (u.errs.length || u.duplicate || u.W !== u.T);
    results.formats[f.id] = { label: f.label, v1: tally(agg.v1), v2: tally(agg.v2), docs: agg.docs,
      v1WrongUnits: agg.v1.filter(u => u.W !== u.T).length, v2WrongUnits: agg.v2.filter(u => u.W !== u.T && u.outcome !== 'caught').length,
      euV1Silent: agg.v1.filter(u => u.eu && u.outcome === 'silent').length };
  }
  // per error type, line level (v2) and unit level (v1)
  for (const e of [...G.ERROR_TYPES, 'DUPFILE']) {
    const ls = allLines.filter(l => l.err === e);
    const wrongAsRead = l => !l.read || l.read.sku !== l.truth.sku || l.read.qty !== l.truth.qty;
    const caughtLine = ls.filter(l => l.status === 'warn' || l.status === 'block');
    const caughtDoc = ls.filter(l => l.status === 'ok' && l.batchFlag);
    const silent = ls.filter(l => l.status === 'ok' && !l.batchFlag && wrongAsRead(l));
    results.byError[e] = { n: ls.length, caughtLine: caughtLine.length, caughtDocOnly: caughtDoc.length,
      silent: silent.length, blocked: ls.filter(l => l.status === 'block').length,
      suggestOk: caughtLine.filter(l => l.suggestOk).length,
      silentByFmt: silent.reduce((m, l) => (m[l.fmt] = (m[l.fmt] || 0) + 1, m), {}) };
  }

  // ---- 3. Stress test: page layout noise (like ε in the adversarial paper). ----
  // Every printed cell is nudged left/right by up to σ points. v1 ignores
  // layout (it always takes the last number) so it is flat; the question for
  // v2 is whether misreads turn into flags or into silent errors.
  for (const layout of ['A', 'B', 'C']) {
    const f = FORMATS.find(x => x.id === `pdf-${layout}`);
    results.jitter[layout] = [];
    for (const sigma of [0, 5, 10, 15, 20, 30, 40]) {
      const s = await scenario(f, { rate: 0, euShare: 0, dupShare: 0, seedN: 21, jitter: sigma });
      const L = s.lines;
      const readOk = L.filter(l => l.read && l.read.qty === l.truth.qty && l.read.sku === l.truth.sku).length;
      const silent = L.filter(l => l.status === 'ok' && !l.batchFlag && (!l.read || l.read.qty !== l.truth.qty)).length;
      const flagged = L.filter(l => l.status !== 'ok' || l.batchFlag).length;
      const v1silent = s.units.v1.filter(u => u.outcome === 'silent').length;
      results.jitter[layout].push({ sigma, n: L.length, readOk, silent, flagged, v1Units: s.units.v1.length, v1silent });
    }
  }

  // ---- 4. Example files for the README / portfolio ----
  const ex = G.realDocs().find(d => d.lines.length >= 6 && d.lines.length <= 9);
  const printed = G.inject(ex, { rate: 0.5, seedN: 4242, eu: false });
  fs.mkdirSync(path.join(OUT, 'samples'), { recursive: true });
  for (const f of FORMATS.filter(x => ['csv-full', 'pdf-A', 'pdf-C'].includes(x.id))) {
    const file = await render(f, ex, printed, false);
    const fn = `sample_${f.id}.${f.kind}`;
    fs.writeFileSync(path.join(OUT, 'samples', fn), file.buf);
    const r1 = await runV1(file.name, file.buf);
    const r2 = await runV2(file.name, file.buf, ex, makeCtx());
    results.examples.push({ file: fn, format: f.label, lines: printed.map((p, i) => {
      const l = v2System(r2, printed).statusOf.get(p);
      return { printedSku: p.sku, err: p.err, truth: p.extra ? 0 : p.truthQty, truthSku: p.truthSku,
        v1: r1.written.get(p.sku.toUpperCase()) ?? null, v2: l ? { qty: l.qty, status: l.status, issues: l.issues.filter(x => x.severity !== 'info').map(x => x.msg) } : null };
    }) });
  }
  results.seconds = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  log(`done in ${results.seconds}s → eval/results/results.json`);
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exit(1); });
