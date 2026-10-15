// Reads Bambu Studio / OrcaSlicer project files (.3mf) the way those apps see them:
// several "plates", each with its own objects and filament colours.
// Plain 3MF files (one plate, no project data) work too.

import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : null;
};

// 3MF "a b c d e f g h i j k l" -> Matrix4
function toMatrix(s) {
  if (!s) return new THREE.Matrix4();
  const t = s.trim().split(/\s+/).map(Number);
  if (t.length !== 12 || t.some(Number.isNaN)) return new THREE.Matrix4();
  return new THREE.Matrix4().set(t[0], t[3], t[6], t[9], t[1], t[4], t[7], t[10], t[2], t[5], t[8], t[11], 0, 0, 0, 1);
}

const UNIT_MM = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };

// split a model file into its <object> blocks
function objectsIn(xml) {
  const out = new Map();
  const re = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m;
  while ((m = re.exec(xml))) out.set(attr(m[1], 'id'), { head: m[1], body: m[2] });
  return out;
}

function parseMesh(body) {
  const vs = body.indexOf('<vertices'), ts = body.indexOf('<triangles');
  if (vs < 0 || ts < 0) return null;
  const vText = body.slice(vs, ts), tText = body.slice(ts);
  const pos = [];
  const vre = /<vertex\b([^>]*)\/?>/g;
  let m;
  while ((m = vre.exec(vText))) {
    const a = m[1];
    pos.push(parseFloat(attr(a, 'x')), parseFloat(attr(a, 'y')), parseFloat(attr(a, 'z')));
  }
  const idx = [];
  let painted = false;
  const tre = /<triangle\b([^>]*)\/?>/g;
  while ((m = tre.exec(tText))) {
    const a = m[1];
    idx.push(+attr(a, 'v1'), +attr(a, 'v2'), +attr(a, 'v3'));
    if (!painted && /paint_color|mmu_segmentation|slic3rpe:mmu/.test(a)) painted = true;
  }
  return { pos: new Float32Array(pos), idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), painted };
}

export function isProject(buf) {
  try { return !!unzipSync(new Uint8Array(buf), { filter: (f) => f.name === '3D/3dmodel.model' })['3D/3dmodel.model']; } catch { return false; }
}

/**
 * Returns { plates: [{ id, name, thumb, objectIds, colors, painted }], colors, unitScale, build(plate) }
 * build(plate) -> THREE.Group with one mesh per object, in the designer's layout.
 */
