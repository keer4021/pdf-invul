// Bespeur invulvelde in 'n "plat" PDF (sonder AcroForm-velde).
// 1. Bestaande AcroForm-velde (via pdf-lib) word eerste gebruik.
// 2. Anders: onderstreep-lyne ("_____") in die teks  -> teksveld
//    Wingdings/☐-karakters of klein vierkante reghoeke -> merkblokkie
//    Groter geteken reghoeke (bv. 'n rekeningnommer-boks) -> teksveld
import { PDFDocument, PDFTextField, PDFCheckBox } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const { OPS, Util } = pdfjs;
const CHECKBOX_CHARS = /[☐□■]/;

export async function detectFields(bytes) {
  const acro = await detectAcroForm(bytes);
  if (acro.length) return { source: 'acroform', fields: acro };
  return { source: 'heuristic', fields: await detectHeuristic(bytes) };
}

async function detectAcroForm(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = doc.getPages();
  const out = [];
  for (const f of doc.getForm().getFields()) {
    for (const w of f.acroField.getWidgets()) {
      const r = w.getRectangle();
      const pageIndex = Math.max(0, pages.findIndex((p) => p.ref === w.P()));
      out.push({
        id: f.getName(), name: f.getName(), pageIndex,
        type: f instanceof PDFCheckBox ? 'checkbox' : 'text',
        x: r.x, y: r.y, width: r.width, height: r.height,
      });
    }
  }
  return out;
}

async function detectHeuristic(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const fields = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const pageIndex = p - 1;
    const { items } = await page.getTextContent();
    const pageFields = [];
    let lastLabel = '';

    for (const it of items) {
      if (!it.str) continue;
      const [a, , , d, e, f] = it.transform;
      const fontH = Math.abs(d) || Math.abs(a) || 10;
      const charW = it.width / Math.max(1, it.str.length);

      // Onthou die laaste stukkie gewone teks as etiket
      const label = it.str.replace(/_+/g, '').replace(/[-☐□]/g, '').trim();
      if (label.length > 1) lastLabel = label.replace(/[:.\s]+$/, '');

      // Onderstreep-lyne -> teksvelde
      // Posisie word van die regterkant af bereken: onderstrepe is ~0.5em breed,
      // terwyl etiket-letters wissel, so dit is akkurater as 'n gemiddelde.
      const uW = fontH * 0.5;
      for (const m of it.str.matchAll(/_{3,}/g)) {
        const after = it.str.length - (m.index + m[0].length);
        const end = e + it.width - after * charW;
        const start = Math.max(e + (m.index ? m.index * charW * 0.6 : 0), end - m[0].length * uW);
        pageFields.push({
          type: 'text', src: 'line', pageIndex, label: lastLabel,
          x: start, y: f - fontH * 0.15,
          width: end - start, height: fontH * 1.25,
        });
      }
      // Merkblokkie-karakters
      [...it.str].forEach((ch, i) => {
        if (CHECKBOX_CHARS.test(ch)) {
          const next = it.str.slice(i + 1).trim().split(/\s{2,}/)[0];
          pageFields.push({
            type: 'checkbox', pageIndex, label: next || lastLabel,
            x: e + i * charW, y: f - fontH * 0.1, width: fontH, height: fontH,
          });
        }
      });
    }

    // Geteken reghoeke en tabelselle
    const { rects, segs } = await geometry(page);
    const boxes = [...rects, ...cellsFromLines(segs)];
    const words = items.filter((it) => it.str && it.str.trim())
      .map((it) => ({ s: it.str.trim(), x: it.transform[4], y: it.transform[5] }));
    for (const { x, y, w, h } of boxes) {
      if (h > 40 || w > 500 || h < 5 || w < 5) continue;
      // Leë boks? (geen teks binne-in)
      if (words.some((t) => t.x > x && t.x < x + w && t.y > y && t.y < y + h)) continue;
      // Etiket direk regs van die boks -> merkblokkie
      const right = words.find((t) => t.x >= x + w - 1 && t.x < x + w + 25 && t.y > y - 2 && t.y < y + h);
      if (right || (w <= 16 && Math.abs(w - h) < 3)) {
        pageFields.push({ type: 'checkbox', pageIndex, label: right ? right.s : '', x, y, width: w, height: h });
      } else {
        pageFields.push({ type: 'text', src: 'cell', pageIndex, label: lastLabelAbove(words, x, y, w), x: x + 1, y: y + 1, width: w - 2, height: h - 2 });
      }
    }
    const kept = dedupe(pageFields);
    // Tabelselle met dieselfde kolomopskrif kry 'n rynommer (van bo na onder)
    const cols = new Map();
    for (const f of kept.filter((f) => f.src === 'cell' && !f.comb && f.label).sort((p, q) => q.y - p.y)) {
      const key = `${f.label}@${Math.round(f.x)}`;
      const n = (cols.get(key) || 0) + 1;
      cols.set(key, n);
      f.row = n;
    }
    for (const f of kept) if (f.row && cols.get(`${f.label}@${Math.round(f.x)}`) > 1) f.label += ` row ${f.row}`;
    fields.push(...kept);
  }
  // Etikette vir blokkies sonder etiket: naaste teks regs daarvan
  return fields.map((f, i) => ({
    ...f,
    id: `f${i + 1}`,
    name: `${f.label || (f.type === 'checkbox' ? 'Checkbox' : 'Field')} (${i + 1})`,
  }));
}

