import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

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

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'error-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// handy for testing
window.__easyprint = { loadFile, get file() { return currentFile; } };
