// Sonify Anything — front end.
// Flow: file bytes → (data explorer edits) → SoX on the local server → WAV →
// custom AudioWorklet granular engine → space (convolver) → speakers / recorder.

import { renderBytes, detectEngine } from './sox-engine.js';
import { Quality, TIERS, isIOS } from './quality.js';

// Adaptive quality (benchmark → tier; then live adjustments). See quality.js.
const Q = new Quality({ onChange: (why) => onQualityChange(why) });
const DPR = () => Q.dpr();

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const MAX_BYTES = 64 * 1024 * 1024;
let ROW = 16;
const ROW_H = 20, MAX_SCROLL_PX = 1.5e7;

/* =========================== state =========================== */
const S = {
  bytes: null, original: null, mask: null, name: '',
  cursor: 0, nibble: 0, mode: 'hex', sel: null, anchor: 0,
  undo: [], redo: [],
  // render mapping: bytes slice → audio
  map: null,
  audioBuf: null, wavBlob: null, peaks: null,
  region: [0, 1], playhead: 0, grains: [], latestGrain: null, voices: 0,
  playing: false, direct: null, recorder: null, extend: false,
};

/* =========================== utils =========================== */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hex2 = (b) => (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
const hex8 = (n) => n.toString(16).toUpperCase().padStart(8, '0');
const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = 'toast'), err ? 5000 : 2200);
}

function byteClass(b) {
  if (b === 0) return 0;
  if (b === 0xff) return 5;
  if (b === 9 || b === 10 || b === 13 || b === 32) return 2;
  if (b < 32 || b === 127) return 1;
  if (b < 127) return 3;
  return 4;
}
const CLASS_COLORS = ['#2c2c2c', '#b67cf0', '#5a9bea', '#8fd16a', '#f2a93b', '#ff5a4f'];
const COL = { well: '#0d0d0d', amber: '#f2a93b', lcd: '#a6e35a', cyan: '#5fd3e0', red: '#ff5a4f', dim: '#5c5850' };

function parsePattern(str) {
  const clean = str.replace(/0x/gi, '').replace(/[\s,]+/g, '');
  if (clean && /^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }
  if (/^[0-9a-f]$/i.test(clean)) return new Uint8Array([parseInt(clean, 16)]);
  return new TextEncoder().encode(str || '\0');
}

function sizeCanvas(c) {
  const dpr = DPR();
  const w = Math.max(10, Math.round(c.clientWidth * dpr)), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
  return false;
}

/* =========================== loading =========================== */
function loadBytes(bytes, name) {
  if (bytes.length > MAX_BYTES) {
    toast(`File is ${fmtBytes(bytes.length)} — using the first 64 MB`, true);
    bytes = bytes.slice(0, MAX_BYTES);
  }
  if (!bytes.length) { toast('That file is empty', true); return; }
  S.bytes = bytes;
  S.original = bytes.slice();
  S.mask = new Uint8Array(bytes.length);
  S.name = name;
  S.cursor = 0; S.nibble = 0; S.sel = null; S.undo = []; S.redo = []; S.modified = false;
  S.region = [0, 1];
  $('#dropZone').classList.add('has-file');
  $('#hexEmpty').hidden = true;
  $('#hexScroll').scrollTop = 0;
  afterEdit({ render: true, force: true });
  if (!$('#tab-text').hidden) textTabLoad();
}

async function loadFile(file) {
  const buf = new Uint8Array(await file.slice(0, MAX_BYTES).arrayBuffer());
  loadBytes(buf, file.name);
  if (file.size > MAX_BYTES) toast(`${file.name} is ${fmtBytes(file.size)} — loaded the first 64 MB`, true);
}

async function loadExample(kind) {
  let bytes;
  if (kind === 'page') {
    const parts = await Promise.all(['index.html', 'app.js', 'style.css'].map((u) => fetch(u).then((r) => r.arrayBuffer())));
    const total = parts.reduce((a, p) => a + p.byteLength, 0);
    bytes = new Uint8Array(total);
    let o = 0; for (const p of parts) { bytes.set(new Uint8Array(p), o); o += p.byteLength; }
  } else if (kind === 'text') {
    const para = 'Everything on a computer is a long line of numbers. A photograph, a song, a spreadsheet of quarterly figures, the program that opens them: underneath, each is the same alphabet of 256 symbols. Read those symbols as air pressure and they become sound. Structure in the data becomes rhythm and pitch; repetition becomes tone; randomness becomes noise. ';
    bytes = new TextEncoder().encode(para.repeat(60));
  } else if (kind === 'noise') {
    bytes = new Uint8Array(96 * 1024);
    for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
  } else {
    bytes = new Uint8Array(160 * 1024);
    let o = 0;
    const seg = (len, fn) => { for (let i = 0; i < len && o < bytes.length; i++, o++) bytes[o] = fn(i) & 255; };
    while (o < bytes.length) {
      const p = 8 + ((Math.random() * 120) | 0);
      seg(6000, (i) => 128 + 100 * Math.sin((2 * Math.PI * i) / p));
      seg(3000, (i) => (i * 3) % 256);
      seg(2000, () => 128);
      seg(4000, (i) => ((i >> 5) & 1 ? 200 : 60) + (Math.random() * 20));
      seg(5000, (i) => 128 + 60 * Math.sin(i / p) + 60 * Math.sin(i / (p * 1.5)));
    }
  }
  loadBytes(bytes, `example: ${kind}`);
}

/* =========================== editing core =========================== */
function rangeOrAll() {
  if (S.sel) return [Math.min(S.sel[0], S.sel[1]), Math.max(S.sel[0], S.sel[1])];
  return [0, S.bytes.length - 1];
}

function pushUndo(entry) {
  S.undo.push(entry);
  S.redo = [];
  let total = 0;
  for (let i = S.undo.length - 1; i >= 0; i--) {
    const e = S.undo[i];
    total += e.type === 'full' ? e.bytes.length : e.old.length;
    if (total > 256 * 1048576 || S.undo.length - i > 300) { S.undo.splice(0, i + 1); break; }
  }
}

// In-place change of [s, s+newBytes.length)
function patch(s, newBytes) {
  const old = S.bytes.slice(s, s + newBytes.length);
  pushUndo({ type: 'patch', off: s, old, neu: newBytes.slice(), cursor: S.cursor });
  S.bytes.set(newBytes, s);
  S.mask.fill(1, s, s + newBytes.length);
  S.modified = true;
}

// Length-changing change: replace [s, s+del) with ins
function splice(s, del, ins) {
  pushUndo({ type: 'full', bytes: S.bytes, mask: S.mask, cursor: S.cursor });
  const n = S.bytes.length - del + ins.length;
  if (n > MAX_BYTES) { S.undo.pop(); toast('That would exceed 64 MB', true); return false; }
  if (n <= 0) { S.undo.pop(); toast("Can't delete every byte", true); return false; }
  const b = new Uint8Array(n), m = new Uint8Array(n);
  b.set(S.bytes.subarray(0, s)); m.set(S.mask.subarray(0, s));
  b.set(ins, s); m.fill(1, s, s + ins.length);
  b.set(S.bytes.subarray(s + del), s + ins.length); m.set(S.mask.subarray(s + del), s + ins.length);
  S.bytes = b; S.mask = m; S.modified = true;
  return true;
}

function applyEntry(e, dir) {
  if (e.type === 'patch') {
    S.bytes.set(dir < 0 ? e.old : e.neu, e.off);
    S.cursor = e.cursor;
    return e;
  }
  const back = { type: 'full', bytes: S.bytes, mask: S.mask, cursor: S.cursor };
  S.bytes = e.bytes; S.mask = e.mask; S.cursor = Math.min(e.cursor, S.bytes.length - 1);
  return back;
}

function undo() {
  if (!S.bytes || !S.undo.length) return;
  const e = S.undo.pop();
  S.redo.push(applyEntry(e, -1));
  S.modified = S.undo.length > 0;
  S.sel = null; afterEdit({ render: true });
}
function redo() {
  if (!S.bytes || !S.redo.length) return;
  const e = S.redo.pop();
  S.undo.push(applyEntry(e, +1));
  S.modified = true;
  S.sel = null; afterEdit({ render: true });
}

