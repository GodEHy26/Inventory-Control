// File parsing for imports (items / stock / sales orders / purchase orders)
// and downloadable templates.
//
// v2 change: this module no longer turns cells into numbers. It returns the
// raw text of every quantity, price, amount, weight and unit cell, plus
// document-level facts (number convention, printed totals, how the table
// was read). Deciding what a number means — and whether to trust it — is
// validate.js's job, so that the decision can be explained and reviewed.
const XLSX = require('xlsx');
const crypto = require('crypto');
const { inferLocale } = require('./numbers');
const { readPdf } = require('./pdfparse');

const HEADERS = {
  sku: ['sku', 'item sku', 'code', 'item code', 'art no', 'article', 'part no', 'product code'],
  name: ['name', 'item name', 'description', 'desc'],
  qty: ['qty', 'quantity', 'pcs', 'pieces', 'opening stock', 'stock', 'qty pcs', 'quantity pcs'],
  unit: ['unit', 'uom', 'usage unit', 'units'],
  price: ['price', 'unit price', 'rate', 'unit rate', 'price usd', 'unit price usd'],
  amount: ['amount', 'line total', 'total', 'value', 'amount usd', 'total amount'],
  warehouse: ['warehouse', 'wh', 'location'],
  heat: ['heat', 'heat no', 'heat number', 'heatno'],
  weight: ['unit weight', 'weight', 'package weight', 'weight kg', 'unit weight kg', 'total weight', 'net weight', 'nw kg'],
  size: ['size', 'cf size'],
  category: ['category', 'type name'],
  item_type: ['item type', 'type'],
  min_stock: ['min stock', 'reorder level', 'minimum'],
  customer: ['customer', 'client', 'buyer'],
  supplier: ['supplier', 'vendor', 'factory'],
  ref: ['ref', 'reference', 'order ref', 'po no', 'po number', 'invoice', 'inv no', 'so ref'],
  eta: ['eta', 'expected', 'arrival', 'delivery date', 'required date', 'date'],
};

function normalize(h) {
  return String(h || '').toLowerCase().replace(/[()\[\]]/g, ' ').replace(/[_.:]/g, ' ').replace(/\s+/g, ' ').trim();
}
function mapColumns(headerRow) {
  const map = {};
  headerRow.forEach((h, i) => {
    const n = normalize(h);
    for (const [key, aliases] of Object.entries(HEADERS)) {
      if (map[key] == null && aliases.includes(n)) { map[key] = i; return; }
    }
  });
  return map;
}

