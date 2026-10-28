# Inventory Control v2 — design notes

**One sentence:** v1 made it impossible for stock to go *negative*; v2 makes it hard for a *wrong positive number* to get in without someone being asked.

---

## 1. What was wrong with v1

v1 was solid at the bottom. Every movement goes through one ledger function, the database's `CHECK` constraints reject negative stock, and the stock figures can be rebuilt from the ledger at any time. That is why the spreadsheet's **−31,250 bolts** (a real cell on the 1 July 2026 stock list, `AA325MT1GCM12X035F`, "ORDERED" column) can't happen in v1.

The weak point was the front door. The importer turned files into ledger rows in one step and trusted every number it was given. Reading the v1 code and testing it on realistic files turned up these failure modes. Each one produces a *positive, plausible-looking* number, so the negative-stock guard never fires:

| # | v1 behaviour (file → line in `imports.js` / `index.js`) | What actually happens |
|---|---|---|
| 1 | PDF: "use the last number on the line as the quantity" | On an invoice laid out `Qty · Unit price · Amount`, **5,000 bolts at 0.12 are booked as 600**. On a packing list ending in `Net weight`, the weight is booked as pieces. No warning. |
| 2 | `parseFloat(qty.replace(/[, ]/g, ''))` | `"1.250"` (1,250 written European-style) → **1.25 bolts**. `"600,00"` → 60,000. `"5000 kg"` → 5,000 pieces. |
| 3 | Import commits immediately | One bad file writes hundreds of ledger rows. The only fix is manual adjustments, and someone has to notice first. |
| 4 | No memory of previous imports | Uploading the same file twice **doubles every line**. |
| 5 | PDF: same SKU on two lines is summed | A line pasted twice doubles that item's order, silently. |
| 6 | Unknown SKU → row skipped, listed afterwards | The purchase order is booked *without* that line. The list of skipped rows is easy to miss. |
| 7 | Stock adjustment uses `Math.abs(qty)` | A typed "−500" with direction "up" becomes +500. |
| 8 | `purchase_orders.status` allows `cancelled`, but no endpoint reaches it | A wrong PO can't be withdrawn; it leaves phantom on-order stock. |

The thread connecting them is the point of the essay: **the system was confidently wrong.** It never said "I'm not sure."

## 2. The principle

The research paper had the same lesson. The "robust" CNN was more accurate on clean digits, but under small perturbations it collapsed and kept answering, often "8". The model couldn't tell when it was wrong.

v2 applies that to the importer:

1. **Never silently choose between two readings.** If `1.250` could mean 1.25 or 1,250, either other evidence in the file settles it, or a person does.
2. **Cross-check with independent numbers on the same document.** Two sources agreeing is evidence; one number "looking unusual" is only a hint. Invoices already carry the check data: `qty × unit price = amount`, and `qty × unit weight ≈ shipping weight` (unit weights come from the Zoho item master).
3. **Every flag explains itself.** It says what was expected, what was found, and the likely correct value when the evidence points to one.
4. **Severity follows consequence, not suspicion.** **Block** means committing would almost certainly book a wrong number. **Warn** means plausible but unusual, so a person should glance at it. **Info** is recorded with no action needed.
5. **Clean files cost nothing extra.** If every line checks out, the file commits immediately, exactly like v1. Review only appears when there is something to review.

## 3. What changed, and why

### 3.1 Stage → review → commit → undo (`server/guard.js`)

- **Stage.** Parse and validate the file, then store every line with its issues in `import_batches` / `import_lines`. *Nothing touches the ledger.* This is the core change: a gap between "the file says" and "the ledger records".
- **Review.** For each line a person can:
  - accept a warning,
  - edit the SKU or quantity, which immediately re-runs all checks (so an edited quantity is still checked against the amount),
  - reject it,
  - or, for admin/purchasing only, override a block with a written reason.

  Every decision is stored with who and when.
