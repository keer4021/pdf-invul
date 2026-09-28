import * as pdfjsLib from '/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const $ = (s) => document.querySelector(s);
const state = { id: null, pdf: null, fields: [], values: {}, scale: 1.4, viewports: [] };

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  status(`Besig om "${file.name}" te ontleed…`);
  const res = await fetch('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-Filename': file.name }, body: file,
  });
  await load(res);
});
$('#sample').addEventListener('click', async () => {
  status('Laai Sapex-voorbeeld…');
  await load(await fetch('/api/sample', { method: 'POST' }));
});
$('#zoom').addEventListener('input', (e) => { state.scale = +e.target.value; render(); });
$('#edit').addEventListener('change', (e) => document.body.classList.toggle('editing', e.target.checked));
$('#dlFlat').addEventListener('click', () => download('flat'));
$('#dlFillable').addEventListener('click', () => download('fillable'));

async function load(res) {
  const data = await res.json();
  if (!res.ok) return status(data.error || 'Fout');
  Object.assign(state, { id: data.id, fields: data.fields, values: {} });
  state.pdf = await pdfjsLib.getDocument(`/api/pdf/${data.id}`).promise;
  await render();
  $('#dlFlat').disabled = $('#dlFillable').disabled = false;
  status(`${data.fields.length} velde bespeur (${data.source === 'acroform' ? 'bestaande vormvelde' : 'outomaties'}). ` +
    `Tik "Wysig velde" aan om velde te skuif/verwyder, of dubbelklik op die bladsy om een by te voeg (Shift = merkblokkie).`);
}

async function render() {
  if (!state.pdf) return;
  const host = $('#pages');
  host.innerHTML = '';
  state.viewports = [];
  for (let n = 1; n <= state.pdf.numPages; n++) {
    const page = await state.pdf.getPage(n);
    const vp = page.getViewport({ scale: state.scale });
    state.viewports.push(vp);
    const wrap = el('div', 'page');
    wrap.style.width = vp.width + 'px';
    wrap.style.height = vp.height + 'px';
    const canvas = el('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = vp.width * dpr; canvas.height = vp.height * dpr;
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    const layer = el('div', 'layer');
    layer.dataset.page = n - 1;
    layer.addEventListener('dblclick', addField);
    wrap.append(canvas, layer);
    host.append(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  }
  drawFields();
}

// PDF-koördinate (oorsprong onder-links, punte) -> skermpiksels
function toScreen(f) {
  const vp = state.viewports[f.pageIndex];
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle([f.x, f.y, f.x + f.width, f.y + f.height]);
  return { left: Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}
function toPdf(pageIndex, left, top, width, height) {
  const vp = state.viewports[pageIndex];
  const [x1, y1] = vp.convertToPdfPoint(left, top + height);
  const [x2, y2] = vp.convertToPdfPoint(left + width, top);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function drawFields() {
  document.querySelectorAll('.layer').forEach((l) => (l.innerHTML = ''));
  for (const f of state.fields) {
    const layer = document.querySelector(`.layer[data-page="${f.pageIndex}"]`);
    if (!layer) continue;
    const r = toScreen(f);
    const holder = el('div', 'holder');
    Object.assign(holder.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    holder.title = f.name;

    if (f.type === 'checkbox') {
      const box = el('div', 'cbwrap');
      const cb = el('input', 'fld');
      cb.type = 'checkbox';
      cb.checked = !!state.values[f.id];
      const s = Math.min(r.height, r.width) * 0.8;
      cb.style.width = cb.style.height = s + 'px';
      cb.addEventListener('change', () => (state.values[f.id] = cb.checked));
      box.append(cb);
      holder.append(box);
    } else {
      const inp = el('input', 'fld');
      inp.value = state.values[f.id] || '';
      if (f.comb > 1) {
        inp.maxLength = f.comb;
        inp.style.letterSpacing = `calc(${r.width / f.comb}px - 1ch)`;
        inp.style.paddingLeft = (r.width / f.comb / 2 - 4) + 'px';
      }
      inp.style.fontSize = Math.min(r.height * 0.75, 11 * state.scale) + 'px';
      inp.addEventListener('input', () => (state.values[f.id] = inp.value));
      holder.append(inp);
    }
    const del = el('button', 'del');
    del.textContent = '×';
    del.title = 'Verwyder veld';
    del.addEventListener('click', () => { state.fields = state.fields.filter((x) => x !== f); drawFields(); });
    holder.append(del);
    makeDraggable(holder, f);
    layer.append(holder);
  }
}

function makeDraggable(holder, f) {
  holder.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('editing') || e.target.classList.contains('del')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const ox = parseFloat(holder.style.left), oy = parseFloat(holder.style.top);
    const w = parseFloat(holder.style.width), h = parseFloat(holder.style.height);
    const resize = e.offsetX > w - 8; // regterrand = grootte verander
    const move = (m) => {
      if (resize) holder.style.width = Math.max(10, w + m.clientX - sx) + 'px';
      else { holder.style.left = ox + m.clientX - sx + 'px'; holder.style.top = oy + m.clientY - sy + 'px'; }
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      Object.assign(f, toPdf(f.pageIndex, parseFloat(holder.style.left), parseFloat(holder.style.top),
        parseFloat(holder.style.width), parseFloat(holder.style.height)));
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}

function addField(e) {
  if (e.target !== e.currentTarget) return;
  const pageIndex = +e.currentTarget.dataset.page;
  const checkbox = e.shiftKey;
  const w = (checkbox ? 12 : 150) * state.scale, h = (checkbox ? 12 : 15) * state.scale;
  const f = { id: 'u' + Date.now(), type: checkbox ? 'checkbox' : 'text', pageIndex,
    ...toPdf(pageIndex, e.offsetX, e.offsetY - h / 2, w, h) };
  f.name = prompt('Veldnaam?', checkbox ? 'Blokkie' : 'Veld') || f.id;
  state.fields.push(f);
  drawFields();
}

async function download(mode) {
  status('Genereer PDF…');
  const res = await fetch(`/api/fill/${state.id}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: state.values, fields: state.fields, mode }),
  });
  const blob = await res.blob();
  const name = /filename="(.+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'vorm.pdf';
  const a = el('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  URL.revokeObjectURL(a.href);
  status(`"${name}" afgelaai.`);
}

function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function status(t) { $('#status').textContent = t; }
