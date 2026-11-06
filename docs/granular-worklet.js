// Custom granular synthesis engine, running on the audio thread.
// The main thread posts a stereo buffer (the SoX render) and parameter updates;
// this processor spawns overlapping windowed grains read from that buffer.

const TABLE = 2048;

function makeWindows() {
  const w = {};
  const mk = (fn) => {
    const t = new Float32Array(TABLE + 1);
    for (let i = 0; i <= TABLE; i++) t[i] = fn(i / TABLE);
    return t;
  };
  w.hann = mk((x) => 0.5 - 0.5 * Math.cos(2 * Math.PI * x));
  w.triangle = mk((x) => 1 - Math.abs(2 * x - 1));
  // fast attack, exponential decay — percussive, "plucked" grains
  w.perc = mk((x) => Math.min(1, x * 40) * Math.exp(-5 * x));
  // slow attack, sharp release — reversed-tape feel
  w.swell = mk((x) => Math.min(1, (1 - x) * 40) * Math.exp(-5 * (1 - x)));
  // tukey: flat top with short cosine tapers, more "solid" grains
  w.tukey = mk((x) => {
    const a = 0.25;
    if (x < a / 2) return 0.5 * (1 - Math.cos((2 * Math.PI * x) / a));
    if (x > 1 - a / 2) return 0.5 * (1 - Math.cos((2 * Math.PI * (1 - x)) / a));
    return 1;
  });
  return w;
}

const SCALES = {
  free: null,
  octaves: [0],
  fifths: [0, 7],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  wholetone: [0, 2, 4, 6, 8, 10],
};

function quantise(semis, scale) {
  const s = SCALES[scale];
  if (!s) return semis;
  const oct = Math.floor(semis / 12);
  const within = semis - oct * 12;
  let best = s[0], bestD = 99;
  for (const n of [...s, 12]) {
    const d = Math.abs(within - n);
    if (d < bestD) { bestD = d; best = n; }
  }
  return oct * 12 + best;
}

class GranularProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.windows = makeWindows();
    this.L = null;
    this.R = null;
    this.bufRate = sampleRate;
    this.voices = [];
    this.maxVoices = 256;
    this.countdown = 0;
    this.playhead = 0; // 0..1 within region
    this.running = false;
    this.events = [];
    this.lastPost = 0;
    this.p = {
      regionStart: 0, regionEnd: 1, position: 0.5,
      spray: 0.1, size: 120, sizeJitter: 0.2,
      density: 20, irregularity: 0.3,
      pitch: 0, pitchJitter: 0, scale: 'free',
      reverseProb: 0, spread: 0.6, window: 'hann',
      scan: 0, gain: 0.8,
    };
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'buffer') {
        this.L = m.L; this.R = m.R; this.bufRate = m.sampleRate;
        this.voices.length = 0;
      } else if (m.type === 'params') {
        const prevPos = this.p.position;
        Object.assign(this.p, m.params);
        if (m.params.position !== undefined && m.params.position !== prevPos) this.playhead = this.p.position;
      } else if (m.type === 'run') {
        this.running = m.value;
        if (!m.value) this.voices.length = 0;
      } else if (m.type === 'seek') {
        this.playhead = m.value;
      }
    };
  }

  spawn(frameOffset) {
    const p = this.p, n = this.L.length;
    const rs = Math.min(p.regionStart, p.regionEnd), re = Math.max(p.regionStart, p.regionEnd);
    const span = Math.max(1e-6, re - rs);
    let centre = rs + this.playhead * span + (Math.random() * 2 - 1) * p.spray * span * 0.5;
    if (centre < rs) centre = rs + (rs - centre) % span;
    if (centre > re) centre = re - (centre - re) % span;

    const sizeMs = Math.max(2, p.size * (1 + (Math.random() * 2 - 1) * p.sizeJitter));
    const len = Math.max(16, Math.floor((sizeMs / 1000) * sampleRate));
    let semis = p.pitch + (Math.random() * 2 - 1) * p.pitchJitter;
    semis = quantise(Math.round(semis * 100) / 100, p.scale);
    const reverse = Math.random() < p.reverseProb;
    const rate = Math.pow(2, semis / 12) * (this.bufRate / sampleRate) * (reverse ? -1 : 1);
    const pan = (Math.random() * 2 - 1) * p.spread;
    const angle = (pan + 1) * Math.PI / 4;
    // normalise loudness so higher density doesn't simply get louder
    const overlap = Math.max(1, (p.density * sizeMs) / 1000);
    const amp = p.gain / Math.sqrt(overlap) * (0.75 + Math.random() * 0.25);

    this.voices.push({
      pos: centre * (n - 1), rate, len, age: -frameOffset,
      gl: Math.cos(angle) * amp, gr: Math.sin(angle) * amp,
      win: this.windows[p.window] || this.windows.hann,
    });
    this.events.push(centre, pan, sizeMs, semis);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const frames = oL.length;
    if (!this.L || !this.running) {
      if (this.voices.length === 0) return true;
    }
    const p = this.p;

    // scheduler: decide which frames in this block start a grain
    if (this.L && this.running) {
      let f = 0;
      while (true) {
        if (this.countdown > frames - f) { this.countdown -= frames - f; break; }
        f += this.countdown;
        if (this.voices.length < this.maxVoices) this.spawn(f);
        const base = sampleRate / Math.max(0.1, p.density);
        const jitter = 1 + (Math.random() * 2 - 1) * p.irregularity;
        this.countdown = Math.max(1, Math.floor(base * jitter));
      }
      // scan the playhead through the region (scan = region-lengths per second)
      this.playhead += (p.scan * frames) / sampleRate;
      this.playhead -= Math.floor(this.playhead);
    }

    const L = this.L, R = this.R, n = L ? L.length : 0;
    for (let v = this.voices.length - 1; v >= 0; v--) {
      const g = this.voices[v];
      const win = g.win;
      for (let i = 0; i < frames; i++) {
        const age = g.age + i;
        if (age < 0) continue;
        if (age >= g.len) break;
        let pos = g.pos + age * g.rate;
        pos = ((pos % n) + n) % n;
        const i0 = pos | 0, fr = pos - i0, i1 = i0 + 1 < n ? i0 + 1 : 0;
        const w = win[((age / g.len) * TABLE) | 0];
        oL[i] += (L[i0] + (L[i1] - L[i0]) * fr) * w * g.gl;
        oR[i] += (R[i0] + (R[i1] - R[i0]) * fr) * w * g.gr;
      }
      g.age += frames;
      if (g.age >= g.len) this.voices.splice(v, 1);
    }

    // gentle soft clip
    for (let i = 0; i < frames; i++) {
      oL[i] = Math.tanh(oL[i]);
      if (oR !== oL) oR[i] = Math.tanh(oR[i]);
    }

    if (currentTime - this.lastPost > 0.033) {
      this.lastPost = currentTime;
      this.port.postMessage({ type: 'tick', playhead: this.playhead, voices: this.voices.length, grains: this.events });
      this.events = [];
    }
    return true;
  }
}

registerProcessor('granular', GranularProcessor);
