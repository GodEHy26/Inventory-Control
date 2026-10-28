"""Turn eval/results/results.json into REPORT.md + charts.  python3 eval/report.py"""
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results")
R = json.load(open(os.path.join(OUT, "results.json")))

V1, V2, INK, INK2, GRID, SURF = "#eb6834", "#2a78d6", "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": GRID,
    "axes.labelcolor": INK2, "xtick.color": INK2, "ytick.color": INK2, "axes.facecolor": SURF,
    "figure.facecolor": SURF, "axes.spines.top": False, "axes.spines.right": False})

def pct(a, b): return 100.0 * a / b if b else 0.0

# ---------- chart 1: silent errors per format ----------
fm = R["formats"]
ids = list(fm.keys())
labels = [fm[i]["label"].replace(" (", "\n(").replace(", ", ",\n", 1) if len(fm[i]["label"]) > 28 else fm[i]["label"] for i in ids]
v1s = [fm[i]["v1"]["silent"] for i in ids]
v2s = [fm[i]["v2"]["silent"] for i in ids]
fig, ax = plt.subplots(figsize=(9.5, 4.4))
x = range(len(ids)); w = 0.38
b1 = ax.bar([i - w/2 - 0.01 for i in x], v1s, w, color=V1, label="v1 (writes straight to the ledger)")
b2 = ax.bar([i + w/2 + 0.01 for i in x], v2s, w, color=V2, label="v2 (Import Guard)")
for bars in (b1, b2):
    for b in bars:
        ax.text(b.get_x() + b.get_width()/2, b.get_height() + 25, f"{int(b.get_height()):,}", ha="center", color=INK, fontsize=9)
ax.set_xticks(list(x)); ax.set_xticklabels(labels, fontsize=8.5)
ax.set_ylabel("stock lines booked wrong, with no warning")
ax.yaxis.grid(True, color=GRID, linewidth=0.8); ax.set_axisbelow(True)
ax.legend(frameon=False, loc="upper left")
ax.set_title("Same 201 imports, same injected errors: wrong lines that got in silently", loc="left", color=INK, fontsize=11)
fig.tight_layout(); fig.savefig(os.path.join(OUT, "chart_silent_errors.png"), dpi=160); plt.close(fig)

# ---------- chart 2: layout-noise stress test ----------
fig, axes = plt.subplots(1, 3, figsize=(11, 3.8), sharey=True)
for ax, L in zip(axes, ["A", "B", "C"]):
    pts = R["jitter"][L]
    s = [p["sigma"] for p in pts]
    ax.plot(s, [pct(p["readOk"], p["n"]) for p in pts], color=V2, lw=2, marker="o", ms=5, label="v2 reads qty correctly")
    ax.plot(s, [pct(p["flagged"], p["n"]) for p in pts], color="#1baf7a", lw=2, marker="s", ms=5, label="v2 holds for review")
    ax.plot(s, [pct(p["silent"], p["n"]) for p in pts], color=INK, lw=2, marker="D", ms=5, label="v2 wrong & silent")
    ax.plot(s, [pct(p["v1silent"], p["v1Units"]) for p in pts], color=V1, lw=2, ls="--", label="v1 wrong & silent")
    ax.set_title({"A": "Invoice (amount last)", "B": "Order (qty last)", "C": "Packing list (weight last)"}[L], loc="left", fontsize=10, color=INK)
    ax.set_xlabel("layout noise σ (points each cell is shifted)")
    ax.yaxis.grid(True, color=GRID); ax.set_axisbelow(True); ax.set_ylim(-3, 105)
axes[0].set_ylabel("% of 351 real lines")
fig.legend(*axes[0].get_legend_handles_labels(), frameon=False, fontsize=8.5, loc="lower center", ncol=4, bbox_to_anchor=(0.5, -0.01))
fig.suptitle("Stress test: as the page gets messier, v2 misreads more — but turns misreads into questions, not wrong stock",
             x=0.01, ha="left", fontsize=10.5, color=INK)
fig.tight_layout(rect=(0, 0.07, 1, 1)); fig.savefig(os.path.join(OUT, "chart_noise_stress.png"), dpi=160); plt.close(fig)

# ---------- chart 3: per error type ----------
NAMES = {"NEG": "Negative qty", "X10": "Extra zero (×10)", "DIV10": "Dropped zero (÷10)", "SEP": "“31.250” separator",
         "KG": "Qty given in kg", "BOX": "Qty given in boxes", "SKUTYPO": "SKU typo", "DUPLINE": "Line pasted twice",
         "DUPFILE": "Whole file imported twice"}
be = R["byError"]
keys = [k for k in NAMES if be.get(k, {}).get("n")]
caught = [pct(be[k]["caughtLine"] + be[k]["caughtDocOnly"], be[k]["n"]) for k in keys]
silent = [pct(be[k]["silent"], be[k]["n"]) for k in keys]
fig, ax = plt.subplots(figsize=(8.5, 4.2))
y = range(len(keys))
ax.barh(list(y), caught, color=V2, height=0.55, label="held for review")
ax.barh(list(y), silent, left=caught, color=INK, height=0.55, label="got through silently")
for i, k in enumerate(keys):
    ax.text(101, i, f"{caught[i]:.0f}%  (n={be[k]['n']:,})", va="center", fontsize=8.5, color=INK2)
