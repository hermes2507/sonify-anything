# Sonify Anything

Drop any file (image, PDF, binary, spreadsheet) and turn its bytes into a soundscape.

**Live:** https://hermes2507.github.io/sonify-anything/

Created by **Santiago Rentería** with [Claude Code](https://claude.com/claude-code). MIT licensed (see [Licences](#licences)).

```
file bytes ──► data explorer (hex / text edits) ──► SoX (read as raw audio + effect chain)
           ──► WAV ──► custom granular synth (AudioWorklet) ──► space reverb ──► out / record
```

## Two ways SoX runs

| where | engine |
|---|---|
| GitHub Pages, or any static host | **SoX 14.4.2 compiled to WebAssembly**, running in a Web Worker in your browser. Nothing is uploaded. |
| locally with `python3 server.py` | **native SoX** on your machine (`brew install sox`), used automatically when the server answers on localhost |

Both engines get the same command line: `buildArgs()` in `docs/sox-engine.js` mirrors `build_command()` in
`server.py`. The header shows which engine is active (`· wasm` or `· native`).

### Run locally

```sh
brew install sox        # optional: native SoX (otherwise the WebAssembly build is used)
python3 server.py       # → http://127.0.0.1:8765
```

Only the Python standard library is needed. The server listens only on localhost. Any static server
pointed at `docs/` also works (WebAssembly engine), e.g. `python3 -m http.server -d docs`.

## How it works

**1. SoX stage** reads the bytes as headerless audio, for example
`sox -t raw -e unsigned-integer -b 8 -r 8000 -c 1 in.bin out.wav …effects`.
You choose how the bytes are interpreted: 8/16/24/32-bit PCM, μ-law, A-law, float, or OKI/IMA ADPCM.
After that come pitch, speed, stretch, filters, EQ, overdrive, chorus, phaser, flanger, echo, tremolo,
reverb and reverse, then `norm`. The exact command is shown under the controls. **▷ SoX** in the transport
bar plays the SoX render on its own, before it reaches the grains.

**2. Granular stage** (`docs/granular-worklet.js`) is a custom AudioWorklet engine that plays overlapping
windowed grains. You can set grain size and jitter, density, irregularity, spray, scan speed, pitch and pitch
spread (with scale quantising), reversed grains, stereo spread, and the window shape (hann, tukey, triangle,
percussive, swell). *Drift* adds slow random walks, and *space* mixes in a convolution reverb.

**Data explorer**: a virtualised hex editor that works up to 64 MB, laid out like a tracker pattern
(16 bytes per row, or 8 on phones).
- type hex or text over bytes (on phones, use the type-in box); select with drag, shift-click or the Select toggle
- see a byte-class and entropy map of the whole file, with ticks for the bytes currently sounding
- apply operations to a selection: randomise, invert, XOR, add, reverse, sort, shuffle, smooth, bit-crush, sine, ramp,
  silence, fill, repeat ×N, insert, delete
- edit the file as Latin-1 text in the Text tab (offsets stay the same)
- use **Granulate selection** to make the grains read only from the selected bytes (it renders just those bytes
  when they're outside the current render); clicking the waveform jumps to the bytes that made that sound

**Export**: download the SoX WAV or the edited bytes, or press **Rec** to capture the live output.

## Adaptive quality

On load, a short benchmark (5–100 ms) picks a quality tier. While you play, the app keeps adjusting:
the AudioWorklet measures its own DSP load, and the main thread watches its frame rate.
The **quality** menu in the header overrides the automatic choice, and the footer shows the active settings.

| tier | typical device | grain voices | interpolation | SoX output | reverb | canvas pixel ratio |
|---|---|---|---|---|---|---|
| Ultra | recent laptops/desktops | 384 | cubic (Hermite) | 24-bit, `rate -v` at the device rate | 6 s | up to 3× |
| High | fast phones, **iPhones** | 256 | cubic | 24-bit, `rate -v` | 4.5 s | up to 2× |
| Balanced | mid-range phones | 128 | linear | 16-bit | 3 s | up to 2× |
| Eco | older / low-end devices | 64 | linear | 16-bit | 2 s | up to 1.5×, 30 fps visuals |

- **Audio:** if DSP load stays above ~55%, the voice cap drops by 30% steps (shown in the `dsp` readout).
  It climbs back once load is under 20%.
- **Visuals:** if frames are slow, canvases render fewer pixels and then fewer frames, and they recover when frames are fast again.
- **iPhones and iPads** keep the top audio path but are capped at High, because iOS Safari is less forgiving under load.
  Audio is set to play through the silent switch, and it resumes after calls, the lock screen or switching apps.
- **SoX output** is rendered at the AudioContext's own sample rate, so the browser doesn't resample it a second time.
- **Measured:** cubic interpolation cuts interpolation distortion from −37 dB to −62 dB. At Ultra (384 cubic voices),
  the engine uses under 10% of the real-time budget on an M4 Pro.

## Extending it

The app is plain ES modules with no build step. Edit the files in `docs/` and reload.

| file | what it does |
|---|---|
| `docs/index.html` | markup: controls are plain `<input>`/`<select>` elements with ids like `sx-…` (SoX) and `g-…` (grains) |
| `docs/style.css` | tracker-style theme; colour tokens at the top; responsive rules at the bottom |
| `docs/app.js` | state, hex editor, byte ops, rendering flow, audio graph, waveform/byte-map drawing, presets |
| `docs/sox-engine.js` | builds the SoX command line; chooses native vs WebAssembly SoX |
| `docs/sox-worker.js` | runs `sox.wasm` in a worker (fresh instance per render, cached compiled module) |
| `docs/granular-worklet.js` | the granular synth (AudioWorkletProcessor) |
| `docs/quality.js` | benchmark, quality tiers and the runtime controller |
| `server.py` | optional local server: static files + `POST /api/render` with native SoX |
| `tools/build-sox-wasm.sh` | rebuilds `docs/sox/sox.{js,wasm}` from the SoX source with Emscripten |

Common changes:
- **Add a SoX effect.** Add a control in `index.html` (`sx-<name>`) and list its id in `SOX_IDS` or `SOX_FLAGS`
  in `app.js`. Then add the effect's arguments in both `buildArgs()` (`sox-engine.js`) and `build_command()`
  (`server.py`), keeping the two in step. Any effect from `sox --help-effect all` is available in both engines.
- **Add a byte operation.** Add a function to `OPS` in `app.js` and a `<button class="op" data-op="name">`.
- **Add a preset.** Add an entry to `PRESETS` in `app.js`.
- **Add a grain window shape.** Add it in `makeWindows()` in the worklet and as an option of `#g-window`.
- **Tune performance.** Edit `TIERS` and the thresholds in `quality.js`. In the browser console,
  `__sonify.Q` shows the live controller (`score`, `dspLoad`, `voiceCap`, `dprCap`, `fps`).
- **Support more SoX formats** (FLAC, Ogg, MP3 input…). Compile those libraries with Emscripten, drop the
  matching `--without-…` flags in `tools/build-sox-wasm.sh`, and rebuild.

Testing tips: the app was checked with headless Chrome through Playwright at 320–1440 px. The checks covered real
touch events and CPU throttling of 4–10× to stand in for phones. Real iPhone and Android devices are still worth testing.

## Rebuilding the SoX WebAssembly build

`docs/sox/sox.js` and `sox.wasm` are built from the unmodified SoX 14.4.2 release with Emscripten. The only
change is removing one `#error` line that the source asks you to remove on unknown platforms:

```sh
brew install emscripten
tools/build-sox-wasm.sh path/to/sox-14.4.2.tar.gz
```

## Attributions

- **Created by Santiago Rentería**, with [Claude Code](https://claude.com/claude-code) (Anthropic) as the coding agent.
- **[SoX — Sound eXchange](https://sourceforge.net/projects/sox/) 14.4.2** by Chris Bagwell, Lance Norskog and the
  SoX contributors. It does all decoding and effects processing, both natively and as WebAssembly. GPL v2.
- **[Emscripten](https://emscripten.org/)** compiles SoX to WebAssembly. The generated loader `docs/sox/sox.js`
  contains Emscripten runtime code (MIT / University of Illinois NCSA licence).
- **[Web Audio API](https://www.w3.org/TR/webaudio/)** and **AudioWorklet**, built into browsers, run the granular
  engine, reverb, metering and recording.
- **Fonts:** [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (JetBrains) and
  [Silkscreen](https://kottke.org/plus/type/silkscreen/) (Jason Kottke), both SIL Open Font License 1.1,
  served by [Google Fonts](https://fonts.google.com/).
- **Tooling:** [Homebrew](https://brew.sh/) (installing SoX and Emscripten), the Python standard library
  (local server), [Playwright](https://playwright.dev/) (automated usability and performance tests during
  development; not shipped), and [GitHub Pages](https://pages.github.com/) (hosting).
- **Inspiration:**
  - [RAMA-L](https://pcarroll.au/tools/rama-l/) by Pat Carroll, for the idea of turning raw data into sound.
  - [Renoise](https://www.renoise.com/) and classic tracker software such as ProTracker and FastTracker II,
    for the look (bevelled panels, LCD readouts, pattern-style rows).
  - Granular synthesis as developed by Iannis Xenakis and Curtis Roads (*Microsound*).

  No code or assets were taken from any of these, and there's no affiliation.

## Licences

- **Sonify Anything source code:** MIT, © 2026 Santiago Rentería ([`LICENSE`](LICENSE)).
- **SoX WebAssembly build** (`docs/sox/`): GNU GPL v2 (`docs/sox/COPYING`, `docs/sox/LICENSE.GPL`). Source:
  https://sourceforge.net/projects/sox/files/sox/14.4.2/. `tools/build-sox-wasm.sh` records exactly how the
  binary was produced.
- **Fonts:** SIL Open Font License 1.1.
