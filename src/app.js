import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { readProject, colorName } from './project3mf.js';

// Ender-3 V3 SE build volume, in millimeters
const BED = { x: 220, y: 220, z: 250 };

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const viewer = $('viewer');

// ---------- Scene ----------
THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // printers are Z-up

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setClearColor(0xf6f3ee);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.up.set(0, 0, 1);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.target.set(BED.x / 2, BED.y / 2, 30);

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d0c4, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-150, -200, 400);
scene.add(sun);

buildBed();
resetCamera();

function buildBed() {
  // plate
  const plate = new THREE.Mesh(
    new THREE.BoxGeometry(BED.x, BED.y, 2),
    new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.8 })
  );
  plate.position.set(BED.x / 2, BED.y / 2, -1.01);
  scene.add(plate);

  // grid lines every 10 mm
  const pts = [];
  for (let i = 0; i <= BED.x; i += 10) pts.push(i, 0, 0.05, i, BED.y, 0.05);
  for (let j = 0; j <= BED.y; j += 10) pts.push(0, j, 0.05, BED.x, j, 0.05);
  const grid = new THREE.BufferGeometry();
  grid.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.LineSegments(grid, new THREE.LineBasicMaterial({ color: 0x5c5955 })));

  // faint build-volume box
  const vol = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(BED.x, BED.y, BED.z)),
    new THREE.LineBasicMaterial({ color: 0xb9b1a5, transparent: true, opacity: 0.6 })
  );
  vol.position.set(BED.x / 2, BED.y / 2, BED.z / 2);
  scene.add(vol);
}

function resetCamera() {
  camera.position.set(BED.x / 2, -230, 260);
  controls.target.set(BED.x / 2, BED.y / 2, 30);
  controls.update();
}

function resize() {
  const { clientWidth: w, clientHeight: h } = viewer;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewer);
resize();

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});

// ---------- Model ----------
const modelMat = new THREE.MeshStandardMaterial({ color: 0x2aa595, roughness: 0.55, metalness: 0.05 });
const tooBigMat = new THREE.MeshStandardMaterial({ color: 0xd2563f, roughness: 0.55 });

let model = null;       // THREE.Group on the bed
let baseScale = 1;      // file units -> mm
let rawMax = 0;         // largest side of the model as stored in the file
let scalePct = 100;
let currentFile = null; // { name, path }
let modelFits = false;

// show a project plate in its own filament colour
const plateMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
function previewMat() {
  const c = currentPlate?.colors?.length === 1 ? currentPlate.colors[0].slice(0, 7) : null;
  if (!c) return modelMat;
  plateMat.color.set(c);
  // very dark filament is hard to see on the dark bed
  const hsl = {}; plateMat.color.getHSL(hsl);
  if (hsl.l < 0.18) plateMat.color.setHSL(hsl.h, hsl.s, 0.22);
  return plateMat;
}

let project = null;      // a Bambu/Orca project with plates
let currentPlate = null;
const printedPlates = new Set();

async function loadFile(file) {
  $('openingNote').hidden = false;
  await new Promise((r) => setTimeout(r, 30)); // let the "Opening" note show
  try { await loadFileInner(file); } finally { $('openingNote').hidden = true; }
}

async function loadFileInner(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  let obj;
  project = null; currentPlate = null; printedPlates.clear();

  try {
    if (ext === 'stl') {
      const geo = new STLLoader().parse(buf);
      obj = new THREE.Mesh(geo, modelMat);
    } else if (ext === '3mf') {
      try {
        const proj = readProject(buf);
        project = proj;
        currentPlate = proj.plates[0];
        obj = proj.build(currentPlate, modelMat);
        if (!obj.children.length) throw new Error('empty');
      } catch (e) {
        console.warn('project reader failed, using basic 3MF loader', e);
        project = null; currentPlate = null;
        obj = new ThreeMFLoader().parse(buf);
      }
    } else if (ext === 'obj') {
      obj = new OBJLoader().parse(new TextDecoder().decode(buf));
      obj.rotation.x = Math.PI / 2; // OBJ files are usually Y-up
    } else {
      return toast('That file type isn’t supported. Use STL, 3MF or OBJ.');
    }
  } catch (err) {
    console.error(err);
    return toast('Couldn’t read that file. It may be damaged.');
  }

  currentFile = { name: file.name, path: window.easyprint?.pathForFile?.(file) || null };
  showObject(obj, { guess: !project });
  renderPlates();
}

// put an object (or a group of them) on the bed
function showObject(obj, { guess = true } = {}) {
  // one consistent look, regardless of file colours
  obj.traverse((c) => {
    if (c.isMesh) {
      c.material = modelMat;
      // many STL files store blank normals, which renders the model black
      if (!c.geometry.attributes.normal) c.geometry.computeVertexNormals();
      else if (guess) c.geometry.computeVertexNormals();
    }
  });

  if (model) scene.remove(model);
  // wrap so we can rotate/scale around the model's own centre
  const inner = new THREE.Group();
  inner.add(obj);
  model = new THREE.Group();
  model.add(inner);
  scene.add(model);

  // centre the raw object at the origin
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const centre = box.getCenter(new THREE.Vector3());
  obj.position.sub(centre);

  // Some programs save in meters, centimeters or inches instead of mm.
  // Guess from the size, like OrcaSlicer does, and let her change it.
  const raw = box.getSize(new THREE.Vector3());
  rawMax = Math.max(raw.x, raw.y, raw.z);
  setUnits(guess ? guessUnits(rawMax) : 'mm', guess);

  scalePct = 100;
  placeOnBed();
  $('modelInfo').hidden = false;
  $('modelName').textContent = modelDisplayName();
  $('viewerHint').hidden = false;
}

function modelDisplayName() {
  const base = currentFile?.name || '';
  return project?.isMultiPlate && currentPlate ? `${base.replace(/\.3mf$/i, '')} – ${currentPlate.name}` : base;
}