function silenceByte() {
  const f = $('#sx-format').value;
  return f === 'u8' ? 0x80 : f === 'u16le' ? null : f === 'mulaw' ? 0xff : f === 'alaw' ? 0xd5 : 0;
}

const OPS = {
  randomise(s, e) { const a = new Uint8Array(e - s + 1); for (let i = 0; i < a.length; i += 65536) crypto.getRandomValues(a.subarray(i, i + 65536)); patch(s, a); },
  invert(s, e) { const a = S.bytes.slice(s, e + 1); for (let i = 0; i < a.length; i++) a[i] ^= 0xff; patch(s, a); },
  xor(s, e, v) { const p = parsePattern(v), a = S.bytes.slice(s, e + 1); for (let i = 0; i < a.length; i++) a[i] ^= p[i % p.length]; patch(s, a); },
  add(s, e, v) { const k = parseInt(v, v.trim().startsWith('0x') ? 16 : 10) || 0, a = S.bytes.slice(s, e + 1); for (let i = 0; i < a.length; i++) a[i] = (a[i] + k) & 255; patch(s, a); },
  reverse(s, e) { patch(s, S.bytes.slice(s, e + 1).reverse()); },
  sort(s, e) { patch(s, S.bytes.slice(s, e + 1).sort()); },
  shuffle(s, e) { const a = S.bytes.slice(s, e + 1); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } patch(s, a); },
  smooth(s, e, v) {
    const w = clamp(parseInt(v) || 8, 2, 4096), src = S.bytes.slice(s, e + 1), a = new Uint8Array(src.length);
    let sum = 0; const q = [];
    for (let i = 0; i < src.length; i++) { sum += src[i]; q.push(src[i]); if (q.length > w) sum -= q.shift(); a[i] = Math.round(sum / q.length); }
    patch(s, a);
  },
  bits(s, e, v) { const n = clamp(parseInt(v) || 3, 1, 7), m = (0xff << (8 - n)) & 0xff, a = S.bytes.slice(s, e + 1); for (let i = 0; i < a.length; i++) a[i] &= m; patch(s, a); },
  sine(s, e, v) { const p = Math.max(4, parseFloat(v) || 32), a = new Uint8Array(e - s + 1); for (let i = 0; i < a.length; i++) a[i] = Math.round(128 + 127 * Math.sin((2 * Math.PI * i) / p)); patch(s, a); },
  ramp(s, e) { const a = new Uint8Array(e - s + 1); for (let i = 0; i < a.length; i++) a[i] = Math.round((i / Math.max(1, a.length - 1)) * 255); patch(s, a); },
  zero(s, e) { const z = silenceByte(); const a = new Uint8Array(e - s + 1); if (z === null) { for (let i = 0; i < a.length; i++) a[i] = i & 1 ? 0x80 : 0; } else a.fill(z); patch(s, a); },
  fill(s, e, v) { const p = parsePattern(v), a = new Uint8Array(e - s + 1); for (let i = 0; i < a.length; i++) a[i] = p[i % p.length]; patch(s, a); },
  repeat(s, e, v) {
    if (!S.sel) return toast('Select some bytes to repeat first', true);
    const n = clamp(parseInt(v) || 2, 1, 1000), chunk = S.bytes.slice(s, e + 1), ins = new Uint8Array(chunk.length * n);
    for (let i = 0; i < n; i++) ins.set(chunk, i * chunk.length);
    if (splice(e + 1, 0, ins)) S.sel = [s, e + ins.length];
  },
  insert(_s, _e, v) {
    const ins = new TextEncoder().encode(v);
    if (!ins.length) return;
    if (splice(S.cursor, 0, ins)) { S.sel = [S.cursor, S.cursor + ins.length - 1]; }
  },
  delete(s, e) {
    if (!S.sel) return toast('Select the bytes to delete first', true);
    if (splice(s, e - s + 1, new Uint8Array(0))) { S.sel = null; S.cursor = Math.min(s, S.bytes.length - 1); }
  },
};

function runOp(name) {
  if (!S.bytes) return toast('Load a file first', true);
  const [s, e] = rangeOrAll();
  OPS[name](s, e, $('#opValue').value);
  afterEdit({ render: true });
}

/* after any change to bytes */
const debouncedRender = debounce(() => renderSox(), 650);
const debouncedMap = debounce(() => { buildByteMap(); }, 120);
function afterEdit({ render = false, force = false } = {}) {
  if (!S.bytes) return;
  S.cursor = clamp(S.cursor, 0, S.bytes.length - 1);
  updateHexGeometry();
  renderHex();
  updateSelBar();
  const changed = S.modified || S.bytes.length !== S.original.length;
  $('#fileInfo').textContent = `${S.name} · ${fmtBytes(S.bytes.length)}${changed ? ' · modified' : ''}`;
  $('#dropName').textContent = $('#fileInfo').textContent;
  if (force) buildByteMap(); else debouncedMap();
  S.textStale = true;
  if (render && (force || $('#autoRender').checked)) force ? renderSox() : debouncedRender();
}

/* =========================== hex view =========================== */
const hexScroll = $('#hexScroll'), hexRows = $('#hexRows'), hexSpacer = $('#hexSpacer');
let hexScale = 1;

// 16 bytes per row when it fits, 8 on narrow screens (phones)
let charW = 0;
function layoutHex() {
  if (!charW) {
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(20);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    hexScroll.appendChild(probe);
    charW = probe.getBoundingClientRect().width / 20 || 7.5;
    probe.remove();
  }
  const need16 = (8 + 48 + 16) * charW + 24 + 20 + 4;
  const next = hexScroll.clientWidth >= need16 ? 16 : 8;
  const narrow = next === 8;
  hexScroll.classList.toggle('narrow', narrow);
  $('#hexHead').classList.toggle('narrow', narrow);
  const cols = Array.from({ length: next }, (_, i) => hex2(i)).join(' ');
  $('#hexHead').innerHTML = `<span class="h-off">${narrow ? 'off' : 'offset'}</span><span class="h-bytes">${cols}</span><span>ascii</span>`;
  if (next !== ROW) { ROW = next; if (S.bytes) { updateHexGeometry(); scrollToByte(S.cursor); } }
}
let offDigits = 8;
const offHex = (n) => ROW === 8 ? n.toString(16).toUpperCase().padStart(offDigits, '0') : hex8(n);
function updateOffsetWidth() {
  // on narrow screens only use as many offset digits as the file needs
  offDigits = S.bytes ? Math.max(4, Math.max(1, S.bytes.length - 1).toString(16).length) : 6;
  for (const el of [hexScroll, $('#hexHead')]) el.style.setProperty('--offw', offDigits + 'ch');
}

function updateHexGeometry() {
  updateOffsetWidth();
  const rows = Math.ceil(S.bytes.length / ROW);
  const total = rows * ROW_H + 8;
  const h = Math.min(total, MAX_SCROLL_PX);
  hexSpacer.style.height = h + 'px';
  const view = hexScroll.clientHeight;
  hexScale = total > MAX_SCROLL_PX ? (total - view) / (h - view) : 1;
}

function visibleRowRange() {
  const virt = hexScroll.scrollTop * hexScale;
  const first = Math.floor(virt / ROW_H);
  const count = Math.ceil(hexScroll.clientHeight / ROW_H) + 1;
  return { first, count, shift: virt - first * ROW_H };
}

