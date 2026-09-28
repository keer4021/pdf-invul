import * as pdfjsLib from '/pdfjs/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';

const $ = (s) => document.querySelector(s);
// touched = veld-ID's wat hierdie gebruiker verander het sedert die laaste stoor.
// Net dié word gestuur, sodat spanlede nie mekaar se inskrywings oorskryf nie.
const state = { id: null, pdf: null, fields: [], values: {}, scale: 1.4, viewports: [], selection: [],
  touched: new Set(), layoutChanged: false, name: '' };
const params = new URLSearchParams(location.search);
// Span-modus (?span=1): net invul, teken, stoor en aflaai
const TEAM = params.get('span') === '1';
document.body.classList.toggle('team', TEAM);

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file || !(await confirmDiscard())) return;
  status(`Analysing "${file.name}"…`);
  const res = await fetch('/api/upload', {
    method: 'POST', body: file,
    headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(file.name) },
  });
  const data = await res.json();
  e.target.value = ''; // sodat dieselfde lêer weer gekies kan word
  if (!res.ok) return status(data.error || 'Error');
  await load(data);
  status(`${data.fields.length} fields detected (${data.source === 'acroform' ? 'existing form fields' : 'automatically'}) ` +
    `and saved. Tick "Edit fields" to adjust them.`);
  refreshForms();
});
$('#zoom').addEventListener('input', (e) => { state.scale = +e.target.value; render(); });
$('#edit').addEventListener('change', (e) => document.body.classList.toggle('editing', e.target.checked));
$('#dlFlat').addEventListener('click', download);
$('#save').addEventListener('click', () => save());

async function openForm(id) {
  const res = await fetch(`/api/forms/${id}`);
  if (!res.ok) return status('This form does not exist (any more).');
  await load(await res.json());
  status(TEAM
    ? `Fill in your part of "${state.name}". Click a yellow "Sign here" box to sign. Your changes are saved automatically.`
    : `Opened "${state.name}".`);
}

async function load(form) {
  Object.assign(state, { id: form.id, name: form.name, fields: form.fields, values: form.values || {},
    selected: null, selection: [], touched: new Set(), layoutChanged: false,
    defaults: { font: 'helvetica', ...form.defaults } });
  if (!TEAM) splitWideCombs();
  showDefaults();
  history.replaceState(null, '', `?form=${form.id}${TEAM ? '&span=1' : ''}`);
  document.title = `${form.name} – PDF-invul`;
  $('#forms').value = form.id;
  showProps();
  markDirty();
  state.pdf = await pdfjsLib.getDocument(`/api/pdf/${form.id}`).promise;
  await render();
  for (const b of ['#dlFlat', '#addField', '#addSig', '#save', '#share', '#delForm']) $(b).disabled = false;
}

// Ouer vorms het tabelrye as een "kam"-veld (een letter per sel) gestoor. Blokkies wyer as
// 35 punte is eintlik tabelselle: verdeel hulle in aparte velde, met enige letters wat al
// ingetik is in die ooreenstemmende sel.
function splitWideCombs() {
  const out = [];
  let fixed = 0;
  for (const f of state.fields) {
    if (!(f.comb > 1 && f.width / f.comb > 35)) { out.push(f); continue; }
    fixed++;
    const w = f.width / f.comb, chars = [...String(state.values[f.id] || '')];
    const base = f.name.replace(/\s*\(\d+\)$/, '');
    for (let i = 0; i < f.comb; i++) {
      const { comb, ...rest } = f;
      const cell = { ...rest, id: `${f.id}_${i + 1}`, name: `${base} ${i + 1}`, x: f.x + i * w + 1, width: w - 2 };
      out.push(cell);
      if (chars[i]) { state.values[cell.id] = chars[i]; state.touched.add(cell.id); }
    }
    delete state.values[f.id];
  }
  if (!fixed) return;
  state.fields = out;
  state.layoutChanged = true;
  queueMicrotask(() => {
    markDirty();
    status(`${fixed} table row(s) were one wide field with spaced letters; split into separate cells. Saving…`);
  });
}

