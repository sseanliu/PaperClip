// Finds display equations on a PDF page from its text: centred lines set in
// math fonts (TeX's CMMI / CMSY / CMEX and the like) with a relation such as
// "=", or beside an equation number "(4.1)" at the column's right edge.
// Inline math inside a sentence is left alone: the line around it is prose.
//
// findEquations(pageProxy) -> [{ x0, y0, x1, y1, label }] in PDF points
// with the origin at the page's top left (scale-1 viewport space).

const MATH_FONT = /CMMI|CMSY|CMEX|CMBSY|MSAM|MSBM|EUFM|EUSM|EUEX|RSFS|STMARY|LMMath|LatinModernMath|STIXMath|STIXTwoMath|XITSMath|CambriaMath|Cambria-Math|NewCMMath|TeXGyre\w*Math|Asana|wasy|bbold|dsrom|txsy|txex|pxsy|pxex|esint|Symbol/i;
const MATH_CHAR = /[=+\-−×·∑∏∫∂∇√∞≤≥≈∝∈∉⊂⊆∪∩→←⇒⇔∀∃αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ‖|^_()[\]{}]/;
const RELATION = /[=<>≤≥≈≃≅≡∝≺≻⊂⊆∈→←↦⇒⇔∼]|:=/;
const EQ_NUMBER = /^\(\s*(?:[A-Z]\.)?\d+(?:\.\d+)*[a-z]?\s*\)$/;

