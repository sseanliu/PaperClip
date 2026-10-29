// Finds figures on a PDF page: each "Figure N" / "Fig. N" caption, with the
// images and vector graphics right above it (or below, for a caption set
// above its figure), up to the running text. Sub-figure captions such as
// "(a) ..." count as part of the figure.
//
// findFigures(pageProxy, OPS) -> [{ x0, y0, x1, y1, captionTop, label }] in
// PDF points from the page's top left (scale-1 viewport space). y0..captionTop
// is the figure itself, captionTop..y1 its caption.

// "Figure 2:", "Fig. 3.", or Meta's "Figure 2 Multistage training." (a
// title in capitals right after the number). "Figure 3 shows ..." in running
// text has neither.
const CAPTION = /^(?:Figure|Fig\.?)\s*(\d+[a-z]?)(?:\s*[:.|]|\s+[A-Z])/;
const SUBCAPTION = /^\(\s*[a-z]\s*\)/i;

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function lettersIn(str) {
  return (str.match(/[A-Za-z]{3,}/g) || []).join('').length;
}

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

// The page-space box of a user-space rectangle under the transform m.
function boxOf(m, x0, y0, x1, y1) {
  const xs = [];
  const ys = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// Everything the page paints that isn't text: images (the unit square under
// the current transform) and filled or stroked paths (their bounding box).
async function graphicsOf(page, OPS, vp) {
  const { fnArray, argsArray } = await page.getOperatorList();
  const boxes = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let clip = null; // the last clipping path's box, where a shading paints
  const add = (b) => {
    const [x0, y0, x1, y1] = vp.convertToViewportRectangle(b);
    boxes.push({ x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) });
  };
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args[0]) && args[0].length === 6) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject
      || fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask) {
      add(boxOf(ctm, 0, 0, 1, 1));
    } else if (fn === OPS.constructPath) {
      // [paint op, path data, [minX, minY, maxX, maxY]]; a path that only
      // sets a clip (endPath) paints nothing itself.
      const minMax = args && args[2];
      if (minMax && minMax.length === 4 && Number.isFinite(minMax[0])) {
        const box = boxOf(ctm, minMax[0], minMax[1], minMax[2], minMax[3]);
        if (args[0] === OPS.endPath) clip = box;
        else add(box);
      }
    } else if (fn === OPS.shadingFill && clip) {
      // A gradient fills the clip it was given.
      add(clip);
    }
  }
  const pageArea = vp.width * vp.height;
  // Page backgrounds and frames are not figures.
  return boxes.filter((b) => (b.x1 - b.x0) * (b.y1 - b.y0) < pageArea * 0.8);
}