// what colour to load for the chosen plate
function plateColorText(p = currentPlate) {
  if (!p?.colors?.length) return null;
  const names = [...new Set(p.colors.map(colorName).filter(Boolean))];
  return names.length ? names.join(' and ') : null;
}

function renderPlates() {
  const box = $('plateList');
  box.innerHTML = '';
  $('plateBox').hidden = !project?.isMultiPlate;
  if (!project?.isMultiPlate) { updatePlateNote(); return; }
  $('plateIntro').textContent = `This project has ${project.plates.length} plates. Print them one at a time:`;
  for (const p of project.plates) {
    const b = document.createElement('button');
    b.className = 'plate' + (p === currentPlate ? ' selected' : '') + (printedPlates.has(p.id) ? ' done' : '');
    if (p.thumb) { const img = document.createElement('img'); img.src = p.thumb; img.alt = ''; b.appendChild(img); }
    const t = document.createElement('div'); t.className = 'plate-text';
    const n = document.createElement('div'); n.className = 'plate-name'; n.textContent = (printedPlates.has(p.id) ? '✓ ' : '') + p.name;
    const d = document.createElement('div'); d.className = 'plate-meta';
    const parts = p.objectIds.length;
    d.textContent = `${parts} part${parts > 1 ? 's' : ''}`;
    for (const c of p.colors || []) { const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = c.slice(0, 7); sw.title = colorName(c) || c; d.appendChild(sw); }
    t.append(n, d); b.appendChild(t);
    b.onclick = () => choosePlate(p);
    box.appendChild(b);
  }
  updatePlateNote();
}

function choosePlate(p) {
  if (p === currentPlate) return;
  currentPlate = p;
  showObject(project.build(p, modelMat), { guess: false });
  renderPlates();
}

function updatePlateNote() {
  const note = $('plateNote');
  const color = plateColorText();
  const many = (currentPlate?.colors?.length || 0) > 1 || currentPlate?.painted;
  if (!currentPlate || (!color && !many)) { note.hidden = true; return; }
  note.hidden = false;
  note.textContent = many
    ? `This plate was designed in ${color || 'several colors'}. Your printer has one nozzle, so it will print in whatever filament is loaded.`
    : `Load ${color} filament for this plate.`;
}

// sit the model flat on the bed, centred, and refresh the info panel
function placeOnBed() {
  if (!model) return;
  const s = baseScale * scalePct / 100;
  model.scale.setScalar(s);
  model.position.set(0, 0, 0);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const c = box.getCenter(new THREE.Vector3());
  model.position.set(BED.x / 2 - c.x, BED.y / 2 - c.y, -box.min.z);
  model.updateMatrixWorld(true);

  const size = box.getSize(new THREE.Vector3());
  $('modelSize').textContent =
    `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)} mm  (wide × deep × tall)`;
  $('scaleLabel').textContent = `${scalePct}%`;

  const fits = size.x <= BED.x && size.y <= BED.y && size.z <= BED.z;
  const badge = $('fitBadge');
  badge.className = 'fit ' + (fits ? 'ok' : 'bad');
  badge.textContent = fits
    ? 'Fits on the printer ✓'
    : 'Too big for the printer. Make it smaller or turn it.';
  model.traverse((m) => { if (m.isMesh) m.material = fits ? previewMat() : tooBigMat; });

  // keep the camera looking at the model
  controls.target.set(BED.x / 2, BED.y / 2, Math.min(size.z / 2, 80));

  modelFits = fits;
  onChoicesChanged();
}

const UNITS = { mm: 1, cm: 10, in: 25.4, m: 1000 };
const UNIT_NAMES = { mm: 'millimeters', cm: 'centimeters', in: 'inches', m: 'meters' };

function guessUnits(maxSide) {
  if (maxSide > 0 && maxSide < 1) return 'm';   // under 1 mm is almost always meters
  return 'mm';
}

function setUnits(u, guessed = false) {
  baseScale = UNITS[u];
  $('unitSelect').value = u;
  const note = $('unitNote');
  note.hidden = !(guessed && u !== 'mm');
  note.textContent = `This file was saved in ${UNIT_NAMES[u]}, so it was converted to mm.`;
}

const fmt = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

function rotate(axis) {
  if (!model) return;
  const inner = model.children[0];
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2);
  inner.quaternion.premultiply(q);
  placeOnBed();
}

function setScale(pct) {
  if (!model) return;
  scalePct = Math.max(10, Math.min(500, pct));
  placeOnBed();
}

// ---------- UI wiring ----------
$('openBtn').onclick = () => $('fileInput').click();
$('fileInput').onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; };
$('biggerBtn').onclick = () => setScale(scalePct + 10);
$('smallerBtn').onclick = () => setScale(scalePct - 10);
$('rotZBtn').onclick = () => rotate(new THREE.Vector3(0, 0, 1));
$('rotXBtn').onclick = () => rotate(new THREE.Vector3(1, 0, 0));
$('rotYBtn').onclick = () => rotate(new THREE.Vector3(0, 1, 0));
$('unitSelect').onchange = (e) => {
  if (!model) return;
  setUnits(e.target.value);
  placeOnBed();
};
$('resetBtn').onclick = () => {
  if (!model) return;
  model.children[0].quaternion.identity();
  scalePct = 100;
  placeOnBed();
};