function fontNameOf(page, id) {
  try {
    return page.commonObjs.has(id) ? page.commonObjs.get(id).name || '' : '';
  } catch {
    return '';
  }
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// Operator names set upright in equations, not words of a sentence.
const OPERATOR = /^(?:log|exp|sin|cos|tan|tanh|max|min|arg|argmax|argmin|softmax|lim|sup|inf|det|diag|sgn|sign|mod|var|cov|tr|and|for|where|if|else|otherwise|s\.t)$/i;

// Letters in words of three or more: how much of a string is running text.
function lettersIn(str) {
  return (str.match(/[A-Za-z]{3,}/g) || []).filter((w) => !OPERATOR.test(w)).join('').length;
}

export async function findEquations(page) {
  const vp = page.getViewport({ scale: 1 });
  // Fonts are known once the page's operator list has been built (the canvas
  // render does it; this reuses the cached one).
  await page.getOperatorList();
  const tc = await page.getTextContent();

  const items = [];
  for (const it of tc.items) {
    const str = (it.str || '').trim();
    if (!str) continue;
    // Text space -> top-left page space at scale 1.
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    const [x, y] = vp.convertToViewportPoint(e, f);
    // Short runs of operators in a text font count too; an equation number
    // "(4)" doesn't.
    const math = MATH_FONT.test(fontNameOf(page, it.fontName))
      || (str.length <= 3 && MATH_CHAR.test(str) && !/^[A-Za-z]+$/.test(str) && !EQ_NUMBER.test(str));
    items.push({ str, size, x0: x, x1: x + it.width, base: y, top: y - size * 0.8, bottom: y + size * 0.25, math });
  }
  if (!items.length) return [];

  const body = median(items.filter((i) => i.str.length > 3).map((i) => i.size)) || 10;

  // Columns, from the long runs of body text: their left edges cluster.
  const columns = [];
  for (const it of items.filter((i) => !i.math && lettersIn(i.str) >= 25).sort((p, q) => p.x0 - q.x0)) {
    const col = columns.find((c) => Math.abs(c.left - it.x0) < body * 2.5);
    if (col) {
      col.right = Math.max(col.right, it.x1);
      col.n += 1;
    } else {
      columns.push({ left: it.x0, right: it.x1, n: 1 });
    }
  }
  const cols = columns.filter((c) => c.n >= 3);
  if (!cols.length) cols.push({ left: 0, right: vp.width });
  const centreOf = (c) => (c.left + c.right) / 2;
  const columnOf = (x0, x1) => {
    const mid = (x0 + x1) / 2;
    return cols.find((c) => mid >= c.left - body && mid <= c.right + body)
      || cols.reduce((best, c) => (Math.abs(mid - centreOf(c)) < Math.abs(mid - centreOf(best)) ? c : best));
  };

  // Equation numbers: "(4.1)" at the right edge of a column, in a text font.
  const numbers = [];
  for (const it of items) {
    it.col = columnOf(it.x0, it.x1);
    if (!it.math && EQ_NUMBER.test(it.str) && it.x1 > it.col.right - body * 2 && it.x0 > centreOf(it.col)) numbers.push(it);
  }

  // Lines: per column, items whose baselines are close. Sub- and
  // superscripts sit a little off and form short lines of their own; the
  // blocks below rejoin them.
  items.sort((p, q) => p.base - q.base || p.x0 - q.x0);
  const lines = [];
  for (const it of items) {
    if (numbers.includes(it)) continue;
    const line = lines.find((l) => l.col === it.col && Math.abs(l.base - it.base) < body * 0.2);
    if (line) {
      line.items.push(it);
      line.x0 = Math.min(line.x0, it.x0);
      line.x1 = Math.max(line.x1, it.x1);
      line.top = Math.min(line.top, it.top);
      line.bottom = Math.max(line.bottom, it.bottom);
    } else {
      lines.push({ col: it.col, base: it.base, items: [it], x0: it.x0, x1: it.x1, top: it.top, bottom: it.bottom });
    }
  }

  for (const l of lines) {
    const text = l.items.map((i) => i.str).join(' ');
    const letters = lettersIn(l.items.filter((i) => !i.math).map((i) => i.str).join(' '));
    const chars = text.replace(/\s+/g, '').length;
    const width = l.col.right - l.col.left;
    l.hasMath = l.items.some((i) => i.math);
    l.relation = RELATION.test(text);
    l.letters = letters;
    // Running text: long, or filling the column with mostly words.
    l.prose = letters >= 30 || (letters >= 10 && l.x1 - l.x0 > width * 0.7 && letters / chars > 0.4);
    // A display equation stands centred in its column, clear of its left edge.
    l.centred = l.x0 > l.col.left + body * 1.5 && Math.abs((l.x0 + l.x1) / 2 - centreOf(l.col)) < width * 0.2;
  }

  // Inline math in a sentence: its sub- and superscripts form short lines of
  // their own, right beside a prose line. Those belong to the prose.
  for (const l of lines) {
    l.inline = lines.some((p) => p.prose && p !== l && p.col === l.col
      && Math.abs(p.base - l.base) < body * 0.75 && l.x0 < p.x1 + body && l.x1 > p.x0 - body);
  }

  // Seeds: centred math lines with a relation, or a line an equation number
  // sits beside. (Tables of symbols and plot labels have neither.) Then the
  // math lines just above and below join them: fractions, sub/superscripts,
  // the rows of an aligned equation.
  // Each number belongs to one line: the one on (or nearest) its baseline.
  const numberOfLine = new Map();
  for (const n of numbers) {
    let best = null;
    for (const l of lines) {
      const off = Math.abs(n.base - l.base);
      if (l.col === n.col && off < body * 0.5 && n.x0 > l.x1 && (!best || off < best.off)) best = { l, off };
    }
    if (best) numberOfLine.set(best.l, n);
  }
  const numbered = (l) => numberOfLine.has(l);
  const seeds = lines.filter((l) => !l.prose && !l.inline && l.hasMath && ((l.centred && l.relation) || numbered(l)));
  const joinable = lines.filter((l) => !l.prose && !l.inline && (l.hasMath || l.letters < 10) && l.x0 > l.col.left + body * 0.5);

  const overlapX = (p, q) => p.x0 < q.x1 + body && p.x1 > q.x0 - body;
  const gapY = (p, q) => Math.max(p.top - q.bottom, q.top - p.bottom);

  // Seeds next to each other form one equation (aligned rows), unless both
  // carry a number: stacked numbered equations stay apart.
  const blocks = [];
  for (const seed of seeds.sort((p, q) => p.top - q.top)) {
    const bk = blocks.find((k) => k.col === seed.col && k.lines.some((l) => gapY(l, seed) < body * 0.9 && overlapX(l, seed))
      && !(numbered(seed) && k.lines.some(numbered)));
    if (bk) bk.lines.push(seed);
    else blocks.push({ col: seed.col, lines: [seed] });
  }

  // The other math lines (fractions, sub/superscripts, limits) go to the
  // nearest equation, closest first, each to one.
  const owner = new Map();
  for (const bk of blocks) for (const l of bk.lines) owner.set(l, bk);
  const rest = joinable.filter((l) => !owner.has(l));
  for (;;) {
    let best = null;
    for (const l of rest) {
      if (owner.has(l)) continue;
      for (const [m, bk] of owner) {
        if (m.col !== l.col || !overlapX(l, m)) continue;
        const g = gapY(l, m);
        if (g < body * 0.9 && (!best || g < best.g)) best = { l, bk, g };
      }
    }
    if (!best) break;
    best.bk.lines.push(best.l);
    owner.set(best.l, best.bk);
  }
  for (const bk of blocks) {
    bk.x0 = Math.min(...bk.lines.map((l) => l.x0));
    bk.x1 = Math.max(...bk.lines.map((l) => l.x1));
    bk.top = Math.min(...bk.lines.map((l) => l.top));
    bk.bottom = Math.max(...bk.lines.map((l) => l.bottom));
  }

  // The block's number is the one beside its numbered line.
  for (const bk of blocks) {
    const l = bk.lines.find(numbered);
    bk.number = l ? numberOfLine.get(l) : null;
  }

  const found = [];
  for (const bk of blocks) {
    if (bk.lines.flatMap((l) => l.items).filter((i) => i.math).length < 2) continue;
    // Too narrow for a display equation (a lone symbol or a short label).
    if (bk.x1 - bk.x0 < body * 3) continue;
    const pad = body * 0.35;
    found.push({
      x0: Math.max(0, bk.x0 - pad),
      y0: Math.max(0, bk.top - pad),
      x1: Math.min(vp.width, bk.x1 + pad),
      y1: Math.min(vp.height, bk.bottom + pad),
      label: bk.number ? bk.number.str.replace(/\s+/g, '') : null,
    });
  }
  return found;
}
