// Stage 2: understand. Claude reads the capture (text + screenshots) and writes
// the brief: what the product is, who it is for, the three ideas worth showing,
// a cinematic text-to-video prompt that visualizes each idea, one keyword per
// scene, the look (colors), the music tone, and the caption.
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
colors, fonts, and screenshots. Your job is to understand the product and turn it into pictures.

The video is made of generated cinematic footage, not screenshots. Each scene is produced by a
text-to-video model from your prompt, so the viewer must *see* what the product does and for whom:
an autonomous truck company shows a truck on a highway at dawn; a payments API shows a card tap in
a busy café and money moving across a map; a testing tool shows a developer watching green checks
cascade across monitors. Pick concrete, physical, filmable scenes. The product's category, its
customers, its setting and its mood all come from the site.

Principles
- Understand first: what the product is, who it is for, what the three ideas worth showing are.
- Distill to keywords: each scene gets ONE keyword or short phrase (max 4 words, or 8 CJK
  characters) shown as a small caption. Use the site's own strongest words.
- The look must come from the site: card colors and the palette hint in every prompt match the
  hero screenshot. Prefer the hero's dominant background as the card background.
- Have a point of view: a confident, specific story, not a feature list.
- Write on-screen text and the caption in the site's primary language. Write prompts in English.

Structure (exactly 5 shots, in this order, durations in seconds):
1. title  (3)   headline = one-line promise (<= 6 words / 12 CJK chars; the product name is shown automatically)
2. scene  (5)   the core idea: what the product does, shown physically
3. scene  (5)   the customer or the moment of use
4. scene  (5)   the outcome, scale, or differentiator
5. cta    (3.5) headline = the site's call to action, sub = the domain

Prompt rules for each scene (field "prompt", 40-80 words):
- One continuous shot. Name the subject, the action, the setting, time of day, camera move
  (slow dolly, aerial, tracking), lens feel, lighting, and a 2-3 color palette hint from the site.
- Photoreal and cinematic unless the site itself is illustrated or playful.
- Absolutely no on-screen text, logos, captions, subtitles, UI screens or watermarks in the scene.
- No readable faces in close-up; people are fine at a distance or from behind.
- Keep it physically plausible: no morphing, no impossible objects.
Also give each scene a fallback screenshot ("shot") and a motion in case footage cannot be generated.

Tone picks the music: "upbeat" bright and friendly, "driving" punchy and technical, "chill" calm and premium.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['product', 'tagline', 'oneLiner', 'audience', 'keywords', 'tone', 'language', 'style', 'shots', 'caption'],
  properties: {
    product: { type: 'string', description: 'Product or company name as the site uses it' },
    tagline: { type: 'string', description: 'The one-line promise' },
    oneLiner: { type: 'string', description: 'What it is and for whom, one sentence' },
    audience: { type: 'string' },
    keywords: { type: 'array', items: { type: 'string' }, description: '3-6 core selling-point keywords distilled from the site' },
    tone: { type: 'string', enum: TONES },
    language: { type: 'string', description: 'BCP-47 primary language of on-screen text, e.g. en, zh, ja, de' },
    style: {
      type: 'object', additionalProperties: false, required: ['bg', 'fg', 'accent', 'paletteHint'],
      properties: {
        bg: { type: 'string', description: 'hex background for text cards, matching the hero' },
        fg: { type: 'string', description: 'hex text color with strong contrast on bg' },
        accent: { type: 'string', description: 'hex brand accent (buttons, highlights)' },
        paletteHint: { type: 'string', description: 'words for the video model, e.g. "deep navy, electric blue, warm white"' },
      },
    },
    shots: {
      type: 'array', minItems: 5, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['kind', 'headline', 'sub', 'keyword', 'concept', 'prompt', 'shot', 'motion', 'duration'],
        properties: {
          kind: { type: 'string', enum: ['title', 'scene', 'cta'] },
          headline: { type: 'string', description: 'title/cta cards only; else empty' },
          sub: { type: 'string', description: 'title: optional short sub line; cta: the domain; else empty' },
          keyword: { type: 'string', description: 'scene only: the caption keyword, max 4 words / 8 CJK chars' },
          concept: { type: 'string', description: 'scene only: one sentence, what this scene shows and why' },
          prompt: { type: 'string', description: 'scene only: the text-to-video prompt, English, 40-80 words' },
          shot: { type: 'string', description: 'scene only: fallback screenshot filename from the capture' },
          motion: { type: 'string', enum: [...MOTIONS, ''], description: 'scene only: fallback motion' },
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
    screenshots: cap.shots.map(s => s.file).concat(cap.pageHeight > 1600 ? ['fullpage.png (fallback motion "scroll" only)'] : []),
  };
}