function renderHex() {
  if (!S.bytes) return;
  const { first, count, shift } = visibleRowRange();
  const b = S.bytes, n = b.length, m = S.mask;
  const [ss, se] = S.sel ? [Math.min(...S.sel), Math.max(...S.sel)] : [-1, -2];
  const pr = S.playRange || [-1, -2];
  const curRow = Math.floor(S.cursor / ROW);
  let html = '';
  for (let r = first; r < first + count; r++) {
    const o = r * ROW;
    if (o >= n) break;
    let hx = '', as = '';
    for (let i = o; i < o + ROW; i++) {
      if (i >= n) { hx += '<b>  </b>'; continue; }
      const v = b[i], k = byteClass(v);
      let cls = 'k' + k;
      if (i >= ss && i <= se) cls += ' sel';
      if (i === S.cursor) cls += ' cur';
      if (m[i]) cls += ' edited';
      if (i >= pr[0] && i <= pr[1]) cls += ' play';
      hx += `<b data-i="${i}" class="${cls}">${hex2(v)}</b>`;
      const ch = v >= 32 && v < 127 ? (v === 60 ? '&lt;' : v === 38 ? '&amp;' : String.fromCharCode(v)) : '·';
      as += `<b data-i="${i}" data-a="1" class="${cls}">${ch}</b>`;
    }
    const rc = r === curRow ? 'hrow currow' : r % 16 === 0 ? 'hrow bar' : r % 4 === 0 ? 'hrow beat' : 'hrow';
    html += `<div class="${rc}"><span class="off">${offHex(o)}</span><span class="bytes">${hx}</span><span class="asc">${as}</span></div>`;
  }
  hexRows.style.top = hexScroll.scrollTop - shift + 'px';
  hexRows.innerHTML = html;
}

// toggle the 'play' class in place, so the DOM under the mouse isn't replaced
function paintPlayRange() {
  const [a, b] = S.playRange || [-1, -2];
  for (const el of hexRows.getElementsByTagName('b')) {
    const i = +el.dataset.i;
    el.classList.toggle('play', el.dataset.i !== undefined && i >= a && i <= b);
  }
}

function scrollToByte(off, center = true) {
  const row = Math.floor(off / ROW);
  const { first, count } = visibleRowRange();
  if (!center && row >= first + 1 && row < first + count - 2) return;
  const target = row * ROW_H - (center ? hexScroll.clientHeight / 2 : row < first + 1 ? 0 : hexScroll.clientHeight - ROW_H * 2);
  hexScroll.scrollTop = Math.max(0, target / hexScale);
}

function updateSelBar() {
  if (!S.bytes) return;
  const v = S.bytes[S.cursor];
  let t = `@${hex8(S.cursor)} (${S.cursor}) = ${hex2(v)} · ${v} · ${(v << 24 >> 24)} signed`;
  if (S.sel) {
    const [a, b] = [Math.min(...S.sel), Math.max(...S.sel)];
    t = `sel ${fmtBytes(b - a + 1)} ${hex8(a)}–${hex8(b)} · ` + t;
  }
  $('#selBar').textContent = t;
  $('#modeBtn').textContent = S.mode === 'hex' ? 'HEX' : 'ASCII';
  $('#opScope').textContent = S.sel
    ? `applies to the ${fmtBytes(Math.abs(S.sel[1] - S.sel[0]) + 1)} selected`
    : 'applies to the whole file — select bytes to narrow it';
}

let dragging = false, touchTap = null;
hexScroll.addEventListener('scroll', () => requestAnimationFrame(renderHex));
function pickByte(i, isAscii, extend) {
  S.mode = isAscii ? 'ascii' : 'hex';
  if (extend) S.sel = [S.anchor, i];
  else { S.anchor = i; S.sel = null; }
  S.cursor = i; S.nibble = 0;
  renderHex(); updateSelBar();
}
hexScroll.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('b[data-i]');
  if (!el || !S.bytes) return;
  if (e.pointerType === 'mouse') {
    e.preventDefault();
    hexScroll.focus({ preventScroll: true });
    pickByte(+el.dataset.i, !!el.dataset.a, e.shiftKey || S.extend);
    dragging = true;
  } else {
    // touch / pen: wait for pointerup so scrolling still works
    touchTap = { x: e.clientX, y: e.clientY, i: +el.dataset.i, a: !!el.dataset.a };
  }
});
hexScroll.addEventListener('pointermove', (e) => {
  if (touchTap && Math.hypot(e.clientX - touchTap.x, e.clientY - touchTap.y) > 8) touchTap = null;
  if (!dragging) return;
  const el = e.target.closest('b[data-i]');
  if (!el) return;
  const i = +el.dataset.i;
  if (i !== S.cursor) { S.sel = [S.anchor, i]; S.cursor = i; renderHex(); updateSelBar(); }
});
hexScroll.addEventListener('pointerup', () => {
  if (touchTap) pickByte(touchTap.i, touchTap.a, S.extend);
  touchTap = null;
});
hexScroll.addEventListener('pointercancel', () => (touchTap = null));
window.addEventListener('pointerup', () => (dragging = false));

// one typed character → byte write at the cursor (shared by keyboard + the type-in box)
function typeChar(ch) {
  let val = null;
  if (S.mode === 'hex') {
    if (!/^[0-9a-f]$/i.test(ch)) return false;
    const d = parseInt(ch, 16), cur = S.bytes[S.cursor];
    val = S.nibble === 0 ? (d << 4) | (cur & 0x0f) : (cur & 0xf0) | d;
  } else {
    const c = ch.codePointAt(0);
    val = c < 256 ? c : 63;
  }
  S.sel = null;
  patch(S.cursor, new Uint8Array([val]));
  if (S.mode === 'hex' && S.nibble === 0) S.nibble = 1;
  else { S.nibble = 0; S.cursor = Math.min(S.bytes.length - 1, S.cursor + 1); }
  return true;
}

$('#poke').addEventListener('input', (e) => {
  const v = e.target.value;
  e.target.value = '';
  if (!S.bytes) return toast('Load a file first', true);
  let any = false;
  for (const ch of v) any = typeChar(ch) || any;
  if (!any) { if (S.mode === 'hex') toast('Hex mode: type 0-9 and A-F (switch to ASCII for text)'); return; }
  scrollToByte(S.cursor, false);
  afterEdit({ render: true });
});
$('#modeBtn').addEventListener('click', () => { S.mode = S.mode === 'hex' ? 'ascii' : 'hex'; S.nibble = 0; updateSelBar(); });
$('#extendBtn').addEventListener('click', (e) => {
  S.extend = !S.extend;
  e.currentTarget.setAttribute('aria-pressed', S.extend);
  if (S.extend && S.bytes && !S.sel) S.anchor = S.cursor;
});

hexScroll.addEventListener('keydown', (e) => {
  if (!S.bytes) return;
  const n = S.bytes.length, meta = e.metaKey || e.ctrlKey;
  const move = (to) => {
    to = clamp(to, 0, n - 1);
    if (e.shiftKey) { if (!S.sel) S.anchor = S.cursor; S.sel = [S.anchor, to]; } else S.sel = null;
    S.cursor = to; S.nibble = 0;
    scrollToByte(to, false); renderHex(); updateSelBar();
    e.preventDefault();
  };
  const page = Math.floor(hexScroll.clientHeight / ROW_H) * ROW;
  if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if (meta && e.key.toLowerCase() === 'a') { e.preventDefault(); S.sel = [0, n - 1]; S.anchor = 0; renderHex(); updateSelBar(); return; }
  if (meta) return;
  switch (e.key) {
    case 'ArrowLeft': return move(S.cursor - 1);
    case 'ArrowRight': return move(S.cursor + 1);
    case 'ArrowUp': return move(S.cursor - ROW);
    case 'ArrowDown': return move(S.cursor + ROW);
    case 'PageUp': return move(S.cursor - page);
    case 'PageDown': return move(S.cursor + page);
    case 'Home': return move(S.cursor - (S.cursor % ROW));
    case 'End': return move(S.cursor - (S.cursor % ROW) + ROW - 1);
    case 'Escape': S.sel = null; renderHex(); updateSelBar(); return;
    case 'Tab': e.preventDefault(); S.mode = S.mode === 'hex' ? 'ascii' : 'hex'; S.nibble = 0; updateSelBar(); return;
    case 'Backspace': case 'Delete':
      e.preventDefault();
      if (S.sel && Math.abs(S.sel[1] - S.sel[0]) > 0) return runOp('delete');
      return move(S.cursor - (e.key === 'Backspace' ? 1 : 0));
  }
  if (e.key.length !== 1 || !typeChar(e.key)) return;
  e.preventDefault();
  scrollToByte(S.cursor, false);
  afterEdit({ render: true });
});

/* =========================== byte map =========================== */
const byteMap = $('#byteMap');
let mapBase = null;

