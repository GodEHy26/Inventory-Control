# Inventory Control — Fastener Inventory & Manufacturing System

Multi-warehouse inventory and lightweight manufacturing/BOM system for an
industrial fastener business. It follows the requirements in
`fastener_inventory_system_spec.md`.

**No company data is in this repository.** It ships with a small made-up demo
catalog (`data/seed/demo.json`). The company's real stock list and item master
stay on the owner's computer in `data/private/`, which git ignores (see
"Real data" below).

## v2 — Import Guard

v1 prevented negative stock, but accepted numbers from imported files without
checking them. On an invoice laid out *Qty · Unit price · Amount* it booked
the Amount as the quantity. It read "1.250" as 1.25 bolts, and importing a
file twice doubled every line. None of these produced a warning.

v2 checks imported data before it reaches the ledger:

- **Every line is cross-checked** against the document's own numbers
  (qty × unit price = amount, qty × unit weight ≈ shipping weight), the item
  master, order history and earlier imports.
- **Anything doubtful is held, with a reason and usually a suggested fix.**
  A person accepts, edits, rejects, or overrides it with a written reason. Clean
  files still commit instantly.
- **Every booked line traces back to its file, line and reviewer, and a
  whole import can be undone.**
- **PDFs are read as tables** (by column header) instead of "last number on
  the line". Number formats, units (kg / boxes) and duplicates are handled
  explicitly.

**Evaluation on 351 real order lines with simulated errors** (full report:
[`eval/results/REPORT.md`](eval/results/REPORT.md)): for CSVs with price/weight
columns and for all three PDF layouts, v1 let 587–2,111 wrong lines into
stock without a warning, and v2 let 2. On the clean real documents, 33 of 34
committed with no human touch.

Read **[DESIGN.md](DESIGN.md)** for what changed and why.

```bash
npm test                              # unit + end-to-end tests
npm run eval                          # v1 vs v2 evaluation (needs python3 + matplotlib for the charts)
node scripts/trace.js <SKU>           # where did this stock figure come from?
node scripts/trace.js --batch <id>    # one import: file hash, every line, file value vs booked value
```

Figures are in [`docs/figures/`](docs/figures). The scripts that produce them from
real program output are in `docs/figures/src/`. The demo video and the figures that
show real product codes are kept out of this public repository.

**Live for everyone:** every stock movement is broadcast over WebSockets
(Socket.IO) — all signed-in users see changes the moment anyone posts them,
with a toast showing who did what.

## What's inside

| Spec area | Where |
|---|---|
| Item master (SKU, type, category, size/grade/coating, custom JSON fields) | Stock tab → item drawer |
| Per-warehouse stock: on hand, held, on order, in transit, sold, available-to-sell | Everywhere; ribbon strip per SKU |
| Zero negative stock, ever | DB `CHECK` constraints + atomic ledger — a violating transaction rolls back entirely |
| Ledger-derived quantities, full audit trail | `transactions` table; `npm run rebuild-levels` reproves it |
| BOM engine, assembly/disassembly, assemble-at-pack | 526 BNW/BNWW BOMs auto-generated from the SKU codes |
| Sales-order stock check (3.2): finished → components → short + suggestions | SO confirm; suggestions show other-warehouse stock, incoming ETAs, disassembly as last resort |
| Component exposure ("available in assemblies") | Item drawer + Reports |
| Pick & pack view with kit checklist | SO drawer |
| Cut-to-length, offcut pieces with own length + heat no (lot instances) | Manufacturing tab; scrap searched by length ≥ requirement |
| Heat-number genealogy | `lots` table; carried through receiving and cutting |
| Cross-warehouse transfers (atomic out+in pair) | Item drawer → Transfer |
| Incoming: PO → in transit → receive; packing-list paste import | Incoming tab |
| **v2:** Import review (checks, suggestions, accept/edit/reject/override, commit, undo) | Imports tab |
| **v2:** Cancel a PO (before receipt) | PO drawer |
| Reports: low stock, assembly availability, exposure, mfg yield, per-SKU audit | Reports tab |
| Roles (admin / sales / purchasing / warehouse) for up to 10 concurrent users | Sign-in; server-side permission checks |

## Run it

```bash
npm install
npm run seed        # loads the made-up demo catalog (or the real one, if it is in data/private/)
npm start           # http://localhost:3000
```

Or with Docker: `docker build -t inventory . && docker run -p 3000:3000 -v inv_data:/app/data inventory`

Default users (change these passwords immediately after first sign-in):
`admin`, `sales`, `warehouse`, `purchasing` — password is `change-me-<username>`.

Set `SESSION_SECRET` in production so sign-ins survive restarts.

## Deploying so the whole team can use it

Any Node host works (Railway, Render, Fly.io, a small VPS). One instance +
one SQLite file is plenty for ~10 users / ~560 invoices a year. Mount a
persistent volume at `data/` so the database survives redeploys.

## Real data (kept private)

The real data files are never committed. Put them in `data/private/`, which
`.gitignore` excludes:

- `data/private/seed.json`: the stock-list workbook, extracted with
  `python3 scripts/extract_from_xlsx.py <xlsx> data/private/seed.json` (needs `openpyxl`).
  Set `SECOND_WH_COLUMN` to a word from the second warehouse's column header.
- `data/private/seed_v2.json`: the item master, from the Zoho exports (below).

`npm run seed` uses `data/private/seed_v2.json` when it exists, and
`npm run eval` needs both files. Without them, the app runs on the demo
catalog and the evaluation explains what is missing.

Workbook notes: the main inventory column becomes **WH-MAIN** and the second
warehouse column **WH-2**. INTRANSIT / ORDERED columns become incoming purchase
orders. CLOSING columns are projections and are **not** used as on-hand.
SALES/PO columns and negative cells are skipped and listed under `exceptions`.

## Still open (from spec §10)
Transfer lead-time in delivery promises, ATP against required dates
(deferred by decision 9.4), and the final role/permission matrix. The data
model already supports all three.


## Release 1.1 — Zoho migration

- The item master (7,657 SKUs) and 1,313 assembly BOMs were imported from Zoho with unit weights. Quantities start at zero and can be added through purchase orders, file imports, or adjustments.
- CSV, XLS, and XLSX files can be imported for items, stock, sales orders, and purchase orders. PDF import is available for orders. Each import section includes a downloadable CSV or Excel template.
- Confirming a sales order reserves stock by line until it is shipped or cancelled.
- Sales order lines and purchase order lines can be shipped, marked in transit, or received in partial quantities. Each receipt can include a heat number. The status updates to `partial` when appropriate.
- **Open any purchase order** to see the components inside it, with ordered / in-transit / received per line and total shipment weight.
- **SKU autocomplete.** Type a few characters in any SKU box and pick from a dropdown of matches.
- Stock views show the all-warehouse total first, with the per-warehouse breakdown available from each row.
- The dashboard and Reports flag assemblies without BOMs, SKUs that appear to be assemblies but are not tagged, BOM components missing from the item master, and missing weights.
- **Unit weights & shipment weights.** Every item carries kg/unit (from Zoho); every SO and PO shows its total weight.
- **Heat number traceability.** Heat numbers are captured at receipt (or import), travel through transfers and kit assembly, and are stamped onto shipments. Reports → "Heat number trace" shows the full purchase→sale genealogy.

### Rebuilding the seed from Zoho exports

```
python3 scripts/extract_from_zoho.py Item.xls Composite_Item.xls data/private/seed.json data/private/seed_v2.json
npm run seed
```
