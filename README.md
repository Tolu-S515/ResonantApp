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
(run the built app), `npm run lint`.

## Audio processing setup

Requires Python 3.10+ and ffmpeg.

```bash
python3 -m venv processing/.venv
processing/.venv/bin/pip install -r processing/requirements.txt
```

Test stem separation:

```bash
processing/.venv/bin/python -m demucs -n htdemucs_6s -o processing/separated path/to/song.wav
```