// Enige verandering aan 'n waarde gaan hierdeur
function setValue(id, v) {
  state.values[id] = v;
  state.touched.add(id);
  markDirty();
}
function layoutChanged() { state.layoutChanged = true; markDirty(); }
const isDirty = () => state.touched.size > 0 || state.layoutChanged;
function markDirty() {
  $('#save').classList.toggle('dirty', isDirty());
  if (isDirty()) scheduleSave();
}

// Outomatiese stoor: 1,5 s nadat die gebruiker ophou tik/skuif
let saveTimer = null, saving = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(true), 1500);
}

async function save(auto = false) {
  if (!state.id) return false;
  clearTimeout(saveTimer);
  if (saving) await saving; // een stoor op 'n slag
  if (!isDirty()) return true;
  saving = doSave(auto);
  try { return await saving; } finally { saving = null; }
}

async function doSave(auto) {
  // Neem 'n momentopname: wat ná hierdie punt verander, bly "touched" vir die volgende stoor
  const sent = new Map([...state.touched].map((k) => [k, state.values[k] ?? '']));
  const sendLayout = !TEAM && state.layoutChanged;
  const body = { values: Object.fromEntries(sent) };
  if (sendLayout) { body.fields = state.fields; body.defaults = state.defaults; }
  state.touched.clear();
  state.layoutChanged = false;
  if (!auto) status('Saving…');
  let form;
  try {
    const res = await fetch(`/api/forms/${state.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(res.status);
    form = await res.json();
  } catch {
    for (const k of sent.keys()) state.touched.add(k);
    if (sendLayout) state.layoutChanged = true;
    $('#save').classList.add('dirty');
    status('Could not save. Check that the server is running and try again (Ctrl+S).');
    return false;
  }
  // Neem ander se nuwe inskrywings oor, behalwe velde wat ek intussen verander het
  for (const [k, v] of Object.entries(form.values)) if (!state.touched.has(k)) state.values[k] = v;
  $('#save').classList.toggle('dirty', isDirty());
  const active = document.activeElement;
  if (!active?.classList.contains('fld')) drawFields(); // moenie die veld waarin iemand tik vervang nie
  status(`${auto ? 'Auto-saved' : 'Saved'} at ${new Date().toLocaleTimeString()}.`);
  refreshForms();
  if (isDirty()) scheduleSave();
  return true;
}

async function confirmDiscard() {
  return !isDirty() || confirm('You have unsaved changes. Continue without saving?');
}
addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });

// Gestoorde vorms (net vir die eienaar)
async function refreshForms() {
  if (TEAM) return;
  const forms = await (await fetch('/api/forms')).json();
  const sel = $('#forms');
  sel.innerHTML = '<option value="">Saved forms…</option>';
  for (const f of forms) {
    const o = el('option');
    o.value = f.id;
    o.textContent = `${f.name} (${f.filled}/${f.fields} filled)`;
    sel.append(o);
  }
  sel.value = state.id || '';
}
$('#forms').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (!id || id === state.id) return;
  if (!(await confirmDiscard())) { e.target.value = state.id || ''; return; }
  openForm(id);
});
$('#delForm').addEventListener('click', async () => {
  if (!state.id || !confirm(`Delete "${state.name}" and everything filled in on it? This cannot be undone.`)) return;
  await fetch(`/api/forms/${state.id}`, { method: 'DELETE' });
  location.href = '/';
});

// Deel: skakel met die rekenaar se netwerkadres, sodat spanlede dit kan oopmaak
$('#share').addEventListener('click', async () => {
  if (isDirty() && !(await save())) return;
  const { port, ips, publicUrl } = await (await fetch('/api/info')).json();
  // Voorkeur: die publieke (tunnel-)adres; anders die adres waarop ek nou is; anders die netwerkadres
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const base = publicUrl ? publicUrl.replace(/\/+$/, '')
    : local && ips.length ? `http://${ips[0]}:${port}` : location.origin;
  const url = `${base}/?form=${state.id}&span=1`;
  $('#shareUrl').value = url;
  $('#shareHint').textContent = publicUrl
    ? 'This link works from anywhere, as long as the server and tunnel are running on this computer.'
    : 'Team members must be on the same network as this computer, and the server must be running.';
  $('#shareMail').href = `mailto:?subject=${encodeURIComponent('Please complete: ' + state.name)}` +
    `&body=${encodeURIComponent(`Hi\n\nPlease fill in your part of "${state.name}" and sign where needed:\n${url}\n\nYour changes are saved automatically.\n`)}`;
  $('#shareDlg').showModal();
  $('#shareUrl').select();
});
$('#shareCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#shareUrl').value); } catch { $('#shareUrl').select(); document.execCommand('copy'); }
  $('#shareCopy').textContent = 'Copied ✓';
  setTimeout(() => ($('#shareCopy').textContent = 'Copy link'), 1500);
});
$('#shareClose').addEventListener('click', () => $('#shareDlg').close());

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

    if (f.type === 'signature') {
      const sig = el('div', 'sig');
      const v = state.values[f.id];
      if (v) {
        sig.classList.add('done');
        const img = el('img');
        img.src = v;
        img.alt = 'Signature';
        sig.append(img);
      } else {
        const span = el('span');
        span.textContent = '✍ Sign here';
        sig.append(span);
      }
      sig.addEventListener('click', () => { if (!document.body.classList.contains('editing')) openSignature(f); });
      holder.append(sig);
    } else if (f.type === 'checkbox') {
      const box = el('div', 'cbwrap');
      const cb = el('input', 'fld');
      cb.type = 'checkbox';
      cb.checked = !!state.values[f.id];
      const s = Math.min(r.height, r.width) * 0.8;
      cb.style.width = cb.style.height = s + 'px';
      cb.addEventListener('change', () => setValue(f.id, cb.checked));
      box.append(cb);
      holder.append(box);
    } else {
      const inp = el('input', 'fld');
      inp.spellcheck = false;
      inp.autocomplete = 'off';
      inp.value = state.values[f.id] || '';
      if (f.comb > 1) {
        inp.maxLength = f.comb;
        inp.style.letterSpacing = `calc(${r.width / f.comb}px - 1ch)`;
        inp.style.paddingLeft = (r.width / f.comb / 2 - 4) + 'px';
      }
      const font = FONTS[f.font] || FONTS.helvetica;
      inp.style.fontFamily = font.css;
      inp.style.fontWeight = font.weight;
      if (!(f.comb > 1)) inp.style.textAlign = alignOf(f);
      inp.style.fontSize = (f.fontSize ? f.fontSize * state.scale : Math.min(r.height * 0.75, 11 * state.scale)) + 'px';
      if (f.type === 'number') {
        // Net syfers (plus . , - en spasie vir bedrae); regs belyn soos bedrae gewoonlik is
        inp.inputMode = 'decimal';
        inp.addEventListener('beforeinput', (e) => {
          if (e.data && /[^\d.,\- ]/.test(e.data)) e.preventDefault();
        });
      }
      inp.addEventListener('input', () => {
        if (f.type === 'number') inp.value = inp.value.replace(/[^\d.,\- ]/g, ''); // bv. as iets geplak word
        setValue(f.id, inp.value);
      });
      holder.append(inp);
    }
    const del = el('button', 'del');
    del.textContent = '×';
    del.title = 'Delete field';
    del.addEventListener('click', () => removeField(f));
    holder.append(del);
    holder.fieldRef = f;
    if (state.selection.includes(f)) holder.classList.add('selected');
    makeDraggable(holder, f);
    makeDropTarget(holder, f);
    layer.append(holder);
  }
}

