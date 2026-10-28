"""Add title and caption around the rendered mermaid diagram. python3 fig5_title.py in.png out.png"""
import sys
from PIL import Image, ImageDraw, ImageFont
im = Image.open(sys.argv[1]).convert("RGB"); W, H = im.size
pad = int(W * 0.015); top = int(W * 0.05); bot = int(W * 0.03)
out = Image.new("RGB", (W + 2 * pad, H + top + bot), "white"); out.paste(im, (pad, top))
d = ImageDraw.Draw(out)
F = "/usr/share/fonts/truetype/dejavu/"
d.text((pad, int(top * 0.18)), "Figure 5 — How v2 works: every imported line is read, cross-checked, and either committed, questioned, or held",
       font=ImageFont.truetype(F + "DejaVuSans-Bold.ttf", int(W * 0.0125)), fill="#111111")
d.text((pad, int(top * 0.62)), "Node.js + Express · SQLite (better-sqlite3) · pdf.js · SheetJS · Socket.IO.   File names refer to the code in the repository.",
       font=ImageFont.truetype(F + "DejaVuSans.ttf", int(W * 0.0085)), fill="#555555")
d.text((pad, H + top + int(bot * 0.25)), "Nothing reaches the stock figures until step 5. Clean files pass straight through; only lines whose numbers disagree wait for a person.",
       font=ImageFont.truetype(F + "DejaVuSans.ttf", int(W * 0.0085)), fill="#555555")
out.save(sys.argv[2]); print("wrote", sys.argv[2])
