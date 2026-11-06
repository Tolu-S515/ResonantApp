#!/bin/sh
# One-time setup for a fresh clone (run with: npm run setup).
# Installs the JavaScript and Python dependencies and builds the two native parts:
# the audio engine (C++, CoreAudio) and the chord detector (Chordino).
set -e
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nSetup stopped: %s\n' "$1" >&2; exit 1; }

step 'Checking requirements'
[ "$(uname)" = Darwin ] || fail 'Resonant runs on macOS only (the audio engine uses CoreAudio).'
xcode-select -p >/dev/null 2>&1 || fail 'Install the Xcode command line tools: xcode-select --install'
command -v node >/dev/null || fail 'Install Node.js 20 or newer.'
PYTHON=${PYTHON:-python3}
command -v "$PYTHON" >/dev/null || fail 'Install Python 3.10 or 3.11.'
command -v ffmpeg >/dev/null || fail 'Install ffmpeg: brew install ffmpeg'
ffmpeg -hide_banner -filters 2>/dev/null | grep -q rubberband ||
  echo "Warning: this ffmpeg has no Rubber Band, so key changes won't work. Homebrew's ffmpeg has it."

step 'Installing JavaScript packages'
npm install

step 'Installing Python packages (PyTorch and Demucs are large, this takes a while)'
[ -d processing/.venv ] || "$PYTHON" -m venv processing/.venv
processing/.venv/bin/pip install --upgrade pip
processing/.venv/bin/pip install -r processing/requirements.txt

step 'Building the audio engine'
npm run build:native

step 'Building chord detection'
npm run build:chordino

printf '\nDone. Start the app with: npm run dev\n'
