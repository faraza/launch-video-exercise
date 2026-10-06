// Orchestrator: url -> out_dir/{video.mp4, poster.png, caption.txt}
//   1. capture    Playwright screenshots + text/colors/fonts        (work/capture.json)
//   2. understand Claude turns that into a brief: story, shots, copy (work/brief.json)
//   3. produce    screen shots -> Seedance clips (fallback: ffmpeg motion); text -> cards
//   4. assemble   crossfade + music -> video.mp4; poster.png; caption.txt
// Every stage reads/writes files in out_dir/work so any one can be re-run or swapped.
import fs from 'node:fs/promises';
import path from 'node:path';
import { capture } from './stages/capture.js';
import { renderCards } from './stages/cards.js';
import { motionClip } from './stages/motion.js';
import { assemble } from './stages/assemble.js';
import { heuristicBrief, validateBrief } from './lib/brief.js';
import { hasAnthropic, hasArk, env } from './lib/env.js';
import { log, elapsedMs } from './lib/log.js';

const [url, outDirArg, ...flags] = process.argv.slice(2);
if (!url || !outDirArg) { console.error('usage: node src/index.js <url> <out_dir> [--no-ai] [--no-clips] [--brief file.json]'); process.exit(2); }
const opts = {
  noAi: flags.includes('--no-ai'),        // skip Claude, use heuristic brief
  noClips: flags.includes('--no-clips'),  // skip Seedance, use ffmpeg motion
  briefFile: flags.includes('--brief') ? flags[flags.indexOf('--brief') + 1] : null,
};

const outDir = path.resolve(outDirArg);
const workDir = path.join(outDir, 'work');
await fs.mkdir(workDir, { recursive: true });

// 1. capture
const cap = await capture(url, workDir);

// 2. understand
let brief;
if (opts.briefFile) {
  brief = JSON.parse(await fs.readFile(opts.briefFile, 'utf8'));
  log('brief', `loaded ${opts.briefFile}`);
} else if (!opts.noAi && hasAnthropic()) {
  const { understand } = await import('./stages/understand.js');
  try {
    brief = await understand(cap, workDir);
  } catch (e) {
    log('brief', `Claude failed (${e.message.slice(0, 120)}); using heuristic brief`);
  }
} else {
  log('brief', opts.noAi ? '--no-ai: heuristic brief' : 'no ANTHROPIC_API_KEY: heuristic brief');
}
brief = validateBrief(brief || heuristicBrief(cap), cap);
await fs.writeFile(path.join(workDir, 'brief.json'), JSON.stringify(brief, null, 2));
log('brief', `${brief.product} | ${brief.tagline} | tone=${brief.tone} | ${brief.shots.length} shots`);

// 3. produce. Clips (slow, remote) start first; cards render locally meanwhile.
const segs = new Array(brief.shots.length);
const screenIdx = brief.shots.map((s, i) => (s.kind === 'screen' ? i : -1)).filter(i => i >= 0);

// Policy: the video model animates only the hero shot (big type survives generation; dense
// body text does not). Other screen shots use pixel-faithful ffmpeg motion. SEEDANCE_ALL_SHOTS=1 overrides.
const aiIdx = process.env.SEEDANCE_ALL_SHOTS === '1' ? screenIdx : screenIdx.slice(0, 1);

let clipsPromise = Promise.resolve({});
if (!opts.noClips && hasArk() && aiIdx.length) {
  const { generateClips } = await import('./stages/seedance.js');
  clipsPromise = generateClips(brief, cap, workDir, aiIdx).catch(e => {
    log('seedance', `failed (${e.message.slice(0, 160)}); falling back to motion`);
    return {};
  });
} else if (screenIdx.length) {
  log('seedance', opts.noClips ? '--no-clips: ffmpeg motion' : 'no ARK_API_KEY: ffmpeg motion');
}

const cards = await renderCards(brief, cap, workDir, outDir);
for (const [i, f] of Object.entries(cards)) segs[i] = f;

const clips = await clipsPromise;
for (const i of screenIdx) {
  segs[i] = clips[i] || await motionClip(brief.shots[i], workDir, i);
}

// 4. assemble
const segments = brief.shots.map((s, i) => ({ file: segs[i], duration: s.duration }));
const total = await assemble(segments, brief, path.join(outDir, 'video.mp4'));
await fs.writeFile(path.join(outDir, 'caption.txt'), brief.caption.trim() + '\n');
log('done', `${(elapsedMs() / 1000).toFixed(0)}s total, video ${total.toFixed(1)}s -> ${outDir}`);
