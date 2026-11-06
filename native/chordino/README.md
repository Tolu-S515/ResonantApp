# chordino

Chord detection for processing: a small command-line tool with
[Chordino](https://github.com/c4dm/nnls-chroma) built in. `processing/process.py`
pipes it the summed harmonic stems and reads back the chord changes.

Build with `npm run build:chordino` (output: `build/chordino`).

## Vendored sources

| Folder | Source | Licence |
|---|---|---|
| `nnls-chroma/` | [c4dm/nnls-chroma](https://github.com/c4dm/nnls-chroma) @ `4c5f214a`, Chordino files only | GPL v2 or later (`nnls-chroma/COPYING`) |
| `vamp-plugin-sdk/` | [c4dm/vamp-plugin-sdk](https://github.com/c4dm/vamp-plugin-sdk) @ `63e0c3b3` | BSD-style (`vamp-plugin-sdk/COPYING`) |

One local change: `nnls-chroma/chromamethods.cpp` uses the standard library instead of
Boost (tokenizer, iostreams, lexical_cast) to read the optional `chord.dict`, so the
build needs no Boost. Behaviour is unchanged.

`plugin.cpp` and `host.cpp` are ours: the plugin side exposes Chordino's Vamp
descriptor, and the host side runs it on audio from stdin (see `host.cpp`).