- **Commit.** Only resolved lines are posted, in one atomic transaction. Each ledger row carries `import_batch`, `import_line`, the decision, and the file's original value if it was changed. Any stock figure can therefore be traced to the exact line of the exact file it came from, and to who approved it.
- **Undo.** A committed import can be reversed. A PO is cancelled, a sales order released, stock-ins reversed with `IMPORT_REVERSAL` entries. The ledger stays append-only: nothing is deleted, and the reversal is itself on the audit trail. If the stock has already been used, undo refuses rather than driving stock negative.

*Why not just validate and reject the whole file?* Real files are mostly right. Rejecting 59 good lines because of 1 bad one makes people stop using the importer and go back to typing, which is the error source the system was built to remove.

### 3.2 Numbers that admit ambiguity (`server/numbers.js`)

`parseNumber` returns every reading of a cell, not one guess:

- **Which separator is decimal?**
  - `1,234.50` vs `1.234,50`: the last separator is the decimal mark. Unambiguous.
  - `1,250`: thousands (the overwhelming convention in the company's US/UK/Gulf documents).
  - `1.250`: genuinely ambiguous, so the cell is marked `ambiguous`.
- **The document's convention is inferred from its unambiguous numbers** (`inferLocale`). In a file that also prints `0,12` and `600,00`, the cell `5.000` is clearly 5,000, so it isn't flagged. In a file with `0.12` and `600.00`, `31.250` is a typo-shaped anomaly, so it is flagged. A file mixing both styles gets a document-level warning.
- **Units are read, not stripped.** `kg`, `t`, `box`, `ctn` and `m` are recognised. A quantity in kg is converted using the item's unit weight and offered as a suggestion, never applied silently.
- **CSV cells reach the parser as typed** (`XLSX.read(..., { raw: true })` for CSV). Otherwise SheetJS converts `1.250` to 1.25 before our code ever sees it.

### 3.3 Reading PDFs as tables (`server/pdfparse.js`)

- **Find the header row** (`Qty`, `Unit Price`, `Amount`, `Net Wt (kg)`, …). Each column spans from its header's left edge to the next header's left edge, and every number goes to the column it overlaps most. So qty, price, amount and weight are each read from their own column.
- **No header?** Use arithmetic. Which number × which number = which number, where the first is a whole number? If exactly one reading works, that's the quantity. Next, try `qty × unit weight ≈ weight`. Only then fall back to v1's "last number", and mark it **low-confidence**, which blocks the line. It never quietly gets used.
- **"Total" rows are kept** and compared with the sum of the lines. A mismatch means a line was probably missed or misread.

### 3.4 The checks (`server/validate.js`)

| Check | Severity | Why this severity |
|---|---|---|
| Negative / zero / missing qty | block | A document can't order −900 pieces. |
| Can't tell which number is the qty | block | Any choice would be a guess. |
| `qty × price ≠ amount` (beyond printing precision) | block, suggests `amount ÷ price` | Two numbers from the supplier's own document contradict the one we read. |
| Weight off by exactly 10ⁿ | block, suggests the corrected qty | A factor of 10 is a dropped or added zero, not packaging. |
| Weight off by >20% otherwise | warn | Could be packaging, gross vs net, or plating. A person should look. |
| Quantity in kg / boxes / metres for a counted item | block, kg converted as suggestion | Booking it as pieces is wrong by definition. |
| Not a whole number of pieces | block | 1.25 bolts can't exist. Usually a separator problem. |
| Ambiguous separator, file doesn't settle it | warn | Probably fine; the reading used is shown. |
| Unknown SKU | block, nearest real SKU suggested (edit distance ≤ 2) | Creating a typo SKU splits one product's stock across two records. |
| New SKU 1 character from an existing one (items import) | warn | Same reason. |
| ≥10× away from this SKU's past orders (≥100× from its category's) | warn, **or info if price/weight confirm it** | History is weak evidence. Big orders happen. If the document's own arithmetic agrees, it's probably real. |
| Line over 50 t | warn | Above the largest stock position on the separate 1 July list (40.6 t). |
| Same SKU twice in a file | warn | Sometimes legitimate, sometimes a paste error. v1 silently summed it. |
| Same file imported before / same reference exists | block (document) | Would double every line. |
| ≥80% of lines identical to an open order | warn (document) | "Is this the same order sent twice?" |
| Printed total ≠ sum of lines | warn (document) | A line may be missing or misread. |

