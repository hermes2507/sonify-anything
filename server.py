#!/usr/bin/env python3
"""
Sonify Anything — local server.

Serves the web app from ./docs and exposes one endpoint that pipes arbitrary
bytes through SoX, interpreting them as raw audio and running an effect chain.

    python3 server.py            # http://127.0.0.1:8765
    python3 server.py --port 9000

Only the Python standard library is used. SoX must be on PATH (brew install sox).
"""

import argparse
import json
import mimetypes
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".js")
import os
import shutil
import subprocess
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "docs")
MAX_BYTES = 64 * 1024 * 1024
SOX = shutil.which("sox")

# How the incoming bytes are interpreted. Each maps to SoX input options.
FORMATS = {
    "u8":     ["-t", "raw", "-e", "unsigned-integer", "-b", "8"],
    "s8":     ["-t", "raw", "-e", "signed-integer", "-b", "8"],
    "s16le":  ["-t", "raw", "-e", "signed-integer", "-b", "16", "-L"],
    "s16be":  ["-t", "raw", "-e", "signed-integer", "-b", "16", "-B"],
    "u16le":  ["-t", "raw", "-e", "unsigned-integer", "-b", "16", "-L"],
    "s24le":  ["-t", "raw", "-e", "signed-integer", "-b", "24", "-L"],
    "s32le":  ["-t", "raw", "-e", "signed-integer", "-b", "32", "-L"],
    "f32le":  ["-t", "raw", "-e", "floating-point", "-b", "32", "-L"],
    "mulaw":  ["-t", "raw", "-e", "mu-law", "-b", "8"],
    "alaw":   ["-t", "raw", "-e", "a-law", "-b", "8"],
    "vox":    ["-t", "vox"],          # OKI / Dialogic ADPCM
    "ima":    ["-t", "ima"],          # IMA ADPCM
}
BYTES_PER_FRAME = {"u8": 1, "s8": 1, "s16le": 2, "s16be": 2, "u16le": 2,
                   "s24le": 3, "s32le": 4, "f32le": 4, "mulaw": 1, "alaw": 1,
                   "vox": 0.5, "ima": 0.5}


def num(q, key, default, lo, hi, cast=float):
    try:
        v = cast(q.get(key, [default])[0])
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))


def flag(q, key):
    return q.get(key, ["0"])[0] in ("1", "true", "on")


def build_command(q, in_path, out_path):
    # Mirrors buildArgs() in docs/sox-engine.js (used by the WebAssembly build) — keep in step.
    fmt = q.get("format", ["u8"])[0]
    if fmt not in FORMATS:
        fmt = "u8"
    rate = num(q, "rate", 8000, 500, 192000, int)
    chans = 1 if fmt in ("vox", "ima") else num(q, "channels", 1, 1, 2, int)
    maxdur = num(q, "maxdur", 120, 1, 600)

    inp = [*FORMATS[fmt], "-r", str(rate)]
    if fmt not in ("vox", "ima"):
        inp += ["-c", str(chans)]

    fx = ["trim", "0", f"{maxdur:g}", "rate", "44100", "highpass", "15", "channels", "2"]

    if flag(q, "reverse"):
        fx += ["reverse"]
    speed = num(q, "speed", 1.0, 0.1, 4.0)
    if abs(speed - 1) > 1e-3:
        fx += ["speed", f"{speed:g}"]
    tempo = num(q, "tempo", 1.0, 0.1, 4.0)
    if abs(tempo - 1) > 1e-3:
        fx += ["tempo", "-s", f"{tempo:g}"]
    pitch = num(q, "pitch", 0, -2400, 2400, int)
    if pitch:
        fx += ["pitch", str(pitch)]
    hp = num(q, "highpass", 0, 0, 20000, int)
    if hp > 15:
        fx += ["highpass", str(hp)]
    lp = num(q, "lowpass", 0, 0, 22000, int)
    if lp > 0:
        fx += ["lowpass", str(lp)]
    bass = num(q, "bass", 0, -30, 30, int)
    if bass:
        fx += ["bass", str(bass)]
    treble = num(q, "treble", 0, -30, 30, int)
    if treble:
        fx += ["treble", str(treble)]
    crush = num(q, "overdrive", 0, 0, 100, int)
    if crush:
        fx += ["overdrive", str(crush)]
    if flag(q, "tremolo"):
        fx += ["tremolo", f"{num(q, 'tremhz', 4, 0.1, 100):g}", "60"]
    if flag(q, "phaser"):
        fx += ["phaser", "0.8", "0.74", "3", "0.4", "0.5", "-t"]
    if flag(q, "flanger"):
        fx += ["flanger"]
    if flag(q, "chorus"):
        fx += ["chorus", "0.7", "0.9", "55", "0.4", "0.25", "2", "-t"]
    if flag(q, "echo"):
        fx += ["echos", "0.8", "0.7", "700", "0.25", "1100", "0.3"]
    rev = num(q, "reverb", 0, 0, 100, int)
    if rev:
        fx += ["reverb", str(rev), "50", "100"]
    fx += ["norm", "-1", "fade", "t", "0.02"]

    cmd = [SOX, "-V1", *inp, in_path, "-t", "wav", "-r", "44100", "-b", "16", out_path, *fx]
    return cmd, fmt, rate, chans


