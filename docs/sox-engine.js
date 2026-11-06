// SoX engine: builds the SoX command line and runs it either with native SoX
// (when server.py is running locally) or with SoX 14.4.2 compiled to
// WebAssembly in a worker (GitHub Pages, or no server).

export const FORMATS = {
  u8:    ['-t', 'raw', '-e', 'unsigned-integer', '-b', '8'],
  s8:    ['-t', 'raw', '-e', 'signed-integer', '-b', '8'],
  s16le: ['-t', 'raw', '-e', 'signed-integer', '-b', '16', '-L'],
  s16be: ['-t', 'raw', '-e', 'signed-integer', '-b', '16', '-B'],
  u16le: ['-t', 'raw', '-e', 'unsigned-integer', '-b', '16', '-L'],
  s24le: ['-t', 'raw', '-e', 'signed-integer', '-b', '24', '-L'],
  s32le: ['-t', 'raw', '-e', 'signed-integer', '-b', '32', '-L'],
  f32le: ['-t', 'raw', '-e', 'floating-point', '-b', '32', '-L'],
  mulaw: ['-t', 'raw', '-e', 'mu-law', '-b', '8'],
  alaw:  ['-t', 'raw', '-e', 'a-law', '-b', '8'],
  vox:   ['-t', 'vox'],
  ima:   ['-t', 'ima'],
};
export const BYTES_PER_FRAME = { u8: 1, s8: 1, s16le: 2, s16be: 2, u16le: 2, s24le: 3, s32le: 4, f32le: 4, mulaw: 1, alaw: 1, vox: 0.5, ima: 0.5 };

const num = (q, k, d, lo, hi, int = false) => {
  let v = parseFloat(q.get(k));
  if (!Number.isFinite(v)) v = d;
  if (int) v = Math.trunc(v);
  return Math.max(lo, Math.min(hi, v));
};
const flag = (q, k) => ['1', 'true', 'on'].includes(q.get(k));
const g = (v) => String(+v.toFixed(6));

// Mirrors build_command() in server.py — keep the two in step.
export function buildArgs(q, inPath, outPath) {
  let fmt = q.get('format');
  if (!FORMATS[fmt]) fmt = 'u8';
  const adpcm = fmt === 'vox' || fmt === 'ima';
  const rate = num(q, 'rate', 8000, 500, 192000, true);
  const chans = adpcm ? 1 : num(q, 'channels', 1, 1, 2, true);
  const maxdur = num(q, 'maxdur', 120, 1, 600);
  const inp = [...FORMATS[fmt], '-r', String(rate)];
  if (!adpcm) inp.push('-c', String(chans));

  // output quality (adaptive): device sample rate, bit depth, resampler quality
  const outrate = [44100, 48000, 88200, 96000].includes(+q.get('outrate')) ? q.get('outrate') : '44100';
  const bits = q.get('bits') === '24' ? '24' : '16';
  const rateArgs = q.get('rateq') === 'v' ? ['rate', '-v', outrate] : ['rate', outrate];
  const fx = ['trim', '0', g(maxdur), ...rateArgs, 'highpass', '15', 'channels', '2'];
  if (flag(q, 'reverse')) fx.push('reverse');
  const speed = num(q, 'speed', 1, 0.1, 4);
  if (Math.abs(speed - 1) > 1e-3) fx.push('speed', g(speed));
  const tempo = num(q, 'tempo', 1, 0.1, 4);
  if (Math.abs(tempo - 1) > 1e-3) fx.push('tempo', '-s', g(tempo));
  const pitch = num(q, 'pitch', 0, -2400, 2400, true);
  if (pitch) fx.push('pitch', String(pitch));
  const hp = num(q, 'highpass', 0, 0, 20000, true);
  if (hp > 15) fx.push('highpass', String(hp));
  const lp = num(q, 'lowpass', 0, 0, 22000, true);
  if (lp > 0) fx.push('lowpass', String(lp));
  const bass = num(q, 'bass', 0, -30, 30, true);
  if (bass) fx.push('bass', String(bass));
  const treble = num(q, 'treble', 0, -30, 30, true);
  if (treble) fx.push('treble', String(treble));
  const od = num(q, 'overdrive', 0, 0, 100, true);
  if (od) fx.push('overdrive', String(od));
  if (flag(q, 'tremolo')) fx.push('tremolo', g(num(q, 'tremhz', 4, 0.1, 100)), '60');
  if (flag(q, 'phaser')) fx.push('phaser', '0.8', '0.74', '3', '0.4', '0.5', '-t');
  if (flag(q, 'flanger')) fx.push('flanger');
  if (flag(q, 'chorus')) fx.push('chorus', '0.7', '0.9', '55', '0.4', '0.25', '2', '-t');
  if (flag(q, 'echo')) fx.push('echos', '0.8', '0.7', '700', '0.25', '1100', '0.3');
  const rev = num(q, 'reverb', 0, 0, 100, true);
  if (rev) fx.push('reverb', String(rev), '50', '100');
  fx.push('norm', '-1', 'fade', 't', '0.02');

  return { args: ['-V1', ...inp, inPath, '-t', 'wav', '-r', outrate, '-b', bits, outPath, ...fx], fmt, rate, chans };
}

