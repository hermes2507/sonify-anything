#!/usr/bin/env bash
# Rebuild docs/sox/sox.{js,wasm}: SoX 14.4.2 compiled to WebAssembly.
# Needs emscripten (brew install emscripten). Run from the repo root:
#   tools/build-sox-wasm.sh [path/to/sox-14.4.2.tar.gz]
# Source: https://sourceforge.net/projects/sox/files/sox/14.4.2/sox-14.4.2.tar.gz
#   sha256 b45f598643ffbd8e363ff24d61166ccec4836fea6d3888881b8df53e3bb55f6c
set -euo pipefail
TARBALL="${1:-sox-14.4.2.tar.gz}"
OUT="$(pwd)/docs/sox"
WORK="$(mktemp -d)"
tar xzf "$TARBALL" -C "$WORK"
cd "$WORK/sox-14.4.2"

# The only source change: formats.c has a deliberate "#error FIX NEEDED HERE" for
# unknown libcs in rewind_pipe(). Its own comment says to remove it and live
# without file-type detection on pipes; we only ever read files, so that's fine.
sed -i.bak 's/^  #error FIX NEEDED HERE$//' src/formats.c

emconfigure ./configure --disable-shared --enable-static --disable-openmp \
  --without-libltdl --without-magic --without-png --without-ladspa --without-mad \
  --without-id3tag --without-lame --without-twolame --without-oggvorbis --without-opus \
  --without-flac --without-amrwb --without-amrnb --without-wavpack --without-sndfile \
  --without-mp3 --without-coreaudio --without-alsa --without-ao --without-pulseaudio \
  --without-oss --without-sndio --without-sunaudio --without-waveaudio CFLAGS="-O2"
emmake make -j8

emcc -O2 src/sox.o src/.libs/libsox.a libgsm/.libs/libgsm.a lpc10/.libs/liblpc10.a -lm \
  -o "$OUT/sox.js" \
  -sMODULARIZE=1 -sEXPORT_NAME=createSox -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2GB -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 \
  -sFORCE_FILESYSTEM=1 -sEXPORTED_RUNTIME_METHODS='["FS","callMain"]'
cp COPYING LICENSE.GPL "$OUT/"
echo "Built $OUT/sox.js and $OUT/sox.wasm"
