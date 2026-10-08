// The "Ask" box: a local Ollama model reads her description and picks
// from EasyPrint's own menu (preset + extras). It can only choose from that
// menu, so it can't produce settings that would wreck a print.

const { RECIPES, TOGGLES } = require('./recipes');

const OLLAMA = process.env.EASYPRINT_OLLAMA || 'http://127.0.0.1:11434';
// best first; the first one installed is used unless she picks another in Printer setup
const PREFERRED = ['qwen2.5:14b', 'qwen3:14b', 'qwen2.5:7b', 'qwen3:8b', 'llama3.1:8b', 'gemma3:12b', 'mistral-nemo'];

async function getJson(path, opts = {}, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(OLLAMA + path, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`Ollama said ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function listModels() {
  try {
    const d = await getJson('/api/tags');
    return (d.models || []).map((m) => m.name).filter((n) => !/embed/i.test(n));
  } catch { return null; } // null = Ollama isn't running
}

function pickModel(installed, wanted) {
  if (!installed?.length) return null;
  if (wanted && installed.includes(wanted)) return wanted;
  const base = (n) => n.replace(/:latest$/, '');
  for (const p of PREFERRED) {
    const hit = installed.find((n) => base(n) === p || n.startsWith(p));
    if (hit) return hit;
  }
  return installed[0];
}

async function status(wanted) {
  const models = await listModels();
  return { running: models !== null, models: models || [], model: pickModel(models, wanted) };
}

const SCHEMA = {
  type: 'object',
  properties: {
    recipe: { type: 'string', enum: Object.keys(RECIPES) },
    supports: { type: 'boolean' },
    stronger: { type: 'boolean' },
    stick: { type: 'boolean' },
    smoothTop: { type: 'boolean' },
    suggestPETG: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['recipe', 'supports', 'stronger', 'stick', 'smoothTop', 'suggestPETG', 'reason'],
};

function buildPrompt({ description, fileName, size, overhangPct, footprintPct, material }) {
  const recipes = Object.entries(RECIPES).map(([id, r]) => `- "${id}": ${r.label}. ${r.blurb}`).join('\n');
  return `You help a beginner choose 3D print settings on an Ender-3 V3 SE. Pick from the menu only.

Choices for "recipe":
${recipes}

Extras (true/false):
- supports: needed when parts hang in the air or overhang steeply (overhang area above ~4% usually needs them; jaws, arms, horns, chins, bridges between towers). Not needed for flat-bottomed simple shapes.
- stronger: for parts that hold weight, get handled a lot, screw together, or flex (hooks, brackets, clips, mounts, tools).
- stick: for tall thin parts, small footprints, or anything that might lift or tip (footprint under ~15% of its height area, or tall and narrow).
- smoothTop: only for decorations with a large flat top that people will see. Adds time.
- suggestPETG: true only if PLA is loaded AND it will be outdoors, in a car, near heat, or in a dishwasher. Always false if PETG is loaded.
- With PETG loaded, lean towards "stick" for anything with a small footprint (PETG lifts more easily).

Rules: decorative/display items -> "decoration". Things that do a job -> "sturdy". "Test", "draft", "check the fit/size", "quick", or "fast" -> "quick". Keep extras off unless there is a reason.
Write "reason" as one short friendly sentence for a beginner, no jargon, no numbers.

The model:
- Filament loaded in the printer: ${material === 'PETG' ? 'PETG' : 'PLA'}
- File name: ${fileName || 'unknown'}
- Size: ${size} mm (wide x deep x tall)
- Overhang area: ${overhangPct}% of the surface faces downward without support
- Footprint on the bed: ${footprintPct}% of the model's widest outline

What she said about it: "${String(description || '').slice(0, 500)}"`;
}

async function ask(input, wantedModel) {
  const st = await status(wantedModel);
  if (!st.running) throw new Error('Ollama isn’t running on this computer.');
  if (!st.model) throw new Error('Ollama has no models installed yet. See Printer setup.');

  const body = {
    model: st.model,
    stream: false,
    think: false,
    format: SCHEMA,
    options: { temperature: 0 },
    keep_alive: '15m',
    messages: [{ role: 'user', content: buildPrompt(input) }],
  };
  // first use loads the model into memory, which can take a while
  const d = await getJson('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 120000);
  let raw = d.message?.content || '';
  raw = raw.replace(/^[\s\S]*?(\{)/, '$1').replace(/\}[^}]*$/, '}'); // in case it wraps the JSON in text
  let out;
  try { out = JSON.parse(raw); } catch { throw new Error('The AI gave an answer EasyPrint couldn’t read. Try again.'); }
  const result = clean(out);
  if (input.material === 'PETG') result.suggestPETG = false;
  return { ...result, model: st.model };
}

// never trust the model: keep only known choices
function clean(o) {
  const recipe = Object.keys(RECIPES).includes(o.recipe) ? o.recipe : 'sturdy';
  const toggles = Object.keys(TOGGLES).filter((k) => o[k] === true);
  return {
    recipe,
    toggles,
    suggestPETG: o.suggestPETG === true,
    reason: String(o.reason || '').slice(0, 240),
  };
}

module.exports = { ask, status, clean, buildPrompt, SCHEMA, PREFERRED };
