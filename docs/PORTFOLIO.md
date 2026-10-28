# MIT Maker Portfolio — attachment plan

MIT's rules for this kind of project (mitadmissions.org/apply/freshman/supplements):

- **Code projects need two things:** the codebase (ideally version-controlled) and a working demo.
- **Every attachment needs a clear explanation.**
- **Video is capped at 2 minutes in total.**
- **Reviewers care more about *how* it was built than about the finished product.**

The plan below follows those rules. It is 6 attachments plus a link to the code. Each caption is short enough to paste into SlideRoom.

---

## 1 · Video: `demo_v1_vs_v2.mp4` (60 s)

**Title:** The same supplier invoice, imported by v1 and by v2

**Caption:**
I built v1 of my father's company's inventory system so that stock could never go negative. Testing it on supplier invoices, I found it booked the *Amount* column as the quantity: 48,000 bolts became 4,622.4, with no warning. In this video the same PDF goes into both versions. v2 reads each number from its column, then checks that quantity × unit price equals the printed amount. Lines that pass are committed; the one that doesn't (16 × 0.4457 ≠ 71.31) is held with a suggested fix. Re-sending the same file is caught by its SHA-256 hash.

## 2 · Image: `fig5_architecture.png`

**Title:** How v2 works

**Caption:**
Every imported line goes through five stages:
1. Read from the file. PDFs are read as tables from the x/y position of each word, not as plain text.
2. Parse the numbers, keeping every possible reading of an ambiguous value like "1.250".
3. Cross-check against the document's own arithmetic, the item master, order history and earlier imports.
4. Classify as OK, WARN or BLOCK.
5. Record it: staging first, then an atomic commit to an append-only ledger whose database constraint forbids negative stock.

Nothing touches the stock figures until stage 5. Stack: Node.js, Express, SQLite, pdf.js, SheetJS, Socket.IO.

## 3 · Image: `fig1_pdf_geometry.png`

**Title:** What the PDF reader actually sees

**Caption:**
Each box is drawn from the PDF's own text coordinates. v2 finds the header row and gives each column a span from its header's left edge to the next header's left edge. It then assigns each number to the span it overlaps most. My first version measured distance to the header's centre instead, and put "5,000" under *Unit*, because the headers are left-aligned and the numbers right-aligned. Right side: v1 booked the last number on each line; v2 commits a line only when quantity × price reproduces the amount.

## 4 · Image: `fig3_stress_test.png`

**Title:** Stress test: does the system fail loudly or silently?

**Caption:**
I tested how the importer handles changes in PDF layout by shifting each printed cell at random by up to σ points across 34 real documents (351 lines). As σ grows, v2 reads fewer quantities correctly (100% → 61%), but **silent errors stay at 0** at every noise level. When a quantity no longer matches the printed amount or weight, the line is held for review.

## 5 · Image: `fig2_tests_and_eval.png`

**Title:** Tests and evaluation: v1 vs v2 on the same files

**Caption:**
This is real terminal output, with 11 automated tests passing. The evaluation uses the company's 351 real order lines (real product codes, quantities and unit weights). Each document is rendered as 6 file formats, and 20% of lines get one of 8 simulated errors: negative numbers, ×10 typos, "31.250"-style separators, kg instead of pieces, boxes, code typos, pasted lines, and duplicate files. The original v1 code runs unchanged as the baseline. With a price or weight column available, silent wrong lines fell from 587 to 2. With only a quantity column, they fell from 587 to 54.

## 6 · Image: `fig4_audit_trace.png`

**Title:** Every stock figure traces back to a file, a line and a person

**Caption:**
`scripts/trace.js` follows a stock number back to its source. It shows the original file's hash, what the file said versus what was booked, which checks passed, and who changed what and why (e.g. "-8430" corrected to 8,430). A re-sent duplicate file is blocked before anything is booked. An undone import stays on the record as a reversing entry, because the ledger is append-only, and the ledger sum always equals the stock shown.

---

## Code

Link the repository (`git log` shows the build in stages, starting from v1). Point reviewers to:

- `DESIGN.md`: every change and the reason for it, including two bugs v2's own checks caught in v2.
- `eval/results/REPORT.md`: full results, and the cases v2 still misses.
- `npm test`, `npm run eval`: how to reproduce every number above.

## Wording rules for every caption

- Say "351 real order lines with **simulated** errors". Never say "it caught 351 real errors".
- Keep the remaining limitations in the report accurate when describing the results.
