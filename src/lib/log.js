const t0 = Date.now();
export function log(stage, msg) {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  process.stderr.write(`[${s}s] ${stage.padEnd(10)} ${msg}\n`);
}
export function elapsedMs() { return Date.now() - t0; }