function makeDraggable(holder, f) {
  holder.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('del')) return;
    const editing = document.body.classList.contains('editing');
    // Ctrl+klik (of Cmd op Mac) voeg by die keuse of haal daaruit, sonder om te sleep
    if (editing && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      document.activeElement?.blur();
      select(f, true);
      return;
    }
    // Klik op 'n veld wat reeds deel van 'n groep is: hou die groep, sodat dit saam sleep
    if (!state.selection.includes(f)) select(f);
    else { state.selected = f; showProps(); }
    if (!editing) return;
    e.preventDefault();
    document.activeElement?.blur(); // sodat Ctrl+C/V/D die veld kopieer, nie teks in die paneel nie
    const sx = e.clientX, sy = e.clientY, m0 = holder.style.cssText;
    const w = parseFloat(holder.style.width), h = parseFloat(holder.style.height);
    const box = holder.getBoundingClientRect();
    // Regterrand = breedte, onderrand = hoogte, hoek = albei (net vir die veld self)
    const resizeW = e.clientX > box.right - 8, resizeH = e.clientY > box.bottom - 6;
    // Skuif: al die gekose velde beweeg saam
    const group = resizeW || resizeH ? [holder]
      : [...document.querySelectorAll('.holder')].filter((x) => state.selection.includes(x.fieldRef));
    const start = group.map((x) => [parseFloat(x.style.left), parseFloat(x.style.top)]);
    const move = (m) => {
      if (resizeW) holder.style.width = Math.max(6, w + m.clientX - sx) + 'px';
      if (resizeH) holder.style.height = Math.max(6, h + m.clientY - sy) + 'px';
      if (!resizeW && !resizeH) group.forEach((x, i) => {
        x.style.left = start[i][0] + m.clientX - sx + 'px';
        x.style.top = start[i][1] + m.clientY - sy + 'px';
      });
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      for (const x of group) {
        const g = x.fieldRef;
        Object.assign(g, toPdf(g.pageIndex, parseFloat(x.style.left), parseFloat(x.style.top),
          parseFloat(x.style.width), parseFloat(x.style.height)));
      }
      if (m0 !== holder.style.cssText) layoutChanged();
      if (resizeW || resizeH) drawFields();
      showProps();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}

