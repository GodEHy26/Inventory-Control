// Drives the app in the computer's own Google Chrome (a visible window) and
// saves screenshots of each step. Called by shots.sh.
//   node scripts/portfolio/browser_shots.js <out dir> <app url>
const path = require('path');
let pw; try { pw = require('playwright-core'); } catch { pw = require('playwright'); }
const { chromium } = pw;
const [out, url] = process.argv.slice(2);
const samples = path.join(__dirname, '..', '..', 'eval', 'results', 'samples');

(async () => {
  const browser = await chromium.launch(process.env.USE_BUNDLED_CHROMIUM
    ? {} : { channel: 'chrome', headless: false });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  const shot = (name, full) => page.screenshot({ path: path.join(out, `app-${name}.png`), fullPage: !!full })
    .then(() => console.log(`saved portfolio-shots/app-${name}.png`));
  const quiet = () => page.evaluate(() => { document.getElementById('toasts').innerHTML = ''; });
  page.on('dialog', d => d.accept('Checked against the supplier invoice'));

  await page.goto(url);
  await page.waitForSelector('#loginForm');
  await shot('1-login');
  await page.fill('input[name=username]', 'admin');
  await page.fill('input[name=password]', 'change-me-admin');
  await page.click('button[type=submit]');
  await page.waitForSelector('.tiles');

  // Upload the sample supplier invoice (two planted errors).
  async function upload(file) {
    await page.click('#nav button[data-tab=po]');
    await page.click('#impPO');
    await page.setInputFiles('#fd_input', path.join(samples, file));
    await page.click('#fd_go');
    await page.waitForFunction(() => document.querySelector('#fd_go')?.textContent === 'Import', null, { timeout: 60000 });
  }
  await upload('sample_pdf-A.pdf');
  await shot('2-upload-held');
  await page.click('#fd_review');
  await page.waitForSelector('#rv_back');
  await page.waitForTimeout(300); await quiet();
  await shot('3-review');

  // Resolve: take the suggested 160, reject the pasted-twice line, commit.
  await page.locator('tr.rv').nth(3).locator('button', { hasText: 'Use 160' }).click();
  await page.waitForTimeout(500);
  await page.locator('tr.rv').nth(1).locator('button[data-a=reject]').click();
  await page.waitForTimeout(500);
  await page.click('#rv_commit');
  await page.waitForSelector('#rv_undo');
  await page.waitForTimeout(300); await quiet();
  await shot('4-committed', true);

  await page.click('#nav button[data-tab=po]');
  await page.waitForTimeout(800); await quiet();
  await shot('5-incoming');

  // The same file again is blocked as a duplicate.
  await upload('sample_pdf-A.pdf');
  await page.click('#fd_review');
  await page.waitForSelector('#rv_back');
  await page.waitForTimeout(300); await quiet();
  await shot('6-duplicate-blocked');

  await page.click('#nav button[data-tab=dashboard]');
  await page.waitForSelector('.tiles');
  await page.waitForTimeout(500); await quiet();
  await shot('7-dashboard');
  await browser.close();
})().catch(e => { console.error('Browser screenshots failed:', e.message); process.exit(1); });
