// Finds OrcaSlicer on this PC, picks the right presets, and slices in the background.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { unzipSync, strFromU8 } = require('./fflate.cjs');
const { ProfileIndex, toCliPreset } = require('./profiles');
const { RECIPES, applyChoices } = require('./recipes');

const TARGET_MODEL = 'Creality Ender-3 V3 SE';

// ---------- where things live ----------

function orcaExeCandidates(override) {
  const env = process.env;
  const list = [
    override,
    env.EASYPRINT_ORCA,
    env.ProgramFiles && path.join(env.ProgramFiles, 'OrcaSlicer', 'orca-slicer.exe'),
    env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'OrcaSlicer', 'orca-slicer.exe'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'OrcaSlicer', 'orca-slicer.exe'),
    'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
  ];
  return [...new Set(list.filter(Boolean))];
}

function findOrcaExe(override) {
  return orcaExeCandidates(override).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function orcaDataDir() {
  if (process.env.EASYPRINT_ORCA_DATA) return process.env.EASYPRINT_ORCA_DATA;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'OrcaSlicer');
}

// Orca remembers what was last selected in OrcaSlicer.conf
function readOrcaSelection(dataDir) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'OrcaSlicer.conf'), 'utf8').replace(/^\uFEFF/, '');
    // the file is JSON but sometimes ends with a "# MD5 checksum" line
    const json = JSON.parse(raw.replace(/\n#.*$/s, ''));
    const p = json.presets || {};
    const filaments = Array.isArray(p.filaments) ? p.filaments : (p.filament ? [p.filament] : []);
    return { machine: p.machine || null, process: p.process || p.print || null, filaments };
  } catch {
    return { machine: null, process: null, filaments: [] };
  }
}

// ---------- choosing presets ----------

function first(v) { return Array.isArray(v) ? v[0] : v; }

class Orca {
  constructor(settings = {}) {
    this.settings = settings; // { orcaPath, machine, filaments: { PLA, PETG } }
    this.reload();
  }

  reload() {
    this.exe = findOrcaExe(this.settings.orcaPath);
    this.dataDir = orcaDataDir();
    const systemRoots = [path.join(this.dataDir, 'system')];
    if (this.exe) systemRoots.push(path.join(path.dirname(this.exe), 'resources', 'profiles'));
    if (process.env.EASYPRINT_ORCA_PROFILES) systemRoots.push(process.env.EASYPRINT_ORCA_PROFILES);
    this.index = new ProfileIndex({ systemRoots, userRoots: [path.join(this.dataDir, 'user')] });
    this.selection = readOrcaSelection(this.dataDir);
    this._flatCache = new Map();
  }

  flat(entry) {
    if (!this._flatCache.has(entry)) this._flatCache.set(entry, this.index.flatten(entry));
    return this._flatCache.get(entry);
  }

  isTargetPrinter(entry) {
    try { return String(this.flat(entry).printer_model || '').trim() === TARGET_MODEL; } catch { return false; }
  }

  machines() {
    return this.index.selectable('machine').filter((e) => this.isTargetPrinter(e));
  }

  machine() {
    const byName = (n) => n && this.index.selectable('machine').find((e) => e.name === n);
    const all = this.machines();
    const nozzle04 = (e) => String(first(this.flat(e).nozzle_diameter)) === '0.4';
    return (
      byName(this.settings.machine) ||
      (byName(this.selection.machine) && this.isTargetPrinter(byName(this.selection.machine)) && byName(this.selection.machine)) ||
      all.filter((e) => e.origin === 'user' && nozzle04(e)).sort((a, b) => mtime(b.file) - mtime(a.file))[0] ||
      all.find((e) => e.name === `${TARGET_MODEL} 0.4 nozzle`) ||
      all[0] ||
      null
    );
  }

  // the built-in printer name Orca's own process/filament presets are written for
  systemPrinterName(machine) {
    return this.index.systemAncestor(machine)?.name || machine.name;
  }