// Naamlys links: sleep 'n naam na 'n veld om dit in te vul
const NAMES_KEY = 'pdf-invul-name';
let names = [];
try { names = JSON.parse(localStorage.getItem(NAMES_KEY)) || []; } catch {}

function saveNames() {
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(names)); } catch {}
  drawNames();
}

function drawNames() {
  const list = $('#nameList');
  list.innerHTML = '';
  names.forEach((n, i) => {
    const li = el('li');
    li.draggable = true;
    li.title = n;
    const span = el('span');
    span.textContent = n;
    const del = el('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Remove';
    del.addEventListener('click', () => { names.splice(i, 1); saveNames(); });
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', n);
      e.dataTransfer.effectAllowed = 'copy';
    });
    li.append(span, del);
    list.append(li);
  });
}

$('#addName').addEventListener('submit', (e) => {
  e.preventDefault();
  const added = $('#nameInput').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!added.length) return;
  names.push(...added);
  $('#nameInput').value = '';
  saveNames();
});
// 'n Geplakte lys (een naam per reël) word as aparte name bygevoeg
$('#nameInput').addEventListener('paste', (e) => {
  const text = e.clipboardData.getData('text');
  if (!text.includes('\n')) return;
  e.preventDefault();
  names.push(...text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  saveNames();
});
drawNames();

function makeDropTarget(holder, f) {
  holder.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    holder.classList.add('over');
  });
  holder.addEventListener('dragleave', () => holder.classList.remove('over'));
  holder.addEventListener('drop', (e) => {
    e.preventDefault(); // keer die blaaier se eie teks-invoeging
    holder.classList.remove('over');
    const text = e.dataTransfer.getData('text/plain');
    if (!text || f.type === 'signature') return;
    const inp = holder.querySelector('.fld');
    if (f.type === 'checkbox') {
      inp.checked = true;
      setValue(f.id, true);
    } else {
      inp.value = f.comb > 1 ? text.slice(0, f.comb) : text;
      setValue(f.id, inp.value);
    }
  });
}

