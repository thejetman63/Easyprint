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

## Progress

- [x] Step 1 – Open a model and see it on the bed (size, fit check, resize, turn)
- [ ] Step 2 – Preset buttons, sliced by OrcaSlicer in the background
- [ ] Step 3 – Layer preview
- [ ] Step 4 – One-button USB printing with temperatures and progress
- [ ] Step 5 – "Ask" box powered by a local Ollama model
