// Reads OrcaSlicer's printer / process / filament presets and "flattens" them.
//
// Orca stores presets as small JSON files that only list the settings that
// differ from a parent ("inherits"). Many Orca versions don't follow that chain
// when slicing from the command line, so we merge the whole chain ourselves and
// hand Orca one complete, self-contained file per preset.

const fs = require('fs');
const path = require('path');

const TYPES = ['machine', 'process', 'filament'];

// keys that describe the preset itself rather than how to print
const META_KEYS = [
  'inherits', 'instantiation', 'setting_id', 'renamed_from', 'base_id', 'filament_id_old',
  'compatible_printers', 'compatible_printers_condition',
  'compatible_prints', 'compatible_prints_condition', 'is_custom_defined', 'user_id', 'updated_time',
];

function walkJson(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkJson(p, out);
    else if (e.name.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

function readJson(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(txt);
  } catch { return null; }
}

function typeFromPath(file) {
  const parts = file.split(/[\\/]/).map((s) => s.toLowerCase());
  return TYPES.find((t) => parts.includes(t)) || null;
}

class ProfileIndex {
  /**
   * @param {object} o
   * @param {string[]} o.systemRoots folders that contain one sub-folder per vendor
   *                   (e.g. <Orca>/resources/profiles and %APPDATA%/OrcaSlicer/system)
   * @param {string[]} o.userRoots   folders holding the user's own presets
   *                   (e.g. %APPDATA%/OrcaSlicer/user)
   */
  constructor({ systemRoots = [], userRoots = [] }) {
    this.byName = new Map(); // name -> [entries], best first
    this.entries = [];

    // user presets first, so they win a name clash
    for (const root of userRoots) {
      for (const file of walkJson(root)) this._add(file, 'user', null);
    }
    for (const root of systemRoots) {
      let vendors;
      try { vendors = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { continue; }
      for (const v of vendors) {
        for (const file of walkJson(path.join(root, v.name))) this._add(file, 'system', v.name);
      }
    }
  }

  _add(file, origin, vendor) {
    const data = readJson(file);
    if (!data || typeof data.name !== 'string') return;
    const type = TYPES.includes(data.type) ? data.type : (origin === 'user' ? typeFromPath(file) : null);
    if (!type) return; // e.g. "machine_model" description files
    const entry = { name: data.name, type, origin, vendor, file, data };
    // skip an identical system copy we've already seen (appdata copy vs install copy)
    const list = this.byName.get(data.name) || [];
    if (origin === 'system' && list.some((x) => x.origin === 'system' && x.vendor === vendor && x.type === type)) return;
    list.push(entry);
    this.byName.set(data.name, list);
    this.entries.push(entry);
  }

  // find a parent by name; prefer the same type, then same vendor, then Orca's shared library
  lookup(name, type, vendor) {
    const list = (this.byName.get(name) || []).filter((e) => !type || e.type === type);
    if (!list.length) return null;
    return (
      list.find((e) => e.origin === 'user') ||
      list.find((e) => vendor && e.vendor === vendor) ||
      list.find((e) => e.vendor === 'OrcaFilamentLibrary') ||
      list[0]
    );
  }

  // returns [leaf, parent, grandparent, ...]
  chain(entry) {
    const out = [entry];
    let cur = entry;
    let vendor = entry.vendor;
    for (let i = 0; i < 30; i++) {
      const parentName = cur.data.inherits;
      if (!parentName) break;
      const parent = this.lookup(parentName, entry.type, vendor);
      if (!parent || out.includes(parent)) {
        if (!parent) out.missing = parentName;
        break;
      }
      out.push(parent);
      vendor = parent.vendor || vendor;
      cur = parent;
    }
    return out;
  }

  // one complete settings object for this preset
  flatten(entry) {
    const chain = this.chain(entry);
    if (chain.missing) {
      throw new Error(`Preset "${entry.name}" needs "${chain.missing}", which couldn't be found.`);
    }
    const merged = {};
    for (let i = chain.length - 1; i >= 0; i--) Object.assign(merged, chain[i].data);
    return merged;
  }

  // the first Orca built-in (system) printer/process this preset is based on
  systemAncestor(entry) {
    return this.chain(entry).find((e) => e.origin === 'system' && e.data.instantiation !== 'false') || null;
  }

  // presets that show up in Orca's dropdowns
  selectable(type) {
    return this.entries.filter(
      (e) => e.type === type && (e.origin === 'user' || String(e.data.instantiation) === 'true')
    );
  }
}

// turn a flattened preset into a file Orca's command line accepts
function toCliPreset(flat, type, name) {
  const out = { ...flat };
  for (const k of META_KEYS) delete out[k];
  out.type = type;
  out.name = name;
  out.from = 'User';
  if (!out.version) out.version = '1.0.0.0';
  return out;
}

module.exports = { ProfileIndex, toCliPreset };
