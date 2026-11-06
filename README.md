# Sonify Anything

Drop any file (image, PDF, binary, spreadsheet) and turn its bytes into a soundscape.

**Live:** https://hermes2507.github.io/sonify-anything/

```
file bytes ──► data explorer (hex / text edits) ──► SoX (read as raw audio + effect chain)
           ──► WAV ──► custom granular synth (AudioWorklet) ──► space reverb ──► out / record
```

## Two ways SoX runs

| where | engine |
|---|---|
| GitHub Pages, or any static host | **SoX 14.4.2 compiled to WebAssembly**, running in a Web Worker in your browser. Nothing is uploaded. |
| locally with `python3 server.py` | **native SoX** on your machine (`brew install sox`), used automatically when the server answers |

Both engines get the same command line: `buildArgs()` in `docs/sox-engine.js` mirrors `build_command()` in
`server.py`. The header shows which engine is active (`· wasm` or `· native`).

### Run locally

```sh
brew install sox        # optional: native SoX (otherwise the WebAssembly build is used)
python3 server.py       # → http://127.0.0.1:8765
```

Only the Python standard library is needed. The server listens only on localhost.

## How it works

**1. SoX stage** reads the bytes as headerless audio, for example
`sox -t raw -e unsigned-integer -b 8 -r 8000 -c 1 in.bin out.wav …effects`.
You choose how the bytes are interpreted: 8/16/24/32-bit PCM, μ-law, A-law, float, or OKI/IMA ADPCM.
After that come pitch, speed, stretch, filters, EQ, overdrive, chorus, phaser, flanger, echo, tremolo,
reverb and reverse, then `norm`. The exact command is shown under the controls.

**2. Granular stage** (`docs/granular-worklet.js`) is a custom AudioWorklet engine that plays up to 256
overlapping windowed grains. You can set grain size and jitter, density, irregularity, spray, scan speed,
pitch and pitch spread (with scale quantising), reversed grains, stereo spread, and the window shape.
*Drift* adds slow random walks, and *space* mixes in a convolution reverb.

**Data explorer**: a virtualised hex editor that works up to 64 MB, laid out like a tracker pattern.
- type hex or text over bytes (on phones, use the type-in box); select with drag, shift-click or the Select toggle
- see a byte-class and entropy map of the whole file, with ticks for the bytes currently sounding
- apply operations to a selection: randomise, invert, XOR, add, reverse, sort, shuffle, smooth, bit-crush, sine, ramp,
  silence, fill, repeat ×N, insert, delete
- edit the file as Latin-1 text in the Text tab (offsets stay the same)
- use **Granulate selection** to make the grains read only from the selected bytes; clicking the waveform jumps to the bytes that made that sound

**Export**: download the SoX WAV or the edited bytes, or press **Rec** to capture the live output.

## Rebuilding the SoX WebAssembly build

`docs/sox/sox.js` and `sox.wasm` are built from the unmodified SoX 14.4.2 release with emscripten. The only
change is removing one `#error` line that the source asks you to remove on unknown platforms:

```sh
brew install emscripten
tools/build-sox-wasm.sh path/to/sox-14.4.2.tar.gz
```

## Licences

SoX is © Chris Bagwell and SoX contributors, and is distributed under the GNU GPL v2
(`docs/sox/COPYING`, `docs/sox/LICENSE.GPL`). Its source is available at
https://sourceforge.net/projects/sox/files/sox/14.4.2/, and `tools/build-sox-wasm.sh` records exactly how
the WebAssembly build was produced.
