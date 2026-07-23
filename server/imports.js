// File imports (items / stock / sales orders / purchase orders) and
// downloadable templates. Accepts CSV, XLS, XLSX via SheetJS and PDF via
// pdf-parse (best-effort text extraction). Header names are matched
// loosely, so Zoho exports and the provided templates both work.
const XLSX = require('xlsx');
const db = require('./db');

const HEADERS = {
  sku: ['sku', 'item sku', 'code', 'item code', 'art no', 'article'],
  name: ['name', 'item name', 'description', 'desc'],
  qty: ['qty', 'quantity', 'pcs', 'pieces', 'opening stock', 'stock'],
  warehouse: ['warehouse', 'wh', 'location'],
  heat: ['heat', 'heat no', 'heat number', 'heatno'],
  weight: ['unit weight', 'weight', 'package weight', 'weight kg', 'unit weight kg'],
  size: ['size', 'cf.size'],
  category: ['category', 'type name'],
  item_type: ['item type', 'type'],
  uom: ['uom', 'unit', 'usage unit'],
  min_stock: ['min stock', 'reorder level', 'minimum'],
  customer: ['customer', 'client', 'buyer'],
  supplier: ['supplier', 'vendor', 'factory'],
  ref: ['ref', 'reference', 'order ref', 'po no', 'po number', 'invoice', 'inv no', 'so ref'],
  eta: ['eta', 'expected', 'arrival', 'delivery date', 'required date', 'date'],
};

function normalize(h) { return String(h || '').toLowerCase().replace(/[_.]/g, ' ').replace(/\s+/g, ' ').trim(); }

function mapColumns(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const n = normalize(h);
    for (const [key, aliases] of Object.entries(HEADERS)) {
      if (map[key] == null && aliases.includes(n)) map[key] = i;
    }
  });
  return map;
}

// Parse an uploaded file (base64) into rows of objects keyed by our fields.
async function parseFile(filename, b64) {
  const buf = Buffer.from(b64, 'base64');
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return parsePdf(buf);
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (!grid.length) return { rows: [], note: 'File appears empty' };
  // find the header row: first row that maps at least sku or name
  let hi = 0, map = {};
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const m = mapColumns(grid[i]);
    if (m.sku != null || (m.name != null && m.qty != null)) { hi = i; map = m; break; }
  }
  if (map.sku == null && map.name == null) return { rows: [], note: 'Could not find a SKU or Name column. Download the template to see the expected format.' };
  const rows = [];
  for (let i = hi + 1; i < grid.length; i++) {
    const r = grid[i];
    const row = {};
    for (const [key, ci] of Object.entries(map)) row[key] = String(r[ci] ?? '').trim();
    if (row.qty) row.qty = parseFloat(String(row.qty).replace(/[, ]/g, '')) || 0;
    if (row.weight) row.weight = parseFloat(row.weight) || 0;
    if (!row.sku && !row.name) continue;
    rows.push(row);
  }
  return { rows, note: null };
}

// PDF: extract text, find lines that contain a known SKU and a quantity.
async function parsePdf(buf) {
  let text = '';
  try {
    const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // Reconstruct visual lines by grouping text items on the same y coordinate.
      const rows = {};
      for (const it of tc.items) {
        const y = Math.round(it.transform[5]);
        (rows[y] = rows[y] || []).push(it.str);
      }
      text += Object.keys(rows).sort((a, b) => b - a).map(y => rows[y].join(' ')).join('\n') + '\n';
    }
  } catch (e) {
    return { rows: [], note: 'Could not read PDF: ' + e.message };
  }
  const knownSkus = new Set(db.prepare('SELECT sku FROM items').all().map(r => r.sku));
  const rows = [];
  const seen = new Map();
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.split(/\s+/).filter(Boolean);
    const skuTok = tokens.find(t => knownSkus.has(t.toUpperCase()));
    if (!skuTok) continue;
    // pick the most plausible quantity: last integer-ish number on the line
    const nums = tokens.map(t => t.replace(/,/g, '')).filter(t => /^\d+(\.\d+)?$/.test(t)).map(Number);
    const qty = nums.length ? nums[nums.length - 1] : 0;
    if (qty > 0) {
      const sku = skuTok.toUpperCase();
      seen.set(sku, (seen.get(sku) || 0) + qty);
    }
  }
  for (const [sku, qty] of seen) rows.push({ sku, qty });
  return {
    rows,
    note: rows.length
      ? 'PDF parsed best-effort: matched lines that contain a known SKU and used the last number on each line as quantity. Check the totals before relying on them.'
      : 'No lines with known SKUs found in this PDF. CSV/XLSX with the template format is far more reliable.',
  };
}

// ---------- templates ----------
const TEMPLATES = {
  items: {
    headers: ['SKU', 'Item Name', 'Item Type', 'Category', 'Size', 'Unit Weight KG', 'UOM', 'Min Stock'],
    example: ['BA325MT1GCM12X030F', 'A325M T-1 Heavy Hex FT Bolt HDG M12X30', 'part', 'Bolt', 'M12X30', '0.052', 'pcs', '0'],
  },
  stock: {
    headers: ['SKU', 'Warehouse', 'Qty', 'Heat No'],
    example: ['BA325MT1GCM12X030F', 'WH-MAIN', '5000', 'H24C08'],
  },
  so: {
    headers: ['Customer', 'Ref', 'Required Date', 'SKU', 'Qty'],
    example: ['MABANI', 'SO-2026-001', '2026-08-15', 'AA325MT1GCM12X035F', '1200'],
  },
  po: {
    headers: ['Supplier', 'Ref', 'ETA', 'SKU', 'Qty', 'Heat No'],
    example: ['Hahn INC.', 'HN24C08O009', '2026-09-01', 'BA325MT1GCM30X120F', '1499', 'H24C08'],
  },
};

function template(kind, fmt) {
  const t = TEMPLATES[kind];
  if (!t) return null;
  const data = [t.headers, t.example];
  if (fmt === 'xlsx') {
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Template');
    return { buf: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }),
             mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
             filename: `${kind}-template.xlsx` };
  }
  const csv = data.map(r => r.join(',')).join('\r\n');
  return { buf: Buffer.from(csv), mime: 'text/csv', filename: `${kind}-template.csv` };
}

module.exports = { parseFile, template };
