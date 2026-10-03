const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Orca } = require('./lib/orca');
const recipes = require('./lib/recipes');

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

app.whenReady().then(() => {
  settings = loadSettings();
  orca = new Orca(settings);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
