"""Turns the click library in Assets/ClickSamples into the app's bundled click sounds.

    processing/.venv/bin/python scripts/prepare_clicks.py

Reads   Assets/ClickSamples/New Click -  Classic-<role>.wav   (1 s, stereo, one hit + silence)
Writes  src/renderer/src/assets/clicks/<role>.wav

The app uses one kit (Classic). Changing the click sound means re-rendering the whole
click track, so a single fixed sound keeps it simple. To switch kits, change KIT.

Each output is mono (the sources have identical channels), 44.1 kHz 16-bit,
starts on the hit's first sample, is 250 ms long with a short fade-out, and is
normalized to peak at PEAK_DBFS (the sources sit around -4.6 dBFS, too quiet
against a mastered song).
Files: quarter, eighth, sixteenth (the kit's own accent sound isn't used). Which file
plays for which click is set by CLICK_SOUNDS in src/renderer/src/audio/grid.js.
"""

import glob
import os
import re
import shutil

import numpy as np
import soundfile as sf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE_DIR = os.path.join(ROOT, "Assets", "ClickSamples")
OUTPUT_DIR = os.path.join(ROOT, "src", "renderer", "src", "assets", "clicks")

KIT = "Classic"
SAMPLE_RATE = 44100
PEAK_DBFS = -1.0
LENGTH_SEC = 0.25
FADE_SEC = 0.01
# The hit starts at the first sample louder than this (-60 dBFS)
ONSET_THRESHOLD = 10 ** (-60 / 20)

NAME = re.compile(r"^New Click -\s+(?P<kit>[A-Za-z]+)-(?P<role>accents|quarter|eighth|sixteenth)\.wav$")
ROLE_NAMES = {"quarter": "quarter", "eighth": "eighth", "sixteenth": "sixteenth"}


def prepare(path):
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    if sr != SAMPLE_RATE:
        raise ValueError(f"{path}: expected {SAMPLE_RATE} Hz, got {sr}")
    mono = audio.mean(axis=1)

    above = np.nonzero(np.abs(mono) > ONSET_THRESHOLD)[0]
    if len(above) == 0:
        raise ValueError(f"{path}: silent")
    length = int(LENGTH_SEC * SAMPLE_RATE)
    clip = np.zeros(length, dtype=np.float32)
    hit = mono[above[0] : above[0] + length]
    clip[: len(hit)] = hit

    fade = int(FADE_SEC * SAMPLE_RATE)
    clip[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)
    clip *= 10 ** (PEAK_DBFS / 20) / np.abs(clip).max()
    return clip, above[0]


def main():
    shutil.rmtree(OUTPUT_DIR, ignore_errors=True)
    os.makedirs(OUTPUT_DIR)
    written = []
    for path in sorted(glob.glob(os.path.join(SOURCE_DIR, "*.wav"))):
        match = NAME.match(os.path.basename(path))
        if not match or match["kit"] != KIT or match["role"] not in ROLE_NAMES:
            continue
        role = ROLE_NAMES[match["role"]]
        clip, trimmed = prepare(path)
        sf.write(os.path.join(OUTPUT_DIR, f"{role}.wav"), clip, SAMPLE_RATE, subtype="PCM_16")
        written.append(f"{role} (trimmed {trimmed / SAMPLE_RATE * 1000:.1f} ms)")

    missing = set(ROLE_NAMES.values()) - {w.split()[0] for w in written}
    if missing:
        raise SystemExit(f"{KIT} kit is missing: {', '.join(sorted(missing))}")
    print(f"{KIT}: {', '.join(written)}")


if __name__ == "__main__":
    main()
