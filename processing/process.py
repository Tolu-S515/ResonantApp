"""Session processing: normalize the user's file, analyze it, then split it into stems.

Usage:
    python process.py --input <original file> --output-dir <session folder> [--skip-separation]

Writes into <output-dir>:
    reference.wav          44.1kHz stereo 16-bit PCM, input to every later step
    stems/<name>.wav       drums, bass, other, vocals, guitar, piano (Demucs htdemucs_6s)
    peaks/<name>.json      waveform overview for reference and each stem (see write_peaks)

stdout carries only JSON lines, one message per line, for the Electron main process:
    {"type": "progress", "stage": "normalizing" | "analyzing" | "separating", "percent"?: 0-100}
    {"type": "reference", "reference": "reference.wav", "peaks": "peaks/reference.json"}
                                                sent as soon as the reference is playable
    {"type": "analysis", "analysis": {...}}     sent as soon as analysis finishes
    {"type": "result", "stems": {"drums": "stems/drums.wav", ...}, "peaks": {"drums": "peaks/drums.json", ...}}
    {"type": "error", "message": "..."}
Anything diagnostic goes to stderr.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

SAMPLE_RATE = 44100
DEMUCS_MODEL = "htdemucs_6s"
# One min/max pair per 512 samples: ~86 pairs per second, ~20k for a 4-minute song.
# Enough detail to zoom in a few times before the waveform looks blocky.
SAMPLES_PER_PEAK = 512


def emit(message):
    print(json.dumps(message), flush=True)


def normalize(input_path, output_dir):
    """Convert any supported input (mp3, m4a, mp4 video, ...) to the reference WAV.

    Every later step (analysis, Demucs, reference playback) reads this one file,
    so all tracks stay sample-aligned.
    """
    final_path = os.path.join(output_dir, "reference.wav")
    tmp_path = os.path.join(output_dir, "reference.tmp.wav")
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error",
            "-i", input_path,
            "-vn",                  # drop any video stream (mp4)
            "-ac", "2",             # stereo
            "-ar", str(SAMPLE_RATE),
            "-c:a", "pcm_s16le",
            tmp_path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    # Rename only once complete, so a crash never leaves a truncated reference.wav
    os.replace(tmp_path, final_path)
    return final_path


def analyze(reference_path):
    # Imported here so --help and ffmpeg errors don't pay Essentia's import cost
    import essentia
    import essentia.standard as es

    # Essentia logs to stdout by default, which would corrupt the JSON protocol
    essentia.log.infoActive = False
    essentia.log.warningActive = False

    audio = es.MonoLoader(filename=reference_path, sampleRate=SAMPLE_RATE)()
    duration_sec = len(audio) / SAMPLE_RATE

    bpm, beats, beats_confidence, _, _ = es.RhythmExtractor2013(method="multifeature")(audio)
    key, scale, key_strength = es.KeyExtractor(sampleRate=SAMPLE_RATE)(audio)

    return {
        "bpm": round(float(bpm), 1),
        # multifeature confidence: roughly 0-5.3; above ~3.5 is very reliable
        "bpmConfidence": round(float(beats_confidence), 2),
        "beats": [round(float(t), 4) for t in beats],
        "key": key,
        "scale": scale,
        "keyStrength": round(float(key_strength), 2),
        "durationSec": round(duration_sec, 3),
    }


class _JsonProgress:
    """Stands in for the tqdm module inside demucs.apply.

    Demucs wraps its list of audio chunks in tqdm.tqdm(...) to draw a terminal
    progress bar; this yields the same chunks and emits JSON progress instead.
    """

    @staticmethod
    def tqdm(iterable, **_kwargs):
        chunks = list(iterable)
        last_percent = -1
        for i, chunk in enumerate(chunks):
            yield chunk
            # Resumes after the caller has finished processing this chunk
            percent = int((i + 1) * 100 / len(chunks))
            if percent != last_percent:
                emit({"type": "progress", "stage": "separating", "percent": percent})
                last_percent = percent


def compute_peaks(samples):
    """Waveform overview of (frames, channels) float audio in [-1, 1].

    Returns a flat list [min0, max0, min1, max1, ...] with one pair per SAMPLES_PER_PEAK
    frames, taken across all channels and scaled to integers in [-127, 127].
    """
    import numpy as np

    frames = samples.shape[0]
    count = -(-frames // SAMPLES_PER_PEAK)  # ceil
    if count == 0:
        return []
    # Pad the last block with silence so every block has the same length
    padded = np.zeros((count * SAMPLES_PER_PEAK, samples.shape[1]), dtype=np.float32)
    padded[:frames] = samples
    blocks = padded.reshape(count, -1)
    pairs = np.stack([blocks.min(axis=1), blocks.max(axis=1)], axis=1)
    return np.clip(np.round(pairs * 127), -127, 127).astype(int).ravel().tolist()


def write_peaks(samples, output_dir, name):
    """Writes peaks/<name>.json and returns its path relative to the session folder."""
    peaks_dir = os.path.join(output_dir, "peaks")
    os.makedirs(peaks_dir, exist_ok=True)
    data = compute_peaks(samples)
    content = {
        "version": 1,
        "sampleRate": SAMPLE_RATE,
        "samplesPerPeak": SAMPLES_PER_PEAK,
        "length": len(data) // 2,
        "data": data,
    }
    final_path = os.path.join(peaks_dir, f"{name}.json")
    tmp_path = f"{final_path}.tmp"
    with open(tmp_path, "w") as f:
        json.dump(content, f, separators=(",", ":"))
    os.replace(tmp_path, final_path)
    return f"peaks/{name}.json"


def reference_peaks(reference_path, output_dir):
    import soundfile as sf

    audio, _ = sf.read(reference_path, dtype="float32", always_2d=True)
    return write_peaks(audio, output_dir, "reference")


def separate(reference_path, output_dir):
    import certifi

    # python.org builds on macOS ship without CA certificates; needed if the model isn't cached yet
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())

    import soundfile as sf
    import torch
    import demucs.apply
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    demucs.apply.tqdm = _JsonProgress

    model = get_model(DEMUCS_MODEL)
    model.eval()

    audio, sr = sf.read(reference_path, dtype="float32", always_2d=True)
    mix = torch.from_numpy(audio.T.copy())  # (channels, samples)

    # Same input normalization as the Demucs CLI
    mono = mix.mean(0)
    mean, std = mono.mean(), mono.std()
    std = std if std > 0 else torch.tensor(1.0)  # silent input
    mix = (mix - mean) / std

    emit({"type": "progress", "stage": "separating", "percent": 0})
    with torch.no_grad():
        # split=True processes overlapping ~8s chunks, so memory stays bounded for long songs
        sources = apply_model(model, mix[None], device="cpu", shifts=1, split=True, overlap=0.25, progress=True)[0]
    sources = sources * std + mean

    # Separated stems can peak above full scale. Scale all stems by the same factor
    # (instead of each on its own) so they still sum back to the original mix.
    peak = float(sources.abs().max())
    if peak > 0.99:
        sources = sources * (0.99 / peak)

    # Write to a temp folder and swap it in only when every stem is complete
    final_dir = os.path.join(output_dir, "stems")
    tmp_dir = os.path.join(output_dir, "stems.tmp")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir)

    stems = {}
    for name, source in zip(model.sources, sources):
        sf.write(os.path.join(tmp_dir, f"{name}.wav"), source.numpy().T, sr, subtype="PCM_16")
        stems[name] = f"stems/{name}.wav"

    shutil.rmtree(final_dir, ignore_errors=True)
    os.replace(tmp_dir, final_dir)

    peaks = {name: write_peaks(source.numpy().T, output_dir, name) for name, source in zip(model.sources, sources)}
    return stems, peaks


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--skip-separation", action="store_true", help="stop after analysis (for tests)")
    args = parser.parse_args()

    try:
        emit({"type": "progress", "stage": "normalizing"})
        reference_path = normalize(args.input, args.output_dir)
        emit({
            "type": "reference",
            "reference": "reference.wav",
            "peaks": reference_peaks(reference_path, args.output_dir),
        })

        emit({"type": "progress", "stage": "analyzing"})
        emit({"type": "analysis", "analysis": analyze(reference_path)})

        stems, peaks = ({}, {}) if args.skip_separation else separate(reference_path, args.output_dir)
        emit({"type": "result", "stems": stems, "peaks": peaks})
    except subprocess.CalledProcessError as err:
        detail = (err.stderr or "").strip().splitlines()
        emit({"type": "error", "message": f"Could not read audio file: {detail[-1] if detail else 'ffmpeg failed'}"})
        sys.exit(1)
    except Exception as err:  # report anything else instead of dying silently
        emit({"type": "error", "message": f"{type(err).__name__}: {err}"})
        sys.exit(1)


if __name__ == "__main__":
    main()
