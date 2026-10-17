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

// ---------- which knobs to turn ----------
// The bed plate is stiff, so it moves as one piece on its four springs. Turning one
// knob by d tips the whole plate: in our 0..1 bed coordinates it changes the
// left-right slope by d*(2x-1)/2 and the front-back slope by d*(2y-1)/2 (x, y = 0 or 1
// for that corner). We want both slopes to end up at zero. A diagonal tilt can be
// fixed with ONE knob; a straight side-to-side or front-to-back tilt needs two.
const KNOBS = [
  { corner: 'frontLeft', v: [-0.5, -0.5] },
  { corner: 'frontRight', v: [0.5, -0.5] },
  { corner: 'backLeft', v: [-0.5, 0.5] },
  { corner: 'backRight', v: [0.5, 0.5] },
];
const leftover = (b, c) => Math.max(Math.abs(b + c), Math.abs(b - c)) / 2; // worst corner, mm

function planKnobs(b, c, pitch) {
  if (leftover(b, c) < 0.03) return null; // already level enough
  const maxSingle = 1.25 * pitch;           // more than ~1 1/4 turns on one knob: split it
  const options = [];
  // one knob
  for (const k of KNOBS) {
    const d = -2 * (b * k.v[0] + c * k.v[1]);
    const rb = b + d * k.v[0], rc = c + d * k.v[1];
    options.push({ knobs: [{ corner: k.corner, d }], rest: leftover(rb, rc), size: Math.abs(d) });
  }
  // two knobs (skip opposite corners: they tip the plate the same way)
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const [a1, a2] = KNOBS[i].v, [b1, b2] = KNOBS[j].v;
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) continue;
    const di = (-b * b2 + c * b1) / det;
    const dj = (-c * a1 + b * a2) / det;
    options.push({ knobs: [{ corner: KNOBS[i].corner, d: di }, { corner: KNOBS[j].corner, d: dj }].filter((k) => Math.abs(k.d) >= 0.02), rest: 0, size: Math.max(Math.abs(di), Math.abs(dj)) });
  }
  // a big diagonal fix can be split between the two opposite corners
  for (const o of options.filter((x) => x.knobs.length === 1 && x.size > maxSingle && x.rest < 0.04)) {
    const k = o.knobs[0];
    const opp = { frontLeft: 'backRight', backRight: 'frontLeft', frontRight: 'backLeft', backLeft: 'frontRight' }[k.corner];
    options.push({ knobs: [{ corner: k.corner, d: k.d / 2 }, { corner: opp, d: -k.d / 2 }], rest: o.rest, size: Math.abs(k.d) / 2, split: true });
  }
  const good = options.filter((o) => o.rest < 0.04 && o.knobs.length);
  // smaller turns first; then prefer tightening (keeps the springs firm),
  // then pairs on the same side turned the same way (easiest to get right)
  const score = (o) => {
    const tighten = o.knobs.filter((k) => k.d < 0).length / o.knobs.length;
    const ids = o.knobs.map((k) => k.corner).sort().join(',');
    const sameSide = o.knobs.length === 2 && Math.sign(o.knobs[0].d) === Math.sign(o.knobs[1].d)
      && /^(backLeft,frontLeft|backRight,frontRight|backLeft,backRight|frontLeft,frontRight)$/.test(ids);
    return Math.round(o.size * 100) - tighten * 0.6 - (sameSide ? 0.5 : 0);
  };
  const byScore = (x, y) => score(x) - score(y);
  const singles = good.filter((o) => o.knobs.length === 1 && o.size <= maxSingle).sort(byScore);
  const pairs = good.filter((o) => o.knobs.length === 2).sort(byScore);
  const pick = singles[0] || pairs[0] || good.sort(byScore)[0];
  if (!pick) return null;
  let note = null;
  if (pick.knobs.length === 1) note = 'The bed tips as one piece, so the opposite corner moves the other way on its own. Leave the other knobs alone.';
  else if (pick.split) note = 'That\u2019s a big tilt, so it\u2019s split between these two opposite corners. Leave the other two knobs alone.';
  else {
    const ids = pick.knobs.map((k) => k.corner).sort().join(',');
    const [k1, k2] = pick.knobs;
    const sameDir = Math.sign(k1.d) === Math.sign(k2.d)
      && Math.abs(Math.abs(k1.d) - Math.abs(k2.d)) <= 0.2 * Math.max(Math.abs(k1.d), Math.abs(k2.d));
    if (sameDir && /^(backLeft,frontLeft|backRight,frontRight)$/.test(ids)) note = 'Turn both by the same amount. This tips the whole side at once.';
    else if (sameDir && /^(backLeft,backRight|frontLeft,frontRight)$/.test(ids)) note = 'Turn both by the same amount. This tips the whole back or front at once.';
    else note = 'Each knob gets its own amount. Leave the other two alone; the bed tips as one piece, so the rest follows.';
  }
  return { knobs: pick.knobs, note };
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

  // corner heights from the tilt, compared to the middle corner height (for display)
  const corners = CORNERS.map((c) => ({ ...c, h: plane.at(c.x, c.y) }));
  const sorted = corners.map((c) => c.h).sort((a, b) => a - b);
  const target = (sorted[1] + sorted[2]) / 2;
  for (const c of corners) c.delta = c.h - target;

  const steps = [];
  const plan = knobs ? planKnobs(leftRight, frontBack, pitch) : null;
  if (plan) {
    for (const k of plan.knobs) {
      const c = CORNERS.find((x) => x.id === k.corner);
      steps.push({
        corner: k.corner,
        mm: +k.d.toFixed(3),
        text: `${plan.knobs.length === 1 ? 'Tighten or loosen only this one: ' : ''}${k.d < 0 ? 'tighten' : 'loosen'} the ${c.label.toLowerCase()} knob ${turnsText(Math.abs(k.d), pitch)} (${k.d < 0 ? 'lowers' : 'raises'} that corner).`
          .replace(/^Tighten or loosen only this one: (\w)/, (_, ch) => `Only one knob to turn: ${ch}`)
          .replace(/^(\w)/, (ch) => ch.toUpperCase()),
      });
    }
    if (plan.note) steps.push({ corner: null, text: plan.note, note: true });
  } else if (!knobs) {
    for (const c of corners) {
      if (Math.abs(c.delta) < 0.05) continue;
      steps.push({ corner: c.id, text: `${c.label} is ${Math.abs(c.delta).toFixed(2)} mm ${c.delta > 0 ? 'higher' : 'lower'} than the rest.` });
    }
  }

  let verdict, level;
  if (range <= 0.15) { level = 'good'; verdict = 'Your bed is nicely level. Nothing to adjust.'; }
  else if (range <= 0.3) { level = 'ok'; verdict = 'Your bed is close. The printer’s auto-leveling will make up the difference.'; }
  else { level = 'bad'; verdict = 'Your bed is uneven enough to cause first-layer problems.'; }

  const notes = [];
  if (level === 'bad' && steps.length && knobs) notes.push('Make the adjustment above, then press Measure again to check.');
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