function addField(e) {
  if (TEAM || e.target !== e.currentTarget) return;
  const pageIndex = +e.currentTarget.dataset.page;
  const checkbox = e.shiftKey;
  const w = (checkbox ? 12 : 150) * state.scale, h = (checkbox ? 12 : 15) * state.scale;
  insertField(pageIndex, checkbox ? 'checkbox' : 'text', toPdf(pageIndex, e.offsetX, e.offsetY - h / 2, w, h));
}

// "+ Nuwe veld" / "Teken hier-veld": plaas 'n veld in die middel van die bladsy wat nou sigbaar is
function addAtCenter(type, wPt, hPt) {
  const pageIndex = visiblePage();
  const r = document.querySelectorAll('.page')[pageIndex].getBoundingClientRect();
  const w = wPt * state.scale, h = hPt * state.scale;
  const top = Math.min(Math.max(innerHeight / 2 - r.top, 0), r.height - h);
  insertField(pageIndex, type, toPdf(pageIndex, (r.width - w) / 2, top, w, h));
  if (!$('#edit').checked) $('#edit').click();
}
$('#addField').addEventListener('click', () => addAtCenter('text', 150, 15));
$('#addSig').addEventListener('click', () => addAtCenter('signature', 170, 40));

let nextId = 1;
// Skep 'n veld sonder om dit te kies of te teken (vir plak van groepe)
function makeField(pageIndex, type, rect, extra = {}) {
  const label = { checkbox: 'Checkbox', signature: 'Sign here' }[type] || 'Field';
  const f = { id: `u${Date.now()}_${nextId}`, name: `${label} ${nextId++}`,
    type, pageIndex, ...fieldStyle(), ...extra, ...rect };
  state.fields.push(f);
  return f;
}

// Vorm-styl: verstek-font, -grootte en -belyning. Nuwe velde kry dit; "Apply to all fields"
// kopieer dit na elke teks-/getalveld. Daarna kan elke veld steeds apart verander word.
const fieldStyle = () => {
  const { font, fontSize, align } = state.defaults || {};
  return { font: font || 'helvetica', ...(fontSize ? { fontSize } : {}), ...(align ? { align } : {}) };
};
function showDefaults() {
  const d = state.defaults || {};
  $('#dFont').value = d.font || 'helvetica';
  $('#dSize').value = d.fontSize || '';
  $('#dAlign').value = d.align || '';
}
function readDefaults() {
  const size = parseFloat($('#dSize').value);
  state.defaults = { font: $('#dFont').value, fontSize: size > 0 ? size : undefined, align: $('#dAlign').value || undefined };
  layoutChanged();
}
for (const id of ['#dFont', '#dSize', '#dAlign']) $(id).addEventListener('change', readDefaults);
$('#dApply').addEventListener('click', () => {
  const targets = state.fields.filter(isTextLike);
  if (!targets.length) return;
  if (!confirm(`Apply this font, size and alignment to all ${targets.length} text and number fields? ` +
    'Any changes you made to individual fields will be overwritten.')) return;
  readDefaults();
  const { font, fontSize, align } = state.defaults;
  for (const f of targets) Object.assign(f, { font, fontSize, align });
  layoutChanged();
  drawFields();
  showProps();
  status(`Style applied to ${targets.length} fields.`);
});
function insertField(pageIndex, type, rect, focusName = true) {
  const f = makeField(pageIndex, type, rect);
  layoutChanged();
  select(f);
  drawFields();
  if (focusName) $('#pName').select();
}

function removeFields(list) {
  const gone = new Set(list);
  state.fields = state.fields.filter((x) => !gone.has(x));
  for (const f of list) { delete state.values[f.id]; state.touched.delete(f.id); }
  layoutChanged();
  const left = state.selection.filter((x) => !gone.has(x));
  select(left.at(-1) || null, false, left);
  drawFields();
}
const removeField = (f) => removeFields([f]);