  processFor(machine, recipeId) {
    const sysName = this.systemPrinterName(machine);
    const target = RECIPES[recipeId].layerHeight;
    const candidates = this.index.selectable('process').filter(
      (e) => e.origin === 'system' && (e.data.compatible_printers || []).includes(sysName)
    );
    if (!candidates.length) throw new Error(`Orca has no print profiles for "${sysName}".`);
    const lh = (e) => parseFloat(this.flat(e).layer_height) || 0.2;
    candidates.sort((a, b) => Math.abs(lh(a) - target) - Math.abs(lh(b) - target)
      || (/standard|optimal|fine|draft/i.test(b.name) - /standard|optimal|fine|draft/i.test(a.name)));
    return candidates[0];
  }

  filamentType(entry) {
    try { return String(first(this.flat(entry).filament_type) || '').toUpperCase(); } catch { return ''; }
  }

  filaments(material) {
    const sysName = this.machine() ? this.systemPrinterName(this.machine()) : '';
    return this.index.selectable('filament').filter((e) => {
      if (this.filamentType(e) !== material) return false;
      if (e.origin === 'user') return true;
      return (e.data.compatible_printers || []).includes(sysName);
    });
  }

  filamentFor(material) {
    const options = this.filaments(material);
    const byName = (n) => n && options.find((e) => e.name === n);
    const fromOrca = this.selection.filaments.map(byName).find(Boolean);
    return (
      byName(this.settings.filaments?.[material]) ||
      fromOrca ||
      options.filter((e) => e.origin === 'user').sort((a, b) => mtime(b.file) - mtime(a.file))[0] ||
      options.find((e) => /^generic/i.test(e.name)) ||
      options.find((e) => /^cr-/i.test(e.name)) ||
      options[0] ||
      null
    );
  }

  // everything the settings screen shows
  status() {
    const m = this.machine();
    const names = (list) => list.map((e) => e.name);
    return {
      orcaFound: !!this.exe,
      orcaPath: this.exe,
      orcaCandidates: orcaExeCandidates(this.settings.orcaPath),
      dataDir: this.dataDir,
      machine: m?.name || null,
      machines: names(this.machines()),
      filament: { PLA: this.filamentFor('PLA')?.name || null, PETG: this.filamentFor('PETG')?.name || null },
      filaments: { PLA: names(this.filaments('PLA')), PETG: names(this.filaments('PETG')) },
    };
  }

  // ---------- slicing ----------

  /**
   * @returns {Promise<{gcodePath, seconds, grams, layerHeight, presets}>}
   */
  async slice({ stlPath, modelName, recipe, toggles = [], material = 'PLA', onLog }) {
    if (!this.exe) throw friendly('OrcaSlicer wasn\u2019t found on this computer. Check Printer setup.');
    const machine = this.machine();
    if (!machine) throw friendly(`No ${TARGET_MODEL} printer profile was found in OrcaSlicer.`);
    const proc = this.processFor(machine, recipe);
    const fil = this.filamentFor(material);
    if (!fil) throw friendly(`No ${material} filament profile was found for this printer in OrcaSlicer.`);

    const work = makeWorkDir();
    const files = {
      machine: path.join(work, 'printer.json'),
      process: path.join(work, 'process.json'),
      filament: path.join(work, 'filament.json'),
    };
    const processSettings = applyChoices(this.flat(proc), recipe, toggles);
    writeJson(files.machine, toCliPreset(this.flat(machine), 'machine', 'EasyPrint printer'));
    writeJson(files.process, toCliPreset(processSettings, 'process', 'EasyPrint process'));
    writeJson(files.filament, toCliPreset(this.flat(fil), 'filament', 'EasyPrint filament'));

    const args = [
      '--arrange', '1',
      '--orient', '0',
      '--slice', '1',
      '--load-settings', `${files.machine};${files.process}`,
      '--load-filaments', files.filament,
      '--outputdir', work,
      '--export-3mf', 'result.gcode.3mf',
      stlPath,
    ];
    const { code, log } = await run(this.exe, args, onLog);
    fs.writeFileSync(path.join(work, 'orca-log.txt'), `${this.exe} ${args.join(' ')}\n\n${log}`);

    const result3mf = path.join(work, 'result.gcode.3mf');
    if (!fs.existsSync(result3mf)) {
      throw friendly(explainExit(code), log, work);
    }

    const zip = unzipSync(fs.readFileSync(result3mf), {
      filter: (f) => /^Metadata\/(plate_\d+\.gcode|slice_info\.config)$/.test(f.name),
    });
    const gname = Object.keys(zip).find((n) => n.endsWith('.gcode'));
    if (!gname) throw friendly('Orca finished but didn\u2019t produce any G-code.', log, work);

    const base = (modelName || 'print').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'print';
    const gcodePath = path.join(work, `${base}.gcode`);
    fs.writeFileSync(gcodePath, zip[gname]);

    const info = zip['Metadata/slice_info.config'] ? strFromU8(zip['Metadata/slice_info.config']) : '';
    const header = strFromU8(zip[gname].subarray(0, 20000));
    return {
      gcodePath,
      workDir: work,
      seconds: num(info, /key="prediction"\s+value="([\d.]+)"/) ?? parseOrcaTime(header),
      grams: num(info, /key="weight"\s+value="([\d.]+)"/) ?? num(header, /total filament weight \[g\]\s*:\s*([\d.]+)/i),
      layerHeight: parseFloat(processSettings.layer_height),
      presets: { printer: machine.name, process: proc.name, filament: fil.name },
    };
  }
}

