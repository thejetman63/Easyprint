const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const fs = require('fs');
const path = require('path');
const { Orca } = require('./lib/orca');
const recipes = require('./lib/recipes');
const { Printer } = require('./lib/printer');
const askAi = require('./lib/ask');
const bed = require('./lib/bed');

// ---------- printer over USB ----------
function makePrinter() {
  if (process.env.EASYPRINT_FAKE_PRINTER) {
    const { FakeMarlin } = require('./lib/fake-printer');
    return new Printer({
      listPorts: async () => [{ path: 'FAKE1', vendorId: '1a86' }],
      openTransport: async () => new FakeMarlin({ speed: Number(process.env.EASYPRINT_FAKE_PRINTER) || 2 }),
    });
  }
  const { SerialPort } = require('serialport');
  return new Printer({
    listPorts: () => SerialPort.list(),
    openTransport: (portPath, baudRate) => new Promise((resolve, reject) => {
      const port = new SerialPort({ path: portPath, baudRate, autoOpen: false });
      port.open((err) => (err ? reject(err) : resolve(port)));
    }),
  });
}
const printer = makePrinter();
let awakeId = null;
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

printer.on('status', (s) => {
  send('printer:status', s);
  // keep the computer awake while printing, otherwise the print stops
  const printing = s.job && !s.job.finished;
  if (printing && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
  if (!printing && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
});
printer.on('problem', (m) => send('printer:problem', m));
printer.on('done', () => send('printer:done'));
const logLines = [];
printer.on('log', (l) => { logLines.push(l); if (logLines.length > 300) logLines.shift(); });

// ---------- saved settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

let settings = {};
let orca = null;
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'EasyPrint',
    backgroundColor: '#f6f3ee',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // don't let the window close by accident in the middle of a print
  win.on('close', (e) => {
    const s = printer.status();
    if (!(s.job && !s.job.finished)) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep printing', 'Stop the print and close'],
      defaultId: 0, cancelId: 0,
      title: 'A print is running',
      message: 'A print is running. Closing EasyPrint will stop it.',
    });
    if (choice === 0) e.preventDefault();
    else printer.stop();
  });
}

// ---------- window <-> computer ----------
ipcMain.handle('choices', () => recipes.describe());

ipcMain.handle('orca:status', () => {
  try { return orca.status(); } catch (e) { return { error: e.message }; }
});

ipcMain.handle('orca:slice', async (_e, { stls, stl, modelName, recipe, toggles, material }) => {
  const tmp = path.join(app.getPath('temp'), 'easyprint', 'models');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  // one file per part, so Orca treats them as separate objects and lays them out
  const stlPaths = (stls || [stl]).map((buf, i) => {
    const p = path.join(tmp, `part_${i + 1}.stl`);
    fs.writeFileSync(p, Buffer.from(buf));
    return p;
  });
  try {
    const result = await orca.slice({
      stlPaths, modelName, recipe, toggles, material,
      onLog: (t) => win?.webContents.send('orca:log', t),
    });
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message, log: e.log || '', workDir: e.workDir || null };
  }
});