ax.set_yticks(list(y)); ax.set_yticklabels([NAMES[k] for k in keys]); ax.invert_yaxis()
ax.set_xlim(0, 125); ax.set_xticks([0, 25, 50, 75, 100]); ax.set_xlabel("% of injected errors (all six file formats, 5 seeds)")
ax.legend(frameon=False, loc="lower left", bbox_to_anchor=(0, 1.0), ncol=2, fontsize=8.5)
ax.set_title("v2: what happened to each kind of error", loc="left", color=INK, fontsize=11, pad=24)
fig.tight_layout(); fig.savefig(os.path.join(OUT, "chart_by_error.png"), dpi=160); plt.close(fig)

# ---------- REPORT.md ----------
c = R["config"]
cl = R["clean"]
def row(i):
    f = fm[i]; e1 = f["v1"]; e2 = f["v2"]
    return (f"| {f['label']} | {e1['silent']:,} | {e1['caught']:,} | **{e2['silent']:,}** | {e2['caught']:,} | "
            f"{f['docs']['cleanAuto']}/{f['docs']['clean']} |")
md = []
md.append("# Import Guard evaluation: v1 vs v2\n")
md.append(f"Generated by `node eval/run.js && python3 eval/report.py` ({R['generated'][:10]}). Every number below is reproducible: the corpus is deterministic.\n")
md.append("## What was tested\n")
md.append(f"- **Real data:** the {c['documents']} incoming documents ({c['lines']} lines) from the company's *Inventory Stock List as on 1 July 2026* — real SKUs, real quantities (2 to 468,750 pcs), real suppliers — with real unit weights from the Zoho item master.\n"
          "- **Synthetic:** unit prices (≈ USD 1.6–2.4/kg, fixed per SKU), the PDF page layouts, and the injected errors.\n"
          "- **Formats:** each document rendered six ways — a quantity-only CSV, a CSV with price/amount/weight, three PDF layouts (amount last, quantity last, weight last) and a PDF with no header row.\n"
          f"- **Errors:** {int(c['rate']*100)}% of lines carry one injected error (negative, ×10, ÷10, “31.250”-style separator, kg instead of pcs, boxes instead of pcs, SKU typo, line pasted twice); {int(c['euShare']*100)}% of documents use 1.234,5 number style; {int(c['dupShare']*100)}% of documents are imported twice. Five random seeds.\n"
          "- **v1** = the original importer, unchanged (`eval/baseline_v1/imports_v1.js`). **v2** = this release.\n"
          "- **The measure** is the business one: after the import, which stock lines are wrong, and did anything warn anyone? Scored per (document, SKU).\n")
md.append("## Headline\n")
tot1 = sum(fm[i]["v1"]["silent"] for i in ids); tot2 = sum(fm[i]["v2"]["silent"] for i in ids)
md.append(f"Across all six formats, **v1 booked {tot1:,} wrong stock lines without any warning; v2 booked {tot2:,}.** "
          f"With a CSV that has price/amount/weight columns, or any of the three PDF layouts, v2 let through **{fm['csv-full']['v2']['silent']}** silent errors out of {fm['csv-full']['v2']['caught'] + fm['csv-full']['v2']['silent']:,} wrong lines.\n")
md.append("![silent errors](chart_silent_errors.png)\n")
md.append("| Format | v1 wrong & silent | v1 skipped with a message | **v2 wrong & silent** | v2 held for review | v2: clean documents committed with no human touch |\n|---|---:|---:|---:|---:|---:|")
md += [row(i) for i in ids]
md.append("\n*v1's “skipped with a message”: rows v1 refused (negative or unknown SKU) and listed after the import — the purchase order was still booked without them.*\n")
md.append("## The cost: how often v2 bothers someone for nothing\n")
md.append("Run on the 34 real documents with **no injected errors**:\n")
md.append("| Format | real lines flagged | documents committed automatically | what was flagged |\n|---|---:|---:|---|")
for i, v in cl.items():
    codes = ", ".join(f"{k} ×{n}" for k, n in sorted(v["flagCodes"].items(), key=lambda kv: -kv[1])) or "—"
    md.append(f"| {v['label']} | {v['flaggedLines']}/{v['lines']} | {v['docs']['cleanAuto']}/{v['docs']['clean']} | {codes} |")
md.append("\n- With only a quantity column, the only evidence is history, so v2 asks about 16 real lines whose quantities are ≥10× off that SKU's usual order. Once price/amount/weight columns exist, those same quantities are confirmed by arithmetic and the questions disappear.\n"
          "- The one real document held in every format is container **A563MHDG-C18**: 6 of its 7 lines are identical (SKU and quantity) to C17. v2 asks “is this the same order sent twice?”. It isn't — but it is exactly the question a person should be asked.\n"
          "- With no header row, two lines are genuinely ambiguous (500 × 3 = 1,500: which is the quantity?) and v2 says so instead of guessing.\n")
