// Build the scenario shown in Figure 4: a messy CSV is staged, two lines are
// fixed by a reviewer, it is committed, the same file is re-sent (blocked),
// and a second, wrong PO is imported and then undone.
const fs = require('fs');
const guard = require('../../../server/guard');
const csv = [
  'Supplier,Ref,SKU,Qty,Unit,Unit Price,Amount,Weight KG',
  'Hahn,HN24C08O009,BA325MT1GCM12X035F,"48,000",pcs,0.0963,4622.40,2736',
  'Hahn,HN24C08O009,BA325MT1GCM12X050F,-8430,pcs,0.1591,1341.21,',
  'Hahn,HN24C08O009,BA325MT1GCM20X60F,1600,pcs,0.4457,713.12,',
  'Hahn,HN24C08O009,BA325MT1GCM24X080F,1294,pcs,0.8622,11156.87,',
  'Hahn,HN24C08O009,BA325MT1GCM24X110F,7500,pcs,0.9896,7422.00,',
].join('\n') + '\n';
(async () => {
  const b64 = Buffer.from(csv).toString('base64');
  const id = await guard.stage({ kind: 'po', filename: 'hahn_HN24C08O009.csv', data_b64: b64, options: { supplier: 'Hahn INC.', ref: 'HN24C08O009' }, user: 'admin' });
  let v = guard.view(id);
  for (const l of v.lines) {
    const s = l.issues.find(i => i.suggest);
    if (l.status === 'block' && s) guard.decide(id, l.id, { action: 'edit', sku: s.suggest.sku, qty: s.suggest.qty, note: 'used suggested value' }, 'purchasing', 'purchasing');
    else if (l.status === 'block') guard.decide(id, l.id, { action: 'edit', sku: 'BA325MT1GCM20X060F', note: 'typo in item code' }, 'purchasing', 'purchasing');
  }
  guard.commit(id, 'purchasing');
  // the supplier e-mails the same file again
  const id2 = await guard.stage({ kind: 'po', filename: 'hahn_HN24C08O009 (1).csv', data_b64: b64, options: { supplier: 'Hahn INC.', ref: 'HN24C08O009' }, user: 'admin' });
  guard.discard(id2, 'purchasing');
  // a wrong PO goes in clean, then turns out to be a test file and is undone
  const id3 = await guard.stage({ kind: 'po', filename: 'test_po.csv', options: { supplier: 'Test', ref: 'TEST-1' }, user: 'admin',
    data_b64: Buffer.from('SKU,Qty,Unit Price,Amount\nBA325MT1GCM12X035F,500,0.0963,48.15\n').toString('base64') });
  guard.commit(id3, 'admin'); guard.undo(id3, 'admin');
  fs.writeFileSync(process.argv[2] || '/dev/stdout', JSON.stringify({ id, id2, id3 }));
})();