function buildByteMap() {
  if (!S.bytes) return;
  sizeCanvas(byteMap);
  const W = byteMap.width, H = byteMap.height, b = S.bytes, n = b.length;
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const g = off.getContext('2d');
  g.fillStyle = COL.well; g.fillRect(0, 0, W, H);
  const barH = H * 0.78;
  const ent = new Float32Array(W);
  const counts = new Uint32Array(6), hist = new Uint32Array(256);
  for (let x = 0; x < W; x++) {
    const s = Math.floor((x / W) * n), e = Math.max(s + 1, Math.floor(((x + 1) / W) * n));
    const step = Math.max(1, Math.floor((e - s) / 2048));
    counts.fill(0); hist.fill(0);
    let tot = 0;
    for (let i = s; i < e && i < n; i += step) { counts[byteClass(b[i])]++; hist[b[i]]++; tot++; }
    let y = barH;
    for (let k = 0; k < 6; k++) {
      if (!counts[k]) continue;
      const h = (counts[k] / tot) * barH;
      g.fillStyle = CLASS_COLORS[k]; g.fillRect(x, y - h, 1, h + 0.5); y -= h;
    }
    let H2 = 0;
    for (let v = 0; v < 256; v++) if (hist[v]) { const p = hist[v] / tot; H2 -= p * Math.log2(p); }
    ent[x] = H2 / Math.min(8, Math.log2(Math.max(2, tot)));
  }
  g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1.2 * DPR();
  g.beginPath();
  for (let x = 0; x < W; x++) { const y = barH - ent[x] * (barH - 3) - 1; x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
  mapBase = off;
}

function drawByteMap(now) {
  if (!mapBase || !S.bytes) return;
  if (sizeCanvas(byteMap)) { buildByteMap(); }
  const g = byteMap.getContext('2d'), W = byteMap.width, H = byteMap.height, n = S.bytes.length;
  g.drawImage(mapBase, 0, 0);
  const x = (o) => (o / n) * W;
  // hex viewport
  const { first, count } = visibleRowRange();
  g.fillStyle = 'rgba(255,255,255,.12)';
  g.fillRect(x(first * ROW), 0, Math.max(2, x(count * ROW)), H);
  if (S.sel) {
    const [a, b] = [Math.min(...S.sel), Math.max(...S.sel)];
    g.fillStyle = 'rgba(95,211,224,.35)'; g.fillRect(x(a), 0, Math.max(2, x(b - a + 1)), H);
  }
  if (S.map) {
    g.fillStyle = 'rgba(242,169,59,.12)';
    g.fillRect(x(S.map.start), H * 0.8, x(S.map.len * S.map.cover), H * 0.2);
    // granular region (in bytes)
    const r0 = fracToByte(S.region[0]), r1 = fracToByte(S.region[1]);
    g.fillStyle = 'rgba(242,169,59,.7)';
    g.fillRect(Math.min(x(r0), x(r1)), H * 0.86, Math.max(2, Math.abs(x(r1) - x(r0))), H * 0.14);
  }
  // grains
  const dpr = DPR();
  for (const gr of S.grains) {
    const a = 1 - (now - gr.t) / 700;
    if (a <= 0) continue;
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.fillRect(x(fracToByte(gr.pos)) - dpr / 2, 0, dpr, H * 0.8);
  }
}

let mapDrag = null;
const mapOffset = (e) => {
  const r = byteMap.getBoundingClientRect();
  return clamp(Math.floor(((e.clientX - r.left) / r.width) * S.bytes.length), 0, S.bytes.length - 1);
};
let mapStart = null;
function mapJump(o) { S.cursor = o; S.sel = null; S.anchor = o; scrollToByte(o); renderHex(); updateSelBar(); }
byteMap.addEventListener('pointerdown', (e) => {
  if (!S.bytes) return;
  mapDrag = mapOffset(e);
  mapStart = { x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse', jumped: false };
  if (!mapStart.touch) { byteMap.setPointerCapture(e.pointerId); mapJump(mapDrag); mapStart.jumped = true; }
});
byteMap.addEventListener('pointerup', () => { if (mapDrag !== null && mapStart && !mapStart.jumped) mapJump(mapDrag); });
byteMap.addEventListener('pointermove', (e) => {
  if (mapDrag === null) return;
  if (mapStart.touch && !mapStart.jumped) {
    const dx = Math.abs(e.clientX - mapStart.x), dy = Math.abs(e.clientY - mapStart.y);
    if (dy > dx && dy > 6) { mapDrag = null; return; } // vertical: user is scrolling the page
    if (dx > 6) { mapJump(mapDrag); mapStart.jumped = true; }
    else return;
  }
  const o = mapOffset(e);
  if (Math.abs(o - mapDrag) > S.bytes.length / 400) { S.sel = [mapDrag, o]; S.cursor = o; renderHex(); updateSelBar(); }
});
const endMap = () => (mapDrag = null);
byteMap.addEventListener('pointerup', endMap);
byteMap.addEventListener('pointercancel', endMap);

/* =========================== text tab =========================== */
const TEXT_LIMIT = 4 * 1048576;
function textTabLoad() {
  const ta = $('#textEdit');
  if (!S.bytes) return;
  if (S.bytes.length > TEXT_LIMIT) {
    ta.value = ''; ta.disabled = true;
    $('#textNote').textContent = `Text editing is limited to files under ${fmtBytes(TEXT_LIMIT)} — use the hex view.`;
    return;
  }
  ta.disabled = false;
  $('#textNote').textContent = 'Edit the file as Latin-1 text (one character per byte, so offsets stay exact). Non-printing bytes appear as control characters.';
  let s = '';
  for (let i = 0; i < S.bytes.length; i += 32768) s += String.fromCharCode.apply(null, S.bytes.subarray(i, i + 32768));
  ta.value = s;
  S.textStale = false;
}
function textTabApply() {
  if (!S.bytes) return;
  const str = $('#textEdit').value, out = [];
  const enc = new TextEncoder();
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 256) out.push(c); else out.push(...enc.encode(ch));
  }
  const nb = new Uint8Array(out);
  if (!nb.length) return toast('Text is empty', true);
  pushUndo({ type: 'full', bytes: S.bytes, mask: S.mask, cursor: S.cursor });
  const m = new Uint8Array(nb.length);
  for (let i = 0; i < nb.length; i++) m[i] = i >= S.bytes.length || S.bytes[i] !== nb[i] ? 1 : S.mask[i];
  S.bytes = nb; S.mask = m; S.sel = null; S.modified = true;
  afterEdit({ render: true });
  S.textStale = false;
  toast('Text applied');
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  $$('.tab').forEach((x) => { x.classList.toggle('active', x === t); x.setAttribute('aria-selected', x === t); });
  $('#tab-hex').hidden = t.dataset.tab !== 'hex';
  $('#tab-text').hidden = t.dataset.tab !== 'text';
  if (t.dataset.tab === 'text' && S.textStale) textTabLoad();
  if (t.dataset.tab === 'hex') { layoutHex(); updateHexGeometry(); renderHex(); }
}));
$('#applyText').addEventListener('click', textTabApply);
$('#reloadText').addEventListener('click', textTabLoad);

/* =========================== SoX rendering =========================== */
const SOX_IDS = ['format', 'rate', 'channels', 'pitch', 'speed', 'tempo', 'lowpass', 'highpass', 'bass', 'treble', 'overdrive', 'reverb', 'maxdur'];
const SOX_FLAGS = ['reverse', 'chorus', 'phaser', 'flanger', 'echo', 'tremolo'];
const BPF = { u8: 1, s8: 1, mulaw: 1, alaw: 1, s16le: 2, s16be: 2, u16le: 2, s24le: 3, s32le: 4, f32le: 4, vox: 0.5, ima: 0.5 };
let renderAbort = null, renderSeq = 0;

function soxParams() {
  const q = new URLSearchParams();
  for (const id of SOX_IDS) q.set(id, $('#sx-' + id).value);
  for (const f of SOX_FLAGS) q.set(f, $('#sx-' + f).checked ? '1' : '0');
  return q;
}