// Loop deur die operatorlys: versamel geverfde reghoeke en reguit lynstukke
// (knipbane/clip-paths word geïgnoreer, anders tel ikone as blokkies).
const PAINT = new Set(['stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke',
  'eoFillStroke', 'closeFillStroke', 'closeEOFillStroke'].map((k) => OPS[k]));

async function geometry(page) {
  const ops = await page.getOperatorList();
  const rects = [], segs = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const T = (x, y) => Util.applyTransform([x, y], ctm);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args[0]) ctm = Util.transform(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.constructPath) {
      if (!PAINT.has(ops.fnArray[i + 1])) continue;
      const [subOps, coords] = args;
      let c = 0, cur = null;
      for (const op of subOps) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(c, c + 4);
          const [x1, y1] = T(x, y), [x2, y2] = T(x + w, y + h);
          rects.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) });
          c += 4;
        } else if (op === OPS.moveTo) { cur = T(coords[c], coords[c + 1]); c += 2; }
        else if (op === OPS.lineTo) {
          const nxt = T(coords[c], coords[c + 1]); c += 2;
          if (cur) segs.push({ x1: cur[0], y1: cur[1], x2: nxt[0], y2: nxt[1] });
          cur = nxt;
        } else if (op === OPS.curveTo) c += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) c += 4;
      }
    }
  }
  // Dun reghoeke is eintlik lyne (Word teken tabelrande so)
  for (const r of rects) {
    if (r.h < 2 && r.w > 3) segs.push({ x1: r.x, y1: r.y + r.h / 2, x2: r.x + r.w, y2: r.y + r.h / 2 });
    else if (r.w < 2 && r.h > 3) segs.push({ x1: r.x + r.w / 2, y1: r.y, x2: r.x + r.w / 2, y2: r.y + r.h });
  }
  return { rects: rects.filter((r) => r.w >= 2 && r.h >= 2), segs };
}

// Vind tabelselle uit horisontale + vertikale lyne
function cellsFromLines(segs) {
  const H = [], V = [];
  for (const s of segs) {
    if (Math.abs(s.y1 - s.y2) < 1.5) H.push({ y: s.y1, a: Math.min(s.x1, s.x2), b: Math.max(s.x1, s.x2) });
    else if (Math.abs(s.x1 - s.x2) < 1.5) V.push({ x: s.x1, a: Math.min(s.y1, s.y2), b: Math.max(s.y1, s.y2) });
  }
  const tol = 2, cells = [];
  const hAt = (y, x1, x2) => H.some((h) => Math.abs(h.y - y) < tol && h.a <= x1 + tol && h.b >= x2 - tol);
  const ys = [...new Set(H.map((h) => Math.round(h.y)))].sort((p, q) => p - q);
  for (const v1 of V) {
    const rights = V.filter((v) => v.x > v1.x + 3 && v.a < v1.b - tol && v.b > v1.a + tol)
      .sort((p, q) => p.x - q.x);
    for (const v2 of rights) {
      const lo = Math.max(v1.a, v2.a), hi = Math.min(v1.b, v2.b);
      const rowYs = ys.filter((y) => y >= lo - tol && y <= hi + tol && hAt(y, v1.x, v2.x));
      for (let k = 0; k + 1 < rowYs.length; k++) {
        cells.push({ x: v1.x, y: rowYs[k], w: v2.x - v1.x, h: rowYs[k + 1] - rowYs[k] });
      }
      if (rowYs.length >= 2) break; // naaste regterlyn wat 'n sel vorm
    }
  }
  return cells.filter((c) => c.h > 6 && c.w > 6);
}

// Etiket vir 'n sel: eers die kolomopskrif (teks bo die sel binne dieselfde kolom),
// anders die naaste teks daarbo
function lastLabelAbove(words, x, y, w = 0) {
  const clean = (t) => t.s.replace(/[:.\s]+$/, '');
  const inCol = words.filter((t) => t.y > y && t.y < y + 200 && t.x >= x - 2 && t.x < x + w - 2 && !/^_+$/.test(t.s))
    .sort((p, q) => p.y - q.y)[0];
  if (inCol) return clean(inCol);
  const c = words.filter((t) => t.y > y && t.y < y + 60 && !/^_+$/.test(t.s))
    .sort((p, q) => p.y - q.y)[0];
  return c ? clean(c) : '';
}

function dedupe(list) {
  const out = [];
  for (const f of list) {
    // Voeg aangrensende onderstreep-stukke op dieselfde lyn saam
    // Tabelselle word net saamgevoeg as hulle smal blokkies is (bv. 'n rekeningnommer);
    // gewone tabelkolomme bly elk 'n eie veld.
    const joinable = f.src !== 'cell' || f.width <= 35;
    const join = joinable && out.find((o) => o.type === 'text' && f.type === 'text' && o.src === f.src &&
      (o.src !== 'cell' || o.width / (o.comb || 1) <= 35) &&
      Math.abs(o.y - f.y) < 2 && f.x - (o.x + o.width) < 12 && f.x >= o.x);
    if (join) {
      join.width = Math.max(join.width, f.x + f.width - join.x);
      // Aangrensende tabelselle (bv. rekeningnommer-blokkies) word 'n "kam"-veld:
      // een karakter per blokkie
      if (f.src === 'cell') join.comb = (join.comb || 1) + 1;
      continue;
    }
    const dup = out.find((o) => o.type === f.type &&
      Math.abs(o.x - f.x) < 4 && Math.abs(o.y - f.y) < 4);
    if (!dup) out.push(f);
  }
  return out;
}