// drag and drop anywhere in the window
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').classList.add('show'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').classList.remove('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

function toast(msg, good = false) {
  const t = document.createElement('div');
  t.className = 'error-toast' + (good ? ' good' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Step 2: what is it? ----------
const api = window.easyprint;
const job = { recipe: 'decoration', material: 'PLA', toggles: new Set() };
let materialKnown = false; // has she told us what's loaded?

function setMaterial(id, remember = true) {
  job.material = id;
  materialKnown = true;
  if (remember) api.setSettings({ loadedMaterial: id });
  onChoicesChanged();
}
document.querySelectorAll('#loadedChips button').forEach((b) => { b.onclick = () => setMaterial(b.dataset.id); });
api?.getSettings?.().then((st) => {
  if (st.loadedMaterial === 'PLA' || st.loadedMaterial === 'PETG') setMaterial(st.loadedMaterial, false);
});
let lastResult = null;   // { gcodePath, seconds, grams, ... }
let lastJobKey = null;   // what the last result was made from
let slicing = false;
let orcaStatus = null;

async function setupChoices() {
  const c = await api.choices();

  const recipeList = $('recipeList');
  for (const [id, r] of Object.entries(c.recipes)) {
    const b = document.createElement('button');
    b.className = 'recipe';
    b.dataset.id = id;
    b.innerHTML = `<span class="recipe-name"></span><span class="recipe-blurb"></span>`;
    b.querySelector('.recipe-name').textContent = r.label;
    b.querySelector('.recipe-blurb').textContent = r.blurb;
    b.onclick = () => { job.recipe = id; onChoicesChanged(); };
    recipeList.appendChild(b);
  }

  const matList = $('materialList');
  for (const [id, m] of Object.entries(c.materials)) {
    const b = document.createElement('button');
    b.dataset.id = id;
    b.innerHTML = `<span class="seg-name"></span><span class="seg-blurb"></span>`;
    b.querySelector('.seg-name').textContent = m.label;
    b.querySelector('.seg-blurb').textContent = m.blurb;
    b.onclick = () => setMaterial(id);
    matList.appendChild(b);
  }

  const toggleList = $('toggleList');
  for (const [id, t] of Object.entries(c.toggles)) {
    const l = document.createElement('label');
    l.className = 'toggle';
    l.innerHTML = `<input type="checkbox"><span class="toggle-text"><span class="toggle-name"></span><span class="toggle-hint"></span></span>`;
    l.querySelector('.toggle-name').textContent = t.label;
    l.querySelector('.toggle-hint').textContent = t.hint;
    const cb = l.querySelector('input');
    cb.dataset.id = id;
    cb.onchange = () => { cb.checked ? job.toggles.add(id) : job.toggles.delete(id); onChoicesChanged(); };
    toggleList.appendChild(l);
  }

  onChoicesChanged();
}

function jobKey() {
  if (!model) return null;
  const m = model.children[0].quaternion;
  return JSON.stringify([currentFile?.name, currentPlate?.id, scalePct, m.toArray().map((v) => v.toFixed(4)),
    job.recipe, job.material, [...job.toggles].sort()]);
}

function onChoicesChanged() {
  document.querySelectorAll('.recipe').forEach((b) => b.classList.toggle('selected', b.dataset.id === job.recipe));
  document.querySelectorAll('#materialList button').forEach((b) => b.classList.toggle('selected', b.dataset.id === job.material));
  document.querySelectorAll('#loadedChips button').forEach((b) => b.classList.toggle('selected', materialKnown && b.dataset.id === job.material));
  document.getElementById('loadedChips').classList.toggle('need', !materialKnown);
  document.querySelectorAll('#toggleList input').forEach((cb) => { cb.checked = job.toggles.has(cb.dataset.id); });

  const ready = !!model;
  $('step2').classList.toggle('locked', !ready);
  $('step2').classList.toggle('active', ready);

  const orcaOk = orcaStatus?.orcaFound && orcaStatus?.machine;
  $('sliceBtn').disabled = !ready || !modelFits || slicing || !orcaOk;
  $('sliceBtn').textContent = !ready ? 'Open a model first'
    : !modelFits ? 'Too big. Make it smaller first'
    : 'Get it ready';

  $('resultStale').hidden = !lastResult || jobKey() === lastJobKey;
  updatePrintButton();
}

function showOrcaWarning() {
  const w = $('orcaWarn');
  if (!orcaStatus || orcaStatus.error) { w.hidden = false; w.textContent = 'Couldn\u2019t read OrcaSlicer\u2019s setup. ' + (orcaStatus?.error || ''); return; }
  if (!orcaStatus.orcaFound) { w.hidden = false; w.textContent = 'OrcaSlicer wasn\u2019t found on this computer. Open Printer setup (top right) and press Find\u2026'; return; }
  if (!orcaStatus.machine) { w.hidden = false; w.textContent = 'No Ender-3 V3 SE printer profile was found in OrcaSlicer.'; return; }
  w.hidden = true;
}

async function refreshOrca(status) {
  orcaStatus = status || await api.orcaStatus();
  showOrcaWarning();
  onChoicesChanged();
}

// the model exactly as shown (size and turns included), as an STL file
// one STL per part, exactly as shown (size and turns included).
// Orca lays the parts out on the bed itself.
function exportModelStls() {
  model.updateMatrixWorld(true);
  const meshes = [];
  model.traverse((m) => { if (m.isMesh) meshes.push(m); });
  const ex = new STLExporter();
  if (meshes.length <= 1) return [ex.parse(model, { binary: true }).buffer];
  return meshes.map((m) => ex.parse(m, { binary: true }).buffer);
}

async function slice() {
  if (!model || slicing) return;
  slicing = true;
  const key = jobKey();
  $('sliceError').hidden = true;
  $('sliceStatus').hidden = false;
  $('sliceStatusText').textContent = 'Getting it ready\u2026 this can take a minute';
  onChoicesChanged();

  const res = await api.slice({
    stls: exportModelStls(),
    modelName: modelDisplayName(),
    recipe: job.recipe,
    toggles: [...job.toggles],
    material: job.material,
  });

  slicing = false;
  $('sliceStatus').hidden = true;
  $('step3').classList.remove('locked');
  $('step3').classList.add('active');

  if (res.ok) {
    lastResult = res;
    lastJobKey = key;
    $('result').hidden = false;
    $('resultTime').textContent = res.seconds ? `Ready \u2013 about ${formatTime(res.seconds)}` : 'Ready';
    const bits = [];
    if (res.grams) bits.push(`${Math.round(res.grams)} g of ${job.material}`);
    if (res.layerHeight) bits.push(`${res.layerHeight} mm layers`);
    $('resultDetail').textContent = bits.join(' \u00b7 ');
    $('step3').scrollIntoView({ behavior: 'smooth', block: 'end' });
  } else {
    lastResult = null;
    $('result').hidden = true;
    $('sliceError').hidden = false;
    $('sliceErrorText').textContent = res.error;
    $('sliceLog').textContent = res.log || '(Orca didn\u2019t say anything)';
    $('sliceLog').hidden = true;
    $('openJobBtn').hidden = !res.workDir;
    $('openJobBtn').onclick = () => api.openFolder(res.workDir);
    $('step3').scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  onChoicesChanged();
}

function formatTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h === 0) return `${Math.max(m, 1)} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

$('sliceBtn').onclick = slice;
$('showLogBtn').onclick = () => { $('sliceLog').hidden = !$('sliceLog').hidden; };
$('saveBtn').onclick = async () => {
  if (!lastResult) return;
  const r = await api.saveGcode(lastResult.gcodePath);
  if (r.ok) toast(`Saved to ${r.filePath}`, true);
};

// ---------- Ask box (local AI via Ollama) ----------
let aiStatus = null;

// rough shape facts the AI can't see for itself
function shapeFacts() {
  model.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  let total = 0, overhang = 0;
  model.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const count = idx ? idx.count : pos.count;
    const get = (i, v) => v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
    const step = Math.max(1, Math.floor(count / 3 / 200000)) * 3; // sample huge models
    for (let i = 0; i + 2 < count; i += step) {
      get(i, a); get(i + 1, b); get(i + 2, c);
      n.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
      const area = n.length() / 2;
      if (!area) continue;
      total += area;
      // facing down more than 45 degrees, and not sitting on the bed
      if (n.z / (area * 2) < -0.707 && Math.min(a.z, b.z, c.z) > 0.4) overhang += area;
    }
  });
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  // how much of the outline actually touches the bed (bottom 0.4 mm)
  let touch = 0;
  model.traverse((m) => {
    if (!m.isMesh) return;
    const pos = m.geometry.attributes.position;
    const idx = m.geometry.index;
    const count = idx ? idx.count : pos.count;
    const get = (i, v) => v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
    for (let i = 0; i + 2 < count; i += 3) {
      get(i, a); get(i + 1, b); get(i + 2, c);
      if (Math.max(a.z, b.z, c.z) < 0.4) touch += Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    }
  });
  return {
    size: `${fmt(size.x)} x ${fmt(size.y)} x ${fmt(size.z)}`,
    overhangPct: total ? +(overhang / total * 100).toFixed(1) : 0,
    footprintPct: size.x * size.y ? Math.min(100, Math.round(touch / (size.x * size.y) * 100)) : 0,
  };
}

async function refreshAi() {
  if (!api?.askStatus) return;
  aiStatus = await api.askStatus();
  $('askBox').hidden = !(aiStatus.running && aiStatus.model);
}

async function runAsk() {
  const text = $('askInput').value.trim();
  if (!model || !text) { $('askInput').focus(); return; }
  if (!materialKnown) {
    const ans = $('askAnswer');
    ans.hidden = false; ans.className = 'ask-answer err';
    ans.textContent = 'First tap which filament is in the printer: PLA or PETG.';
    return;
  }
  const btn = $('askBtn');
  btn.disabled = true; btn.textContent = 'Thinking\u2026';
  const ans = $('askAnswer');
  ans.hidden = true;
  const res = await api.ask({ description: text, fileName: modelDisplayName(), material: job.material, ...shapeFacts() });
  btn.disabled = false; btn.textContent = 'Ask';
  ans.hidden = false;
  if (!res.ok) { ans.className = 'ask-answer err'; ans.textContent = res.error; return; }

  job.recipe = res.recipe;
  job.toggles = new Set(res.toggles);
  onChoicesChanged();

  const labels = (await api.choices());
  const picked = [labels.recipes[res.recipe].label, ...res.toggles.map((t) => labels.toggles[t].label)];
  ans.className = 'ask-answer';
  ans.innerHTML = '';
  const b = document.createElement('b'); b.textContent = picked.join(' + ');
  ans.append(b, document.createTextNode(` \u2013 ${res.reason}`));
  if (res.suggestPETG && job.material !== 'PETG') {
    const tip = document.createElement('span'); tip.className = 'tip';
    tip.textContent = 'Tip: PETG would hold up better for this. If you have some, load it and tap PETG above.';
    ans.append(tip);
  }
}

$('askBtn').onclick = runAsk;
$('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAsk(); });

// ---------- Printer setup ----------
function fillSelect(sel, options, current) {
  sel.innerHTML = '';
  for (const name of options) {
    const o = document.createElement('option');
    o.value = o.textContent = name;
    if (name === current) o.selected = true;
    sel.appendChild(o);
  }
  if (!options.length) {
    const o = document.createElement('option');
    o.textContent = 'None found';
    sel.appendChild(o);
    sel.disabled = true;
  } else sel.disabled = false;
}

function fillSetup() {
  const s = orcaStatus || {};
  $('orcaPathText').textContent = s.orcaPath || 'Not found';
  fillSelect($('machineSelect'), s.machines || [], s.machine);
  fillSelect($('plaSelect'), s.filaments?.PLA || [], s.filament?.PLA);
  fillSelect($('petgSelect'), s.filaments?.PETG || [], s.filament?.PETG);
  const ai = aiStatus || {};
  fillSelect($('aiSelect'), ai.models || [], ai.model);
  $('aiNote').textContent = !ai.running
    ? 'Ollama isn\u2019t running, so the box is hidden. Install it from ollama.com, then run: ollama pull qwen2.5:14b'
    : !ai.models?.length ? 'Ollama is running but has no models. In a command window run: ollama pull qwen2.5:14b' : '';
}

$('setupBtn').onclick = async () => { await refreshAi(); fillSetup(); $('setupDialog').showModal(); };
$('aiSelect').onchange = async (e) => { await api.setSettings({ ollamaModel: e.target.value }); await refreshAi(); fillSetup(); };
$('browseOrcaBtn').onclick = async () => {
  const p = await api.browseOrca();
  if (p) { await refreshOrca(await api.setSettings({ orcaPath: p })); fillSetup(); }
};
$('machineSelect').onchange = async (e) => { await refreshOrca(await api.setSettings({ machine: e.target.value })); fillSetup(); };
$('plaSelect').onchange = async (e) => { await refreshOrca(await api.setSettings({ filaments: { PLA: e.target.value } })); };
$('petgSelect').onchange = async (e) => { await refreshOrca(await api.setSettings({ filaments: { PETG: e.target.value } })); };

if (api?.choices) {
  setupChoices();
  refreshOrca();
  refreshAi();
  setInterval(refreshAi, 30000); // notice if Ollama is started later
}

// ---------- Step 3: printing over USB ----------
const pr = api?.printer;
let printerStatus = { connected: false, temps: {}, job: null };
let printingName = '';
let printingPlate = null;
let connecting = false;

const deg = (v) => (v == null ? '–' : `${Math.round(v)}°`);
const tempText = (cur, target) => (target > 0 ? `${deg(cur)} / ${deg(target)}` : deg(cur));

function isPrinting() { return !!(printerStatus.job && !printerStatus.job.finished); }

function updatePill() {
  const s = printerStatus;
  const dot = $('printerDot');
  dot.className = 'dot' + (s.connected ? (isPrinting() ? ' busy' : ' on') : '');
  if (connecting) $('printerText').textContent = 'Connecting\u2026';
  else if (!s.connected) $('printerText').textContent = 'Printer not connected';
  else $('printerText').textContent = `Printer connected \u00b7 Nozzle ${deg(s.temps.nozzle)} \u00b7 Bed ${deg(s.temps.bed)}`;
  $('connectBtn').textContent = s.connected ? 'Disconnect' : 'Connect';
  $('connectBtn').hidden = connecting || isPrinting();
}

function updatePrintButton() {
  if (!pr) return;
  const fresh = lastResult && jobKey() === lastJobKey;
  const btn = $('printBtn');
  $('saveBtn').hidden = !lastResult;
  if (isPrinting()) { btn.disabled = true; btn.textContent = 'Printing\u2026'; $('printHint').textContent = 'A print is running'; return; }
  btn.disabled = !fresh || connecting;
  btn.textContent = 'Print';
  $('printHint').textContent = !lastResult ? 'Get it ready first'
    : !fresh ? 'Press Get it ready again first'
    : (plateColorText() && (currentPlate?.colors?.length === 1) ? `Load ${plateColorText()} filament first. ` : '')
      + (printerStatus.connected ? 'Starts printing straight away' : 'Connects to the printer and starts');
}

async function connectPrinter() {
  connecting = true; updatePill(); updatePrintButton();
  const r = await pr.connect();
  connecting = false;
  if (r.ok) printerStatus = r.status;
  else toast(r.error);
  updatePill(); updatePrintButton();
  return r.ok;
}

$('connectBtn').onclick = async () => {
  if (printerStatus.connected) {
    const r = await pr.disconnect();
    if (!r.ok) toast(r.error);
    printerStatus = await pr.status();
    updatePill(); updatePrintButton();
  } else {
    await connectPrinter();
  }
};

async function startPrint(gcodePath, name, estimateSeconds) {
  $('printError').hidden = true;
  if (!printerStatus.connected && !(await connectPrinter())) return;
  if (!(await zPreflight())) return;
  const r = await pr.print(gcodePath, estimateSeconds);
  if (!r.ok) { $('printError').hidden = false; $('printError').textContent = r.error; return; }
  printingName = name;
  $('psFile').textContent = name;
  $('printSheet').hidden = false;
}

$('printBtn').onclick = () => {
  if (!lastResult) return;
  printingPlate = currentPlate;
  startPrint(lastResult.gcodePath, modelDisplayName() || 'Your print', lastResult.seconds);
};

$('printFileBtn').onclick = async () => {
  const file = await pr.openGcode();
  if (file) startPrint(file, file.split(/[\\/]/).pop(), null);
};

function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  return formatTime(Math.max(60, sec));
}

function updateSheet() {
  const j = printerStatus.job;
  const sheet = $('printSheet');
  if (!j) return;
  const pct = Math.floor(j.progress * 100);
  $('psPct').textContent = `${j.finished && !j.stopped && !j.failed ? 100 : pct}%`;
  $('psBar').style.width = `${j.finished && !j.stopped && !j.failed ? 100 : j.progress * 100}%`;
  $('psLeft').textContent = j.finished ? '–' : fmtDuration(j.left);
  $('psElapsed').textContent = fmtDuration(j.elapsed);
  $('psNozzle').textContent = tempText(printerStatus.temps.nozzle, printerStatus.temps.nozzleTarget);
  $('psBed').textContent = tempText(printerStatus.temps.bed, printerStatus.temps.bedTarget);
  sheet.classList.toggle('paused', !!j.paused);

  const heating = !j.finished && j.progress < 0.02 && printerStatus.temps.nozzleTarget > 0 &&
    printerStatus.temps.nozzle < printerStatus.temps.nozzleTarget - 3;
  $('psTitle').textContent = j.failed ? 'The print stopped' : j.stopped ? 'Print stopped'
    : j.finished ? 'Finished! \ud83c\udf89' : j.paused ? 'Paused' : heating ? 'Heating up' : 'Printing';
  let doneNote = 'Let the bed cool for a few minutes before taking it off.';
  if (j.finished && !j.stopped && !j.failed && printingPlate && project?.isMultiPlate) {
    if (!printedPlates.has(printingPlate.id)) { printedPlates.add(printingPlate.id); renderPlates(); }
    const next = project.plates.find((p) => !printedPlates.has(p.id));
    if (next) {
      const c = plateColorText(next);
      doneNote += ` Next up: \u201c${next.name}\u201d${c ? ` in ${c}` : ''}. Pick it in step 1 when you\u2019re ready.`;
    } else doneNote += ' That\u2019s every plate in this project done!';
  }
  $('psNote').textContent = j.paused ? 'The nozzle lifted out of the way. Press Resume to carry on.'
    : j.finished && !j.stopped && !j.failed ? doneNote : '';

  $('psAfter').hidden = !(j.finished && (j.stopped || j.failed));
  $('pauseBtn').hidden = j.finished;
  $('stopBtn').hidden = j.finished;
  $('closeSheetBtn').hidden = !j.finished;
  $('pauseBtn').textContent = j.paused ? 'Resume' : 'Pause';
}

$('pauseBtn').onclick = () => (printerStatus.job?.paused ? pr.resume() : pr.pause());
$('stopBtn').onclick = () => $('confirmStop').showModal();
$('confirmStop').addEventListener('close', () => { if ($('confirmStop').returnValue === 'yes') pr.stop(); });
$('closeSheetBtn').onclick = () => { $('printSheet').hidden = true; };

if (pr) {
  pr.onStatus((s) => {
    printerStatus = s;
    updatePill(); updatePrintButton(); updateSheet();
    const nc = document.getElementById('bedNotConnected'); if (nc) nc.hidden = s.connected;
  });
  pr.onProblem((m) => {
    $('printError').hidden = false;
    $('printError').textContent = m;
    toast(m);
  });
  pr.status().then((s) => { printerStatus = s; updatePill(); updatePrintButton(); });
  setInterval(() => { if (isPrinting()) pr.status().then((s) => { printerStatus = s; updateSheet(); }); }, 5000);
}

// ---------- Bed setup ----------
const bedApi = api?.bed;
let bedSettings = {};
let lastGrid = null;

async function loadBedSettings() {
  bedSettings = (await api.getSettings()) || {};
  $('zTarget').value = typeof bedSettings.zTarget === 'number' ? bedSettings.zTarget.toFixed(2) : '';
  $('zCheck').checked = bedSettings.zCheck !== false;
  $('zAuto').checked = !!bedSettings.zAuto;
  document.querySelectorAll('#knobChips button').forEach((b) => b.classList.toggle('selected',
    bedSettings.bedKnobs === undefined ? false : (b.dataset.id === 'yes') === bedSettings.bedKnobs));
  $('knobChips').classList.toggle('need', bedSettings.bedKnobs === undefined);
}
async function saveBed(patch) { await api.setSettings(patch); Object.assign(bedSettings, patch); }

const zFmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '–');
const sameZ = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;

async function ensureConnected() {
  if (printerStatus.connected) return true;
  return connectPrinter();
}

function showZ(now) {
  $('zNow').textContent = zFmt(now);
  const target = bedSettings.zTarget;
  const st = $('zStatus');
  $('zSetBtn').hidden = true;
  if (typeof now !== 'number') { st.className = 'z-status'; st.textContent = ''; return; }
  if (typeof target !== 'number') {
    st.className = 'z-status';
    st.textContent = 'Type your Z-offset on the left and press Save, so EasyPrint can keep the printer at it.';
  } else if (sameZ(now, target)) {
    st.className = 'z-status ok'; st.textContent = '\u2713 The printer matches your Z-offset.';
  } else {
    st.className = 'z-status bad';
    st.textContent = `The printer is at ${zFmt(now)}, not your ${zFmt(target)}. Leveling usually does this.`;
    $('zSetBtn').hidden = false;
    $('zSetBtn').textContent = `Set the printer to ${zFmt(target)}`;
  }
}

async function readZNow() {
  if (!(await ensureConnected())) return null;
  const r = await bedApi.readZ();
  if (!r.ok) { bedErr(r.error); return null; }
  showZ(r.zOffset);
  return r.zOffset;
}

async function setZ(v) {
  const r = await bedApi.setZ(v);
  if (!r.ok) { bedErr(r.error); return false; }
  showZ(r.zOffset);
  return true;
}

function bedErr(msg) { const e = $('bedError'); e.hidden = !msg; e.textContent = msg || ''; if (msg) toast(msg); }

// before each print: make sure the printer is at her Z-offset
async function zPreflight() {
  if (!bedApi || typeof bedSettings.zTarget !== 'number' || bedSettings.zCheck === false) return true;
  const r = await bedApi.readZ();
  if (!r.ok || typeof r.zOffset !== 'number') return true; // can't tell; don't block the print
  if (sameZ(r.zOffset, bedSettings.zTarget)) return true;
  if (bedSettings.zAuto) {
    const ok = await setZ(bedSettings.zTarget);
    if (ok) toast(`Z-offset set back to ${zFmt(bedSettings.zTarget)}`, true);
    return true;
  }
  $('zDialogText').textContent = `The printer's Z-offset is ${zFmt(r.zOffset)}, but yours is ${zFmt(bedSettings.zTarget)}. This usually happens after leveling.`;
  $('zDialogFix').textContent = `Set it to ${zFmt(bedSettings.zTarget)} and print`;
  const d = $('zDialog');
  d.showModal();
  const choice = await new Promise((res) => d.addEventListener('close', () => res(d.returnValue), { once: true }));
  if (choice === 'fix') return setZ(bedSettings.zTarget);
  return choice === 'anyway';
}

// ---- mesh drawing ----
function meshColor(v, center) {
  const t = Math.max(-1, Math.min(1, (v - center) / 0.3));
  const mid = [42, 165, 149], low = [59, 125, 216], high = [210, 86, 63];
  const to = t < 0 ? low : high, k = Math.abs(t);
  return `rgb(${mid.map((c, i) => Math.round(c + (to[i] - c) * k)).join(',')})`;
}

function drawMesh(canvas, grid, withNumbers) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = withNumbers ? 24 : 6;
  const inset = withNumbers ? 24 : 0; // keep the numbers clear of the edge labels
  const ny = grid.length, nx = grid[0].length;
  const flat = grid.flat(); const center = flat.reduce((a, b) => a + b, 0) / flat.length;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#3a3836'; ctx.fillRect(0, 0, W, H);
  const iw = W - pad * 2, ih = H - pad * 2, res = 40;
  // smooth colours between measured points
  for (let py = 0; py < res; py++) for (let px = 0; px < res; px++) {
    const fx = (px + 0.5) / res * (nx - 1), fy = (py + 0.5) / res * (ny - 1);
    const i = Math.min(nx - 2, Math.floor(fx)), j = Math.min(ny - 2, Math.floor(fy));
    const u = fx - i, w = fy - j;
    const v = grid[j][i] * (1 - u) * (1 - w) + grid[j][i + 1] * u * (1 - w) + grid[j + 1][i] * (1 - u) * w + grid[j + 1][i + 1] * u * w;
    ctx.fillStyle = meshColor(v, center);
    // row 0 is the front, drawn at the bottom
    ctx.fillRect(pad + px * iw / res, pad + ih - (py + 1) * ih / res, iw / res + 1, ih / res + 1);
  }
  if (withNumbers) {
    ctx.font = '600 11px Segoe UI, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = pad + inset + i / (nx - 1) * (iw - inset * 2), y = pad + ih - inset * 0.6 - j / (ny - 1) * (ih - inset * 1.2);
      const v = grid[j][i] - center;
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(x - 19, y - 8, 38, 16);
      ctx.fillStyle = '#fff'; ctx.fillText((v >= 0 ? '+' : '') + v.toFixed(2), x, y);
    }
    ctx.fillStyle = '#f6f3ee'; ctx.font = '600 11px Segoe UI, system-ui, sans-serif';
    ctx.fillText('BACK', W / 2, 12); ctx.fillText('FRONT (door side)', W / 2, H - 11);
    ctx.save(); ctx.translate(11, H / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('LEFT', 0, 0); ctx.restore();
    ctx.save(); ctx.translate(W - 11, H / 2); ctx.rotate(Math.PI / 2); ctx.fillText('RIGHT', 0, 0); ctx.restore();
  }
}

function showMesh(grid, analysis, before) {
  $('meshArea').hidden = false;
  drawMesh($('meshMap'), grid, true);
  $('beforeFig').hidden = !before;
  if (before) drawMesh($('beforeMap'), before, false);
  $('meshCaption').textContent = before ? 'Now' : 'Your bed (numbers are mm above/below average)';
  const v = $('meshVerdict'); v.className = `verdict ${analysis.level}`; v.textContent = analysis.verdict;
  $('meshRange').textContent = `Highest to lowest point: ${analysis.range.toFixed(2)} mm` + (analysis.tilt.length ? ` \u00b7 ${analysis.tilt.join(', ')}` : '');
  const ol = $('meshSteps'); ol.innerHTML = '';
  for (const st of analysis.steps) { const li = document.createElement('li'); li.textContent = st.text; ol.appendChild(li); }
  const notes = $('meshNotes'); notes.innerHTML = '';
  for (const n of analysis.notes) { const p = document.createElement('p'); p.textContent = n; notes.appendChild(p); }
  if (bedSettings.bedKnobs === undefined && analysis.steps.length) {
    const p = document.createElement('p'); p.textContent = 'Answer the knob question above for turn-by-turn steps.'; notes.appendChild(p);
  }
}

function bedBusy(msg) {
  $('bedProgress').hidden = !msg;
  $('bedProgressText').textContent = msg || '';
  ['meshReadBtn', 'meshMeasureBtn', 'zSetBtn', 'zReadBtn', 'infoBtn'].forEach((id) => { $(id).disabled = !!msg; });
}

async function readMesh() {
  bedErr(null);
  if (!(await ensureConnected())) return;
  bedBusy('Reading the bed from the printer\u2026');
  const r = await bedApi.readMesh();
  bedBusy(null);
  if (!r.ok) return bedErr(r.error);
  lastGrid = r.grid;
  showMesh(r.grid, r.analysis, null);
}

async function measureMesh() {
  bedErr(null);
  if (!(await ensureConnected())) return;
  const before = lastGrid;
  bedBusy('Starting\u2026');
  const r = await bedApi.measure(job.material);
  if (!r.ok) { bedBusy(null); return bedErr(r.error); }
  lastGrid = r.grid;
  // measuring resets the printer's Z-offset, so put hers back
  if (typeof bedSettings.zTarget === 'number') {
    bedBusy('Putting your Z-offset back\u2026');
    const z = await bedApi.readZ();
    if (z.ok && !sameZ(z.zOffset, bedSettings.zTarget)) {
      if (await setZ(bedSettings.zTarget)) toast(`Measuring changed the Z-offset to ${zFmt(z.zOffset)}. Set it back to ${zFmt(bedSettings.zTarget)}.`, true);
    } else if (z.ok) showZ(z.zOffset);
  }
  bedBusy(null);
  showMesh(r.grid, r.analysis, before);
}

if (bedApi) {
  bedApi.onProgress((m) => bedBusy(m));
  $('bedBtn').onclick = async () => {
    await loadBedSettings();
    $('bedNotConnected').hidden = printerStatus.connected;
    bedErr(null);
    $('bedDialog').showModal();
    if (printerStatus.connected && !isPrinting()) readZNow();
  };
  $('bedClose').onclick = () => $('bedDialog').close();
  $('zSaveBtn').onclick = async () => {
    const v = Math.round(parseFloat($('zTarget').value) * 100) / 100;
    if (!(v >= -5 && v <= 1)) return bedErr('That doesn\u2019t look like a Z-offset. It should be a small number like -2.07.');
    bedErr(null);
    await saveBed({ zTarget: v });
    $('zTarget').value = v.toFixed(2);
    toast(`Saved. EasyPrint will keep the printer at ${v.toFixed(2)}.`, true);
    if (printerStatus.connected) readZNow(); else showZ(null);
  };
  $('zReadBtn').onclick = () => { bedErr(null); readZNow(); };
  $('zSetBtn').onclick = async () => { bedBusy('Setting the Z-offset\u2026'); const ok = await setZ(bedSettings.zTarget); bedBusy(null); if (ok) toast('Z-offset set and saved in the printer.', true); };
  $('zCheck').onchange = (e) => saveBed({ zCheck: e.target.checked });
  $('zAuto').onchange = (e) => saveBed({ zAuto: e.target.checked });
  document.querySelectorAll('#knobChips button').forEach((b) => {
    b.onclick = async () => {
      await saveBed({ bedKnobs: b.dataset.id === 'yes' });
      await loadBedSettings();
      if (lastGrid) showMesh(lastGrid, await bedApi.analyze(lastGrid), null);
    };
  });
  $('meshReadBtn').onclick = readMesh;
  $('meshMeasureBtn').onclick = measureMesh;
  $('infoBtn').onclick = async () => {
    if (!(await ensureConnected())) return;
    bedBusy('Reading printer details\u2026');
    const r = await bedApi.info();
    bedBusy(null);
    if (!r.ok) return bedErr(r.error);
    $('infoText').hidden = false; $('infoText').textContent = r.text;
    $('infoCopy').hidden = false;
  };
  $('infoCopy').onclick = () => { navigator.clipboard.writeText($('infoText').textContent); toast('Copied', true); };
  loadBedSettings();
}

// ---------- Printer controls ----------
const ctl = api?.ctl;
let fanOn = false;

function ctlBusy(msg) {
  $('ctlBusy').hidden = !msg; $('ctlBusyText').textContent = msg || '';
  document.querySelectorAll('#ctlDialog button:not(#ctlClose), #psAfter button').forEach((b) => { b.disabled = !!msg; });
}

function updateCtl() {
  const t = printerStatus.temps || {};
  $('ctlTemps').textContent = `${tempText(t.nozzle, t.nozzleTarget)} / ${tempText(t.bed, t.bedTarget)}`;
  const note = $('ctlNote');
  if (isPrinting()) { note.hidden = false; note.textContent = 'A print is running. Use Pause or Stop on the print panel first.'; }
  else if (!printerStatus.connected) { note.hidden = false; note.textContent = 'Not connected. Pressing a button connects first. Close Pronterface if it\u2019s open.'; }
  else note.hidden = true;
}

function showPos(pos) {
  if (!pos) { $('ctlZ').textContent = 'unknown'; return; }
  $('ctlZ').textContent = pos.guessed ? `+${pos.z.toFixed(1)} mm` : `${pos.z.toFixed(1)} mm`;
  $('ctlZ').title = pos.guessed ? 'Measured from where the nozzle was. The printer will know the real height after Home.' : '';
  const hint = document.getElementById('ctlZHint');
  if (hint) hint.textContent = pos.guessed ? 'above where it stopped (exact height after Home)' : 'above the bed';
}

// run one control action, connecting first if needed
async function act(label, fn) {
  if (isPrinting()) return toast('A print is running. Pause or stop it first.');
  if (!(await ensureConnected())) return null;
  ctlBusy(label);
  const r = await fn();
  ctlBusy(null);
  updateCtl();
  if (!r.ok) { toast(r.error); return null; }
  if ('position' in r) showPos(r.position);
  return r;
}

const raise = (d) => act(d > 0 ? `Raising ${d} mm\u2026` : `Lowering ${-d} mm\u2026`, () => ctl.moveZ(d)).then((r) => {
  return r;
});
const cool = () => act('Turning heaters off\u2026', () => ctl.cool()).then((r) => r && toast('Heaters off. The nozzle takes a few minutes to cool.', true));
const present = () => act('Moving the bed forward\u2026', () => ctl.present());

if (ctl) {
  $('ctlBtn').onclick = async () => {
    updateCtl();
    $('ctlDialog').showModal();
    if (printerStatus.connected && !isPrinting()) { const r = await ctl.position(); if (r.ok) showPos(r.position); }
  };
  $('ctlClose').onclick = () => $('ctlDialog').close();
  document.querySelectorAll('#ctlDialog [data-z], #psAfter [data-z]').forEach((b) => { b.onclick = () => raise(Number(b.dataset.z)); });
  $('ctlCool').onclick = cool;
  $('ctlFan').onclick = async () => {
    const r = await act(fanOn ? 'Turning the fan off\u2026' : 'Turning the fan on\u2026', () => ctl.fan(!fanOn));
    if (r) { fanOn = !fanOn; $('ctlFan').textContent = fanOn ? 'Fan off' : 'Fan on (cool faster)'; }
  };
  $('ctlPresent').onclick = present;
  $('ctlMotors').onclick = () => act('Turning motors off\u2026', () => ctl.motorsOff()).then((r) => r && toast('Motors off. You can move the head and bed by hand.', true));
  $('ctlHome').onclick = async () => {
    const d = $('homeConfirm'); d.showModal();
    const v = await new Promise((res) => d.addEventListener('close', () => res(d.returnValue), { once: true }));
    if (v === 'yes') act('Homing\u2026', () => ctl.home());
  };
  document.querySelector('#psAfter [data-act="present"]').onclick = present;
  document.querySelector('#psAfter [data-act="cool"]').onclick = cool;
  pr?.onStatus(() => { if ($('ctlDialog').open) updateCtl(); });
}

// handy for testing
window.__easyprint = { loadFile, get file() { return currentFile; }, exportModelStls, get project() { return project; } };
