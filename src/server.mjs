import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { detectFields } from './detect.mjs';
import { fillFlat } from './fill.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Stoorplek vir vorms: DATA_DIR in .env (bv. 'n gedeelde OneDrive-vouer), anders ./data/forms
const DATA = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data', 'forms');
await fs.mkdir(DATA, { recursive: true });
const app = express();
app.set('trust proxy', 'loopback');

app.use(express.static(path.join(root, 'public')));
// PDF.js vir die frontend direk uit node_modules bedien
app.use('/pdfjs', express.static(path.join(root, 'node_modules/pdfjs-dist/build')));
app.use(express.json({ limit: '15mb' })); // handtekeninge kom as prente saam

// --- Aanmelding vir die eienaar ---------------------------------------------------
// Die eienaar (OWNER_PASSWORD in .env) kan oplaai, velde wysig, deel en verwyder.
// Spanlede het geen wagwoord nie: hulle kan net die vorm oopmaak waarvan hulle die skakel
// (met die onraaibare vorm-ID) het, dit invul en aflaai.
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update('pdf-invul:' + OWNER_PASSWORD).digest();
const ownerToken = crypto.createHmac('sha256', SECRET).update('owner').digest('hex');
const cookies = (req) => Object.fromEntries((req.get('cookie') || '').split(';')
  .map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const safeEqual = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const isOwner = (req) => !OWNER_PASSWORD || safeEqual(cookies(req).owner || '', ownerToken);
const requireOwner = (req, res, next) => (isOwner(req) ? next() : res.status(401).json({ error: 'Meld eers aan.' }));

const failures = new Map(); // ip -> { n, until }: sluit 15 min uit na 5 verkeerde wagwoorde
app.post('/api/login', async (req, res) => {
  const ip = req.get('cf-connecting-ip') || req.ip;
  const f = failures.get(ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).json({ error: 'Te veel pogings. Probeer oor 15 minute weer.' });
  const pw = String(req.body?.password || '');
  if (!OWNER_PASSWORD || !safeEqual(crypto.createHash('sha256').update(pw).digest('hex'),
    crypto.createHash('sha256').update(OWNER_PASSWORD).digest('hex'))) {
    f.n += 1;
    if (f.n >= 5) Object.assign(f, { n: 0, until: Date.now() + 15 * 60e3 });
    failures.set(ip, f);
    await new Promise((r) => setTimeout(r, 700));
    return res.status(401).json({ error: 'Verkeerde wagwoord.' });
  }
  failures.delete(ip);
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  res.set('Set-Cookie', `owner=${ownerToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${secure}`);
  res.json({ owner: true });
});
app.post('/api/logout', (_req, res) => {
  res.set('Set-Cookie', 'owner=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0').json({ owner: false });
});
app.get('/api/me', (req, res) => res.json({ owner: isOwner(req) }));

// Elke vorm is 'n vouer: data/forms/<id>/original.pdf + form.json
const ID = /^[0-9a-f-]{36}$/;
const dir = (id) => path.join(DATA, id);
async function readForm(id) {
  if (!ID.test(id)) return null;
  try { return JSON.parse(await fs.readFile(path.join(dir(id), 'form.json'), 'utf8')); } catch { return null; }
}
// Skryf eers na 'n tydelike lêer en hernoem dan, sodat OneDrive nooit 'n halwe lêer sinkroniseer nie
async function writeFile(file, data) {
  await fs.writeFile(file + '.tmp', data);
  await fs.rename(file + '.tmp', file);
}
async function writeForm(form) {
  form.updatedAt = new Date().toISOString();
  await writeFile(path.join(dir(form.id), 'form.json'), JSON.stringify(form, null, 1));
}
const pdfName = (form) => form.name.replace(/\.pdf$/i, '').replace(/[^\w\- ]+/g, '_') + '-ingevul.pdf';
async function renderFilled(form) {
  const bytes = await fs.readFile(path.join(dir(form.id), 'original.pdf'));
  return fillFlat(bytes, form.fields, form.values);
}
const summary = (f) => ({ id: f.id, name: f.name, updatedAt: f.updatedAt, fields: f.fields.length,
  filled: Object.values(f.values).filter((v) => v !== '' && v !== false && v != null).length });

// Laai 'n PDF op (rou liggaam) -> bespeur velde en stoor
app.post('/api/upload', requireOwner, express.raw({ type: 'application/pdf', limit: '25mb' }), async (req, res) => {
  try {
    const bytes = new Uint8Array(req.body);
    const { source, fields } = await detectFields(bytes);
    const form = { id: crypto.randomUUID(), name: decodeURIComponent(req.get('x-filename') || 'vorm.pdf'),
      source, fields, values: {}, createdAt: new Date().toISOString() };
    await fs.mkdir(dir(form.id), { recursive: true });
    await fs.writeFile(path.join(dir(form.id), 'original.pdf'), bytes);
    await writeForm(form);
    res.json(form);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'Kon nie die PDF lees nie: ' + e.message });
  }
});

