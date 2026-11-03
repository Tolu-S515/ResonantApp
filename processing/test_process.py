"""End-to-end tests for process.py on synthesized audio with a known tempo and key.

Run from the project root:
    processing/.venv/bin/python -m unittest discover processing
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf

SCRIPT = os.path.join(os.path.dirname(__file__), "process.py")
SR = 44100
BPM = 120
DURATION = 30.0

# Chord tones as MIDI notes: a I-IV-V-I progression in C major, one chord per bar
PROGRESSION = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]]


def midi_to_hz(note):
    return 440.0 * 2 ** ((note - 69) / 12)


def synthesize_song():
    """Kick drum on every beat over a looping C major chord progression."""
    t = np.arange(int(SR * DURATION)) / SR
    audio = np.zeros_like(t)

    # Chords: a few harmonics per note so it reads as a pitched instrument
    bar_sec = 4 * 60 / BPM
    for i in range(int(DURATION / bar_sec)):
        start, end = int(i * bar_sec * SR), int((i + 1) * bar_sec * SR)
        seg = t[start:end] - t[start]
        for note in PROGRESSION[i % len(PROGRESSION)]:
            f = midi_to_hz(note)
            for harmonic, amp in [(1, 1.0), (2, 0.5), (3, 0.25)]:
                audio[start:end] += 0.08 * amp * np.sin(2 * np.pi * f * harmonic * seg)

    # Kick: a short pitch-dropping sine burst on each beat
    beat_sec = 60 / BPM
    kick_t = np.arange(int(0.12 * SR)) / SR
    kick = np.sin(2 * np.pi * (60 + 90 * np.exp(-kick_t * 40)) * kick_t) * np.exp(-kick_t * 30)
    for i in range(int(DURATION / beat_sec)):
        start = int(i * beat_sec * SR)
        audio[start : start + len(kick)] += 0.9 * kick[: len(audio) - start]

    audio /= np.max(np.abs(audio))
    return np.stack([audio, audio], axis=1) * 0.8


def run_process(input_path, output_dir, *extra_args):
    proc = subprocess.run(
        [sys.executable, SCRIPT, "--input", input_path, "--output-dir", output_dir, *extra_args],
        capture_output=True,
        text=True,
    )
    messages = [json.loads(line) for line in proc.stdout.splitlines()]
    return proc.returncode, messages


def analysis_of(messages):
    return next(m["analysis"] for m in messages if m["type"] == "analysis")


class AnalysisTest(unittest.TestCase):
    """Normalization and analysis only; Demucs is skipped to keep these fast."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.wav_path = os.path.join(cls.tmp.name, "song.wav")
        sf.write(cls.wav_path, synthesize_song(), SR, subtype="PCM_16")

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def process(self, input_path):
        out = tempfile.mkdtemp(dir=self.tmp.name)
        code, messages = run_process(input_path, out, "--skip-separation")
        self.assertEqual(code, 0, messages)
        return out, messages

    def test_protocol_messages_in_order(self):
        _, messages = self.process(self.wav_path)
        self.assertEqual(
            [(m["type"], m.get("stage")) for m in messages],
            [
                ("progress", "normalizing"),
                ("reference", None),
                ("progress", "analyzing"),
                ("analysis", None),
                ("result", None),
            ],
        )

    def test_writes_reference_peaks(self):
        out, messages = self.process(self.wav_path)
        reference = next(m for m in messages if m["type"] == "reference")
        self.assertEqual(reference, {"type": "reference", "reference": "reference.wav", "peaks": "peaks/reference.json"})

        with open(os.path.join(out, "peaks", "reference.json")) as f:
            peaks = json.load(f)
        frames = sf.info(os.path.join(out, "reference.wav")).frames
        spp = peaks["samplesPerPeak"]
        self.assertEqual(peaks["sampleRate"], SR)
        self.assertEqual(peaks["length"], -(-frames // spp))
        self.assertEqual(len(peaks["data"]), 2 * peaks["length"])

        data = np.array(peaks["data"]).reshape(-1, 2)
        self.assertTrue(np.all(data[:, 0] <= data[:, 1]), "min must not exceed max")
        self.assertTrue(np.all(np.abs(data) <= 127))
        # Matches the audio: the loudest block reaches the file's actual peak
        audio, _ = sf.read(os.path.join(out, "reference.wav"))
        self.assertAlmostEqual(np.abs(data).max() / 127, np.abs(audio).max(), delta=0.02)
        self.assertFalse(os.path.exists(os.path.join(out, "peaks", "reference.json.tmp")))

    def test_detects_tempo_key_and_duration(self):
        _, messages = self.process(self.wav_path)
        analysis = analysis_of(messages)

        self.assertAlmostEqual(analysis["bpm"], BPM, delta=2)
        self.assertEqual((analysis["key"], analysis["scale"]), ("C", "major"))
        self.assertAlmostEqual(analysis["durationSec"], DURATION, delta=0.01)

        # Beats should be evenly spaced at the tempo
        intervals = np.diff(analysis["beats"])
        self.assertAlmostEqual(float(np.median(intervals)), 60 / BPM, delta=0.02)

    def test_writes_normalized_reference_wav(self):
        out, _ = self.process(self.wav_path)
        info = sf.info(os.path.join(out, "reference.wav"))
        self.assertEqual((info.samplerate, info.channels, info.subtype), (SR, 2, "PCM_16"))
        self.assertFalse(os.path.exists(os.path.join(out, "reference.tmp.wav")))

    def test_compressed_input_keeps_duration(self):
        # AAC adds encoder delay/padding; the reference should still match the song length
        m4a_path = os.path.join(self.tmp.name, "song.m4a")
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", self.wav_path, "-c:a", "aac", "-b:a", "192k", m4a_path],
            check=True,
        )
        out, messages = self.process(m4a_path)
        analysis = analysis_of(messages)
        self.assertAlmostEqual(analysis["durationSec"], DURATION, delta=0.05)
        self.assertAlmostEqual(analysis["bpm"], BPM, delta=2)

    def test_reports_unreadable_file_as_error(self):
        bad_path = os.path.join(self.tmp.name, "not-audio.mp3")
        with open(bad_path, "w") as f:
            f.write("this is not audio")

        out = tempfile.mkdtemp(dir=self.tmp.name)
        code, messages = run_process(bad_path, out, "--skip-separation")

        self.assertEqual(code, 1)
        self.assertEqual(messages[-1]["type"], "error")
        self.assertTrue(messages[-1]["message"].startswith("Could not read audio file"))
        self.assertFalse(os.path.exists(os.path.join(out, "reference.wav")))


class SeparationTest(unittest.TestCase):
    """Runs the real Demucs model once on a short clip (~15-20s on an Intel CPU)."""

    STEMS = {"drums", "bass", "other", "vocals", "guitar", "piano"}

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = cls.tmp.name
        song = synthesize_song()[: 8 * SR]
        input_path = os.path.join(cls.out, "original.wav")
        sf.write(input_path, song, SR, subtype="PCM_16")
        cls.code, cls.messages = run_process(input_path, cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_succeeds_and_lists_all_six_stems(self):
        self.assertEqual(self.code, 0, self.messages)
        result = self.messages[-1]
        self.assertEqual(result["type"], "result")
        self.assertEqual(result["stems"], {name: f"stems/{name}.wav" for name in self.STEMS})
        self.assertEqual(result["peaks"], {name: f"peaks/{name}.json" for name in self.STEMS})

    def test_writes_peaks_for_every_stem(self):
        reference_frames = sf.info(os.path.join(self.out, "reference.wav")).frames
        for name in self.STEMS:
            with open(os.path.join(self.out, "peaks", f"{name}.json")) as f:
                peaks = json.load(f)
            self.assertEqual(peaks["length"], -(-reference_frames // peaks["samplesPerPeak"]), name)

    def test_sends_analysis_before_separation_starts(self):
        types = [(m["type"], m.get("stage")) for m in self.messages]
        self.assertLess(types.index(("analysis", None)), types.index(("progress", "separating")))

    def test_reports_increasing_progress_up_to_100(self):
        percents = [m["percent"] for m in self.messages if m.get("stage") == "separating"]
        self.assertEqual(percents[0], 0)
        self.assertEqual(percents[-1], 100)
        self.assertEqual(percents, sorted(percents))

    def test_stems_match_the_reference_format_and_length(self):
        reference = sf.info(os.path.join(self.out, "reference.wav"))
        for name in self.STEMS:
            info = sf.info(os.path.join(self.out, "stems", f"{name}.wav"))
            self.assertEqual((info.samplerate, info.channels, info.frames), (SR, 2, reference.frames), name)

    def test_stems_sum_back_to_the_mix(self):
        # Demucs isn't exactly additive, but the stems should reconstruct the mix closely
        mix, _ = sf.read(os.path.join(self.out, "reference.wav"))
        total = sum(sf.read(os.path.join(self.out, "stems", f"{name}.wav"))[0] for name in self.STEMS)
        residual = np.sqrt(np.mean((total - mix) ** 2)) / np.sqrt(np.mean(mix**2))
        self.assertLess(residual, 0.1)

    def test_leaves_no_temp_folder(self):
        self.assertFalse(os.path.exists(os.path.join(self.out, "stems.tmp")))


if __name__ == "__main__":
    unittest.main()
