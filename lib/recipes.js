// The "what is it?" choices and the plain-English toggles, translated into
// OrcaSlicer settings. Everything starts from Orca's own tested profile for
// the printer; these only change a handful of values on top.

const RECIPES = {
  decoration: {
    label: 'Decoration',
    blurb: 'Looks its best. Fine layers, slower.',
    layerHeight: 0.12,
    settings: {
      wall_loops: '3',
      sparse_infill_density: '10%',
      sparse_infill_pattern: 'gyroid',
      seam_position: 'back',
    },
  },
  sturdy: {
    label: 'Sturdy part',
    blurb: 'Strong enough to use. Hooks, holders, brackets.',
    layerHeight: 0.2,
    settings: {
      wall_loops: '4',
      sparse_infill_density: '35%',
      sparse_infill_pattern: 'gyroid',
      top_shell_layers: '5',
      bottom_shell_layers: '5',
    },
  },
  quick: {
    label: 'Quick test',
    blurb: 'Fast and rough. Check the size or fit.',
    layerHeight: 0.24,
    settings: {
      wall_loops: '2',
      sparse_infill_density: '10%',
    },
  },
};

const TOGGLES = {
  supports: {
    label: 'Add supports',
    hint: 'For parts that hang out in the air',
    apply: (s) => {
      s.enable_support = '1';
      s.support_type = 'tree(auto)';
      s.support_on_build_plate_only = '0';
    },
  },
  stronger: {
    label: 'Make it stronger',
    hint: 'Thicker walls and more inside',
    apply: (s) => {
      s.wall_loops = String(Number(s.wall_loops || 2) + 2);
      const infill = parseFloat(s.sparse_infill_density || '15') || 15;
      s.sparse_infill_density = `${Math.min(infill + 20, 80)}%`;
    },
  },
  stick: {
    label: 'Help it stick',
    hint: 'Adds a thin rim so it won’t lift or tip',
    apply: (s) => {
      s.brim_type = 'outer_only';
      s.brim_width = '5';
    },
  },
  smoothTop: {
    label: 'Smoother top',
    hint: 'Irons the top flat. Adds time',
    apply: (s) => {
      s.ironing_type = 'top';
    },
  },
};

const MATERIALS = {
  PLA: { label: 'PLA', blurb: 'Everyday filament' },
  PETG: { label: 'PETG', blurb: 'Tougher, handles heat' },
};

// apply a recipe + toggles to a flattened base process
function applyChoices(baseProcess, recipeId, toggleIds = []) {
  const recipe = RECIPES[recipeId];
  if (!recipe) throw new Error(`Unknown choice: ${recipeId}`);
  const s = { ...baseProcess, ...recipe.settings };
  for (const id of toggleIds) TOGGLES[id]?.apply(s);
  return s;
}

// what the window needs to draw the buttons
function describe() {
  const pick = (obj, keys) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Object.fromEntries(keys.map((x) => [x, v[x]]))]));
  return {
    recipes: pick(RECIPES, ['label', 'blurb']),
    toggles: pick(TOGGLES, ['label', 'hint']),
    materials: MATERIALS,
  };
}

module.exports = { RECIPES, TOGGLES, MATERIALS, applyChoices, describe };