async function renderSox() {
  if (!S.bytes) return;
  let start = 0, len = S.bytes.length;
  if ($('#sx-selonly').checked && S.sel) {
    const [a, b] = [Math.min(...S.sel), Math.max(...S.sel)];
    start = a; len = b - a + 1;
  }
  await ensureAudio();
  const q = soxParams();
  const sr = ctx.sampleRate;
  q.set('outrate', [44100, 48000, 88200, 96000].includes(sr) ? sr : 44100);
  q.set('bits', String(Q.s.bits));
  q.set('rateq', Q.s.rateq);
  const fmt = q.get('format'), rate = +q.get('rate');
  const ch = fmt === 'vox' || fmt === 'ima' ? 1 : +q.get('channels');
  const rawDur = len / (BPF[fmt] * ch) / rate;
  const maxdur = +q.get('maxdur');

  renderAbort?.abort();
  renderAbort = new AbortController();
  const seq = ++renderSeq;
  $('#renderInfo').textContent = 'rendering…';
  $('#renderBtn').disabled = true;
  try {
    const t0 = performance.now();
    const { wav: ab, cmd } = await renderBytes(S.bytes.slice(start, start + len), q, renderAbort.signal);
    S.renderMs = performance.now() - t0;
    if (seq !== renderSeq) return;
    S.wavBlob = new Blob([ab], { type: 'audio/wav' });
    let buf;
    try { buf = await ctx.decodeAudioData(ab.slice(0)); }
    catch (e) {
      if (Q.s.bits === 24) { Q.s.bits = 16; toast('This browser can\'t decode 24-bit WAV — using 16-bit'); return renderSox(); }
      throw e;
    }
    if (seq !== renderSeq) return;
    S.audioBuf = buf;
    S.map = { start, len, cover: Math.min(1, maxdur / rawDur), reverse: q.get('reverse') === '1' };
    const L = buf.getChannelData(0).slice(), R = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice();
    granNode.port.postMessage({ type: 'buffer', L, R, sampleRate: buf.sampleRate }, [L.buffer, R.buffer]);
    S.peaks = null;
    $('#soxCmd').textContent = cmd;
    const trimmed = rawDur > maxdur ? ` · trimmed from ${rawDur.toFixed(1)}s` : '';
    $('#renderInfo').textContent = `${buf.duration.toFixed(2)}s stereo · ${fmtBytes(ab.byteLength)} · ${Math.round(S.renderMs)} ms${trimmed}`;
    ['#playBtn', '#directBtn', '#recBtn', '#dlWavBtn'].forEach((s) => ($(s).disabled = false));
    if (S.direct) { stopDirect(); playDirect(); }
  } catch (err) {
    if (err.name === 'AbortError') return;
    $('#renderInfo').textContent = '';
    toast('SoX: ' + err.message, true);
  } finally {
    if (seq === renderSeq) $('#renderBtn').disabled = false;
  }
}

// byte offset ↔ fraction of the rendered audio
function byteToFrac(off) {
  const m = S.map; if (!m) return 0;
  let f = (off - m.start) / m.len / m.cover;
  return m.reverse ? 1 - f : f;
}
function fracToByte(f) {
  const m = S.map; if (!m) return 0;
  if (m.reverse) f = 1 - f;
  return clamp(m.start + f * m.cover * m.len, 0, S.bytes.length - 1);
}

$('#renderBtn').addEventListener('click', () => renderSox());
const debouncedSox = debounce(() => renderSox(), 350);
SOX_IDS.concat(SOX_FLAGS).forEach((id) => $('#sx-' + id).addEventListener('change', debouncedSox));
$('#sx-selonly').addEventListener('change', debouncedSox);
$('#dlWavBtn').addEventListener('click', () => {
  if (!S.wavBlob) return;
  download(S.wavBlob, (S.name.replace(/[^\w.-]+/g, '_') || 'data') + '.sox.wav');
});

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* =========================== audio graph =========================== */
let ctx = null, granNode = null, master, dry, wet, conv, analyser, recDest, vuL, vuR;

function makeImpulse(seconds = Q.s.irSec, decay = 2.6) {
  const len = Math.floor(ctx.sampleRate * seconds), ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4; // slightly darker tail
      d[i] = lp * Math.pow(1 - i / len, decay);
    }
  }
  return ir;
}

let audioReady = null;
function ensureAudio() { return (audioReady ||= initAudio()); } // one shared init, even if called concurrently
async function initAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
  ctx = new AudioContext({ latencyHint: Q.s.latency });
  const revive = () => { if ((S.playing || S.direct) && ctx.state !== 'running') ctx.resume().catch(() => {}); };
  ctx.addEventListener('statechange', () => { if (ctx.state === 'interrupted') setTimeout(revive, 500); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) revive(); });
  window.addEventListener('pointerdown', revive, { passive: true });
  await ctx.audioWorklet.addModule('granular-worklet.js');
  granNode = new AudioWorkletNode(ctx, 'granular', { numberOfInputs: 0, outputChannelCount: [2] });
  master = ctx.createGain();
  dry = ctx.createGain(); wet = ctx.createGain();
  conv = ctx.createConvolver(); conv.buffer = makeImpulse();
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  recDest = ctx.createMediaStreamDestination();
  granNode.connect(dry); granNode.connect(conv); conv.connect(wet);
  dry.connect(master); wet.connect(master);
  master.connect(analyser); analyser.connect(ctx.destination); master.connect(recDest);
  const split = ctx.createChannelSplitter(2);
  vuL = ctx.createAnalyser(); vuR = ctx.createAnalyser(); vuL.fftSize = vuR.fftSize = 512;
  master.connect(split); split.connect(vuL, 0); split.connect(vuR, 1);
  granNode.port.onmessage = (e) => {
    const m = e.data;
    if (m.type !== 'tick') return;
    S.playhead = m.playhead; S.voices = m.voices;
    if (typeof m.load === 'number') Q.reportDSP(m.load);
    const now = performance.now();
    for (let i = 0; i < m.grains.length; i += 4) {
      S.grains.push({ pos: m.grains[i], pan: m.grains[i + 1], size: m.grains[i + 2], t: now });
      S.latestGrain = { pos: m.grains[i], size: m.grains[i + 2] };
    }
    if (S.grains.length > 600) S.grains.splice(0, S.grains.length - 600);
  };
  sendParams();
}

/* =========================== granular params =========================== */
const G_IDS = ['size', 'sizeJitter', 'density', 'irregularity', 'spray', 'scan', 'pitch', 'pitchJitter', 'reverseProb', 'spread', 'drift', 'space', 'gain'];
const drift = { size: 0, density: 0, pitch: 0, spray: 0 };

function gval(id) { return +$('#g-' + id).value; }

function sendParams() {
  if (!granNode) return;
  const d = gval('drift');
  const p = {
    regionStart: S.region[0], regionEnd: S.region[1],
    size: gval('size') * Math.pow(2, drift.size * d * 1.5),
    sizeJitter: gval('sizeJitter'),
    density: gval('density') * Math.pow(2, drift.density * d * 1.5),
    irregularity: gval('irregularity'),
    spray: clamp(gval('spray') + drift.spray * d * 0.3, 0, 1),
    scan: gval('scan'),
    pitch: gval('pitch') + drift.pitch * d * 2,
    pitchJitter: gval('pitchJitter'),
    reverseProb: gval('reverseProb'),
    spread: gval('spread'),
    gain: gval('gain'),
    window: $('#g-window').value,
    scale: $('#g-scale').value,
    maxVoices: Q.voiceCap,
    interp: Q.s.interp,
  };
  granNode.port.postMessage({ type: 'params', params: p });
  const sp = gval('space'), t = ctx.currentTime;
  wet.gain.setTargetAtTime(sp * 0.9, t, 0.05);
  dry.gain.setTargetAtTime(1 - sp * 0.55, t, 0.05);
}

// slow random walks give the soundscape life
setInterval(() => {
  if (!S.playing || gval('drift') === 0) return;
  for (const k in drift) drift[k] = clamp(drift[k] * 0.995 + (Math.random() * 2 - 1) * 0.04, -1, 1);
  sendParams();
}, 120);

