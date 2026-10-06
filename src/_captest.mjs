// Dev helper: node src/_captest.mjs <url> <workDir>
import fs from 'node:fs/promises';
import { capture } from './stages/capture.js';
const [url, work] = process.argv.slice(2);
await fs.mkdir(work, { recursive: true });
const info = await capture(url, work);
const { headings, paragraphs, ctas, fonts, logo, ...rest } = info;
console.log(JSON.stringify({
  ...rest,
  logo: logo ? { ...logo, svg: logo.svg ? logo.svg.slice(0, 80) + '…' : undefined } : null,
  headings: headings.slice(0, 8), paragraphs: paragraphs.slice(0, 3), ctas: ctas.slice(0, 5),
  fonts: { ...fonts, faces: fonts.faces.length },
}, null, 1));
