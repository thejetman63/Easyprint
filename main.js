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

ipcMain.handle('orca:slice', async (_e, { stl, modelName, recipe, toggles, material }) => {
  const tmp = path.join(app.getPath('temp'), 'easyprint');
  fs.mkdirSync(tmp, { recursive: true });
  const stlPath = path.join(tmp, 'model.stl');
  fs.writeFileSync(stlPath, Buffer.from(stl));
  try {
    const result = await orca.slice({
      stlPath, modelName, recipe, toggles, material,
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
  step('Measuring the bed (this takes a few minutes)\u2026');
  await printer.query('G29', 15 * 60 * 1000);
  const [lines] = await printer.query('M420 V');
  await printer.query(['M420 S1', 'M140 S0']);
  logStep('Measured a new bed mesh');
  const grid = bed.parseMesh(lines);
  if (!grid) throw new Error('The printer measured the bed but didn\u2019t report the result.');
  return { grid, analysis: bed.analyze(grid, { knobs: settings.bedKnobs !== false, pitch: settings.knobPitch || 0.7 }) };
}));

ipcMain.handle('printer:connect', async () => {
  try { return { ok: true, status: await printer.connect() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('printer:disconnect', async () => {
  try { await printer.disconnect(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('printer:status', () => printer.status());
ipcMain.handle('printer:print', (_e, { gcodePath, estimateSeconds }) => {
  try { printer.startPrint(gcodePath, { estimateSeconds }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
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