app.get('/api/forms', requireOwner, async (_req, res) => {
  const ids = await fs.readdir(DATA).catch(() => []);
  const forms = (await Promise.all(ids.map(readForm))).filter(Boolean).map(summary);
  res.json(forms.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
});

app.get('/api/forms/:id', async (req, res) => {
  const form = await readForm(req.params.id);
  form ? res.json(form) : res.sendStatus(404);
});

// Stoor. `values` word saamgevoeg (net die velde wat die gebruiker verander het), sodat
// spanlede wat gelyk werk nie mekaar se inskrywings oorskryf nie. `fields` (net die
// eienaar stuur dit) vervang die uitleg.
app.put('/api/forms/:id', async (req, res) => {
  const form = await readForm(req.params.id);
  if (!form) return res.sendStatus(404);
  const { fields, values, name } = req.body;
  const owner = isOwner(req); // spanlede mag net waardes stoor, nie velde of die naam verander nie
  if (owner && Array.isArray(fields)) form.fields = fields;
  if (values && typeof values === 'object') Object.assign(form.values, values);
  if (owner && typeof name === 'string' && name.trim()) form.name = name.trim();
  const ids = new Set(form.fields.map((f) => f.id));
  for (const k of Object.keys(form.values)) if (!ids.has(k)) delete form.values[k];
  await writeForm(form);
  res.json(form);
  // Hou ook 'n ingevulde PDF langs die vorm, sodat dit direk in OneDrive oopgemaak kan word
  renderFilled(form)
    .then((out) => writeFile(path.join(dir(form.id), pdfName(form)), out))
    .catch((e) => console.error('Kon nie ingevulde PDF skryf nie:', e.message));
});

app.delete('/api/forms/:id', requireOwner, async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  await fs.rm(dir(req.params.id), { recursive: true, force: true });
  res.sendStatus(204);
});

app.get('/api/pdf/:id', async (req, res) => {
  if (!ID.test(req.params.id)) return res.sendStatus(404);
  res.type('application/pdf').sendFile(path.join(dir(req.params.id), 'original.pdf'), (e) => e && res.sendStatus(404));
});

// Ingevulde PDF (plat) met die gestoorde waardes en handtekeninge
app.get('/api/download/:id', async (req, res) => {
  const form = await readForm(req.params.id);
  if (!form) return res.sendStatus(404);
  const out = await renderFilled(form);
  res.type('application/pdf')
    .set('Content-Disposition', `attachment; filename="${pdfName(form)}"`)
    .send(Buffer.from(out));
});

// Netwerkadresse, sodat die deel-skakel werk vir spanlede op ander rekenaars
const port = process.env.PORT || 3000;
app.get('/api/info', requireOwner, (_req, res) => {
  // Slaan virtuele adapters oor (Hyper-V, WSL, VirtualBox, VPN) — daardie adresse werk nie vir spanlede nie
  const virtual = /vEthernet|WSL|VirtualBox|VMware|Hyper-V|Loopback|Tailscale|ZeroTier/i;
  const ips = Object.entries(os.networkInterfaces())
    .filter(([name]) => !virtual.test(name))
    .flatMap(([, list]) => list)
    .filter((n) => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.'))
    .map((n) => n.address);
  res.json({ port, ips, publicUrl: process.env.PUBLIC_URL || '' });
});

app.listen(port, () => {
  console.log(`PDF-invul loop op http://localhost:${port}\nVorms word gestoor in: ${DATA}`);
  if (!OWNER_PASSWORD) console.warn('LET WEL: geen OWNER_PASSWORD in .env nie - enigiemand kan vorms oplaai en verwyder.');
});
