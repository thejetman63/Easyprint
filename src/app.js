import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

// Ender-3 V3 SE build volume, in millimetres
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
let baseScale = 1;      // file units -> mm (always 1 for now)
let scalePct = 100;
let currentFile = null; // { name, path }
let modelFits = false;

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  let obj;

  try {
    if (ext === 'stl') {
      const geo = new STLLoader().parse(buf);
      obj = new THREE.Mesh(geo, modelMat);
    } else if (ext === '3mf') {
      obj = new ThreeMFLoader().parse(buf);
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

  // one consistent look, regardless of file colours
  obj.traverse((c) => {
    if (c.isMesh) {
      c.material = modelMat;
      // many STL files store blank normals, which renders the model black
      c.geometry.computeVertexNormals();
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

  scalePct = 100;
  currentFile = { name: file.name, path: window.easyprint?.pathForFile?.(file) || null };
  placeOnBed();
  $('modelInfo').hidden = false;
  $('modelName').textContent = file.name;
  $('viewerHint').hidden = false;
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
  model.traverse((m) => { if (m.isMesh) m.material = fits ? modelMat : tooBigMat; });

  // keep the camera looking at the model
  controls.target.set(BED.x / 2, BED.y / 2, Math.min(size.z / 2, 80));

  modelFits = fits;
  onChoicesChanged();
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
    b.onclick = () => { job.material = id; onChoicesChanged(); };
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
  return JSON.stringify([currentFile?.name, scalePct, m.toArray().map((v) => v.toFixed(4)),
    job.recipe, job.material, [...job.toggles].sort()]);
}

function onChoicesChanged() {
  document.querySelectorAll('.recipe').forEach((b) => b.classList.toggle('selected', b.dataset.id === job.recipe));
  document.querySelectorAll('#materialList button').forEach((b) => b.classList.toggle('selected', b.dataset.id === job.material));

  const ready = !!model;
  $('step2').classList.toggle('locked', !ready);
  $('step2').classList.toggle('active', ready);

  const orcaOk = orcaStatus?.orcaFound && orcaStatus?.machine;
  $('sliceBtn').disabled = !ready || !modelFits || slicing || !orcaOk;
  $('sliceBtn').textContent = !ready ? 'Open a model first'
    : !modelFits ? 'Too big. Make it smaller first'
    : 'Get it ready';

  $('resultStale').hidden = !lastResult || jobKey() === lastJobKey;
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
function exportModelStl() {
  model.updateMatrixWorld(true);
  return new STLExporter().parse(model, { binary: true }).buffer;
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
    stl: exportModelStl(),
    modelName: currentFile?.name,
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
}

$('setupBtn').onclick = () => { fillSetup(); $('setupDialog').showModal(); };
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
}

// handy for testing
window.__easyprint = { loadFile, get file() { return currentFile; }, exportModelStl };
