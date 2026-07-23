# Inventory Control — Fastener Inventory & Manufacturing System

Multi-warehouse inventory + lightweight manufacturing/BOM engine for an
industrial fastener business, built to the spec in
`fastener_inventory_system_spec.md`. Pre-loaded with the
**INVENTORY STOCK LIST AS ON 1 JULY 2026** as the opening base.

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
| Reports: low stock, assembly availability, exposure, mfg yield, per-SKU audit | Reports tab |
| Roles (admin / sales / purchasing / warehouse) for up to 10 concurrent users | Sign-in; server-side permission checks |

## Run it

```bash
npm install
npm run seed        # loads data/seed/seed.json (the 1 July 2026 stock list)
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

## Data migration notes (1 July 2026 workbook)

- Main inventory column → **WH-MAIN**; "INVENTORY SAIF ZONE" → **WH-SAIF**.
- INTRANSIT / ORDERED columns → 34 incoming POs with ETA, supplier and
  invoice ref, ready to Receive.
- CLOSING columns are projections and were **not** used as on-hand.
- SALES/PO columns and negative cells were skipped — all 141 judgement
  calls are listed in `data/seed/seed.json → exceptions`. Fix any of them
  with a Stock Adjustment (it stays on the audit trail).
- Re-extract any time: `python3 scripts/extract_from_xlsx.py <xlsx> data/seed/seed.json`
  (needs `openpyxl`), then `node scripts/seed.js` on a fresh database.

## Still open (from spec §10)
Transfer lead-time in delivery promises, ATP against required dates
(deferred by decision 9.4), and the final role/permission matrix. The data
model already supports all three.


## What's new in v2

- **Stock starts at zero.** The item master (7,657 SKUs) and all 1,313 assembly BOMs come straight from your Zoho exports, complete with unit weights — but every quantity begins at 0. Build stock up through purchase orders, file imports, or adjustments.
- **File imports everywhere.** Upload CSV / XLS / XLSX (and best-effort PDF for orders) to add items, stock, sales orders, or purchase orders. Column names are matched loosely, so Zoho exports work as-is. Every import section has a downloadable CSV/Excel template.
- **"Reserved for orders".** Confirming a sales order moves stock into a reserved bank, per line, until shipped or cancelled.
- **Partial everything.** Ship a sales order line in any partial quantity; mark any part of a PO line in transit; receive any part of a PO line — each with its own heat number. Statuses show `partial` automatically.
- **Open any purchase order** to see the components inside it, with ordered / in-transit / received per line and total shipment weight.
- **SKU autocomplete.** Type a few characters in any SKU box and pick from a dropdown of matches.
- **Totals first.** Stock views lead with the all-warehouse total; the per-warehouse split is one click away.
- **Data flags.** The system continuously flags things that look wrong — assemblies with no BOM, SKUs that look like assemblies but aren't tagged, BOM components missing from the item master, missing weights — on the dashboard and in Reports.
- **Unit weights & shipment weights.** Every item carries kg/unit (from Zoho); every SO and PO shows its total weight.
- **Heat number traceability.** Heat numbers are captured at receipt (or import), travel through transfers and kit assembly, and are stamped onto shipments. Reports → "Heat number trace" shows the full purchase→sale genealogy.

### Rebuilding the seed from Zoho exports

```
python3 scripts/extract_from_zoho.py Item.xls Composite_Item.xls data/seed/seed.json data/seed/seed_v2.json
npm run seed
```