md.append("## Each kind of error\n![by error](chart_by_error.png)\n")
md.append("| Error | n | held (line) | held (whole document) | silent | v2's suggested fix was the true value |\n|---|---:|---:|---:|---:|---:|")
for k in keys:
    e = be[k]
    md.append(f"| {NAMES[k]} | {e['n']:,} | {e['caughtLine']:,} | {e['caughtDocOnly']:,} | {e['silent']:,} | {pct(e['suggestOk'], e['caughtLine']):.0f}% |")
md.append("\n**Where v2 still fails (honestly):**\n"
          f"- **×10 / ÷10 typos in a quantity-only CSV:** {be['X10']['silent'] + be['DIV10']['silent']} got through, all of them in that one format (about {round(pct(be['X10']['silent'] + be['DIV10']['silent'], (be['X10']['n'] + be['DIV10']['n']) / 6))}% of the ×10/÷10 errors it contained). With no price or weight to cross-check, the only evidence is order history — and some SKUs legitimately vary 10× between orders.\n"
          "- **A typo that lands on another real SKU** with almost the same weight (BA325MT1GCM36X**140**F → …X**130**F, 1.55 vs 1.48 kg): nothing on the document contradicts it, in any format. This is the 1 silent case per format.\n")
md.append("## Stress test: page-layout noise\n")
md.append("Like testing a model against ε-perturbations: every printed cell is shifted left or right at random by up to σ points, no injected errors. v1 ignores layout entirely (it always takes the last number), so it's flat — right on layout B, wrong on every line of A and C. v2's reading degrades as the noise grows, but **at every noise level its silent-error count stays at 0**: when columns blur, qty × price stops equalling the amount, or qty × unit weight stops matching the weight, and the line is held.\n")
md.append("![noise](chart_noise_stress.png)\n")
md.append("| Layout | σ | v2 read correctly | v2 held | v2 wrong & silent | v1 wrong & silent |\n|---|---:|---:|---:|---:|---:|")
for L in ["A", "B", "C"]:
    for p in R["jitter"][L]:
        md.append(f"| {L} | {p['sigma']} | {p['readOk']}/{p['n']} | {p['flagged']} | **{p['silent']}** | {p['v1silent']}/{p['v1Units']} |")
md.append("\nCaveat: v2's zero depends on the document carrying a second number to check against (amount or weight). On a PDF with only a quantity column, layout noise could produce silent misreads; the arithmetic fallback would mark them low-confidence only when it finds no consistent reading.\n")
md.append("## Changes made during evaluation (kept honest)\n"
          "1. First PDF test, before any scoring: v2's column finder placed right-aligned numbers by distance to the header's centre, so “5,000” under “Qty” was read as the Unit column. Fixed by giving each column the span from its header's left edge to the next header's left edge.\n"
          "2. First full run: v2's own number parser read “0.162” as 162 (it treated `0.` as a thousands group). That made clean prices look wrong. Fixed: a thousands group never starts with 0. All numbers above are after this fix.\n"
          "3. Document totals were first only matched against the column they were printed under; noise showed totals rows are often offset. Now any printed total equal to a column sum counts. (This changed no headline number.)\n"
          "No threshold was tuned on these results. Thresholds were set beforehand: 20% weight tolerance (galvanising + packaging), 10× from a SKU's own history (100× from its category's), 50 t per line (above the largest stock position on the separate 1 July stock list).\n")
open(os.path.join(OUT, "REPORT.md"), "w").write("\n".join(md))
print("wrote REPORT.md + 3 charts")

# ---------- terminal summary ----------
print()
print(f"Corpus: {c['documents']} real documents, {c['lines']} real lines × 6 formats × {len(c['seeds'])} seeds "
      f"({int(c['rate']*100)}% of lines with an injected error)")
print(f"{'format':<42}{'v1 silent':>11}{'v2 silent':>11}{'v2 held':>9}{'clean docs auto':>17}")
for i in ids:
    f = fm[i]
    print(f"{f['label']:<42}{f['v1']['silent']:>11,}{f['v2']['silent']:>11,}{f['v2']['caught']:>9,}"
          f"{str(f['docs']['cleanAuto'])+'/'+str(f['docs']['clean']):>17}")
print()
print("Stress test, invoice layout A (σ = points each printed cell is shifted):")
print(f"{'σ':>4}{'v2 read ok':>13}{'v2 held':>10}{'v2 silent':>12}{'v1 silent':>12}")
for p in R["jitter"]["A"]:
    print(f"{p['sigma']:>4}{p['readOk']:>9}/{p['n']}{p['flagged']:>10}{p['silent']:>12}{p['v1silent']:>8}/{p['v1Units']}")
