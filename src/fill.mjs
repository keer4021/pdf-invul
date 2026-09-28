import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Die 5 basiese fonts wat die gebruiker per veld kan kies
const FONT_NAMES = {
  helvetica: StandardFonts.Helvetica,
  'helvetica-bold': StandardFonts.HelveticaBold,
  times: StandardFonts.TimesRoman,
  'times-bold': StandardFonts.TimesRomanBold,
  courier: StandardFonts.Courier,
};

// Bed elke font net een keer in, en net as dit gebruik word
function fontLoader(doc) {
  const cache = new Map();
  return (key) => {
    const name = FONT_NAMES[key] || StandardFonts.Helvetica;
    if (!cache.has(name)) cache.set(name, doc.embedFont(name));
    return cache.get(name);
  };
}

// Skryf waardes direk op die bladsy (plat, nie meer wysigbaar nie)
export async function fillFlat(bytes, fields, values) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const getFont = fontLoader(doc);
  const bold = await getFont('helvetica-bold');
  const pages = doc.getPages();

  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === '' || v === false) continue;
    const page = pages[f.pageIndex];
    if (!page) continue;

    if (f.type === 'signature') {
      await drawSignature(doc, page, f, v);
      continue;
    }
    if (f.type === 'checkbox') {
      const s = Math.min(f.height, 12);
      page.drawText('X', {
        x: f.x + (Math.min(f.width, f.height * 1.5) - s * 0.65) / 2,
        y: f.y + (f.height - s * 0.7) / 2,
        size: s, font: bold, color: rgb(0, 0, 0.55),
      });
      continue;
    }
    const font = await getFont(f.font);
    if (f.comb > 1) {
      const cw = f.width / f.comb, size = f.fontSize || Math.min(11, f.height * 0.7);
      [...String(v)].slice(0, f.comb).forEach((ch, i) => {
        page.drawText(ch, { x: f.x + i * cw + (cw - font.widthOfTextAtSize(ch, size)) / 2,
          y: f.y + (f.height - size) / 2 + 1, size, font, color: rgb(0, 0, 0.55) });
      });
    } else {
      const text = String(v);
      // Vaste grootte as die gebruiker een gekies het, anders krimp tot dit pas
      let size = f.fontSize || Math.min(11, f.height * 0.8);
      if (!f.fontSize) while (size > 5 && font.widthOfTextAtSize(text, size) > f.width - 2) size -= 0.5;
      page.drawText(text, {
        x: f.x + 2, y: f.y + Math.max(2, (f.height - size) / 2 + 1),
        size, font, color: rgb(0, 0, 0.55),
      });
    }
  }
  return doc.save();
}

// Handtekening (PNG/JPG data-URL) binne die veld, met behoud van verhouding
async function drawSignature(doc, page, f, dataUrl) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(String(dataUrl));
  if (!m) return;
  const bytes = Buffer.from(m[2], 'base64');
  const img = m[1] === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const k = Math.min(f.width / img.width, f.height / img.height);
  const w = img.width * k, h = img.height * k;
  page.drawImage(img, { x: f.x + (f.width - w) / 2, y: f.y + (f.height - h) / 2, width: w, height: h });
}