**The arithmetic tolerance is derived, not tuned.** A price printed as `0.05` is only known to ±0.005, so `qty × price` is only known to ±`qty × 0.005`. The check allows exactly that plus the amount's own rounding. In the tests, 5,000 × "0.05" vs 261.50 (true price 0.0523) correctly passes.

### 3.5 The same checks on typed-in orders and adjustments

- **PO and SO forms** run the same validators. A block is refused with the reason. A warning returns `409 needs_confirm`, and the form shows the warnings with "It's correct — save anyway" or "Go back and fix".
- **Stock adjustments:**
  - the quantity must be positive (the direction gives the sign; no more `Math.abs`),
  - a reason is required (it goes on the audit trail),
  - a count-up that would multiply stock ≥10× asks for confirmation.
- **PO cancel** now exists (`POST /api/po/:id/cancel`). It is refused once goods have been received.

### 3.6 The UI

- **A new Imports tab** with a badge for files waiting.
- **One review screen per file.** Each line shows its status, every finding in plain language, a one-click "Use 5,000"-style suggestion button, and edit/reject/override. Edited values show the file's original struck through.
- **Three colours, used one way everywhere:**
  - green: checked and consistent, and the chip says which checks agreed ("✓ arithmetic + weight"),
  - amber: a person should look,
  - red: would book a wrong number.

## 4. How it was evaluated

The full report is in [`eval/results/REPORT.md`](eval/results/REPORT.md), and `npm run eval` reproduces it.

- **Data.** 34 real incoming documents (351 lines) from the 1 July 2026 workbook, with real unit weights.
- **Formats.** Each document is rendered as 6 file formats.
- **Errors.** 20% of lines get one injected error of 8 types, 20% of documents are in European number style, and 15% are imported twice. 5 seeds.
- **Comparison.** The same files go through v1's original importer (kept unchanged in `eval/baseline_v1/`) and through v2.
- **Stress test.** Every PDF cell is randomly shifted by up to σ points, the same idea as the ε sweep in the adversarial-attacks paper.

## 5. Bugs v2 found in itself (kept on record)

1. **The column finder used distance to the header's centre.** On the most common layout (left-aligned header text, right-aligned numbers), "5,000" sat closer to the *Unit* header than to *Qty*. Found on the first test PDF; fixed with left-edge column spans.
2. **The number parser read `0.162` as 162.** It treated `0.` as a thousands group, which made clean prices fail the arithmetic check. Found by the evaluation's first run on clean documents; fixed: a thousands group never starts with 0. There is now a regression test.

Both are the same kind of error the project is about: a confident wrong reading. Both were caught because the cross-checks disagreed, not because the code looked wrong.

## 6. Known limits

- **A typo that turns one real SKU into another real SKU of nearly the same weight** (…M36X140F → …M36X130F, 1.55 vs 1.48 kg) passes every check. Nothing on the document contradicts it.
- **With a quantity-only file, ×10/÷10 typos are caught only by order history.** Some SKUs legitimately vary 10× between orders, so some get through. Asking suppliers for files with price or weight columns closes most of this gap.
- **Order-history checks need history.** A fresh install with zero stock has none, so they stay silent until orders accumulate.
- **PDFs must contain text.** Scanned images need OCR first, which v2 doesn't do.
- **Thresholds were set before evaluation and not tuned to it.** They are: 20% weight tolerance, 10× / 100× history, 50 t per line, edit distance 2. They live in `THRESHOLDS` in `validate.js`.
