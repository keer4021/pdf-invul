import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Skryf waardes direk op die bladsy (plat, nie meer wysigbaar nie)
export async function fillFlat(bytes, fields, values) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();

  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === '' || v === false) continue;
    const page = pages[f.pageIndex];
    if (!page) continue;

    if (f.type === 'checkbox') {
      const s = Math.min(f.height, 12);
      page.drawText('X', {
        x: f.x + (Math.min(f.width, f.height * 1.5) - s * 0.65) / 2,
        y: f.y + (f.height - s * 0.7) / 2,
        size: s, font: bold, color: rgb(0, 0, 0.55),
      });
    } else if (f.comb > 1) {
      const cw = f.width / f.comb, size = Math.min(11, f.height * 0.7);
      [...String(v)].slice(0, f.comb).forEach((ch, i) => {
        page.drawText(ch, { x: f.x + i * cw + (cw - font.widthOfTextAtSize(ch, size)) / 2,
          y: f.y + (f.height - size) / 2 + 1, size, font, color: rgb(0, 0, 0.55) });
      });
    } else {
      const text = String(v);
      let size = Math.min(11, f.height * 0.8);
      while (size > 5 && font.widthOfTextAtSize(text, size) > f.width - 2) size -= 0.5;
      page.drawText(text, {
        x: f.x + 2, y: f.y + Math.max(2, (f.height - size) / 2 + 1),
        size, font, color: rgb(0, 0, 0.55),
      });
    }
  }
  return doc.save();
}

// Maak 'n regte invulbare AcroForm-PDF met velde op die bespeurde posisies
export async function makeFillable(bytes, fields, values = {}) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  const used = new Set(form.getFields().map((f) => f.getName()));

  for (const f of fields) {
    const page = pages[f.pageIndex];
    if (!page) continue;
    let name = (f.name || f.id).replace(/[.]/g, ' ');
    while (used.has(name)) name += '_';
    used.add(name);

    if (f.type === 'checkbox') {
      const s = Math.min(f.width, f.height);
      const cb = form.createCheckBox(name);
      cb.addToPage(page, { x: f.x + 2, y: f.y + (f.height - s) / 2 + 1, width: s - 2, height: s - 2, borderWidth: 0 });
      if (values[f.id]) cb.check();
    } else {
      const tf = form.createTextField(name);
      tf.addToPage(page, { x: f.x, y: f.y, width: f.width, height: f.height, borderWidth: 0, font });
      if (f.comb > 1) { tf.setMaxLength(f.comb); tf.enableCombing(); }
      tf.setFontSize(0); // outomatiese grootte
      if (values[f.id]) tf.setText(String(values[f.id]));
    }
  }
  form.updateFieldAppearances(font);
  return doc.save();
}
