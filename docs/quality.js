// Adaptive quality: pick a tier from a quick CPU benchmark, then keep adjusting
// at runtime from the measured DSP load (reported by the AudioWorklet) and the
// main-thread frame rate. Fast laptops and recent iPhones get the high-quality
// path (cubic interpolation, more voices, 24-bit high-quality SoX resampling);
// slower devices stay smooth.

export const TIERS = {
  eco:      { label: 'Eco',      maxVoices: 64,  interp: 'linear', irSec: 2.0, bits: 16, rateq: '',   dprCap: 1.5, fps: 30, latency: 'playback' },
  balanced: { label: 'Balanced', maxVoices: 128, interp: 'linear', irSec: 3.0, bits: 16, rateq: '',   dprCap: 2,   fps: 60, latency: 'playback' },
  high:     { label: 'High',     maxVoices: 256, interp: 'cubic',  irSec: 4.5, bits: 24, rateq: 'v',  dprCap: 2,   fps: 60, latency: 'balanced' },
  ultra:    { label: 'Ultra',    maxVoices: 384, interp: 'cubic',  irSec: 6.0, bits: 24, rateq: 'v',  dprCap: 3,   fps: 60, latency: 'interactive' },
};
const ORDER = ['eco', 'balanced', 'high', 'ultra'];

export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ~5 ms (fast laptop) to ~60 ms (low-end phone) micro-benchmark shaped like the grain inner loop (interpolated reads).
const ITER = 5_000_000;
export function benchmark() {
  const n = 1 << 16, buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = Math.sin(i * 0.01);
  let best = Infinity, acc = 0;
  for (let run = 0; run < 2; run++) {
    const t0 = performance.now();
    let pos = 0.5;
    for (let i = 0; i < ITER; i++) {
      const i0 = pos | 0, fr = pos - i0, i1 = (i0 + 1) & (n - 1);
      acc += buf[i0] + (buf[i1] - buf[i0]) * fr;
      pos += 1.37; if (pos >= n) pos -= n;
    }
    best = Math.min(best, performance.now() - t0);
  }
  if (acc === 42) console.log(acc); // keep the loop alive
  return ITER / best / 1000; // iterations per µs — M4 Pro ≈ 1100, mid-range phone ≈ 280
}

export function pickTier(score) {
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 8; // not exposed by Safari → assume fine
  let t = score >= 600 ? 'ultra' : score >= 300 ? 'high' : score >= 140 ? 'balanced' : 'eco';
  if (t === 'ultra' && (cores < 6 || mem < 4)) t = 'high';
  if (mem <= 2 && t !== 'eco') t = 'balanced';
  // iPhones/iPads: Apple silicon is fast, but iOS Safari glitches easily under
  // load and the screens are 3× — keep top audio quality, cap at 'high'.
  if (isIOS && t === 'ultra') t = 'high';
  return t;
}

/* ---------------- runtime controller ---------------- */
export class Quality {
  constructor({ onChange }) {
    this.onChange = onChange;
    this.mode = 'auto';
    try { this.mode = localStorage.getItem('sonify.quality') || 'auto'; } catch {}
    this.score = benchmark();
    this.autoTier = pickTier(this.score);
    this.tierName = this.mode === 'auto' ? this.autoTier : this.mode;
    this.s = { ...TIERS[this.tierName] };
    this.voiceCap = this.s.maxVoices;   // lowered when DSP load is high
    this.dprCap = this.s.dprCap;        // lowered when frames are slow
    this.fps = this.s.fps;
    this.dspLoad = 0;
    this.frames = [];
    this.lastAdjust = performance.now();
    this.calm = 0;
  }
  setMode(mode) {
    this.mode = mode;
    try { localStorage.setItem('sonify.quality', mode); } catch {}
    this.tierName = mode === 'auto' ? this.autoTier : mode;
    this.s = { ...TIERS[this.tierName] };
    this.voiceCap = this.s.maxVoices; this.dprCap = this.s.dprCap; this.fps = this.s.fps;
    this.onChange?.('tier');
  }
  dpr() { return Math.min(window.devicePixelRatio || 1, this.dprCap); }
  frame(dt) { this.frames.push(dt); if (this.frames.length > 240) this.frames.shift(); }
  reportDSP(load) { this.dspLoad = this.dspLoad * 0.7 + load * 0.3; }

  // called ~1×/s
  tick(playing) {
    const now = performance.now();
    if (now - this.lastAdjust < 1000) return;
    this.lastAdjust = now;
    let changed = null;
    // audio: keep the worklet comfortably inside its real-time budget
    if (playing && this.dspLoad > 0.55 && this.voiceCap > 24) {
      this.voiceCap = Math.max(24, Math.floor(this.voiceCap * 0.7)); changed = 'voices-down';
    } else if (playing && this.dspLoad < 0.2 && this.voiceCap < this.s.maxVoices) {
      this.voiceCap = Math.min(this.s.maxVoices, Math.ceil(this.voiceCap * 1.25)); changed = 'voices-up';
    }
    // visuals: if the main thread is struggling, render fewer pixels / frames
    const f = this.frames.slice(-90).sort((a, b) => a - b);
    if (f.length > 60) {
      const p90 = f[Math.floor(f.length * 0.9)];
      if (p90 > 40) {
        this.calm = 0;
        if (this.dprCap > 1) { this.dprCap = Math.max(1, this.dprCap - 0.5); changed ||= 'visual-down'; }
        else if (this.fps > 30) { this.fps = 30; changed ||= 'visual-down'; }
      } else if (p90 < 20 && ++this.calm > 8) {
        this.calm = 0;
        if (this.fps < this.s.fps) { this.fps = this.s.fps; changed ||= 'visual-up'; }
        else if (this.dprCap < this.s.dprCap) { this.dprCap = Math.min(this.s.dprCap, this.dprCap + 0.5); changed ||= 'visual-up'; }
      }
    }
    if (changed) this.onChange?.(changed);
  }
  describe() {
    return `${this.mode === 'auto' ? 'Auto · ' : ''}${this.s.label}`;
  }
}
