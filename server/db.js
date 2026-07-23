const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'inventory.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','sales','purchasing','warehouse','viewer')),
  display_name TEXT, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS items (
  sku TEXT PRIMARY KEY, name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK(item_type IN ('part','assembly','raw')),
  category TEXT, size TEXT, grade TEXT, coating TEXT, head_marking TEXT,
  uom TEXT DEFAULT 'each', min_stock INTEGER DEFAULT 0, unit_weight REAL DEFAULT 0,
  attrs TEXT DEFAULT '{}',          -- custom/extendable fields, JSON
  active INTEGER DEFAULT 1, created_ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS bom (
  parent_sku TEXT NOT NULL REFERENCES items(sku),
  component_sku TEXT NOT NULL REFERENCES items(sku),
  qty REAL NOT NULL CHECK(qty > 0),
  PRIMARY KEY (parent_sku, component_sku)
);
-- Derived stock levels. Every change goes through ledger.post(); CHECK
-- constraints make negative stock impossible at the database level.
CREATE TABLE IF NOT EXISTS stock_levels (
  sku TEXT NOT NULL REFERENCES items(sku),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  on_hand REAL NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
  on_hold REAL NOT NULL DEFAULT 0 CHECK(on_hold >= 0 AND on_hold <= on_hand),
  on_order REAL NOT NULL DEFAULT 0 CHECK(on_order >= 0),
  in_transit REAL NOT NULL DEFAULT 0 CHECK(in_transit >= 0),
  sold REAL NOT NULL DEFAULT 0 CHECK(sold >= 0),
  PRIMARY KEY (sku, warehouse_id)
);
-- Append-only audit ledger. stock_levels is always rebuildable from this.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, ts TEXT DEFAULT (datetime('now')),
  group_id TEXT, type TEXT NOT NULL,
  sku TEXT NOT NULL, warehouse_id TEXT NOT NULL, qty REAL NOT NULL,
  d_on_hand REAL DEFAULT 0, d_on_hold REAL DEFAULT 0, d_on_order REAL DEFAULT 0,
  d_in_transit REAL DEFAULT 0, d_sold REAL DEFAULT 0,
  ref TEXT, counterparty TEXT, user TEXT, meta TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_txn_sku ON transactions(sku, ts);
CREATE INDEX IF NOT EXISTS idx_txn_group ON transactions(group_id);
-- Lot / instance layer: heat-number genealogy + individually tracked
-- pieces (rod scrap with a real length each). SKU stock = sum of pieces
-- for instance-tracked SKUs; lots also annotate normal stock-in events.
CREATE TABLE IF NOT EXISTS lots (
  id INTEGER PRIMARY KEY, sku TEXT NOT NULL REFERENCES items(sku),
  warehouse_id TEXT NOT NULL, qty REAL NOT NULL CHECK(qty >= 0),
  length_mm REAL, heat_no TEXT, parent_lot INTEGER REFERENCES lots(id),
  origin_txn TEXT, created_ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lots_sku ON lots(sku, warehouse_id);
CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY, customer TEXT NOT NULL, ref TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft','confirmed','partial','shipped','cancelled')),
  required_date TEXT, note TEXT,
  created_by TEXT, created_ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS so_lines (
  id INTEGER PRIMARY KEY, so_id INTEGER NOT NULL REFERENCES sales_orders(id),
  sku TEXT NOT NULL REFERENCES items(sku), qty REAL NOT NULL CHECK(qty > 0),
  warehouse_id TEXT NOT NULL,
  mode TEXT DEFAULT 'pending' CHECK(mode IN ('pending','stock','kit','short','shipped','cancelled')),
  shipped_qty REAL NOT NULL DEFAULT 0,
  suggestions TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY, supplier TEXT, ref TEXT, eta TEXT,
  status TEXT NOT NULL DEFAULT 'ordered'
    CHECK(status IN ('ordered','in_transit','partial','received','cancelled')),
  warehouse_id TEXT NOT NULL DEFAULT 'WH-MAIN', note TEXT,
  created_by TEXT, created_ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
  sku TEXT NOT NULL REFERENCES items(sku), qty REAL NOT NULL CHECK(qty > 0),
  received_qty REAL NOT NULL DEFAULT 0, in_transit_qty REAL NOT NULL DEFAULT 0, heat_no TEXT
);
`);

// Best-effort migrations for databases created by v1.
for (const sql of [
  "ALTER TABLE items ADD COLUMN unit_weight REAL DEFAULT 0",
  "ALTER TABLE so_lines ADD COLUMN shipped_qty REAL NOT NULL DEFAULT 0",
  "ALTER TABLE po_lines ADD COLUMN in_transit_qty REAL NOT NULL DEFAULT 0",
]) { try { db.exec(sql); } catch (e) { /* column exists */ } }

module.exports = db;
