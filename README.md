# EasyPrint

A simple 3D printing app for our Ender-3 V3 SE. Pick a model, pick what it is, press Print.
OrcaSlicer does the slicing in the background.

## Setup on Windows (one time)

1. Install **Node.js LTS** from https://nodejs.org
2. Install **GitHub Desktop** from https://desktop.github.com, sign in, then
   *File → Clone repository* → `easyprint`.
3. Open the cloned folder and double-click **Start EasyPrint.bat**.
   The first run takes a minute to set up.

To get updates: open GitHub Desktop, click **Fetch origin**, then **Pull**, and start the app again.

## The "Tell me what it is" box

Install Ollama from https://ollama.com, then in a command window run `ollama pull qwen2.5:14b`.
The box appears automatically while Ollama is running. The AI only picks from EasyPrint's own
menu (preset + extras), so it can't produce settings that would wreck a print.

## How slicing works

EasyPrint finds OrcaSlicer and uses the printer and filament profiles already set up in it
(the ones last selected in Orca are preferred). It starts from Orca's own tested print profile
for the printer and changes only a few settings for each choice. The recipes live in
`lib/recipes.js`. If something goes wrong, the error box has **Show details** and
**Open job folder**, which holds `orca-log.txt` to send to Claude.

## Printer controls

**↕ Controls** (top right), for when a print goes wrong: raise/lower the nozzle (50/10/1 mm),
heaters off, fan on, bring the bed forward, home (asks first), motors off. Only works when nothing
is printing. Raising never goes above 245 mm or below 0.3 mm. If the printer was just restarted and
doesn't know its height, raising still works (measured from where it stopped); lowering and moving
the bed need a Home first. After a print is stopped or fails, the print panel shows quick fixes.

## Bed setup

**▦ Bed setup** (top right):
- **Z-offset:** save your value (e.g. -2.07). EasyPrint checks the printer before every print and
  after measuring the bed, and puts it back if leveling changed it. Values outside -5 to 1 are refused.
- **Bed level:** *Check my bed* reads the mesh the printer already has; *Measure again* heats the bed,
  homes and re-probes. You get a colour map, a verdict, and corner-by-corner knob instructions,
  with a before/after map.
- **Printer details:** read-only dump of M115 / M503 / M851 / M420 V for troubleshooting.

## Progress

- [x] Step 1 – Open a model and see it on the bed (size, fit check, resize, turn)
- [x] Step 2 – Preset buttons, sliced by OrcaSlicer in the background, save G-code
- [ ] Step 3 – Layer preview
- [x] Step 4 – One-button USB printing with temperatures, progress, pause and stop (replaces Pronterface)
- [x] Step 5 – "Tell me what it is" box powered by a local Ollama model
- [x] Bed setup – keep my Z-offset, bed mesh map with knob instructions
