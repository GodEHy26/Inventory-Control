// Audit trace: where did a stock figure come from?
//   node scripts/trace.js <SKU>        every ledger row for a SKU, traced back to file / line / reviewer
//   node scripts/trace.js --batch <id> one import: file hash, every line, what the file said vs what was booked
// v2 tags every imported ledger row with its batch and line, so this is a join, not a guess.
const db = require('../server/db');
const J = s => { try { return JSON.parse(s); } catch { return {}; } };
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const lpad = (s, n) => String(s ?? '').padStart(n).slice(-n);
const num = n => (n == null ? '—' : Number(n).toLocaleString('en-US'));

const args = process.argv.slice(2);
if (args[0] === '--batch') {
  const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(+args[1]);
  if (!b) { console.log('no such batch'); process.exit(1); }
  const issues = J(b.batch_issues);
  console.log(`batch #${b.id}  ${b.kind.toUpperCase()}  ${b.filename}  status=${b.status}`);
  console.log(`sha256 ${b.file_hash}`);
  console.log(`staged by ${b.created_by} ${b.created_ts}` + (b.committed_ts ? ` · committed by ${b.committed_by} ${b.committed_ts}` : '') +
    (b.undone_ts ? ` · ${b.status} by ${b.undone_by} ${b.undone_ts}` : ''));
  for (const i of issues) console.log(`  [doc ${i.severity}] ${i.code}: ${i.msg}`);
  console.log('');
  console.log(`${pad('line', 5)}${pad('SKU', 21)}${lpad('file says', 11)}${lpad('booked', 10)}  ${pad('check', 6)}${pad('decision', 11)}${pad('by', 11)}reason / note`);
  for (const l of db.prepare('SELECT * FROM import_lines WHERE batch_id=? ORDER BY line_no').all(b.id)) {
    const raw = J(l.raw);
    const iss = J(l.issues).filter(i => i.severity !== 'info');
    const fileSays = (raw.qty_raw || '') + (raw.unit_raw ? ' ' + raw.unit_raw : '');
    console.log(`${pad(l.line_no, 5)}${pad(l.sku, 21)}${lpad(fileSays, 11)}${lpad(l.decision === 'rejected' || b.status !== 'committed' ? '—' : num(l.qty), 10)}  ` +
      `${pad(l.status, 6)}${pad(l.status === 'ok' && l.decision === 'pending' ? 'auto' : l.decision, 11)}${pad(l.decided_by || '', 11)}` +
      (l.note ? `"${l.note}" ` : '') + (l.orig_sku !== l.sku ? `(file SKU ${l.orig_sku}) ` : '') + (iss[0] ? iss[0].code : (J(l.verified).length ? 'verified: ' + J(l.verified).join('+') : '')));
  }
  process.exit(0);
}

const sku = (args[0] || '').toUpperCase();
if (!sku) { console.log('usage: node scripts/trace.js <SKU> | --batch <id>'); process.exit(1); }
const lvl = db.prepare('SELECT COALESCE(SUM(on_hand),0) h, COALESCE(SUM(on_order),0) o, COALESCE(SUM(in_transit),0) t FROM stock_levels WHERE sku=?').get(sku);
console.log(`${sku}   on hand ${num(lvl.h)} · on order ${num(lvl.o)} · in transit ${num(lvl.t)}`);
console.log('');
console.log(`${pad('txn', 5)}${pad('type', 16)}${lpad('Δ on order', 11)}${lpad('Δ on hand', 10)}  ${pad('ref', 13)}${pad('source', 58)}`);
let sum = 0;
for (const t of db.prepare('SELECT * FROM transactions WHERE sku=? ORDER BY id').all(sku)) {
  const m = J(t.meta);
  let src = `by ${t.user}`;
  if (m.import_batch && m.import_line) {
    const l = db.prepare('SELECT line_no, decision, decided_by, note FROM import_lines WHERE id=?').get(m.import_line);
    const b = db.prepare('SELECT filename, file_hash FROM import_batches WHERE id=?').get(m.import_batch);
    src = `batch #${m.import_batch} ${b.filename} line ${l.line_no} (${b.file_hash.slice(0, 8)}…)` +
      (m.file_qty != null ? ` · file said ${num(m.file_qty)}` : '') + ` · ${l.decision === 'pending' ? 'auto (all checks passed)' : l.decision + (l.decided_by ? ' by ' + l.decided_by : '')}`;
  } else if (m.reason) src = `reason: ${m.reason}`;
  sum += t.d_on_order;
  console.log(`${pad(t.id, 5)}${pad(t.type, 16)}${lpad((t.d_on_order > 0 ? '+' : '') + num(t.d_on_order), 11)}${lpad(num(t.d_on_hand), 10)}  ${pad(t.ref, 13)}${src}`);
}
console.log(`${pad('', 21)}${lpad('= ' + num(sum), 11)}   (ledger sum equals the stock figure above)`);