function fmtOut(input) {
  const o = input.parentElement.querySelector('output');
  if (!o) return;
  const v = +input.value;
  if (o.dataset.zero && v === 0) o.textContent = o.dataset.zero;
  else if ('pct' in o.dataset) o.textContent = Math.round(v * 100) + '%';
  else {
    const u = o.dataset.unit || '';
    const s = Math.abs(v) >= 100 || Number.isInteger(v) ? String(Math.round(v * 100) / 100) : v.toFixed(Math.abs(v) < 1 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
    o.textContent = (u === 'st' || u === 'c') && v > 0 ? '+' + s + u : s + u;
  }
}
$$('input[type=range]').forEach((r) => { fmtOut(r); r.addEventListener('input', () => fmtOut(r)); });
G_IDS.forEach((id) => $('#g-' + id).addEventListener('input', sendParams));
['window', 'scale'].forEach((id) => $('#g-' + id).addEventListener('change', sendParams));

const PRESETS = {
  'Cloud': { size: 300, sizeJitter: .4, density: 30, irregularity: .5, spray: .3, scan: .005, pitch: 0, pitchJitter: .2, reverseProb: .3, spread: .8, drift: .3, space: .6, window: 'hann', scale: 'free' },
  'Glacier': { size: 1200, sizeJitter: .3, density: 7, irregularity: .4, spray: .08, scan: .002, pitch: -12, pitchJitter: 0, reverseProb: .2, spread: .6, drift: .4, space: .85, window: 'hann', scale: 'octaves' },
  'Swarm': { size: 25, sizeJitter: .5, density: 160, irregularity: .8, spray: .5, scan: .01, pitch: 0, pitchJitter: 7, reverseProb: .4, spread: 1, drift: .2, space: .4, window: 'perc', scale: 'pentatonic' },
  'Dust': { size: 14, sizeJitter: .6, density: 7, irregularity: 1, spray: 1, scan: 0, pitch: 5, pitchJitter: 3, reverseProb: .5, spread: 1, drift: .1, space: .75, window: 'perc', scale: 'free' },
  'Tape scrub': { size: 420, sizeJitter: .2, density: 10, irregularity: .2, spray: .02, scan: .05, pitch: 0, pitchJitter: 0, reverseProb: .5, spread: .4, drift: .2, space: .3, window: 'tukey', scale: 'free' },
  'Choir': { size: 650, sizeJitter: .3, density: 26, irregularity: .4, spray: .2, scan: .003, pitch: 0, pitchJitter: 12, reverseProb: .1, spread: 1, drift: .3, space: .7, window: 'hann', scale: 'fifths' },
  'Machine': { size: 60, sizeJitter: 0, density: 40, irregularity: 0, spray: 0, scan: .03, pitch: 0, pitchJitter: 0, reverseProb: 0, spread: .3, drift: 0, space: .2, window: 'tukey', scale: 'free' },
  'Underwater': { size: 220, sizeJitter: .5, density: 20, irregularity: .6, spray: .4, scan: -.004, pitch: -19, pitchJitter: 2, reverseProb: .6, spread: .9, drift: .5, space: .8, window: 'swell', scale: 'free' },
};
// "Default" = the settings the page starts with, captured from the controls
const PRESET_KEYS = [...G_IDS.filter((k) => k !== 'gain'), 'window', 'scale'];
const DEFAULT_PRESET = Object.fromEntries(PRESET_KEYS.map((k) => { const el = $('#g-' + k); return [k, el.type === 'range' ? +el.value : el.value]; }));
const presetSel = $('#presetSel');
presetSel.add(new Option('Default', 'Default'));
for (const k in PRESETS) presetSel.add(new Option(k, k));
const customOpt = new Option('Custom', 'custom');
customOpt.disabled = true; // shown when settings no longer match a preset; can't be picked
presetSel.add(customOpt);
presetSel.value = 'Default';
const markCustom = () => { if (presetSel.value !== 'custom') presetSel.value = 'custom'; };
G_IDS.filter((k) => k !== 'gain').forEach((id) => $('#g-' + id).addEventListener('input', markCustom));
['window', 'scale'].forEach((id) => $('#g-' + id).addEventListener('change', markCustom));

function applyPreset(p) {
  for (const k in p) {
    const el = $('#g-' + k);
    if (!el) continue;
    el.value = p[k];
    if (el.type === 'range') fmtOut(el);
  }
  sendParams();
}
presetSel.addEventListener('change', (e) => {
  const name = e.target.value;
  const p = name === 'Default' ? DEFAULT_PRESET : PRESETS[name];
  if (p) { applyPreset(p); toast(`Preset: ${name}`); }
});
$('#randomiseGrains').addEventListener('click', () => {
  const r = (a, b) => a + Math.random() * (b - a);
  const lg = (a, b) => Math.exp(r(Math.log(a), Math.log(b)));
  applyPreset({
    size: Math.round(lg(10, 1200)), sizeJitter: r(0, .7), density: Math.round(lg(2, 120) * 2) / 2, irregularity: r(0, 1),
    spray: r(0, .8), scan: Math.random() < .3 ? 0 : r(-.03, .05), pitch: Math.round(r(-14, 8)), pitchJitter: Math.random() < .5 ? 0 : r(0, 12),
    reverseProb: r(0, .7), spread: r(.3, 1), drift: r(0, .6), space: r(.1, .9),
    window: ['hann', 'tukey', 'triangle', 'perc', 'swell'][(Math.random() * 5) | 0],
    scale: ['free', 'octaves', 'fifths', 'pentatonic', 'minor'][(Math.random() * 5) | 0],
  });
  // pick a random region too
  const w = r(.05, .6), s0 = r(0, 1 - w);
  S.region = [s0, s0 + w]; sendParams();
  markCustom();
});

/* =========================== transport =========================== */
function setBtn(sel, on, ico, lbl) {
  const b = $(sel);
  b.classList.toggle('on', on);
  b.querySelector('.ico').textContent = ico;
  if (lbl) b.querySelector('.lbl').textContent = lbl;
  b.setAttribute('aria-pressed', on);
}
$('#playBtn').addEventListener('click', async () => {
  await ensureAudio(); await ctx.resume();
  S.playing = !S.playing;
  granNode.port.postMessage({ type: 'run', value: S.playing });
  setBtn('#playBtn', S.playing, S.playing ? '■' : '▶');
});

function playDirect() {
  const src = ctx.createBufferSource();
  src.buffer = S.audioBuf; src.loop = true;
  src.connect(master);
  src.start();
  S.direct = { src, t0: ctx.currentTime };
  setBtn('#directBtn', true, '■');
}
function stopDirect() {
  S.direct?.src.stop(); S.direct = null;
  setBtn('#directBtn', false, '▷');
}
$('#directBtn').addEventListener('click', async () => {
  await ensureAudio(); await ctx.resume();
  if (S.direct) stopDirect(); else if (S.audioBuf) playDirect();
});

$('#recBtn').addEventListener('click', async () => {
  await ensureAudio(); await ctx.resume();
  if (S.recorder) { S.recorder.stop(); return; }
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(recDest.stream, type ? { mimeType: type, audioBitsPerSecond: 256000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType });
    const ext = rec.mimeType.includes('mp4') ? 'm4a' : rec.mimeType.includes('ogg') ? 'ogg' : 'webm';
    download(blob, (S.name.replace(/[^\w.-]+/g, '_') || 'soundscape') + `.soundscape.${ext}`);
    S.recorder = null;
    setBtn('#recBtn', false, '●', 'Rec');
  };
  rec.start(500);
  S.recorder = rec;
  setBtn('#recBtn', true, '●', 'Save');
  if (!S.playing) $('#playBtn').click();
});

/* =========================== waveform =========================== */
const wave = $('#wave');

function buildPeaks() {
  const W = wave.width, buf = S.audioBuf;
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const n = L.length, mins = new Float32Array(W), maxs = new Float32Array(W), rms = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const s = Math.floor((x / W) * n), e = Math.floor(((x + 1) / W) * n);
    const step = Math.max(1, Math.floor((e - s) / 1500));
    let mn = 1, mx = -1, sq = 0, c = 0;
    for (let i = s; i < e; i += step) { const v = (L[i] + R[i]) * 0.5; if (v < mn) mn = v; if (v > mx) mx = v; sq += v * v; c++; }
    mins[x] = c ? mn : 0; maxs[x] = c ? mx : 0; rms[x] = c ? Math.sqrt(sq / c) : 0;
  }
  S.peaks = { mins, maxs, rms, W };
}

