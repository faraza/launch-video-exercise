// Stage 2: understand. Claude reads the capture (text + screenshots) and writes
// the brief: what the product is, who it is for, the 6-shot story, on-screen
// copy in the site's language, the look, the music, the caption, and a camera
// prompt for each screenshot that Seedance will animate.
import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { env, FFMPEG } from '../lib/env.js';
import { run } from '../lib/run.js';
import { log } from '../lib/log.js';
import { TONES, MOTIONS } from '../lib/brief.js';

const SYSTEM = `You are the creative director for a 20-second launch video of a product website.
You receive what a headless browser captured from the site: visible headings and copy, buttons,
colors, fonts, and screenshots. You decide the story and write every word that appears on screen.

Principles
- Understand first: what the product is, who it is for, what the one thing worth saying is.
- Use the site's own language and its strongest phrases. Do not invent features or claims.
- On-screen text is read in ~3 seconds: headlines at most 8 words, sub lines at most 14 words.
- Write on-screen text and the caption in the site's primary language.
- The look must come from the site: pick background, text and accent colors that match the hero
  screenshot, not generic defaults. Prefer the hero's dominant background as the card background.
- Pick screenshots that show the product itself (UI, output, pricing, proof), not footers or boilerplate.
- Have a point of view: the video should feel like it was made for this product, by someone who gets it.

Structure (exactly 6 shots, in this order, durations in seconds):
1. title   (3.5)  headline = the one-line promise (NOT the product name; the name is shown automatically), sub = one supporting sentence or empty
2. screen  (5)    hero or product screenshot, animated
3. point   (3)    first benefit or who it is for
4. screen  (5)    a second screenshot (can be "fullpage.png" with motion "scroll" to tour the site)
5. point   (3)    second benefit, proof, or differentiator
6. cta     (3.5)  the site's call to action + domain

Screen shots get a "prompt" for an image-to-video model that animates the screenshot as its first
frame. Describe only camera motion and subtle ambient movement (slow push-in, gentle parallax,
cursor drifting, soft light). Keep all UI and text crisp and unchanged. Never ask for new text,
people, or scene changes. One or two sentences.

Tone picks the music: "upbeat" bright and friendly, "driving" punchy and technical, "chill" calm and premium.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'tagline', 'oneLiner', 'audience', 'tone', 'language', 'style', 'shots', 'caption'],
  properties: {
    product: { type: 'string', description: 'Product or company name as the site uses it' },
    tagline: { type: 'string', description: 'The one-line promise, <= 8 words' },
    oneLiner: { type: 'string', description: 'What it is and for whom, one sentence' },
    audience: { type: 'string' },
    tone: { type: 'string', enum: TONES },
    language: { type: 'string', description: 'BCP-47 primary language of on-screen text, e.g. en, zh, de' },
    style: {
      type: 'object', additionalProperties: false, required: ['bg', 'fg', 'accent'],
      properties: {
        bg: { type: 'string', description: 'hex background for text cards, matching the hero' },
        fg: { type: 'string', description: 'hex text color with strong contrast on bg' },
        accent: { type: 'string', description: 'hex brand accent (buttons, highlights)' },
      },
    },
    shots: {
      type: 'array', minItems: 6, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'headline', 'sub', 'shot', 'motion', 'prompt', 'duration'],
        properties: {
          kind: { type: 'string', enum: ['title', 'screen', 'point', 'cta'] },
          headline: { type: 'string', description: 'text cards: the headline; screen shots: empty' },
          sub: { type: 'string', description: 'text cards: optional sub line; cta: the domain; screen: empty' },
          shot: { type: 'string', description: 'screen shots: screenshot filename from the capture; else empty' },
          motion: { type: 'string', enum: [...MOTIONS, ''], description: 'screen shots: fallback motion if the video model is unavailable' },
          prompt: { type: 'string', description: 'screen shots: image-to-video camera prompt; else empty' },
          duration: { type: 'number' },
        },
      },
    },
    caption: { type: 'string', description: 'Social post, 2-3 sentences, ends with the URL, no hashtag spam' },
  },
};

export async function understand(cap, workDir) {
  const client = new Anthropic({ apiKey: env.anthropicKey });
  const images = await prepareImages(cap, workDir);

  const content = [];
  for (const im of images) {
    content.push({ type: 'text', text: `Screenshot ${im.file} (scrollY=${im.scrollY}):` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im.b64 } });
  }
  content.push({ type: 'text', text: `Captured data:\n${JSON.stringify(captureSummary(cap), null, 1)}\n\nWrite the brief.` });

  log('brief', `asking ${env.claudeModel} with ${images.length} screenshots`);
  const res = await client.messages.parse({
    model: env.claudeModel,
    max_tokens: 8000,
    output_config: { effort: 'medium', format: jsonSchemaOutputFormat(SCHEMA) },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`refused: ${res.stop_details?.category || ''}`);
  const brief = res.parsed_output;
  if (!brief) throw new Error('no parsed brief');
  await fs.writeFile(path.join(workDir, 'brief.claude.json'), JSON.stringify(brief, null, 2));
  log('brief', `tokens in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);
  return brief;
}

// Downscaled JPEGs keep the request small and fast; Claude does not need 1080p to read a page.
async function prepareImages(cap, workDir) {
  const out = [];
  for (const s of cap.shots.slice(0, 4)) {
    const jpg = path.join(workDir, s.file.replace(/\.png$/, '.jpg'));
    await run(FFMPEG, ['-y', '-i', path.join(workDir, s.file), '-vf', 'scale=1280:-2', '-q:v', '4', jpg]);
    out.push({ file: s.file, scrollY: s.scrollY, b64: (await fs.readFile(jpg)).toString('base64') });
  }
  return out;
}

function captureSummary(cap) {
  return {
    url: cap.finalUrl || cap.url,
    title: cap.title, lang: cap.lang, description: cap.description, ogTitle: cap.ogTitle, siteName: cap.siteName,
    headings: cap.headings.slice(0, 30).map(h => `${h.tag}@${h.y}: ${h.text}`),
    paragraphs: cap.paragraphs.slice(0, 20).map(p => `@${p.y}: ${p.text}`),
    buttons: cap.ctas.slice(0, 12).map(c => `${c.text}${c.bg ? ` (${c.bg})` : ''}`),
    nav: cap.navLinks,
    colors: cap.colors,
    heroPalette: cap.heroPalette.slice(0, 10),
    fonts: { heading: cap.fonts.heading, body: cap.fonts.body },
    screenshots: cap.shots.map(s => s.file).concat(cap.pageHeight > 1600 ? ['fullpage.png (for motion "scroll" only)'] : []),
  };
}