ipcMain.handle('gcode:save', async (_e, { gcodePath }) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save G-code',
    defaultPath: path.basename(gcodePath),
    filters: [{ name: 'G-code', extensions: ['gcode'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.copyFileSync(gcodePath, filePath);
  return { ok: true, filePath };
});

ipcMain.handle('folder:open', (_e, dir) => { if (dir) shell.openPath(dir); });

ipcMain.handle('settings:set', (_e, patch) => {
  settings = { ...settings, ...patch, filaments: { ...(settings.filaments || {}), ...(patch.filaments || {}) } };
  saveSettings(settings);
  orca = new Orca(settings);
  return orca.status();
});

ipcMain.handle('orca:browse', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Find orca-slicer.exe',
    properties: ['openFile'],
    filters: [{ name: 'OrcaSlicer', extensions: ['exe'] }],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('settings:get', () => settings);
ipcMain.handle('ask:status', () => askAi.status(settings.ollamaModel));
ipcMain.handle('ask:run', async (_e, input) => {
  try { return { ok: true, ...(await askAi.ask(input, settings.ollamaModel)) }; }
  catch (e) { return { ok: false, error: e.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : e.message }; }
});

// ---------- bed setup ----------
const wrap = (fn) => async (_e, arg) => {
  try { return { ok: true, ...(await fn(arg)) }; } catch (e) { return { ok: false, error: e.message }; }
};
const logStep = (t) => logLines.push(`[EasyPrint] ${t}`);

async function readZ() {
  const [lines] = await printer.query('M851');
  let z = bed.parseZOffset(lines);
  if (z === null) z = bed.parseZOffset((await printer.query('M503'))[0]);
  return z;
}

// read-only: what the printer is and how it reports things
ipcMain.handle('bed:info', wrap(async () => {
  const [fw, cfg, probe, mesh] = await printer.query(['M115', 'M503', 'M851', 'M420 V']);
  const text = [
    '> M115', ...fw, '', '> M503', ...cfg, '', '> M851', ...probe, '', '> M420 V', ...mesh,
  ].join('\n');
  return { text, zOffset: bed.parseZOffset([...probe, ...cfg]), meshFound: !!bed.parseMesh(mesh) };
}));

ipcMain.handle('bed:readZ', wrap(async () => ({ zOffset: await readZ() })));

ipcMain.handle('bed:setZ', wrap(async (value) => {
  const v = Math.round(Number(value) * 100) / 100;
  if (!bed.validZ(v)) throw new Error(`${value} doesn\u2019t look like a sensible Z-offset (it should be between ${bed.Z_MIN} and ${bed.Z_MAX}).`);
  const before = await readZ();
  await printer.query([`M851 Z${v.toFixed(2)}`, 'M500']);
  const after = await readZ();
  logStep(`Z-offset changed from ${before} to ${after} (asked for ${v})`);
  if (after !== null && Math.abs(after - v) > 0.005) throw new Error(`The printer didn\u2019t accept the new Z-offset (it reports ${after}).`);
  return { before, zOffset: after ?? v };
}));

ipcMain.handle('bed:readMesh', wrap(async () => {
  const [lines] = await printer.query('M420 V');
  const grid = bed.parseMesh(lines);
  if (!grid) throw new Error('The printer didn\u2019t report a bed mesh. Try Measure again.');
  return { grid, analysis: bed.analyze(grid, { knobs: settings.bedKnobs !== false, pitch: settings.knobPitch || 0.7 }) };
}));

ipcMain.handle('bed:analyze', (_e, grid) => bed.analyze(grid, { knobs: settings.bedKnobs !== false, pitch: settings.knobPitch || 0.7 }));

// heat the bed, home, probe a new mesh. Takes a few minutes.
ipcMain.handle('bed:measure', wrap(async (material) => {
  const t = material === 'PETG' ? 70 : 60;
  const step = (m) => send('bed:progress', m);
  step(`Heating the bed to ${t}\u00b0\u2026`);
  await printer.query(`M190 S${t}`, 15 * 60 * 1000);
  step('Homing\u2026');
  await printer.query('G28', 3 * 60 * 1000);
  zGuessed = false; posKnown = true;
  step('Measuring the bed (this takes a few minutes)\u2026');
  await printer.query('G29', 15 * 60 * 1000);
  const [lines] = await printer.query('M420 V');
  await printer.query(['M420 S1', 'M140 S0']);
  logStep('Measured a new bed mesh');
  const grid = bed.parseMesh(lines);
  if (!grid) throw new Error('The printer measured the bed but didn\u2019t report the result.');
  return { grid, analysis: bed.analyze(grid, { knobs: settings.bedKnobs !== false, pitch: settings.knobPitch || 0.7 }) };
}));

// ---------- manual controls (only when not printing) ----------
const Z_TOP = 245; // Ender-3 V3 SE is 250 mm tall; stay just under
let zGuessed = false; // true after a restart, until the printer is homed again
let posKnown = false; // the printer only knows where it is after homing (or a print)
const refused = (lines) => lines.some((l) => /home\s*(xyz|xy|z)?\s*first|not homed|unknown position|move out of range|homing failed/i.test(l));

async function position() {
  const [lines] = await printer.query('M114');
  const m = lines.join(' ').match(/X:\s*(-?[\d.]+)\s*Y:\s*(-?[\d.]+)\s*Z:\s*(-?[\d.]+)/);
  return m ? { x: +m[1], y: +m[2], z: +m[3], guessed: zGuessed, unknown: !posKnown && !zGuessed } : null;
}

async function moveZ(delta, { unlocked = false } = {}) {
  let d = Number(delta);
  if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 100) throw new Error('That move isn\u2019t allowed.');
  let pos = unlocked ? null : await position();
  if (pos && pos.unknown) {
    if (d < 0) throw new Error('The printer doesn\u2019t know how high the nozzle is yet. Press Home (with the bed clear) before lowering it.');
    pos = null; // can't clamp against a height it doesn't know; the top limit is enforced after homing
    if (d > 20) d = 20; // small steps until we know where the top is
  }
  const wasUnknown = !unlocked && !pos && !zGuessed;
  if (pos) {
    if (d > 0 && pos.z + d > Z_TOP) d = Z_TOP - pos.z;
    if (d < 0 && pos.z + d < 0.3) d = 0.3 - pos.z;
    if (d > 0 && d < 0.05) throw new Error('The nozzle is already at the top.');
    if (d < 0 && d > -0.05) throw new Error('The nozzle is already at the bottom.');
  }
  const replies = await printer.query(['G91', `G1 Z${d.toFixed(2)} F600`, 'G90', 'M400'], 60000);
  if (refused(replies.flat())) {
    if (d < 0) throw new Error('The printer needs to be homed before the nozzle can go down. Clear the bed and press Home.');
    if (unlocked) throw new Error('The printer won\u2019t move until it\u2019s homed. Let the nozzle cool, pull off any stuck plastic, then press Home.');
    // After a restart the printer doesn't know where it is. Tell it "you're at 0"
    // so it allows moving up (never down) from where it is now.
    logStep('Printer not homed: treating the current height as 0 so the nozzle can be raised');
    await printer.query('G92 Z0');
    zGuessed = true;
    return moveZ(delta, { unlocked: true });
  }
  if (wasUnknown) zGuessed = true; // heights are now 'from where it was'
  logStep(`Moved nozzle ${d > 0 ? 'up' : 'down'} ${Math.abs(d).toFixed(1)} mm`);
  return { moved: +d.toFixed(2), position: await position() };
}

ipcMain.handle('ctl:position', wrap(async () => ({ position: await position() })));
ipcMain.handle('ctl:moveZ', wrap((d) => moveZ(d)));
ipcMain.handle('ctl:cool', wrap(async () => { clearHeatTimer(); await printer.query(['M104 S0', 'M140 S0']); logStep('Heaters off'); return {}; }));

// ---- heating the nozzle to clear or change filament ----
const MIN_EXTRUDE = 180;    // below this the plastic isn't melted (printer refuses too)
const AUTO_OFF_MIN = 10;    // don't leave a hot nozzle sitting there
let heatTimer = null;
function clearHeatTimer() { if (heatTimer) { clearTimeout(heatTimer); heatTimer = null; } send('ctl:heatOff', null); }
function armHeatTimer() {
  if (heatTimer) clearTimeout(heatTimer);
  const at = Date.now() + AUTO_OFF_MIN * 60000;
  send('ctl:heatOff', at);
  heatTimer = setTimeout(async () => {
    heatTimer = null;
    send('ctl:heatOff', null);
    const st = printer.status();
    if (st.connected && !(st.job && !st.job.finished)) {
      try { await printer.query('M104 S0'); logStep(`Nozzle turned off after ${AUTO_OFF_MIN} idle minutes`); } catch {}
      send('printer:problem', `The nozzle was turned off after ${AUTO_OFF_MIN} minutes so it isn\u2019t left hot.`);
    }
  }, AUTO_OFF_MIN * 60000);
}

ipcMain.handle('ctl:heat', wrap(async (temp) => {
  const t = Math.round(Number(temp));
  if (!(t >= 0 && t <= 260)) throw new Error('That temperature isn\u2019t allowed.');
  await printer.query(`M104 S${t}`);
  if (t > 0) armHeatTimer(); else clearHeatTimer();
  logStep(`Nozzle set to ${t}\u00b0`);
  return { target: t };
}));

// mm > 0 pushes filament out of the nozzle, mm < 0 pulls it back up
ipcMain.handle('ctl:extrude', wrap(async ({ mm, speed }) => {
  const d = Number(mm);
  if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 120) throw new Error('That amount isn\u2019t allowed.');
  const now = printer.status().temps.nozzle;
  if (now == null || now < MIN_EXTRUDE) {
    throw new Error(`The nozzle is only ${now == null ? '?' : Math.round(now)}\u00b0. Heat it first and wait until it\u2019s at least ${MIN_EXTRUDE}\u00b0.`);
  }
  const feed = Math.max(60, Math.min(1800, Number(speed) || 300)); // mm per minute
  const replies = await printer.query(['M83', `G1 E${d.toFixed(1)} F${feed}`, 'M82', 'M400'], 120000);
  if (replies.flat().some((l) => /cold extrusion/i.test(l))) throw new Error('The printer says the nozzle isn\u2019t hot enough yet. Wait a little longer.');
  armHeatTimer(); // still working, so restart the auto-off countdown
  logStep(`${d > 0 ? 'Pushed' : 'Pulled'} ${Math.abs(d)} mm of filament`);
  return {};
}));
ipcMain.handle('ctl:fan', wrap(async (on) => { await printer.query(on ? 'M106 S255' : 'M107'); return {}; }));
ipcMain.handle('ctl:motorsOff', wrap(async () => { await printer.query('M84'); return {}; }));
ipcMain.handle('ctl:home', wrap(async () => {
  await printer.query(['G28', 'M400'], 3 * 60 * 1000);
  zGuessed = false; posKnown = true;
  logStep('Homed');
  return { position: await position() };
}));
// lift the nozzle, then bring the bed forward so the print is easy to reach
ipcMain.handle('ctl:present', wrap(async () => {
  const pos = await position();
  if (pos && pos.z < 30) await moveZ(Math.min(30 - pos.z, 50));
  const replies = await printer.query(['G90', 'G1 X5 Y215 F3000', 'M400'], 60000);
  if (refused(replies.flat())) throw new Error('The printer needs to be homed before it can move the bed. Press Home when the bed is clear.');
  return { position: await position() };
}));

ipcMain.handle('printer:connect', async () => {
  if (!printer.status().connected) { posKnown = false; zGuessed = false; } // connecting restarts the board
  try { return { ok: true, status: await printer.connect() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('printer:disconnect', async () => {
  try { await printer.disconnect(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('printer:status', () => printer.status());
ipcMain.handle('printer:print', (_e, { gcodePath, estimateSeconds }) => {
  try { printer.startPrint(gcodePath, { estimateSeconds }); zGuessed = false; posKnown = true; return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('printer:pause', () => printer.pause());
ipcMain.handle('printer:resume', () => printer.resume());
ipcMain.handle('printer:stop', () => printer.stop());
ipcMain.handle('printer:log', () => logLines.join('\n'));
ipcMain.handle('gcode:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Print a G-code file', properties: ['openFile'],
    filters: [{ name: 'G-code', extensions: ['gcode', 'gco', 'g'] }],
  });
  return canceled ? null : filePaths[0];
});

app.whenReady().then(() => {
  settings = loadSettings();
  orca = new Orca(settings);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
