// Dev helper: generate one Seedance clip from an existing screenshot.
//   node src/_cliptest.mjs <workDir> [shot.png]
// Never prints the key.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, hasArk } from './lib/env.js';
import { generateClips } from './stages/seedance.js';

const [workDir, shotFile = 'shot-00.png'] = process.argv.slice(2);
if (!workDir) { console.error('usage: node src/_cliptest.mjs <workDir> [shot.png]'); process.exit(2); }
console.log('ark key present:', hasArk(), '| base:', env.arkBaseUrl, '| model:', env.seedanceModel);
const brief = { shots: [{ kind: 'screen', shot: shotFile, duration: 5,
  prompt: 'Slow, smooth cinematic push-in toward the center of the page. Subtle parallax between headline and background. Keep every UI element and all text perfectly crisp and unchanged.' }] };
const t0 = Date.now();
const res = await generateClips(brief, {}, path.resolve(workDir), [0]);
console.log('result:', res, `in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (res[0]) console.log('size', (await fs.stat(res[0])).size);
