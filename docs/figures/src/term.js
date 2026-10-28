// Render real command output as a terminal image (ANSI colours kept).
// Usage: node term.js session.json out.png  — session = { title, blocks: [{cmd, out}] }
const fs = require('fs');
const { chromium } = require('playwright');
const S = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const COL = { 30: '#6e7681', 31: '#ff7b72', 32: '#7ee787', 33: '#e3b341', 34: '#79c0ff', 35: '#d2a8ff', 36: '#76e3ea', 37: '#e6edf3', 90: '#8b949e' };
function ansi(s) {
  let out = '', open = false;
  for (const part of esc(s).split(/\x1b\[([\d;]*)m/).map((p, i) => [p, i % 2])) {
    const [p, isCode] = part;
    if (!isCode) { out += p; continue; }
    if (open) { out += '</span>'; open = false; }
    const codes = p.split(';').map(Number);
    const c = codes.find(x => COL[x]); const bold = codes.includes(1);
    if (c || bold) { out += `<span style="${c ? 'color:' + COL[c] + ';' : ''}${bold ? 'font-weight:700' : ''}">`; open = true; }
  }
  return out + (open ? '</span>' : '');
}
const body = S.blocks.map(b => `<div class="cmd"><span class="ps">user@inventory-control</span>:<span class="cwd">~/Inventory-Control-v2</span>$ ${esc(b.cmd)}</div><pre>${ansi(b.out.replace(/\s+$/, ''))}</pre>`).join('');
const html = `<!doctype html><meta charset=utf-8><style>
body{margin:0;background:#fff;padding:22px;font-family:"DejaVu Sans Mono",monospace}
.win{background:#0d1117;border-radius:9px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.25);width:max-content;min-width:900px}
.bar{background:#161b22;padding:9px 14px;color:#8b949e;font-size:12px;display:flex;gap:7px;align-items:center}
.bar i{width:11px;height:11px;border-radius:50%;display:inline-block}
.t{padding:14px 18px 16px;color:#e6edf3;font-size:13px;line-height:1.45}
pre{margin:2px 0 12px;font:inherit;white-space:pre}
.cmd{color:#e6edf3}.ps{color:#7ee787}.cwd{color:#79c0ff}
</style><div class=win><div class=bar><i style="background:#ff5f56"></i><i style="background:#ffbd2e"></i><i style="background:#27c93f"></i><span style="margin-left:8px">${esc(S.title)}</span></div><div class=t>${body}</div></div>`;
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ deviceScaleFactor: 2, viewport: { width: 1600, height: 900 } });
  await p.setContent(html); const el = await p.$('.win');
  const box = await el.boundingBox();
  await p.screenshot({ path: process.argv[3], clip: { x: box.x - 22, y: box.y - 22, width: box.width + 44, height: box.height + 44 } });
  await b.close(); console.log('wrote', process.argv[3]);
})();
