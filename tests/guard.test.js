// node --test tests/   — unit tests for the v2 checks and an end-to-end
// import → review → commit → undo run over HTTP on a throwaway database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-test-'));
process.env.DATA_DIR = TMP;
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'seed.js')], { env: { ...process.env }, stdio: 'ignore' });

const { parseNumber, inferLocale } = require('../server/numbers');
const { validateLine, resolveSku } = require('../server/validate');
const { resolveByArithmetic } = require('../server/pdfparse');

const ITEM = { sku: 'BA325MT1GCM12X030F', uom: 'pcs', unit_weight: 0.052, category: 'Bolt' };
const ctx = { item: s => (s === ITEM.sku ? ITEM : s === 'BA325MT1GCM12X040F' ? { ...ITEM, sku: s } : null),
  skus: () => [ITEM.sku, 'BA325MT1GCM12X040F'], history: () => [4000, 4000, 4500, 3500], groupHistory: () => [] };
const line = (o) => validateLine({ sku_raw: ITEM.sku, method: 'table', confidence: 'high', ...o }, { kind: 'po', locale: 'us' }, ctx);
const codes = r => r.issues.map(i => i.code);

test('numbers: separators are read, and ambiguity is admitted', () => {
  assert.strictEqual(parseNumber('1,250').value, 1250);
  assert.strictEqual(parseNumber('1.234,50').value, 1234.5);
  assert.strictEqual(parseNumber('0.162').value, 0.162);          // regression: was read as 162
  assert.strictEqual(parseNumber('(900)').value, -900);
  assert.strictEqual(parseNumber('5000 pcs').unit, 'pcs');
  const p = parseNumber('1.250');
  assert.ok(p.ambiguous && p.alternatives.includes(1.25));
  assert.strictEqual(parseNumber('1.250', 'eu').value, 1250);
  assert.strictEqual(inferLocale(['0,12', '600,00', '5.000']).locale, 'eu');
});

test('a consistent line passes and says why', () => {
  const r = line({ qty_raw: '5000', price_raw: '0.12', amount_raw: '600.00', weight_raw: '262' });
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.verified, ['arithmetic', 'weight']);
});

test('negative quantity is blocked (the -31,250 case)', () => {
  const r = line({ qty_raw: '-31250' });
  assert.strictEqual(r.status, 'block');
  assert.ok(codes(r).includes('QTY_NEGATIVE'));
});

test('qty × price ≠ amount is blocked with the implied quantity', () => {
  const r = line({ qty_raw: '2000', price_raw: '0.20', amount_raw: '4000.00' });
  const i = r.issues.find(x => x.code === 'ARITH_MISMATCH');
  assert.strictEqual(r.status, 'block');
  assert.strictEqual(i.suggest.qty, 20000);
});

test('price rounding is tolerated: 0.05 printed, true price 0.0523', () => {
  assert.strictEqual(line({ qty_raw: '5000', price_raw: '0.05', amount_raw: '261.50' }).status, 'ok');
});

test('kg instead of pieces is converted, not trusted', () => {
  const r = line({ qty_raw: '260', unit_raw: 'kg' });
  assert.strictEqual(r.status, 'block');
  assert.strictEqual(r.issues.find(x => x.code === 'UNIT_MASS').suggest.qty, 5000);
});

test('an extra zero is caught by weight, and by history when nothing else exists', () => {
  const w = line({ qty_raw: '50000', weight_raw: '262' });
  assert.strictEqual(w.issues.find(x => x.code === 'WEIGHT_MISMATCH').suggest.qty, 5000);
  const h = line({ qty_raw: '50000' });
  assert.strictEqual(h.status, 'warn');
  assert.ok(codes(h).includes('MAGNITUDE_OUTLIER'));
});

test('an unusual but confirmed quantity is not nagged about', () => {
  const r = line({ qty_raw: '50000', price_raw: '0.12', amount_raw: '6000.00' });
  assert.strictEqual(r.status, 'ok');
});

test('SKU typo gets the nearest real SKU as a suggestion', () => {
  const r = resolveSku('BA325MT1GCM12X40F', ctx);
  assert.strictEqual(r.issues[0].code, 'SKU_UNKNOWN');
  assert.strictEqual(r.issues[0].suggest.sku, 'BA325MT1GCM12X040F');
});

test('PDF without a header: arithmetic finds the quantity, or admits it cannot', () => {
  assert.strictEqual(resolveByArithmetic(['5,000', '0.12', '600.00'], 0.05).qty_raw, '5,000');
  assert.strictEqual(resolveByArithmetic(['500', '3', '1,500.00'], 0).confidence, 'low');
});

// ---------- end to end ----------
test('HTTP: stage → review → commit → duplicate blocked → undo', async () => {
  const { server } = require('../server/index');
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  const api = async (p, body) => {
    const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  try {
    await api('/api/login', { username: 'admin', password: 'change-me-admin' });
    const csv = 'SKU,Qty,Unit Price,Amount\nBA325MT1GCM12X030F,5000,0.12,600.00\nBA325MT1GCM12X035F,-900,0.13,117.00\n';
    const up = await api('/api/import/file', { kind: 'po', filename: 'po.csv', data_b64: Buffer.from(csv).toString('base64'), options: { ref: 'T-1', supplier: 'Hahn' } });
    assert.strictEqual(up.body.committed, false);
    const id = up.body.batch_id;
    let v = (await api(`/api/import/batch/${id}`)).body;
    assert.strictEqual(v.counts.block, 1);
    // nothing is on order yet
    let items = (await api('/api/items?q=BA325MT1GCM12X030F')).body;
    assert.strictEqual(items[0].on_order, 0);
    const bad = v.lines.find(l => l.status === 'block');
    assert.strictEqual((await api(`/api/import/batch/${id}/commit`, {})).status, 400);
    v = (await api(`/api/import/batch/${id}/line/${bad.id}`, { action: 'edit', qty: 900 })).body;
    assert.strictEqual(v.lines.find(l => l.id === bad.id).decision, 'edited');
    v = (await api(`/api/import/batch/${id}/commit`, {})).body;
    assert.strictEqual(v.batch.status, 'committed');
    items = (await api('/api/items?q=BA325MT1GCM12X035F')).body;
    assert.strictEqual(items.find(i => i.sku === 'BA325MT1GCM12X035F').on_order, 900);
    // same file again → duplicate
    const again = await api('/api/import/file', { kind: 'po', filename: 'po.csv', data_b64: Buffer.from(csv).toString('base64'), options: { ref: 'T-1' } });
    const v2 = (await api(`/api/import/batch/${again.body.batch_id}`)).body;
    assert.ok(v2.batch.batch_issues.some(i => i.code === 'DUPLICATE_FILE'));
    // undo the first import
    const u = (await api(`/api/import/batch/${id}/undo`, {})).body;
    assert.strictEqual(u.batch.status, 'undone');
    items = (await api('/api/items?q=BA325MT1GCM12X035F')).body;
    assert.strictEqual(items.find(i => i.sku === 'BA325MT1GCM12X035F').on_order, 0);
    // manual adjustment: negative typed quantity is refused, not flipped
    const adj = await api('/api/txn/adjust', { sku: 'BA325MT1GCM12X030F', wh: 'WH-MAIN', qty: -500, direction: 'up', reason: 'count' });
    assert.strictEqual(adj.status, 400);
  } finally { server.close(); }
});