// Eienskappe-paneel. X/Y word gewys van links-bo van die bladsy (punte),
// terwyl die PDF self van links-onder meet.
const FONTS = {
  helvetica: { css: 'Helvetica, Arial, sans-serif', weight: 400 },
  'helvetica-bold': { css: 'Helvetica, Arial, sans-serif', weight: 700 },
  times: { css: '"Times New Roman", Times, serif', weight: 400 },
  'times-bold': { css: '"Times New Roman", Times, serif', weight: 700 },
  courier: { css: '"Courier New", Courier, monospace', weight: 400 },
};
const r1 = (n) => Math.round(n * 10) / 10;
const isTextLike = (f) => f.type === 'text' || f.type === 'number'; // velde met font, grootte en kam
// Belyning: gekies deur die gebruiker, anders getalle regs en teks links (moet ooreenstem met fill.mjs)
const alignOf = (f) => f.align || (f.type === 'number' ? 'right' : 'left');
const pageBox = (f) => state.viewports[f.pageIndex].viewBox; // [x0, y0, x1, y1]

// Keuse: state.selection is al die gekose velde; state.selected die laaste een (vir die paneel).
// additive = Ctrl+klik: voeg by of haal uit. list = stel die hele keuse.
function select(f, additive = false, list = null) {
  if (list) state.selection = list;
  else if (additive && f) {
    state.selection = state.selection.includes(f)
      ? state.selection.filter((x) => x !== f)
      : [...state.selection, f];
    if (!state.selection.includes(f)) f = state.selection.at(-1) || null;
  } else state.selection = f ? [f] : [];
  state.selected = f;
  document.querySelectorAll('.holder').forEach((h) => h.classList.toggle('selected', state.selection.includes(h.fieldRef)));
  showProps();
}

function showProps() {
  const f = state.selected;
  const many = state.selection.length > 1;
  $('#props').hidden = !f;
  if (!f) return;
  $('#pTitle').textContent = many ? `${state.selection.length} fields selected` : 'Field';
  $('#pSingle').hidden = many;
  $('#pMulti').hidden = !many;
  $('#pDelete').textContent = many ? `Delete ${state.selection.length} fields` : 'Delete field';
  const [x0, , , y1] = pageBox(f);
  $('#pName').value = f.name || '';
  $('#pType').value = f.type;
  $('#pX').value = r1(f.x - x0);
  $('#pY').value = r1(y1 - (f.y + f.height));
  $('#pW').value = r1(f.width);
  $('#pH').value = r1(f.height);
  $('#pSize').value = f.fontSize || '';
  $('#pFont').value = f.font || 'helvetica';
  $('#pAlign').value = f.align || '';
  $('#pComb').value = f.comb > 1 ? f.comb : '';
  $('#pComb').disabled = !isTextLike(f);
  $('#pSize').disabled = $('#pFont').disabled = $('#pAlign').disabled = !state.selection.some(isTextLike);
}

function applyProps(e) {
  const f = state.selected;
  if (!f) return;
  if (state.selection.length > 1) {
    // Groep: net die font, grootte of belyning wat verander is, op al die teks-/getalvelde
    const size = parseFloat($('#pSize').value);
    for (const g of state.selection.filter(isTextLike)) {
      if (e?.target === $('#pSize')) g.fontSize = size > 0 ? size : undefined;
      if (e?.target === $('#pFont')) g.font = $('#pFont').value;
      if (e?.target === $('#pAlign')) g.align = $('#pAlign').value || undefined;
    }
    layoutChanged();
    drawFields();
    return;
  }
  const [x0, , , y1] = pageBox(f);
  const num = (id, fallback) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : fallback; };
  f.name = $('#pName').value.trim() || f.name;
  f.type = $('#pType').value;
  f.width = Math.max(2, num('#pW', f.width));
  f.height = Math.max(2, num('#pH', f.height));
  f.x = x0 + num('#pX', f.x - x0);
  f.y = y1 - num('#pY', y1 - (f.y + f.height)) - f.height;
  f.fontSize = num('#pSize', 0) || undefined;
  f.font = $('#pFont').value;
  f.align = $('#pAlign').value || undefined;
  const comb = parseInt($('#pComb').value, 10);
  if (isTextLike(f) && comb > 1) f.comb = comb; else delete f.comb;
  layoutChanged();
  drawFields();
  $('#pSize').disabled = $('#pFont').disabled = $('#pAlign').disabled = !isTextLike(f);
}
for (const id of ['#pName', '#pType', '#pX', '#pY', '#pW', '#pH', '#pSize', '#pFont', '#pAlign', '#pComb']) {
  $(id).addEventListener('change', applyProps);
  $(id).addEventListener('input', (e) => { if (id !== '#pName') applyProps(e); });
}
$('#pDelete').addEventListener('click', () => state.selection.length && removeFields(state.selection));

