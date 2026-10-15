// Bed setup helpers: read the Z-offset and bed mesh out of the printer's replies,
// and turn a mesh into plain advice.

// ---------- reading replies ----------

// Marlin and Creality firmware word this a few different ways
function parseZOffset(lines) {
  const text = lines.join('\n');
  const patterns = [
    /M851[^\n]*?\bZ\s*(-?\d+(?:\.\d+)?)/i,          // "echo:  M851 X-31.8 Y-40.5 Z-2.07"
    /Probe Offset[^\n]*?\bZ:?\s*(-?\d+(?:\.\d+)?)/i,  // "Probe Offset X0 Y0 Z-2.07"
    /Z[\s_-]*Offset\s*[:=]?\s*(-?\d+(?:\.\d+)?)/i,    // "Z Offset: -2.07"
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return parseFloat(m[1]);
  }
  return null;
}

// Finds the grid in an "M420 V" / "G29" reply:
//        0      1      2
//  0 +0.120 +0.080 -0.010
//  1 ...
// Row 0 is the front of the bed (closest to you), column 0 is the left.
function parseMesh(lines) {
  const rows = [];
  let best = [];
  for (const raw of lines) {
    const line = raw.replace(/^echo:\s*/i, '').trim();
    const m = line.match(/^(\d+)\s+((?:[-+]?(?:\d+\.\d+|nan)\s*){2,})$/i);
    if (m) {
      const vals = m[2].trim().split(/\s+/).map((v) => (/nan/i.test(v) ? NaN : parseFloat(v)));
      if (rows.length && vals.length !== rows[0].length) { if (rows.length > best.length) best = rows.slice(); rows.length = 0; }
      rows.push(vals);
    } else if (rows.length) {
      if (rows.length > best.length) best = rows.slice();
      rows.length = 0;
    }
  }
  if (rows.length > best.length) best = rows.slice();
  if (best.length < 2 || best[0].length < 2) return null;
  // fill any missing points with the average of their neighbours
  const flat = best.flat().filter((v) => !Number.isNaN(v));
  if (flat.length < 4) return null;
  const mean = flat.reduce((a, b) => a + b, 0) / flat.length;
  return best.map((r) => r.map((v) => (Number.isNaN(v) ? mean : v)));
}

// ---------- understanding the mesh ----------

function fitPlane(grid) {
  // z = a + b*x + c*y, x and y from 0..1 (left->right, front->back)
  const ny = grid.length, nx = grid[0].length;
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = i / (nx - 1), y = j / (ny - 1), z = grid[j][i];
    n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
  }
  // solve the 3x3 normal equations
  const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
  const B = [sz, sxz, syz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  const col = (k) => A.map((r, i) => r.map((v, c) => (c === k ? B[i] : v)));
  const [a, b, c] = [0, 1, 2].map((k) => det(col(k)) / D);
  return { a, b, c, at: (x, y) => a + b * x + c * y };
}

const CORNERS = [
  { id: 'frontLeft', label: 'Front-left', x: 0, y: 0 },
  { id: 'frontRight', label: 'Front-right', x: 1, y: 0 },
  { id: 'backLeft', label: 'Back-left', x: 0, y: 1 },
  { id: 'backRight', label: 'Back-right', x: 1, y: 1 },
];

function turnsText(mm, pitch) {
  const eighths = Math.round((mm / pitch) * 8);
  if (eighths <= 0) return 'a tiny nudge';
  const whole = Math.floor(eighths / 8), rest = eighths % 8;
  const frac = { 1: 'an eighth', 2: 'a quarter', 3: 'three eighths', 4: 'a half', 5: 'five eighths', 6: 'three quarters', 7: 'seven eighths' }[rest];
  if (!whole) return rest === 4 ? 'half a turn' : `${frac} of a turn`;
  const w = whole === 1 ? 'one' : String(whole);
  return rest ? `${w} and ${frac} turns` : `${w} full turn${whole > 1 ? 's' : ''}`;
}

