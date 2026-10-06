import { spawn } from 'node:child_process';

// Run a binary, collect stderr, reject with a readable error on non-zero exit.
export function run(bin, args, { timeoutMs = 10 * 60 * 1000, quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    const timer = setTimeout(() => { p.kill(); reject(new Error(`${bin} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${bin} exited ${code}\n${args.join(' ')}\n${err.slice(-2000)}`));
    });
    if (!quiet) p.stderr.pipe(process.stderr);
  });
}