// Kopieer / plak / dupliseer, vir een veld of 'n hele groep. Die kopieë behou grootte,
// font, tipe en hul posisie ten opsigte van mekaar.
let clipboard = null; // [{...veld sonder id}]
function copyField() {
  if (!state.selection.length) return;
  clipboard = state.selection.map(({ id, ...rest }) => ({ ...rest }));
  $('#pPaste').disabled = false;
  status(clipboard.length > 1
    ? `${clipboard.length} fields copied. Press Ctrl+V or "Paste" to paste them.`
    : `"${clipboard[0].name}" copied. Press Ctrl+V or "Paste" to paste it.`);
}
function pasteField(dx = 10, dy = -10, pageIndex = visiblePage()) {
  if (!clipboard?.length) return;
  const [tx0, , , ty1] = state.viewports[pageIndex].viewBox;
  const pasted = clipboard.map((c) => {
    const same = c.pageIndex === pageIndex;
    const [x0, , , y1] = pageBox(c);
    // Ander bladsy: dieselfde posisie van links-bo af
    const rect = { width: c.width, height: c.height,
      x: same ? c.x + dx : tx0 + (c.x - x0), y: same ? c.y + dy : ty1 - (y1 - c.y) };
    const { x, y, width, height, pageIndex: _p, type, ...extra } = c;
    extra.name = `${c.name.replace(/( \(copy\))+$/, '')} (copy)`;
    return makeField(pageIndex, type, rect, extra);
  });
  // Volgende plak skuif weer 'n entjie verder
  clipboard = pasted.map(({ id, ...rest }) => ({ ...rest }));
  layoutChanged();
  select(pasted.at(-1), false, pasted);
  drawFields();
}
function duplicateBelow() {
  const list = state.selection;
  if (!list.length) return;
  if (new Set(list.map((f) => f.pageIndex)).size > 1) return status('Duplicate below only works for fields on one page.');
  const top = Math.max(...list.map((f) => f.y + f.height)), bottom = Math.min(...list.map((f) => f.y));
  copyField();
  pasteField(0, -(top - bottom + 2), list[0].pageIndex); // direk onder die groep
}
$('#pCopy').addEventListener('click', copyField);
$('#pPaste').addEventListener('click', () => pasteField());
$('#pDup').addEventListener('click', duplicateBelow);

function visiblePage() {
  const pages = [...document.querySelectorAll('.page')];
  const mid = innerHeight / 2;
  const i = pages.findIndex((p) => { const r = p.getBoundingClientRect(); return r.top <= mid && r.bottom >= mid; });
  return i < 0 ? 0 : i;
}

// Ctrl+A: kies al die velde op die bladsy wat sigbaar is
function selectPage() {
  const list = state.fields.filter((f) => f.pageIndex === visiblePage());
  select(list.at(-1) || null, false, list);
}

// Sleutels. Ctrl+S stoor altyd; die res net in wysig-modus, en nie terwyl jy in 'n invoerveld tik nie.
addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (!document.body.classList.contains('editing') || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' && state.selection.length) removeFields(state.selection);
  else if (e.key === 'Escape') select(null);
  else if (mod && k === 'a') { e.preventDefault(); selectPage(); }
  else if (mod && k === 'c' && state.selection.length) { e.preventDefault(); copyField(); }
  else if (mod && k === 'v' && clipboard) { e.preventDefault(); pasteField(); }
  else if (mod && k === 'd' && state.selection.length) { e.preventDefault(); duplicateBelow(); }
});