/**
 * @param grid   mesh heights in mm, grid[row][col], row 0 = front
 * @param opts   { knobs: bool, pitch: mm per knob turn }
 */
function analyze(grid, { knobs = true, pitch = 0.7 } = {}) {
  const flat = grid.flat();
  const min = Math.min(...flat), max = Math.max(...flat);
  const range = max - min;
  const plane = fitPlane(grid);
  const ny = grid.length, nx = grid[0].length;

  // how far it bows after removing the tilt (knobs can't fix this part)
  let warp = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    warp = Math.max(warp, Math.abs(grid[j][i] - plane.at(i / (nx - 1), j / (ny - 1))));
  }
  const leftRight = plane.b;  // + means the right side is higher
  const frontBack = plane.c;  // + means the back is higher

  // corner heights from the tilt, compared to the middle corner height
  const corners = CORNERS.map((c) => ({ ...c, h: plane.at(c.x, c.y) }));
  const sorted = corners.map((c) => c.h).sort((a, b) => a - b);
  const target = (sorted[1] + sorted[2]) / 2; // least total turning
  const steps = [];
  for (const c of corners) {
    const d = c.h - target;
    c.delta = d;
    if (Math.abs(d) < 0.05) continue;
    const high = d > 0;
    if (knobs) {
      steps.push({
        corner: c.id,
        text: `${c.label} is ${Math.abs(d).toFixed(2)} mm ${high ? 'high' : 'low'}: ${high ? 'tighten' : 'loosen'} that knob ${turnsText(Math.abs(d), pitch)}.`,
      });
    } else {
      steps.push({ corner: c.id, text: `${c.label} is ${Math.abs(d).toFixed(2)} mm ${high ? 'higher' : 'lower'} than the rest.` });
    }
  }

  let verdict, level;
  if (range <= 0.15) { level = 'good'; verdict = 'Your bed is nicely level. Nothing to adjust.'; }
  else if (range <= 0.3) { level = 'ok'; verdict = 'Your bed is close. The printer’s auto-leveling will make up the difference.'; }
  else { level = 'bad'; verdict = 'Your bed is uneven enough to cause first-layer problems.'; }

  const notes = [];
  if (level === 'bad' && steps.length && knobs) notes.push('Adjust the corners above, then press Measure again to check.');
  if (level === 'ok' && steps.length && knobs) notes.push('These tweaks are optional, for an even better first layer. Press Measure again afterwards to check.');
  if (level === 'good') steps.length = 0;
  if (warp > 0.2) notes.push(`The middle of the bed bows by about ${warp.toFixed(2)} mm. Knobs can’t fix that, but the printer’s auto-leveling covers it.`);
  if (!knobs && level === 'bad') notes.push('Without corner knobs, the auto-leveling has to make up for this. If prints still fail, the bed may need shimming.');

  const describeTilt = (v, pos, neg) => (Math.abs(v) < 0.05 ? null : `${v > 0 ? pos : neg} by ${Math.abs(v).toFixed(2)} mm`);
  const tilt = [describeTilt(leftRight, 'right side higher', 'left side higher'), describeTilt(frontBack, 'back higher', 'front higher')].filter(Boolean);

  return {
    level, verdict, notes, steps,
    range: +range.toFixed(3), min: +min.toFixed(3), max: +max.toFixed(3), warp: +warp.toFixed(3),
    tilt, corners: corners.map(({ id, label, h, delta }) => ({ id, label, h: +h.toFixed(3), delta: +delta.toFixed(3) })),
  };
}

// a sane Z-offset for this printer (stops typos like -20.7)
const Z_MIN = -5, Z_MAX = 1;
function validZ(v) { return typeof v === 'number' && Number.isFinite(v) && v >= Z_MIN && v <= Z_MAX; }

module.exports = { parseZOffset, parseMesh, analyze, fitPlane, turnsText, validZ, Z_MIN, Z_MAX };
