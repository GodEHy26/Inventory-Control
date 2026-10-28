// v2: quantity parsing that admits when it is unsure.
//
// v1 did `parseFloat(str.replace(/[, ]/g, ''))`. That silently turns
// "1.250" (one thousand two hundred fifty, written the European way) into
// 1.25 bolts, and "5000 kg" into 5000 pieces. Here every number comes back
// with the interpretations it could have, so the validator can decide
// whether to trust it or ask a person.

const COUNT_UNITS = /^(pcs?|pieces?|nos?|numbers?|each|ea|units?|sets?|kits?|qty)$/i;
const MASS_UNITS = { kg: 1, kgs: 1, kilo: 1, kilos: 1, kilogram: 1, kilograms: 1,
  t: 1000, ton: 1000, tons: 1000, tonne: 1000, tonnes: 1000, mt: 1000 };
const PACK_UNITS = /^(box(es)?|bx|ctns?|cartons?|bags?|pkts?|packs?|packets?|cases?|pallets?|plt)$/i;
const LENGTH_UNITS = /^(m|mtrs?|meters?|metres?|mm)$/i;

function unitKind(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase().replace(/\.$/, '');
  if (!s) return null;
  if (COUNT_UNITS.test(s)) return { kind: 'count', unit: s };
  if (MASS_UNITS[s] != null) return { kind: 'mass', unit: s, toKg: MASS_UNITS[s] };
  if (PACK_UNITS.test(s)) return { kind: 'pack', unit: s };
  if (LENGTH_UNITS.test(s)) return { kind: 'length', unit: s };
  return { kind: 'unknown', unit: s };
}

/**
 * Parse one numeric cell.
 * locale: 'us' (1,234.5), 'eu' (1.234,5) or null (unknown — infer, and say so).
 * Returns { value, raw, unit, negative, ambiguous, alternatives[], style }
 *   style: 'us' | 'eu' | 'plain' — which convention the text itself proves.
 */
function parseNumber(raw, locale = null) {
  const out = { raw: raw == null ? '' : String(raw), value: null, unit: null,
    negative: false, ambiguous: false, alternatives: [], style: null };
  let s = out.raw.trim();
  if (!s) return out;
  // Accounting negatives "(900)" and trailing minus "900-".
  if (/^\(.*\)$/.test(s)) { out.negative = true; s = s.slice(1, -1).trim(); }
  if (/-$/.test(s) && !/^-/.test(s)) { out.negative = true; s = s.slice(0, -1).trim(); }
  // Peel a unit suffix/prefix ("5000 pcs", "1,250kg").
  const um = /^([-+]?[\d.,\s']+)\s*([A-Za-z.]+)?$/.exec(s);
  if (!um) return out;
  let num = um[1].replace(/[\s']/g, '');
  if (um[2]) out.unit = um[2];
  if (num.startsWith('-')) { out.negative = true; num = num.slice(1); }
  if (num.startsWith('+')) num = num.slice(1);
  if (!/\d/.test(num)) return out;

  const hasDot = num.includes('.'), hasComma = num.includes(',');
  let value = null;
  if (hasDot && hasComma) {
    // Whichever separator comes last is the decimal mark. Unambiguous.
    if (num.lastIndexOf(',') > num.lastIndexOf('.')) {
      value = parseFloat(num.replace(/\./g, '').replace(',', '.')); out.style = 'eu';
    } else {
      value = parseFloat(num.replace(/,/g, '')); out.style = 'us';
    }
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = num.split(sep);
    // A thousands group never starts with 0: "0.162" can only be a decimal.
    const groupsOf3 = parts.length > 1 && parts.slice(1).every(p => p.length === 3) && /^[1-9]\d{0,2}$/.test(parts[0]);
    if (parts.length > 2) {
      // "1.250.000" or "1,250,000" — only thousands grouping makes sense.
      value = parseFloat(parts.join('')); out.style = sep === ',' ? 'us' : 'eu';
    } else if (!groupsOf3) {
      // "0.12", "12,5" — only a decimal reading makes sense.
      value = parseFloat(parts.join('.')); out.style = sep === '.' ? 'us' : 'eu';
    } else {
      // "1,250" or "1.250": thousands grouping OR a decimal with 3 places.
      const asThousands = parseFloat(parts.join(''));
      const asDecimal = parseFloat(parts.join('.'));
      const prefer = locale || (sep === ',' ? 'us' : null);
      if (prefer === 'us') value = sep === ',' ? asThousands : asDecimal;
      else if (prefer === 'eu') value = sep === '.' ? asThousands : asDecimal;
      else value = asThousands; // best guess, but flagged below
      if (!locale) {
        out.ambiguous = sep === '.'; // "1,250" is the overwhelmingly normal US/UK/Gulf form
        out.alternatives = [asThousands, asDecimal].filter(v => v !== value);
      }
    }
  } else {
    value = parseFloat(num); out.style = 'plain';
  }
  if (!Number.isFinite(value)) return out;
  out.value = out.negative ? -value : value;
  out.alternatives = out.alternatives.map(v => (out.negative ? -v : v));
  return out;
}

/** Look at every numeric cell in a document and decide its convention. */
function inferLocale(rawCells) {
  let us = 0, eu = 0;
  for (const c of rawCells) {
    const p = parseNumber(c);
    if (p.style === 'us') us++;
    else if (p.style === 'eu') eu++;
  }
  if (us && !eu) return { locale: 'us', us, eu };
  if (eu && !us) return { locale: 'eu', us, eu };
  return { locale: null, us, eu }; // no evidence, or contradictory evidence
}

// How many decimal places a printed number carries, given the document's
// convention. Used to size arithmetic tolerances: a price printed as 0.05
// could really be anything in [0.045, 0.055).
function decimalsOf(raw, locale = 'us') {
  const s = String(raw || '').trim().replace(/[A-Za-z\s]+$/, '');
  const mark = locale === 'eu' ? ',' : '.';
  const i = s.lastIndexOf(mark);
  if (i < 0) return 0;
  const tail = s.slice(i + 1).replace(/[^\d]/g, '');
  return tail.length;
}

module.exports = { parseNumber, inferLocale, unitKind, decimalsOf };