export function readProject(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const text = (n) => (files[n] ? strFromU8(files[n]) : null);
  const rootName = Object.keys(files).find((n) => /^3D\/3dmodel\.model$/i.test(n)) || Object.keys(files).find((n) => /\.model$/i.test(n));
  const root = text(rootName);
  if (!root) throw new Error('No 3D model inside this file.');

  const unit = (root.match(/<model\b[^>]*\bunit="([^"]+)"/) || [])[1] || 'millimeter';
  const unitScale = UNIT_MM[unit] || 1;
  const rootObjects = objectsIn(root);
  const fileCache = new Map([[rootName.replace(/^\/?/, '/'), rootObjects]]);
  const objectsOf = (p) => {
    const key = p.startsWith('/') ? p : `/${p}`;
    if (!fileCache.has(key)) fileCache.set(key, objectsIn(text(key.slice(1)) || ''));
    return fileCache.get(key);
  };

  // build items: what's actually placed, with its transform
  const items = [];
  const bre = /<item\b([^>]*)\/?>/g;
  let m;
  const buildBlock = (root.match(/<build\b[\s\S]*?<\/build>/) || [''])[0];
  while ((m = bre.exec(buildBlock))) {
    if (attr(m[1], 'printable') === '0') continue;
    items.push({ id: attr(m[1], 'objectid'), matrix: toMatrix(attr(m[1], 'transform')) });
  }

  // ---- project data written by Bambu Studio / OrcaSlicer ----
  const settings = text('Metadata/model_settings.config') || '';
  let project = {};
  try { project = JSON.parse(text('Metadata/project_settings.config') || '{}'); } catch {}
  const colors = Array.isArray(project.filament_colour) ? project.filament_colour : [];
  const types = Array.isArray(project.filament_type) ? project.filament_type : [];

  const names = {}, extruders = {};
  for (const om of settings.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) {
    const [, id, body] = om;
    names[id] = (body.match(/<metadata key="name" value="([^"]*)"/) || [])[1] || `Part ${id}`;
    const ex = new Set();
    const objEx = (body.match(/^\s*<metadata key="extruder" value="(\d+)"/m) || [])[1];
    for (const e of body.matchAll(/<metadata key="extruder" value="(\d+)"/g)) ex.add(+e[1]);
    if (!ex.size) ex.add(+(objEx || 1));
    extruders[id] = [...ex];
  }

  let plates = [];
  for (const pm of settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const body = pm[1];
    const pid = +((body.match(/key="plater_id" value="(\d+)"/) || [])[1] || plates.length + 1);
    const pname = ((body.match(/key="plater_name" value="([^"]*)"/) || [])[1] || '').trim();
    const ids = [...body.matchAll(/<metadata key="object_id" value="(\d+)"/g)].map((x) => x[1]);
    const thumbFile = `Metadata/plate_${pid}.png`;
    plates.push({
      id: pid,
      name: pname || `Plate ${pid}`,
      objectIds: [...new Set(ids)].filter((id) => items.some((it) => it.id === id)),
      thumb: files[thumbFile] ? URL.createObjectURL(new Blob([files[thumbFile]], { type: 'image/png' })) : null,
    });
  }
  plates = plates.filter((p) => p.objectIds.length);
  if (!plates.length) plates = [{ id: 1, name: 'Everything', objectIds: [...new Set(items.map((i) => i.id))], thumb: null }];

  for (const p of plates) {
    const ex = [...new Set(p.objectIds.flatMap((id) => extruders[id] || [1]))];
    p.colors = ex.map((e) => colors[e - 1] || null).filter(Boolean);
    p.types = ex.map((e) => types[e - 1] || null).filter(Boolean);
    p.objectNames = p.objectIds.map((id) => names[id] || `Part ${id}`);
  }

  // ---- geometry ----
  const geomCache = new Map();
  function meshesFor(objects, id, path, parentMatrix, out, depth = 0) {
    const o = objects.get(id);
    if (!o || depth > 8) return;
    const comps = [...o.body.matchAll(/<component\b([^>]*)\/?>/g)];
    if (comps.length) {
      for (const [, a] of comps) {
        const subPath = attr(a, 'p:path');
        const subObjects = subPath ? objectsOf(subPath) : objects;
        const mtx = parentMatrix.clone().multiply(toMatrix(attr(a, 'transform')));
        meshesFor(subObjects, attr(a, 'objectid'), subPath || path, mtx, out, depth + 1);
      }
      return;
    }
    const key = `${path}#${id}`;
    if (!geomCache.has(key)) geomCache.set(key, parseMesh(o.body));
    const g = geomCache.get(key);
    if (g) out.push({ g, matrix: parentMatrix });
  }

  function build(plate, material) {
    const group = new THREE.Group();
    let painted = false;
    for (const it of items.filter((x) => plate.objectIds.includes(x.id))) {
      const parts = [];
      meshesFor(rootObjects, it.id, rootName, it.matrix, parts);
      if (!parts.length) continue;
      // merge an object's parts into one mesh, already in place
      const geos = parts.map(({ g, matrix }) => {
        painted = painted || g.painted;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(g.pos.slice(), 3));
        geo.setIndex(new THREE.BufferAttribute(g.idx, 1));
        const nonIndexed = geo.toNonIndexed();
        nonIndexed.applyMatrix4(new THREE.Matrix4().makeScale(unitScale, unitScale, unitScale).multiply(matrix));
        return nonIndexed;
      });
      const merged = geos.length === 1 ? geos[0] : mergeSimple(geos);
      merged.computeVertexNormals();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = names[it.id] || `Part ${it.id}`;
      group.add(mesh);
    }
    plate.painted = painted;
    return group;
  }

  return { plates, colors, unitScale, build, isMultiPlate: plates.length > 1 };
}

function mergeSimple(geos) {
  const total = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) { pos.set(g.attributes.position.array, o); o += g.attributes.position.array.length; }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return out;
}

// "#C12E1F" -> "red", for "load red filament"
const NAMED = {
  black: [20, 20, 20], white: [245, 245, 245], gray: [128, 128, 128], silver: [192, 192, 192],
  red: [200, 30, 30], orange: [240, 130, 30], yellow: [245, 215, 70], green: [40, 160, 70],
  'dark green': [20, 90, 40], blue: [40, 90, 210], 'light blue': [120, 180, 240], purple: [130, 60, 170],
  pink: [240, 130, 180], brown: [120, 70, 35], beige: [220, 200, 160], gold: [200, 160, 50],
};
export function colorName(hex) {
  const m = String(hex || '').match(/^#?([0-9a-f]{6})/i);
  if (!m) return null;
  const n = parseInt(m[1], 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let best = null, bd = Infinity;
  for (const [name, v] of Object.entries(NAMED)) {
    const d = (c[0] - v[0]) ** 2 * 0.3 + (c[1] - v[1]) ** 2 * 0.59 + (c[2] - v[2]) ** 2 * 0.11;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}