// ---------- helpers ----------

function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
function writeJson(f, obj) { fs.writeFileSync(f, JSON.stringify(obj, null, 2)); }
function num(text, re) { const m = text && text.match(re); return m ? parseFloat(m[1]) : null; }

function parseOrcaTime(header) {
  const m = header.match(/estimated printing time[^=:]*[=:]\s*([^\n;]+)/i);
  if (!m) return null;
  let s = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+)\s*([dhms])/g)) s += n * { d: 86400, h: 3600, m: 60, s: 1 }[u];
  return s || null;
}

function makeWorkDir() {
  const root = path.join(os.tmpdir(), 'easyprint');
  fs.mkdirSync(root, { recursive: true });
  // keep only the last few jobs
  const old = fs.readdirSync(root).filter((d) => d.startsWith('job-')).sort();
  for (const d of old.slice(0, Math.max(0, old.length - 5))) {
    fs.rmSync(path.join(root, d), { recursive: true, force: true });
  }
  const dir = path.join(root, `job-${Date.now()}`);
  fs.mkdirSync(dir);
  return dir;
}

function run(exe, args, onLog) {
  return new Promise((resolve) => {
    let log = '';
    const child = spawn(exe, args, { windowsHide: true });
    const timer = setTimeout(() => { log += '\n[EasyPrint] Gave up after 10 minutes.'; child.kill(); }, 10 * 60 * 1000);
    const take = (d) => { const t = d.toString(); log += t; onLog?.(t); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { log += `\n[EasyPrint] Couldn't start Orca: ${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, log }); });
  });
}

// Orca's exit codes, in plain words
const EXIT = {
  [-2]: 'Orca didn\u2019t understand the request.',
  [-3]: 'The model file couldn\u2019t be found.',
  [-5]: 'One of the Orca profiles couldn\u2019t be read.',
  [-6]: 'The model file couldn\u2019t be read. It may be damaged.',
  [-14]: 'The computer ran out of memory while slicing.',
  [-17]: 'The print profile doesn\u2019t match the printer.',
  [-21]: 'Orca couldn\u2019t fit the model on the bed.',
  [-50]: 'Nothing printable was found on the bed.',
  [-51]: 'Orca found a problem with the settings for this model.',
  [-52]: 'The model is partly off the bed. Try making it smaller.',
  [-58]: 'This model takes too long to slice. Try the Quick test choice.',
  [-59]: 'This model is too detailed for Orca to slice.',
  [-100]: 'Orca couldn\u2019t slice this model.',
};
function explainExit(code) {
  // Windows reports negative codes as big numbers, Linux/macOS as 0-255
  let signed = code;
  if (code > 2147483647) signed = code - 4294967296;
  else if (code > 127 && code < 256) signed = code - 256;
  if (code === null) return 'Orca was stopped before it finished.';
  return EXIT[signed] || `Orca stopped with an error (code ${signed}).`;
}

function friendly(message, log = '', workDir = null) {
  const e = new Error(message);
  e.log = log.slice(-4000);
  e.workDir = workDir;
  return e;
}

module.exports = { Orca, findOrcaExe, orcaDataDir, readOrcaSelection, parseOrcaTime };