class Handler(BaseHTTPRequestHandler):
    server_version = "SonifyAnything/1.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.address_string(), fmt % args))

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            version = ""
            if SOX:
                try:
                    out = subprocess.run([SOX, "--version"], capture_output=True, text=True, timeout=5)
                    version = (out.stdout or out.stderr).strip()
                except Exception:
                    pass
            return self.send_json(200, {"sox": bool(SOX), "version": version,
                                        "formats": list(FORMATS), "maxBytes": MAX_BYTES})
        if path == "/":
            path = "/index.html"
        full = os.path.realpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(full):
            self.send_error(404)
            return
        with open(full, "rb") as fh:
            data = fh.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/render":
            self.send_error(404)
            return
        if not SOX:
            return self.send_json(500, {"error": "SoX not found on PATH. Install with: brew install sox"})
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return self.send_json(400, {"error": "Empty body"})
        if length > MAX_BYTES:
            return self.send_json(413, {"error": f"Too large (max {MAX_BYTES // 1048576} MB)"})
        data = self.rfile.read(length)
        q = parse_qs(url.query)

        with tempfile.TemporaryDirectory(prefix="sonify-") as tmp:
            in_path = os.path.join(tmp, "in.bin")
            out_path = os.path.join(tmp, "out.wav")
            fmt = q.get("format", ["u8"])[0]
            # SoX needs whole frames; pad with zeros so odd lengths don't error.
            bpf = BYTES_PER_FRAME.get(fmt, 1) * (1 if fmt in ("vox", "ima") else num(q, "channels", 1, 1, 2, int))
            if bpf >= 1 and len(data) % int(bpf):
                data += b"\x00" * (int(bpf) - len(data) % int(bpf))
            with open(in_path, "wb") as fh:
                fh.write(data)
            cmd, fmt, rate, chans = build_command(q, in_path, out_path)
            try:
                res = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            except subprocess.TimeoutExpired:
                return self.send_json(504, {"error": "SoX timed out"})
            if res.returncode != 0 or not os.path.exists(out_path):
                return self.send_json(500, {"error": res.stderr.strip() or "SoX failed"})
            with open(out_path, "rb") as fh:
                wav = fh.read()

        shown = ["sox", *cmd[1:]]
        shown = ["<input>" if c == in_path else "<output.wav>" if c == out_path else c for c in shown]
        raw_dur = len(data) / (BYTES_PER_FRAME[fmt] * (1 if fmt in ("vox", "ima") else chans)) / rate
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("X-Sox-Command", " ".join(shown))
        self.send_header("X-Raw-Duration", f"{raw_dur:.4f}")
        self.send_header("Access-Control-Expose-Headers", "X-Sox-Command, X-Raw-Duration")
        self.end_headers()
        self.wfile.write(wav)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    if not SOX:
        print("WARNING: sox not found on PATH — install it with `brew install sox`.")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Sonify Anything → http://{args.host}:{args.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
