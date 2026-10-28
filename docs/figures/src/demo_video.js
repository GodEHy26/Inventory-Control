// Records the demo video: the same supplier invoice imported into v1 and v2.
// Needs v1 on :3312 and v2 on :3311 (fresh databases). Output: WebM clips in <dir>.
const { chromium } = require('playwright');
const path = require('path');
const DIR = process.argv[2];
const PDF = path.join(__dirname, '../../../eval/results/samples/sample_pdf-A.pdf');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function caption(p, title, sub = '') {
  await p.evaluate(([t, s]) => {
    let el = document.getElementById('__cap');
    if (!el) {
      el = document.createElement('div'); el.id = '__cap';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:rgba(10,12,16,.92);color:#fff;' +
        'padding:14px 26px;font:600 19px/1.35 system-ui,sans-serif;box-shadow:0 -4px 18px rgba(0,0,0,.25)';
      document.body.appendChild(el);
    }
    el.innerHTML = t + (s ? `<div style="font-weight:400;font-size:15px;color:#c9d1d9;margin-top:3px">${s}</div>` : '');
  }, [title, sub]);
}
async function login(p, base) {
  await p.goto(base); await p.fill('input[name=username]', 'admin'); await p.fill('input[name=password]', 'change-me-admin');
  await p.click('button[type=submit]'); await p.waitForSelector('#nav');
}
async function importPdf(p) {
  await p.click('button[data-tab=po]'); await wait(500);
  await p.click('#impPO'); await wait(400);
  await p.fill('#po_sup', 'Cherry'); await p.fill('#po_ref', 'A325MFTHDG-C14');
  await p.setInputFiles('#fd_input', PDF); await wait(700);
  await p.click('#fd_go');
}

(async () => {
  const b = await chromium.launch();
  const mk = () => b.newContext({ viewport: { width: 1280, height: 760 }, recordVideo: { dir: DIR, size: { width: 1280, height: 760 } } });

  // ---------- v1 ----------
  const c1 = await mk(); const p1 = await c1.newPage();
  await login(p1, 'http://127.0.0.1:3312');
  await caption(p1, 'v1 — importing a real-format supplier invoice (PDF)', 'Lines: 8 bolt SKUs from the company’s 1 July 2026 stock list. Columns: Qty · Unit price · Amount.');
  await wait(2500);
  await importPdf(p1); await wait(1800);
  await caption(p1, 'v1 says “Imported.” — no warnings', 'It took the LAST number on each line as the quantity.');
  await wait(2800);
  await p1.keyboard.press('Escape'); await p1.click('button[data-tab=po]'); await wait(700);
  await p1.click('tr.click'); await wait(1200);
  await caption(p1, 'v1 booked the Amount column as the quantity', '48,000 bolts became 4,622.4 · the repeated line was summed to 9,244.8 · none of it flagged.');
  await wait(5000);
  await c1.close();

  // ---------- v2 ----------
  const c2 = await mk(); const p2 = await c2.newPage();
  await login(p2, 'http://127.0.0.1:3311');
  await caption(p2, 'v2 — the same file', 'Every line is read from its column, then cross-checked: quantity × unit price must equal the amount.');
  await wait(2500);
  await importPdf(p2); await p2.waitForSelector('#fd_review'); await wait(1200);
  await caption(p2, 'v2 holds the file — nothing has been booked yet', '6 lines verified, 1 to check, 1 blocked.');
  await wait(2800);
  await p2.click('#fd_review'); await wait(1300);
  await caption(p2, 'Each line says which checks agreed — or what didn’t add up', 'Line 4: 16 × 0.4457 = 7.13, but the invoice says 71.31 → the amount implies 160.');
  await p2.mouse.wheel(0, 260); await wait(4500);
  await p2.click('tr.rv button.sug'); await wait(1500);
  await caption(p2, 'Reviewer applies the suggested fix → the line is re-checked and passes', 'Line 2 (same SKU twice) is confirmed as a real second line.');
  await wait(2200);
  await p2.click('tr.rv button[data-a=accept]'); await wait(1500);
  await p2.mouse.wheel(0, 900); await wait(800);
  await p2.click('#rv_commit'); await wait(1500);
  await caption(p2, 'Committed — every ledger row is tagged with its file, line and reviewer', 'And the whole import can be undone with reversing entries.');
  await wait(3500);
  // re-send same file
  await p2.click('button[data-tab=po]'); await wait(500);
  await importPdf(p2); await p2.waitForSelector('#fd_review'); await wait(800);
  await p2.click('#fd_review'); await wait(1300);
  await caption(p2, 'The supplier e-mails the same invoice again', 'v2 recognises the exact file (SHA-256) and the order number — v1 would have doubled every line.');
  await wait(5000);
  await c2.close(); await b.close();
  console.log('recorded');
})();