function drawWave(now) {
  sizeCanvas(wave);
  const g = wave.getContext('2d'), W = wave.width, H = wave.height, mid = H / 2, dpr = DPR();
  g.fillStyle = COL.well; g.fillRect(0, 0, W, H);
  if (!S.audioBuf) {
    g.fillStyle = COL.dim; g.font = `${11 * dpr}px Silkscreen, ui-monospace, monospace`; g.textAlign = 'center';
    g.fillText(S.bytes ? 'rendering…' : 'no audio yet — drop a file', W / 2, mid);
    return;
  }
  if (!S.peaks || S.peaks.W !== W) buildPeaks();
  const [r0, r1] = [Math.min(...S.region), Math.max(...S.region)];
  const key = `${W}x${H}:${r0}:${r1}`;
  if (!S.waveBase || S.waveBase.key !== key || S.waveBase.peaks !== S.peaks) S.waveBase = drawWaveBase(W, H, r0, r1, dpr, key);
  g.drawImage(S.waveBase.canvas, 0, 0);
  drawWaveOverlay(g, W, H, mid, dpr, r0, r1, now);
}

function drawWaveBase(W, H, r0, r1, dpr, key) {
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), mid = H / 2;
  g.fillStyle = COL.well; g.fillRect(0, 0, W, H);
  const { mins, maxs, rms } = S.peaks;
  // sample-editor grid: a line per second, brighter every 4
  const dur = S.audioBuf.duration, stepS = dur > 120 ? 10 : dur > 30 ? 5 : 1;
  for (let t = stepS, k = 1; t < dur; t += stepS, k++) {
    g.fillStyle = k % 4 === 0 ? '#242320' : '#181816';
    g.fillRect(Math.round((t / dur) * W), 0, dpr, H);
  }
  g.fillStyle = '#1e1c18'; g.fillRect(0, mid, W, dpr);
  g.fillStyle = 'rgba(242,169,59,.07)'; g.fillRect(r0 * W, 0, (r1 - r0) * W, H);
  for (let x = 0; x < W; x++) {
    const inR = x >= r0 * W && x <= r1 * W;
    g.fillStyle = inR ? '#3e5a22' : '#2b2925';
    g.fillRect(x, mid - maxs[x] * mid * 0.95, 1, Math.max(1, (maxs[x] - mins[x]) * mid * 0.95));
    g.fillStyle = inR ? COL.lcd : '#4a463f';
    g.fillRect(x, mid - rms[x] * mid * 0.95, 1, Math.max(1, rms[x] * 2 * mid * 0.95));
  }
  g.fillStyle = COL.amber;
  g.fillRect(r0 * W, 0, dpr * 1.5, H); g.fillRect(r1 * W - dpr * 1.5, 0, dpr * 1.5, H);
  g.fillRect(r0 * W, 0, 6 * dpr, 3 * dpr); g.fillRect(r1 * W - 6 * dpr, 0, 6 * dpr, 3 * dpr);
  // time labels
  g.fillStyle = '#6b665c'; g.font = `${10 * dpr}px "JetBrains Mono", ui-monospace, monospace`; g.textAlign = 'left';
  g.fillText('0s', 4 * dpr, H - 5 * dpr);
  g.textAlign = 'right'; g.fillText(S.audioBuf.duration.toFixed(1) + 's', W - 4 * dpr, H - 5 * dpr);
  return { canvas: c, key, peaks: S.peaks };
}

function drawWaveOverlay(g, W, H, mid, dpr, r0, r1, now) {
  // grains
  for (const gr of S.grains) {
    const a = 1 - (now - gr.t) / 900;
    if (a <= 0) continue;
    const x = gr.pos * W, y = mid - gr.pan * mid * 0.8;
    const rad = clamp(Math.sqrt(gr.size) * 0.5, 2, 18) * dpr;
    g.fillStyle = `rgba(242,169,59,${a * 0.55})`;
    g.beginPath(); g.arc(x, y, rad * (1.4 - a * 0.4), 0, Math.PI * 2); g.fill();
  }
  // playheads
  if (S.playing) {
    const px = (r0 + S.playhead * (r1 - r0)) * W;
    g.fillStyle = '#ffffff'; g.fillRect(px - dpr / 2, 0, dpr, H);
  }
  if (S.direct) {
    const t = (ctx.currentTime - S.direct.t0) % S.audioBuf.duration;
    g.fillStyle = COL.cyan; g.fillRect((t / S.audioBuf.duration) * W, 0, dpr, H);
  }
}

let waveDrag = null;
const waveFrac = (e) => { const r = wave.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1); };
wave.addEventListener('pointerdown', (e) => {
  if (!S.audioBuf) return;
  wave.setPointerCapture(e.pointerId);
  waveDrag = { x0: e.clientX, y0: e.clientY, f0: waveFrac(e), moved: false };
});
wave.addEventListener('pointermove', (e) => {
  if (!waveDrag) return;
  if (!waveDrag.moved && e.pointerType !== 'mouse' && Math.abs(e.clientY - waveDrag.y0) > Math.abs(e.clientX - waveDrag.x0)) { waveDrag = null; return; }
  if (Math.abs(e.clientX - waveDrag.x0) > 6) waveDrag.moved = true;
  if (waveDrag.moved) { S.region = [Math.min(waveDrag.f0, waveFrac(e)), Math.max(waveDrag.f0, waveFrac(e))]; sendParams(); }
});
wave.addEventListener('pointercancel', () => (waveDrag = null));
wave.addEventListener('pointerup', (e) => {
  if (!waveDrag) return;
  const f = waveFrac(e);
  if (waveDrag.moved) {
    S.region = [Math.min(waveDrag.f0, f), Math.max(waveDrag.f0, f)];
    if (S.region[1] - S.region[0] < 0.002) S.region[1] = Math.min(1, S.region[0] + 0.002);
  } else {
    let [r0, r1] = S.region;
    if (f < r0 || f > r1) { const w = r1 - r0; r0 = clamp(f - w / 2, 0, 1 - w); r1 = r0 + w; S.region = [r0, r1]; }
    const ph = (f - S.region[0]) / (S.region[1] - S.region[0]);
    granNode?.port.postMessage({ type: 'seek', value: clamp(ph, 0, 0.9999) });
    // follow in the hex view: which bytes made this sound?
    if (S.bytes && S.map) { const o = Math.floor(fracToByte(f)); S.cursor = o; scrollToByte(o); renderHex(); updateSelBar(); }
  }
  sendParams();
  waveDrag = null;
});
$('#regionReset').addEventListener('click', () => { S.region = [0, 1]; sendParams(); });
wave.addEventListener('dblclick', () => { S.region = [0, 1]; sendParams(); });

$('#granSelBtn').addEventListener('click', async () => {
  if (!S.sel || !S.map) return toast(S.map ? 'Select some bytes first' : 'Render first', true);
  const [a, b] = [Math.min(...S.sel), Math.max(...S.sel)];
  const m = S.map;
  const raw0 = (a - m.start) / m.len / m.cover, raw1 = (b + 1 - m.start) / m.len / m.cover;
  if (raw0 < -1e-9 || raw1 > 1 + 1e-9) {
    // part of the selection isn't in the current render (max length / render range): render just these bytes
    $('#sx-selonly').checked = true;
    toast(`Rendering the ${fmtBytes(b - a + 1)} selected with SoX…`);
    await renderSox();
    S.region = [0, 1]; sendParams();
    const used = Math.round((b - a + 1) * Math.min(1, S.map.cover));
    toast(S.map.cover < 1
      ? `Rendered the first ${fmtBytes(used)} of the selection — raise "max length" or the sample rate to hear all ${fmtBytes(b - a + 1)}`
      : `Grains now read from the ${fmtBytes(b - a + 1)} selected ("selection only" is on)`);
    return;
  }
  let f0 = byteToFrac(a), f1 = byteToFrac(b + 1);
  [f0, f1] = [clamp(Math.min(f0, f1), 0, 1), clamp(Math.max(f0, f1), 0, 1)];
  S.region = [f0, f1]; sendParams();
  toast(`Grains now read from ${fmtBytes(b - a + 1)} of data`);
});

