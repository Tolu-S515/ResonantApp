# Resonant

Desktop practice app for musicians: split a song into stems and play along.
Electron (React UI + Node main process) with a Python sidecar for Demucs.

## Structure

- `src/main/` — Electron main process (Node): windows, file dialogs, IPC handlers
- `src/preload/` — bridge exposing a safe API to the UI as `window.resonant`
- `src/renderer/` — React UI (Vite)
- `processing/` — Python audio processing (Demucs 6-stem separation)
- `Assets/` — design assets

The UI never touches Node directly; it calls `window.resonant.*`, which goes
over IPC to handlers registered with `ipcMain.handle` in `src/main/index.js`.

## Getting started

```bash
npm install
npm run dev     # opens the app with hot reload
```

- Renderer (React) changes hot-reload in the window.
- Main and preload changes restart Electron automatically.
- Renderer DevTools: Cmd+Opt+I. Main process logs go to the terminal.

If `npm run dev` fails with `Electron uninstall`, the Electron binary didn't
download during install. Run `node node_modules/electron/install.js`.

Other scripts: `npm run build` (compile to `out/`), `npm run preview`
(run the built app), `npm run lint`, `npm test` (Vitest; `npm run test:watch`
to re-run on save). Tests live next to the code they test as `*.test.js`.

## Audio processing setup

Requires Python 3.10+ and ffmpeg.

```bash
python3 -m venv processing/.venv
processing/.venv/bin/pip install -r processing/requirements.txt
```

`processing/process.py` is spawned by the main process after a song is imported.
It converts the song to `reference.wav`, detects BPM, beats, key and duration,
then splits it into six stems with Demucs (`stems/`), reporting progress as JSON
lines on stdout. Run it by hand with (add `--skip-separation` to stop after analysis):

```bash
processing/.venv/bin/python processing/process.py --input song.mp3 --output-dir some/folder
```

Python tests (synthesized audio with a known tempo and key):

```bash
processing/.venv/bin/python -m unittest discover processing
```

Test stem separation:

```bash
processing/.venv/bin/python -m demucs -n htdemucs_6s -o processing/separated path/to/song.wav
```
