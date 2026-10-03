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

## How slicing works

EasyPrint finds OrcaSlicer and uses the printer and filament profiles already set up in it
(the ones last selected in Orca are preferred). It starts from Orca's own tested print profile
for the printer and changes only a few settings for each choice. The recipes live in
`lib/recipes.js`. If something goes wrong, the error box has **Show details** and
**Open job folder**, which holds `orca-log.txt` to send to Claude.

## Progress

- [x] Step 1 – Open a model and see it on the bed (size, fit check, resize, turn)
- [x] Step 2 – Preset buttons, sliced by OrcaSlicer in the background, save G-code
- [ ] Step 3 – Layer preview
- [x] Step 4 – One-button USB printing with temperatures, progress, pause and stop (replaces Pronterface)
- [ ] Step 5 – "Ask" box powered by a local Ollama model