/* =========================== scope + meters + animation =========================== */
const vu = $('#vu'), vuBuf = new Float32Array(512), vuPeak = [0, 0], vuHold = [0, 0];
function drawVU() {
  sizeCanvas(vu);
  const g = vu.getContext('2d'), W = vu.width, H = vu.height, dpr = DPR();
  g.fillStyle = COL.well; g.fillRect(0, 0, W, H);
  const segs = Math.max(8, Math.floor(W / (5 * dpr))), sw = W / segs, rowH = (H - 3 * dpr) / 2;
  [vuL, vuR].forEach((an, c) => {
    let pk = 0;
    if (an) { an.getFloatTimeDomainData(vuBuf); for (let i = 0; i < vuBuf.length; i++) pk = Math.max(pk, Math.abs(vuBuf[i])); }
    const db = pk > 0 ? 20 * Math.log10(pk) : -60;
    const lvl = clamp((db + 48) / 48, 0, 1);
    vuPeak[c] = Math.max(lvl, vuPeak[c] * 0.92);
    vuHold[c] = lvl >= vuHold[c] ? lvl : Math.max(0, vuHold[c] - 0.006);
    const y = dpr + c * (rowH + dpr);
    for (let s = 0; s < segs; s++) {
      const f = (s + 1) / segs, lit = f <= vuPeak[c], hold = Math.abs(f - vuHold[c]) < 1 / segs;
      const col = f > 0.9 ? COL.red : f > 0.72 ? COL.amber : COL.lcd;
      g.fillStyle = lit || hold ? col : '#1c1c1a';
      g.globalAlpha = lit || hold ? 1 : 1;
      g.fillRect(s * sw + dpr * 0.5, y, sw - dpr * 1.5, rowH);
    }
  });
}
let lcdCache = '';
function updateLCDs() {
  const [r0, r1] = [Math.min(...S.region), Math.max(...S.region)];
  const pos = S.playing ? ((r0 + S.playhead * (r1 - r0)) * 100).toFixed(1).padStart(4, '0') : '--.-';
  const vox = String(S.playing ? S.voices : 0).padStart(3, '0');
  const len = S.audioBuf ? S.audioBuf.duration.toFixed(1) + 's' : '--.-s';
  const reg = `${String(Math.round(r0 * 100)).padStart(3, '0')}–${String(Math.round(r1 * 100)).padStart(3, '0')}%`;
  const dsp = S.playing ? String(Math.min(999, Math.round(Q.dspLoad * 100))).padStart(2, '0') + '%' : '--%';
  const key = pos + vox + len + reg + dsp;
  if (key === lcdCache) return;
  lcdCache = key;
  $('#lcdDsp').textContent = dsp;
  $('#lcdPos').textContent = pos; $('#lcdVox').textContent = vox; $('#lcdLen').textContent = len; $('#lcdReg').textContent = reg;
}

const scope = $('#scope');
let scopeData = null, lastPlayRangeUpdate = 0, lastFrame = 0, skip = false;
function frame(now) {
  Q.frame(now - lastFrame); lastFrame = now;
  Q.tick(S.playing);
  skip = Q.fps < 60 ? !skip : false;
  if (skip) { requestAnimationFrame(frame); return; }
  drawWave(now);
  drawByteMap(now);
  if (analyser) {
    sizeCanvas(scope);
    const g = scope.getContext('2d'), W = scope.width, H = scope.height;
    scopeData ||= new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(scopeData);
    g.fillStyle = COL.well; g.fillRect(0, 0, W, H);
    g.fillStyle = '#1a2410'; g.fillRect(0, H / 2, W, 1);
    g.strokeStyle = COL.lcd; g.lineWidth = DPR(); g.beginPath();
    for (let i = 0; i < scopeData.length; i++) { const x = (i / scopeData.length) * W, y = H / 2 - scopeData[i] * H * 0.45; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  drawVU();
  updateLCDs();
  // highlight bytes that the most recent grain is reading (~8 fps)
  if (S.playing && S.latestGrain && S.map && now - lastPlayRangeUpdate > 120) {
    lastPlayRangeUpdate = now;
    const lg = S.latestGrain;
    const halfF = (lg.size / 1000) / S.audioBuf.duration / 2;
    const a = Math.floor(fracToByte(lg.pos - halfF)), b = Math.ceil(fracToByte(lg.pos + halfF));
    S.playRange = [Math.min(a, b), Math.max(a, b)];
    paintPlayRange();
  } else if (!S.playing && S.playRange) { S.playRange = null; paintPlayRange(); }
  const cutoff = now - 1000;
  while (S.grains.length && S.grains[0].t < cutoff) S.grains.shift();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* =========================== wiring =========================== */
$('#pickBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => e.target.files[0] && loadFile(e.target.files[0]));
$('#exampleSel').addEventListener('change', (e) => { if (e.target.value) loadExample(e.target.value); e.target.value = ''; });
$$('.op').forEach((b) => b.addEventListener('click', () => runOp(b.dataset.op)));
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#revertBtn').addEventListener('click', () => {
  if (!S.bytes) return;
  pushUndo({ type: 'full', bytes: S.bytes, mask: S.mask, cursor: S.cursor });
  S.bytes = S.original.slice(); S.mask = new Uint8Array(S.bytes.length); S.sel = null; S.modified = false;
  afterEdit({ render: true });
});
$('#saveBytesBtn').addEventListener('click', () => S.bytes && download(new Blob([S.bytes]), 'edited_' + (S.name.replace(/[^\w.-]+/g, '_') || 'data')));

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select, button, label, .chip, [contenteditable]') || e.target === hexScroll) return;
  if (e.code === 'Space' && !$('#playBtn').disabled) { e.preventDefault(); $('#playBtn').click(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});
window.addEventListener('resize', debounce(() => { S.peaks = null; charW = 0; layoutHex(); buildByteMap(); if (S.bytes) { updateHexGeometry(); renderHex(); } }, 150));
layoutHex();
document.fonts?.ready.then(() => { charW = 0; layoutHex(); if (S.bytes) { updateHexGeometry(); renderHex(); } });

detectEngine().then((eng) => {
  const el = $('#soxStatus');
  el.className = 'status ok';
  el.title = eng.kind === 'native' ? 'Native SoX via the local server' : 'SoX compiled to WebAssembly, running in your browser';
  el.innerHTML = `<span class="led"></span><span>SoX ${eng.version.replace(/^v$/, '')} · ${eng.kind}</span>`;
}).catch((err) => {
  $('#soxStatus').className = 'status bad';
  $('#soxStatus').innerHTML = '<span class="led"></span><span>SoX failed to load</span>';
  toast('Could not start SoX: ' + err.message, true);
});

/* =========================== adaptive quality =========================== */
let voiceToastShown = false;
function showQuality() {
  const sel = $('#qualitySel');
  sel.value = Q.mode;
  sel.options[0].textContent = `Auto (${TIERS[Q.autoTier].label})`;
  $('#qualityInfo').textContent = `${Q.describe()} · ${Q.s.interp} interpolation · up to ${Q.voiceCap} voices · SoX ${Q.s.bits}-bit${Q.s.rateq ? ' HQ resampling' : ''} · score ${Math.round(Q.score)}${isIOS ? ' · iOS' : ''}`;
}
function onQualityChange(why) {
  if (why === 'tier') {
    sendParams();
    if (ctx) conv.buffer = makeImpulse();
    S.peaks = null; S.waveBase = null; buildByteMap();
    if (S.bytes) renderSox();
    toast(`Quality: ${Q.describe()}`);
  } else if (why.startsWith('voices')) {
    sendParams();
    if (why === 'voices-down' && !voiceToastShown) { voiceToastShown = true; toast(`Audio engine busy — capping grains at ${Q.voiceCap} voices to keep playback smooth`); }
  } else {
    S.peaks = null; S.waveBase = null; buildByteMap();
  }
  showQuality();
}
$('#qualitySel').addEventListener('change', (e) => Q.setMode(e.target.value));
showQuality();
window.__sonify = { Q }; // handy for debugging in the console

/* =========================== about dialog =========================== */
const about = $('#about');
$('#aboutBtn').addEventListener('click', () => { showQuality(); about.showModal(); });
$('#aboutClose').addEventListener('click', () => about.close());
about.addEventListener('click', (e) => { if (e.target === about) about.close(); }); // click on the backdrop
