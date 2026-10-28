"""Figure 3 — the stress test. Top: one real document rendered at three noise
levels (σ = how far each printed cell is shifted). Bottom: results over all 351
real lines. Usage: python3 fig3_stress.py <scratch dir> results.json out.png"""
import json, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from PIL import Image

SP, RES, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
st = json.load(open(f"{SP}/st.json")); R = json.load(open(RES))
INK, INK2, GRID = "#111111", "#555555", "#e2e2e2"
BLUE, GREEN, ORANGE = "#2a78d6", "#1b9e6b", "#e0662e"
plt.rcParams.update({"font.family": "DejaVu Sans", "axes.spines.top": False, "axes.spines.right": False,
                     "axes.edgecolor": "#bbbbbb", "xtick.color": INK2, "ytick.color": INK2})
fig = plt.figure(figsize=(15, 8.4), dpi=160)
fig.text(0.012, 0.965, "Figure 3 — Stress test: make the page messier, count the errors that get through without a warning",
         fontsize=13.5, weight="bold", color=INK)
fig.text(0.012, 0.935, "Same idea as the ε-sweep in adversarial testing, applied to documents: every printed cell is shifted "
         "left/right at random by up to σ points.", fontsize=9.5, color=INK2)

s = 200 / 72  # render scale
for i, r in enumerate(st["res"]):
    im = Image.open(f"{SP}/st_{r['sigma']}-1.png")
    crop = im.crop((int(25 * s), int(68 * s), int(568 * s), int(240 * s)))
    ax = fig.add_axes([0.012 + i * 0.33, 0.63, 0.315, 0.26]); ax.imshow(crop); ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values(): sp.set_visible(True); sp.set_color("#cccccc")
    ax.set_title(f"σ = {r['sigma']} pt", loc="left", fontsize=11, weight="bold", color=INK)
    fig.text(0.012 + i * 0.33, 0.60, f"v2 on this page ({r['n']} lines):", fontsize=9, color=INK2)
    fig.text(0.012 + i * 0.33, 0.576, f"{r['ok']:>2} committed correctly · {r['held']:>2} held for review · {r['silent']} silent", fontsize=9.3, color=INK, family="DejaVu Sans Mono")

ax = fig.add_axes([0.06, 0.085, 0.92, 0.40])
pts = R["jitter"]["A"]; x = [p["sigma"] for p in pts]; pct = lambda a, b: 100 * a / b
ax.plot(x, [pct(p["readOk"], p["n"]) for p in pts], color=BLUE, lw=2.2, marker="o", ms=6, label="v2 reads the quantity correctly")
ax.plot(x, [pct(p["flagged"], p["n"]) for p in pts], color=GREEN, lw=2.2, marker="s", ms=6, label="v2 holds the line for review")
ax.plot(x, [pct(p["silent"], p["n"]) for p in pts], color=INK, lw=2.6, marker="D", ms=6, label="v2 wrong and silent")
ax.plot(x, [pct(p["v1silent"], p["v1Units"]) for p in pts], color=ORANGE, lw=2, ls="--", label="v1 wrong and silent")
for p in pts:
    if p["sigma"] in (0, 20, 40): ax.axvline(p["sigma"], color=GRID, lw=1, zorder=0)
ax.annotate("0 silent errors at every noise level", xy=(35, 0), xytext=(29, 20), fontsize=10, weight="bold", color=INK,
            arrowprops=dict(arrowstyle="->", color=INK))
ax.set_xlabel("layout noise σ (points)", color=INK2); ax.set_ylabel("% of 351 real lines", color=INK2)
ax.set_ylim(-4, 106); ax.yaxis.grid(True, color=GRID); ax.set_axisbelow(True)
ax.legend(frameon=False, loc="lower left", bbox_to_anchor=(0.36, 0.16), fontsize=9.5)
ax.set_title("All 34 real documents, invoice layout (Qty · Unit price · Amount)", loc="left", fontsize=10.5, color=INK)
fig.text(0.012, 0.012, f"Top: real document {st['ref']} (real SKUs and quantities; simulated prices). Bottom: eval/results/results.json. "
         "Misreads become questions because a wrong quantity no longer satisfies quantity × unit price = amount.",
         fontsize=8, color=INK2)
fig.savefig(OUT, facecolor="white"); print("wrote", OUT)