function fileHash(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

/**
 * Parse an uploaded file. kind matters only for the "weight" column:
 * on an items file it is the unit weight; on an order it is the line weight.
 * Returns { rows, doc, note }.
 *   rows[i] = { line_no, sku_raw, name, qty_raw, unit_raw, price_raw, amount_raw,
 *               weight_raw, heat, warehouse, customer, supplier, ref, eta,
 *               method, confidence, candidates? }
 *   doc     = { format, file_hash, locale, localeConflict, totals[], header[] }
 */
async function parseFile(filename, b64, { kind = 'po', known = new Set(), itemOf = () => null } = {}) {
  const buf = Buffer.from(b64, 'base64');
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const doc = { format: ext, file_hash: fileHash(buf), totals: [], header: null };
  let rows = [], rawNumbers = [], note = null;

  if (ext === 'pdf') {
    let t;
    try { t = await readPdf(buf, known, itemOf); }
    catch (e) { return { rows: [], doc, note: 'Could not read PDF: ' + e.message }; }
    rows = t.lines.map(l => ({ ...l, sku_raw: l.sku_raw }));
    doc.totals = t.totals; doc.header = t.header; rawNumbers = t.rawNumbers;
    note = t.header
      ? `Read the PDF as a table using its header row (${t.header.join(', ')}).`
      : 'No table header found in the PDF — quantities were identified by arithmetic where possible; anything uncertain is held for review.';
  } else {
    // For CSV/TXT, raw:true stops SheetJS from guessing types — otherwise it
    // would turn "1.250" into 1.25 before we ever see the text.
    const wb = XLSX.read(buf, { type: 'buffer', raw: ['csv', 'txt', 'tsv'].includes(ext) });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // raw:true keeps real spreadsheet numbers as numbers (no separator
    // ambiguity); text cells — including every CSV cell — stay as typed.
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    if (!grid.length) return { rows: [], doc, note: 'File appears empty' };
    let hi = -1, map = {};
    for (let i = 0; i < Math.min(grid.length, 15); i++) {
      const m = mapColumns(grid[i]);
      if (m.sku != null || (m.name != null && m.qty != null)) { hi = i; map = m; break; }
    }
    if (hi < 0) return { rows: [], doc, note: 'Could not find a SKU or Name column. Download the template to see the expected format.' };
    doc.header = Object.keys(map);
    const cell = (r, k) => (map[k] == null ? '' : String(r[map[k]] ?? '').trim());
    let lineNo = 0;
    for (let i = hi + 1; i < grid.length; i++) {
      const r = grid[i];
      const sku = cell(r, 'sku'), name = cell(r, 'name');
      if (!sku && !name) continue;
      const label = `${sku} ${name}`;
      if (!sku && /\btotal\b/i.test(label)) {
        doc.totals.push({ text: label.trim(), numbers: ['qty', 'amount', 'weight']
          .filter(k => cell(r, k)).map(k => ({ raw: cell(r, k), col: k })) });
        continue;
      }
      lineNo++;
      const row = {
        line_no: lineNo, sku_raw: sku, name,
        qty_raw: cell(r, 'qty'), unit_raw: cell(r, 'unit'),
        price_raw: cell(r, 'price'), amount_raw: cell(r, 'amount'),
        weight_raw: kind === 'items' ? '' : cell(r, 'weight'),
        unit_weight_raw: kind === 'items' ? cell(r, 'weight') : '',
        heat: cell(r, 'heat'), warehouse: cell(r, 'warehouse'),
        customer: cell(r, 'customer'), supplier: cell(r, 'supplier'),
        ref: cell(r, 'ref'), eta: cell(r, 'eta'),
        size: cell(r, 'size'), category: cell(r, 'category'), item_type: cell(r, 'item_type'),
        min_stock: cell(r, 'min_stock'),
        method: 'table', confidence: 'high',
      };
      for (const k of ['qty_raw', 'price_raw', 'amount_raw', 'weight_raw']) if (row[k]) rawNumbers.push(row[k]);
      rows.push(row);
    }
  }
  const loc = inferLocale(rawNumbers);
  doc.locale = loc.locale;
  doc.localeConflict = loc.us > 0 && loc.eu > 0;
  return { rows, doc, note };
}

// ---------- templates ----------
const TEMPLATES = {
  items: {
    headers: ['SKU', 'Item Name', 'Item Type', 'Category', 'Size', 'Unit Weight KG', 'UOM', 'Min Stock'],
    example: ['BA325MT1GCM12X030F', 'A325M T-1 Heavy Hex FT Bolt HDG M12X30', 'part', 'Bolt', 'M12X30', '0.052', 'pcs', '0'],
  },
  stock: {
    headers: ['SKU', 'Warehouse', 'Qty', 'Unit', 'Heat No'],
    example: ['BA325MT1GCM12X030F', 'WH-MAIN', '5000', 'pcs', 'H24C08'],
  },
  so: {
    headers: ['Customer', 'Ref', 'Required Date', 'SKU', 'Qty', 'Unit'],
    example: ['MABANI', 'SO-2026-001', '2026-08-15', 'AA325MT1GCM12X035F', '1200', 'sets'],
  },
  po: {
    // Price, Amount and Weight are optional — but when present, v2 uses them
    // to cross-check every quantity.
    headers: ['Supplier', 'Ref', 'ETA', 'SKU', 'Qty', 'Unit', 'Unit Price', 'Amount', 'Weight KG', 'Heat No'],
    example: ['Hahn INC.', 'HN24C08O009', '2026-09-01', 'BA325MT1GCM30X120F', '1499', 'pcs', '0.85', '1274.15', '1394.07', 'H24C08'],
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

module.exports = { parseFile, template, fileHash, HEADERS };