// Stoor eers, dan laai die bediener die ingevulde PDF (met handtekeninge) af
async function download() {
  if (isDirty() && !(await save())) return;
  const a = el('a');
  a.href = `/api/download/${state.id}`;
  a.click();
  status('Downloading filled PDF…');
}

// Handtekening: teken op 'n canvas (muis, vinger of pen) of laai 'n prent op.
// Die resultaat word as PNG-data-URL die veld se waarde.
const pad = $('#sigPad'), pctx = pad.getContext('2d');
let sigField = null, sigHasInk = false;
function clearPad() { pctx.clearRect(0, 0, pad.width, pad.height); sigHasInk = false; }
function openSignature(f) {
  sigField = f;
  clearPad();
  $('#sigRemove').hidden = !state.values[f.id];
  $('#sigDlg').showModal();
}
pad.addEventListener('pointerdown', (e) => {
  const k = pad.width / pad.getBoundingClientRect().width;
  const pt = (m) => { const r = pad.getBoundingClientRect(); return [(m.clientX - r.left) * k, (m.clientY - r.top) * k]; };
  pad.setPointerCapture(e.pointerId);
  Object.assign(pctx, { lineWidth: 2.5, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0a1a5c' });
  pctx.beginPath();
  pctx.moveTo(...pt(e));
  const move = (m) => { pctx.lineTo(...pt(m)); pctx.stroke(); sigHasInk = true; };
  const up = () => { pad.removeEventListener('pointermove', move); pad.removeEventListener('pointerup', up); };
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', up);
});
$('#sigClear').addEventListener('click', clearPad);
$('#sigCancel').addEventListener('click', () => $('#sigDlg').close());
$('#sigRemove').addEventListener('click', () => { setValue(sigField.id, ''); $('#sigDlg').close(); drawFields(); });
$('#sigFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    clearPad();
    const k = Math.min(pad.width / img.width, pad.height / img.height);
    pctx.drawImage(img, (pad.width - img.width * k) / 2, (pad.height - img.height * k) / 2, img.width * k, img.height * k);
    sigHasInk = true;
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
});
$('#sigOk').addEventListener('click', () => {
  if (!sigHasInk) return alert('Draw your signature first, or upload an image.');
  setValue(sigField.id, trimCanvas(pad).toDataURL('image/png'));
  $('#sigDlg').close();
  drawFields();
});
// Sny leë rande af, sodat die handtekening die veld goed vul
function trimCanvas(c) {
  const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  }
  if (x1 < 0) return c;
  const pad = 4, out = document.createElement('canvas');
  out.width = x1 - x0 + 1 + pad * 2; out.height = y1 - y0 + 1 + pad * 2;
  out.getContext('2d').drawImage(c, x0, y0, x1 - x0 + 1, y1 - y0 + 1, pad, pad, x1 - x0 + 1, y1 - y0 + 1);
  return out;
}

function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
function status(t) { $('#status').textContent = t; }

// Aanmelding vir die eienaar (spanlede het net hul skakel nodig)
async function ensureOwner() {
  if ((await (await fetch('/api/me')).json()).owner) return;
  $('#loginDlg').showModal();
  await new Promise((done) => {
    $('#loginForm').addEventListener('submit', async function login(e) {
      e.preventDefault();
      const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#loginPw').value }) });
      if (!res.ok) { $('#loginErr').textContent = (await res.json()).error; $('#loginPw').select(); return; }
      $('#loginForm').removeEventListener('submit', login);
      $('#loginDlg').close();
      done();
    });
  });
}
$('#loginDlg').addEventListener('cancel', (e) => e.preventDefault()); // Esc maak dit nie toe nie
$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/';
});

// Begin: maak die vorm in die skakel oop (?form=...), of wys die gestoorde vorms
if (!TEAM) await ensureOwner();
refreshForms();
if (params.get('form')) openForm(params.get('form'));
else if (TEAM) status('This link is incomplete. Ask for a new link.');