export async function findFigures(page, OPS) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const it of tc.items) {
    const str = (it.str || '').trim();
    if (!str) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    const [x, y] = vp.convertToViewportPoint(e, f);
    items.push({ str, x0: x, x1: x + it.width, base: y, top: y - size * 0.8, bottom: y + size * 0.25 });
  }
  if (!items.length) return [];
  const body = median(items.filter((i) => i.str.length > 3).map((i) => i.bottom - i.top)) / 1.05 || 10;

  // Lines: items on one baseline, split where a gap is wider than a few
  // spaces (two columns, or two sub-captions side by side).
  items.sort((p, q) => p.base - q.base || p.x0 - q.x0);
  const lines = [];
  for (const it of items) {
    // Captions side by side share baselines: a "Figure" after more than a
    // word space starts a line of its own.
    const startsCaption = /^(?:Figure|Fig\.?)(?:\s*\d|$)/.test(it.str);
    const line = lines.find((l) => Math.abs(l.base - it.base) < body * 0.25 && it.x0 < l.x1 + body * 1.5 && it.x1 > l.x0 - body * 1.5
      && !(startsCaption && it.x0 - l.x1 > body * 0.6));
    if (line) {
      line.items.push(it);
      line.x0 = Math.min(line.x0, it.x0);
      line.x1 = Math.max(line.x1, it.x1);
      line.top = Math.min(line.top, it.top);
      line.bottom = Math.max(line.bottom, it.bottom);
    } else {
      lines.push({ base: it.base, items: [it], x0: it.x0, x1: it.x1, top: it.top, bottom: it.bottom });
    }
  }
  for (const l of lines) {
    l.items.sort((p, q) => p.x0 - q.x0);
    l.text = l.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  }
  lines.sort((p, q) => p.top - q.top);

  const graphics = await graphicsOf(page, OPS, vp);
  if (!graphics.length) return [];

  // Text columns, from the left edges of long lines of running text. A
  // figure belongs to its caption's column, or spans them all (figure*).
  // Edges are medians, so a full-width title or abstract sharing the left
  // column's edge doesn't stretch it.
  const columns = [];
  for (const l of lines.filter((x) => lettersIn(x.text) >= 30).sort((p, q) => p.x0 - q.x0)) {
    const col = columns.find((c) => Math.abs(c.lefts[0] - l.x0) < body * 2.5);
    if (col) {
      col.lefts.push(l.x0);
      col.rights.push(l.x1);
    } else {
      columns.push({ lefts: [l.x0], rights: [l.x1] });
    }
  }
  const cols = columns.filter((c) => c.lefts.length >= 3)
    .map((c) => ({ left: Math.min(...c.lefts), right: median(c.rights) }));
  const textLeft = cols.length ? Math.min(...cols.map((c) => c.left)) : 0;
  const textRight = cols.length ? Math.max(...cols.map((c) => c.right)) : vp.width;

  const heads = lines.filter((l) => CAPTION.test(l.text));
  const found = [];
  for (const head of heads) {
    const m = head.text.match(CAPTION);
    // A caption starts its line at the left of its block, not mid-sentence.
    if (!m) continue;

    // Figures side by side, each with its caption: the space between two
    // neighbouring captions splits halfway.
    let left = -Infinity;
    let right = Infinity;
    for (const other of heads) {
      if (other === head || Math.abs(other.top - head.top) > body) continue;
      if (other.x0 >= head.x1) right = Math.min(right, (head.x1 + other.x0) / 2);
      else if (other.x1 <= head.x0) left = Math.max(left, (other.x1 + head.x0) / 2);
    }

    // The caption runs on through the lines below it, evenly spaced (only
    // its own side of a line shared with a neighbouring caption).
    const caption = { x0: head.x0, x1: head.x1, top: head.top, bottom: head.bottom };
    let last = head;
    for (const l of lines) {
      if (l.top <= last.top || l.top - last.bottom > body * 0.7) continue;
      const own = l.items.filter((i) => i.x0 >= left - 1 && i.x1 <= right + 1);
      if (!own.length) continue;
      const x0 = Math.min(...own.map((i) => i.x0));
      const x1 = Math.max(...own.map((i) => i.x1));
      if (x0 > caption.x1 || x1 < caption.x0) continue;
      caption.x1 = Math.max(caption.x1, x1);
      caption.x0 = Math.min(caption.x0, x0);
      caption.bottom = l.bottom;
      last = l;
    }
    const width = caption.x1 - caption.x0;
    const mid = (caption.x0 + caption.x1) / 2;
    const own = cols.find((c) => mid >= c.left - body && mid <= c.right + body);
    // A column too taken up by figures to show three long lines isn't found:
    // it starts at the caption and is as wide as the columns that were; on a
    // page with none (all figures), the page's text spans it.
    let col = own;
    if (!col && cols.length) {
      col = { left: caption.x0, right: Math.max(caption.x1, caption.x0 + Math.max(...cols.map((c) => c.right - c.left))) };
    } else if (!col) {
      col = { left: Math.min(...lines.map((l) => l.x0)), right: Math.max(...lines.map((l) => l.x1)) };
    }
    if (caption.x1 > col.right + body * 2 || (cols.length > 1 && width > (textRight - textLeft) * 0.6)) {
      col = { left: Math.min(textLeft, caption.x0), right: Math.max(textRight, caption.x1) };
    }
    col = { left: Math.max(col.left, left), right: Math.min(col.right, right) };
    // Graphics and labels of this figure stay within its column (side-by-side
    // figures each keep to their own).
    const inColumn = (b) => b.x0 >= col.left - body * 3 && b.x1 <= col.right + body * 3;
    // A figure wider than its column (or a short caption under a wide grid
    // of samples) is centred on its caption.
    const centredOnCaption = (b) => Math.abs((b.x0 + b.x1) / 2 - mid) < (b.x1 - b.x0) * 0.1
      && b.x0 >= textLeft - body * 3 && b.x1 <= textRight + body * 3;

    // Running text that ends a figure: a line as wide as most of the caption
    // that isn't a sub-caption and isn't inside the graphics.
    const blocks = (l) => !SUBCAPTION.test(l.text) && lettersIn(l.text) >= 30 && l.x1 - l.x0 > width * 0.8;
    const overlapsX = (g) => (inColumn(g) || centredOnCaption(g)) && Math.min(g.x1, caption.x1) - Math.max(g.x0, caption.x0) > Math.min(g.x1 - g.x0, width) * 0.3;

    // Collect graphics on one side of the caption, nearest first, as long as
    // no running text comes between.
    const collect = (above) => {
      // Text lines that aren't running text (axis labels, legends, sub-
      // captions) are stepping stones between graphics and the caption.
      const labels = lines
        .filter((l) => l !== head && !blocks(l) && inColumn(l))
        .map((l) => ({ x0: l.x0, x1: l.x1, y0: l.top, y1: l.bottom, label: true }));
      const side = [...graphics.filter(overlapsX), ...labels]
        .filter((g) => (above ? g.y1 <= caption.top + 2 : g.y0 >= caption.bottom - 2))
        .sort((p, q) => (above ? q.y1 - p.y1 : p.y0 - q.y0));
      const region = { top: caption.top, bottom: caption.bottom, x0: Infinity, x1: -Infinity, n: 0 };
      for (const g of side) {
        const edge = above ? region.top : region.bottom;
        const gap = above ? edge - g.y1 : g.y0 - edge;
        if (gap > body * 4) break;
        const between = lines.some((l) => blocks(l) && (above
          ? l.top >= g.y1 - 1 && l.bottom <= edge + 1
          : l.top >= edge - 1 && l.bottom <= g.y0 + 1));
        if (between) break;
        if (above) region.top = Math.min(region.top, g.y0);
        else region.bottom = Math.max(region.bottom, g.y1);
        if (g.label) continue;
        region.x0 = Math.min(region.x0, g.x0);
        region.x1 = Math.max(region.x1, g.x1);
        region.n += 1;
        region.edge = above ? region.top : region.bottom;
      }
      return region;
    };
    let side = collect(true);
    let above = true;
    if (!side.n) {
      side = collect(false);
      above = false;
    }
    if (!side.n) continue;
    // The outermost graphic ends the figure, plus a title or legend set as
    // text just beyond it.
    let figTop = above ? side.edge : caption.bottom;
    let figBottom = above ? caption.top : side.edge;
    for (const l of lines) {
      if (l === head || blocks(l) || !inColumn(l)) continue;
      // Lines reaching across the edge count too (a plot title over a frame).
      if (above && l.top < figTop && l.bottom >= figTop - body * 1.5) figTop = l.top;
      if (!above && l.bottom > figBottom && l.top <= figBottom + body * 1.5) figBottom = l.bottom;
    }
    if (figBottom - figTop < body * 2) continue;

    // Labels set as text (axis ticks, legends, sub-captions) widen the box.
    let x0 = Math.min(side.x0, caption.x0);
    let x1 = Math.max(side.x1, caption.x1);
    for (const l of lines) {
      if (l.top >= figTop - 1 && l.bottom <= figBottom + 1 && !blocks(l) && inColumn(l)) {
        x0 = Math.min(x0, l.x0);
        x1 = Math.max(x1, l.x1);
      }
    }
    const pad = body * 0.3;
    found.push({
      x0: Math.max(0, x0 - pad),
      x1: Math.min(vp.width, x1 + pad),
      y0: Math.max(0, (above ? figTop : caption.top) - pad),
      y1: Math.min(vp.height, (above ? caption.bottom : figBottom) + pad),
      // The clickable part: the figure, not its caption (whose text stays
      // selectable for translation).
      figTop: Math.max(0, figTop - pad),
      figBottom: Math.min(vp.height, figBottom + pad),
      label: `Figure ${m[1]}`,
    });
  }
  return found;
}