// SoX needs whole frames; pad with zeros so odd lengths don't error.
export function padToFrames(bytes, fmt, chans) {
  const bpf = BYTES_PER_FRAME[fmt] * (fmt === 'vox' || fmt === 'ima' ? 1 : chans);
  if (bpf < 1 || bytes.length % bpf === 0) return bytes;
  const out = new Uint8Array(bytes.length + (bpf - (bytes.length % bpf)));
  out.set(bytes);
  return out;
}

/* ---------------- engine selection ---------------- */
let engine = null; // { kind: 'native' | 'wasm', version }
let worker = null, seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./sox-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const { id, ok, wav, error, version } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve({ wav, version }) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'SoX worker crashed'));
    pending.clear();
    worker = null;
  };
  return worker;
}
function callWorker(msg, transfer = []) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

export async function detectEngine() {
  if (engine) return engine;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
  if (local) try {
    const r = await fetch('api/health', { cache: 'no-store' });
    const h = r.ok && (r.headers.get('content-type') || '').includes('json') ? await r.json() : null;
    if (h && h.sox) {
      engine = { kind: 'native', version: (h.version.match(/v\d[\d.]*/) || ['14.4'])[0] };
      return engine;
    }
  } catch { /* no server — static hosting */ }
  const { version } = await callWorker({ type: 'version' });
  engine = { kind: 'wasm', version };
  return engine;
}

// Render bytes → { wav: ArrayBuffer, cmd: string }
export async function renderBytes(bytes, q, signal) {
  const eng = await detectEngine();
  if (eng.kind === 'native') {
    const res = await fetch('api/render?' + q, { method: 'POST', body: bytes, signal });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || res.statusText);
    }
    return { wav: await res.arrayBuffer(), cmd: res.headers.get('X-Sox-Command') };
  }
  const { args, fmt, chans } = buildArgs(q, '/in.bin', '/out.wav');
  const data = padToFrames(bytes, fmt, chans);
  const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const id = seq + 1;
  const job = callWorker({ type: 'render', args, input: buf }, [buf]);
  const abort = new Promise((_, rej) => signal?.addEventListener('abort', () => {
    // a newer render replaced this one: stop SoX mid-job instead of letting renders queue up
    if (pending.has(id)) {
      worker?.terminate(); worker = null;
      for (const p of pending.values()) p.reject(new DOMException('aborted', 'AbortError'));
      pending.clear();
    }
    rej(new DOMException('aborted', 'AbortError'));
  }));
  const { wav } = await Promise.race([job, abort]);
  const cmd = ['sox', ...args].map((a) => (a === '/in.bin' ? '<input>' : a === '/out.wav' ? '<output.wav>' : a)).join(' ');
  return { wav, cmd };
}
