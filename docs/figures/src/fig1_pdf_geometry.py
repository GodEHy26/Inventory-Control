"""Figure 1 — what the PDF reader actually sees.
Left: the real invoice page with v2's detected column spans and every number
boxed in the colour of the column it was assigned to. Right: what v1 booked
vs what v2 decided, line by line. All values come from geometry.js output.
Usage: python3 fig1_pdf_geometry.py geo.json page.png out.png"""
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from PIL import Image

geo = json.load(open(sys.argv[1])); page = Image.open(sys.argv[2]); out = sys.argv[3]
W, H = geo["page"]["w"], geo["page"]["h"]
INK, INK2, GRID = "#111111", "#555555", "#dddddd"
COL = {"qty": "#2a78d6", "price": "#7a4fd0", "amount": "#e0662e"}
plt.rcParams.update({"font.family": "DejaVu Sans"})

fig = plt.figure(figsize=(15, 4.3), dpi=170)
ax = fig.add_axes([0.01, 0.15, 0.98, 0.68])
ax.imshow(page, extent=[0, W, 0, H], interpolation="lanczos")
X0, X1, Y0, Y1 = 22, 905, 632, 784
ax.set_xlim(X0, X1); ax.set_ylim(Y0, Y1); ax.axis("off")
ax.add_patch(Rectangle((X0, Y0), 595 - X0 - 28, Y1 - Y0, fill=False, ec=GRID, lw=0.8))

# column spans: header left edge -> next header left edge
cols = geo["header"]["cols"]
for i, c in enumerate(cols):
    lo = c["x0"] - 2
    hi = cols[i + 1]["x0"] - 2 if i + 1 < len(cols) else 563
    if c["key"] in COL:
        ax.add_patch(Rectangle((lo, Y0 + 12), hi - lo, Y1 - Y0 - 24, color=COL[c["key"]], alpha=0.07, lw=0))
        ax.plot([lo, lo], [Y0 + 12, Y1 - 12], color=COL[c["key"]], lw=1, ls=(0, (3, 2)))
        ax.text(lo + 2, Y1 - 3, f"{c['key'].upper()} span", color=COL[c["key"]], fontsize=8, va="top", weight="bold")

# assign each number token to its column (same rule as pdfparse.js: max overlap)
spans = []
for i, c in enumerate(cols):
    lo = c["x0"] - 2; hi = cols[i + 1]["x0"] - 2 if i + 1 < len(cols) else 1e9
    spans.append((c["key"], lo, hi))
def col_of(x0, x1):
    return max(spans, key=lambda s: min(x1, s[2]) - max(x0, s[1]))[0]
import re
num = re.compile(r"^[\d][\d.,]*$")
hy = geo["header"]["y"]
for it in geo["items"]:
    if it["y"] >= hy or it["y"] < Y0 + 4 or not num.match(it["str"]): continue
    k = col_of(it["x"], it["x"] + it["w"])
    if k in COL:
        ax.add_patch(Rectangle((it["x"] - 1.5, it["y"] - 2.2), it["w"] + 3, 9.2, fill=False, ec=COL[k], lw=1.3))

# right-hand panel: v1 vs v2 per line
rows = [it for it in geo["items"] if it["str"].startswith("BA") and it["y"] < hy]
xv1, xv2 = 600, 690
ax.text(xv1, hy + 2, "v1 books", fontsize=9, weight="bold", color=INK)
ax.text(xv2, hy + 2, "v2 decides", fontsize=9, weight="bold", color=INK)
ax.text(xv1, hy - 6, "(last number on line)", fontsize=7, color=INK2)
ax.text(xv2, hy - 6, "(qty column, then cross-check qty × price = amount)", fontsize=7, color=INK2)
for r, l in zip(rows, geo["v2"]):
    y = r["y"] + 1
    last = [it for it in geo["items"] if abs(it["y"] - r["y"]) < 1 and num.match(it["str"])][-1]["str"]
    ax.text(xv1, y, f"{last} pcs  ✗", fontsize=8.5, color="#b3261e", family="DejaVu Sans Mono")
    if l["status"] == "ok":
        t, c = f"✓ {l['qty_raw']}   {l['qty_raw']} × {l['price_raw']} = {l['amount_raw']}", "#1b7a46"
    elif l["status"] == "block":
        t, c = f"✕ HOLD  {l['qty_raw']} × {l['price_raw']} ≠ {l['amount_raw']} → implies {l['issues'][0]['suggest']['qty']}", "#b3261e"
    else:
        t, c = f"⚠ ASK   same SKU as line 1 — pasted twice?", "#b26b00"
    ax.text(xv2, y, t, fontsize=8.5, color=c, family="DejaVu Sans Mono")

fig.text(0.01, 0.93, "Figure 1 — Reading a supplier invoice: v1 vs v2 on the same PDF", fontsize=13, weight="bold", color=INK)
fig.text(0.01, 0.875, "Boxes are drawn from the PDF's own text coordinates (pdf.js). Each number is assigned to the column span it overlaps most; "
         "colour = assigned column.", fontsize=9, color=INK2)
fig.text(0.01, 0.085, "v1 took the last number on each line as the quantity, so it booked the Amount column (and summed the repeated line into 9,244.8 bolts).\n"
         "v2 reads the Qty column and commits a line only when quantity × unit price reproduces the printed amount.", fontsize=8.8, color=INK2)
fig.text(0.01, 0.015, "Source: sample_pdf-A.pdf (eval/results/samples) — real SKUs and quantities from the 1 Jul 2026 stock list; prices and the two errors on lines 2 and 4 are simulated.",
         fontsize=7.6, color=INK2)
fig.savefig(out, facecolor="white"); print("wrote", out)
