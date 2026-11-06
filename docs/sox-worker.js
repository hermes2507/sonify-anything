// Runs SoX 14.4.2 (compiled to WebAssembly with emscripten) off the main thread.
// Each render gets a fresh SoX instance — SoX's main() isn't re-entrant — but the
// compiled WebAssembly module is cached, so a new instance costs only milliseconds.
const V = new URL(import.meta.url).search; // release tag, see index.html
const { default: createSox } = await import('./sox/sox.js' + V);

const wasmUrl = new URL('./sox/sox.wasm' + V, import.meta.url);
let compiled = null;

async function getCompiled() {
  if (compiled) return compiled;
  try {
    compiled = await WebAssembly.compileStreaming(fetch(wasmUrl));
  } catch {
    // some servers send the wrong MIME type for .wasm
    compiled = await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer());
  }
  return compiled;
}

async function run(args, input) {
  const module = await getCompiled();
  const log = [];
  const sox = await createSox({
    noInitialRun: true,
    print: (s) => log.push(s),
    printErr: (s) => log.push(s),
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then((inst) => done(inst, module));
      return {};
    },
  });
  if (input) sox.FS.writeFile('/in.bin', new Uint8Array(input));
  let status = 0;
  try {
    status = sox.callMain(args);
  } catch (e) {
    // EXIT_RUNTIME build: exit() surfaces as an ExitStatus exception
    status = e && typeof e.status === 'number' ? e.status : 1;
    if (!(e && 'status' in e)) log.push(String(e));
  }
  return { sox, status, log };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'version') {
      const { log } = await run(['--version']);
      const v = (log.join(' ').match(/v\d[\d.]*/) || ['v14.4.2'])[0];
      self.postMessage({ id, ok: true, version: v });
      return;
    }
    const { sox, status, log } = await run(e.data.args, e.data.input);
    let out = null;
    try { out = sox.FS.readFile('/out.wav'); } catch { /* not written */ }
    if (status !== 0 || !out || !out.length) throw new Error(log.filter(Boolean).join('\n') || `SoX exited with ${status}`);
    const wav = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    self.postMessage({ id, ok: true, wav }, [wav]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err.message || err).replace(/^.*?sox:?\s*/i, '') });
  }
};
