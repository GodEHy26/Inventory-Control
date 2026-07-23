#!/usr/bin/env python3
"""
Build seed.json v2 from the Zoho Books exports:
  - Item export        -> item master with unit weight (kg), size, unit
  - Composite Item     -> assembly items + real BOM mappings

Stock starts at ZERO (per business decision). The old workbook extractor
(extract_from_xlsx.py) can still add extra non-Zoho items (round bar,
sagrods, anchors) as zero-stock items if its seed.json is passed 3rd.

Usage:
  python3 scripts/extract_from_zoho.py Item.xls Composite_Item.xls [old_seed.json] out.json
"""
import json, re, sys, datetime
import xlrd

def clean(s): return re.sub(r"\s+", " ", str(s)).strip()

def category_of(sku, name):
    n = name.upper()
    if sku.startswith("AA") or "BNW" in n or "SET" in n: return "Bolt-Nut-Washer Set"
    if sku.startswith("B"): return "Bolt"
    if sku.startswith("N") or " NUT" in n: return "Nut"
    if sku.startswith("W") or "WASHER" in n: return "Washer"
    if "ANCHOR" in n: return "Anchor Bolt"
    if "SAG" in n: return "Sag Rod"
    if "ROD" in n or "BAR" in n: return "Round Bar / Rod"
    if "SCREW" in n: return "Self Drill Screw"
    return "Fastener"

def coating_of(name):
    n = name.upper()
    if "HDG" in n or "GALV" in n: return "HDG"
    if "YZP" in n or "YELLOW ZINC" in n: return "YZP"
    if "ZINC" in n: return "Zinc Plated"
    if "BLACK" in n or "PLAIN" in n: return "Black"
    return ""

def main(item_xls, comp_xls, old_seed_path, out_path):
    items = {}

    # --- Zoho Item export ---
    wb = xlrd.open_workbook(item_xls)
    ws = wb.sheet_by_index(0)
    hdr = [clean(ws.cell_value(0, c)).lower() for c in range(ws.ncols)]
    col = {name: hdr.index(name) for name in hdr}
    def get(r, key, default=""):
        return clean(ws.cell_value(r, col[key])) if key in col else default
    for r in range(1, ws.nrows):
        sku = get(r, "sku")
        if not sku: continue
        w = get(r, "package weight")
        items[sku] = dict(
            sku=sku, name=get(r, "item name") or sku, item_type="part",
            category=category_of(sku, get(r, "item name")),
            size=get(r, "cf.size"), grade="", coating=coating_of(get(r, "item name")),
            uom=get(r, "usage unit") or "pcs",
            unit_weight=float(w) if w else 0.0,
            active=1 if get(r, "status").lower() != "inactive" else 0,
            source="Zoho Item export")

    # --- Zoho Composite Item export (assemblies + BOM) ---
    wb2 = xlrd.open_workbook(comp_xls)
    ws2 = wb2.sheet_by_index(0)
    hdr2 = [clean(ws2.cell_value(0, c)).lower() for c in range(ws2.ncols)]
    col2 = {name: hdr2.index(name) for name in hdr2}
    def g2(r, key, default=""):
        return clean(ws2.cell_value(r, col2[key])) if key in col2 else default
    boms = {}
    exceptions = []
    for r in range(1, ws2.nrows):
        parent = g2(r, "sku")
        comp = g2(r, "mapped item sku")
        if not parent: continue
        w = g2(r, "package weight")
        if parent not in items or items[parent]["item_type"] != "assembly":
            items[parent] = dict(
                sku=parent, name=g2(r, "composite item name") or parent,
                item_type="assembly", category="Bolt-Nut-Washer Set",
                size=g2(r, "cf.size"), grade="",
                coating=coating_of(g2(r, "composite item name")),
                uom=g2(r, "unit") or "pcs",
                unit_weight=float(w) if w else 0.0,
                active=1 if g2(r, "status").lower() != "inactive" else 0,
                source="Zoho Composite export")
        if comp:
            qty = float(g2(r, "mapped quantity") or 1)
            boms.setdefault(parent, [])
            if not any(c["sku"] == comp for c in boms[parent]):
                boms[parent].append(dict(sku=comp, qty=qty))
            if comp not in items:
                exceptions.append(f"BOM component {comp} (of {parent}) missing from Item export — created as bare item")
                items[comp] = dict(sku=comp, name=comp, item_type="part",
                    category=category_of(comp, comp), size="", grade="", coating="",
                    uom="pcs", unit_weight=0.0, active=1, source="auto (BOM component)")

    # --- extra items from the old workbook extraction (zero stock) ---
    if old_seed_path:
        old = json.load(open(old_seed_path))
        added = 0
        for it in old.get("items", []):
            if it["sku"] not in items:
                items[it["sku"]] = dict(
                    sku=it["sku"], name=it["name"], item_type=it["item_type"],
                    category=it.get("category", ""), size=it.get("size", ""),
                    grade=it.get("grade", ""), coating=it.get("coating", ""),
                    uom=it.get("uom", "each"), unit_weight=0.0, active=1,
                    source=f"Workbook: {it.get('source','')}")
                added += 1
        exceptions.append(f"{added} non-Zoho items (round bar, sagrods, anchors, etc.) added with zero stock")

    seed = dict(
        generated=datetime.date.today().isoformat(),
        source="Zoho Item + Composite Item exports (stock starts at 0)",
        warehouses=[dict(id="WH-MAIN", name="Main Warehouse (Jebel Ali)", address="Jebel Ali, Dubai, UAE"),
                    dict(id="WH-SAIF", name="SAIF Zone Warehouse", address="SAIF Zone, Sharjah, UAE")],
        items=list(items.values()),
        stock=[],           # start from zero
        shipments=[],
        boms=[dict(parent=p, components=c) for p, c in boms.items()],
        exceptions=exceptions)
    with open(out_path, "w") as f: json.dump(seed, f, indent=1)
    a = sum(1 for i in items.values() if i["item_type"] == "assembly")
    print(f"items={len(items)} (assemblies={a}) boms={len(boms)} exceptions={len(exceptions)}")

if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 3: main(args[0], args[1], None, args[2])
    else: main(args[0], args[1], args[2], args[3])
