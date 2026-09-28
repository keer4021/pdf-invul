import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { detectFields } from './detect.mjs';
import { fillFlat, makeFillable } from './fill.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const docs = new Map(); // id -> { name, bytes, fields }

app.use(express.static(path.join(root, 'public')));
// PDF.js vir die frontend direk uit node_modules bedien
app.use('/pdfjs', express.static(path.join(root, 'node_modules/pdfjs-dist/build')));
app.use(express.json({ limit: '2mb' }));

// Laai 'n PDF op (rou liggaam) -> bespeur velde
app.post('/api/upload', express.raw({ type: 'application/pdf', limit: '25mb' }), async (req, res) => {
  try {
    const bytes = new Uint8Array(req.body);
    const id = crypto.randomUUID();
    const result = await detectFields(bytes);
    docs.set(id, { name: req.get('x-filename') || 'vorm.pdf', bytes, fields: result.fields });
    res.json({ id, ...result });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'Kon nie die PDF lees nie: ' + e.message });
  }
});

// Voorbeeld-vorm (Sapex-aansoek) direk laai
app.post('/api/sample', async (_req, res) => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(root, 'samples/sapex-aansoek.pdf')));
  const id = crypto.randomUUID();
  const result = await detectFields(bytes);
  docs.set(id, { name: 'sapex-aansoek.pdf', bytes, fields: result.fields });
  res.json({ id, ...result });
});

app.get('/api/pdf/:id', (req, res) => {
  const d = docs.get(req.params.id);
  if (!d) return res.sendStatus(404);
  res.type('application/pdf').send(Buffer.from(d.bytes));
});

// Vul in: { values: {veldId: waarde}, fields?: [...aangepaste velde], mode: 'flat'|'fillable' }
app.post('/api/fill/:id', async (req, res) => {
  const d = docs.get(req.params.id);
  if (!d) return res.sendStatus(404);
  const fields = Array.isArray(req.body.fields) ? req.body.fields : d.fields;
  const values = req.body.values || {};
  const out = req.body.mode === 'fillable'
    ? await makeFillable(d.bytes, fields, values)
    : await fillFlat(d.bytes, fields, values);
  const base = d.name.replace(/\.pdf$/i, '');
  res.type('application/pdf')
    .set('Content-Disposition', `attachment; filename="${base}-${req.body.mode === 'fillable' ? 'invulbaar' : 'ingevul'}.pdf"`)
    .send(Buffer.from(out));
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`PDF-invul loop op http://localhost:${port}`));
