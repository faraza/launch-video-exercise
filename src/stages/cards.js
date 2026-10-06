// Stage: cards. Renders text cards (title / point / cta) as HTML in the site's
// colors and fonts, captures frames deterministically by driving the Web
// Animations clock, and encodes each card to an mp4 segment. Also renders poster.png.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { FFMPEG } from '../lib/env.js';
import { run } from '../lib/run.js';
import { log } from '../lib/log.js';
import { isDark } from '../lib/brief.js';

const FPS = 30;
const W = 1920, H = 1080;

export async function renderCards(brief, cap, workDir, outDir) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  // Fonts hosted on the site need CORS to load from our page; add the header ourselves.
  await context.route(/\.(woff2?|ttf|otf)(\?.*)?$/i, async route => {
    try {
      const res = await route.fetch();
      await route.fulfill({ response: res, headers: { ...res.headers(), 'access-control-allow-origin': '*' } });
    } catch { await route.abort(); }
  });
  const page = await context.newPage();

  const results = {};
  for (let i = 0; i < brief.shots.length; i++) {
    const shot = brief.shots[i];
    if (shot.kind === 'screen' || shot.kind === 'scene') continue;
    const seg = path.join(workDir, `seg-${String(i).padStart(2, '0')}.mp4`);
    await renderCard(page, cardHtml(shot, brief, cap), shot.duration, path.join(workDir, `frames-${i}`), seg);
    results[i] = seg;
    log('cards', `${shot.kind} card ${i} -> ${path.basename(seg)}`);
  }

  // Keyword overlays for footage scenes: transparent PNGs composited in assemble.
  for (let i = 0; i < brief.shots.length; i++) {
    const shot = brief.shots[i];
    if (shot.kind !== 'scene' || !shot.keyword) continue;
    const file = path.join(workDir, `ov-${String(i).padStart(2, '0')}.png`);
    await page.setContent(overlayHtml(shot, brief, cap), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: file, omitBackground: true });
    results[`ov${i}`] = file;
  }

  // Poster: the title card at the end of its intro animation.
  const title = brief.shots.find(s => s.kind === 'title') || brief.shots[0];
  await page.setContent(cardHtml(title, brief, cap), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await seekAnimations(page, 1500);
  await page.screenshot({ path: path.join(outDir, 'poster.png') });
  log('cards', 'poster.png');

  await browser.close();
  return results;
}

async function renderCard(page, html, duration, framesDir, outFile) {
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  const n = Math.round(duration * FPS);
  for (let f = 0; f < n; f++) {
    await seekAnimations(page, (f / FPS) * 1000);
    await page.screenshot({ path: path.join(framesDir, `f-${String(f).padStart(4, '0')}.png`), type: 'png' });
  }
  await run(FFMPEG, ['-y', '-framerate', String(FPS), '-i', path.join(framesDir, 'f-%04d.png'),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS), outFile]);
  await fs.rm(framesDir, { recursive: true, force: true });
}

// Pause every animation and set it to time t (ms). Deterministic frames regardless of render speed.
async function seekAnimations(page, t) {
  await page.evaluate(t => {
    for (const a of document.getAnimations()) { a.pause(); a.currentTime = t; }
  }, t);
}

function esc(s) { return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function words(s, startDelay = 0.15, step = 0.07) {
  return esc(s).split(/\s+/).filter(Boolean)
    .map((w, i) => `<span class="w" style="animation-delay:${(startDelay + i * step).toFixed(2)}s">${w}</span>`).join(' ');
}

function logoHtml(cap) {
  const l = cap.logo;
  if (!l) return '';
  if (l.type === 'svg') return `<div class="logo">${l.svg}</div>`;
  return `<div class="logo"><img src="${esc(l.src)}" alt=""></div>`;
}

// A wide logo is a wordmark that already says the product name; a square one is an icon.
function logoIsWordmark(cap) {
  const l = cap.logo;
  return !!(l && l.w && l.h && l.w / l.h > 2.2);
}

export function cardHtml(shot, brief, cap) {
  const st = brief.style;
  const dark = isDark(st.bg);
  const muted = dark ? 'rgba(255,255,255,.72)' : 'rgba(0,0,0,.62)';
  let headline = shot.headline || brief.tagline || brief.product;
  let sub = shot.sub;
  // Product name is already shown as the eyebrow; never repeat it as the headline.
  if (shot.kind !== 'cta' && headline.trim().toLowerCase() === (brief.product || '').trim().toLowerCase()) {
    headline = sub || brief.tagline || headline;
    sub = sub && headline !== sub ? sub : '';
  }
  const long = headline.length > 48;
  const size = shot.kind === 'title' ? (long ? 92 : 112) : shot.kind === 'cta' ? 96 : (long ? 84 : 104);
  const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(headline);
  const useFont = shot.kind === 'cta' ? st.fontHeading : st.fontHeading;

  let body;
  if (shot.kind === 'title') {
    body = `
      ${logoHtml(cap)}
      ${logoIsWordmark(cap) ? '' : `<div class="name a-up" style="animation-delay:.05s">${esc(brief.product)}</div>`}
      <h1 style="font-size:${size}px">${words(headline, 0.25)}</h1>
      ${sub ? `<p class="sub a-up" style="animation-delay:${(0.4 + headline.split(/\s+/).length * 0.07).toFixed(2)}s">${esc(sub)}</p>` : ''}
      <div class="bar"></div>`;
  } else if (shot.kind === 'cta') {
    body = `
      ${logoHtml(cap)}
      ${logoIsWordmark(cap) || !cap.logo ? '' : `<div class="name a-up" style="animation-delay:.05s">${esc(brief.product)}</div>`}
      <h1 style="font-size:${size}px">${words(headline, 0.2)}</h1>
      <div class="btn a-up" style="animation-delay:.7s">${esc(shot.sub || brief.product)}</div>
      <div class="bar"></div>`;
  } else {
    body = `
      <div class="eyebrow a-up" style="animation-delay:.05s">${esc(brief.product)}</div>
      <h1 style="font-size:${size}px">${words(headline, 0.2)}</h1>
      ${sub ? `<p class="sub a-up" style="animation-delay:.9s">${esc(sub)}</p>` : ''}
      <div class="bar"></div>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8">
<style>
${(st.fontFaces || []).join('\n')}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${st.bg};color:${st.fg}}
body{font-family:${st.fontBody};position:relative}
.glow{position:absolute;width:1400px;height:1400px;border-radius:50%;filter:blur(160px);opacity:${dark ? 0.35 : 0.22};background:${st.accent};right:-500px;top:-600px;animation:drift 6s ease-in-out forwards}
.wrap{position:absolute;left:160px;right:160px;top:50%;transform:translateY(-50%)}
.logo{height:56px;margin-bottom:36px;display:flex;align-items:center}
.logo img,.logo svg{height:56px;width:auto;max-width:320px}
.name,.eyebrow{font-size:34px;letter-spacing:.02em;color:${muted};margin-bottom:28px;font-weight:600}
.eyebrow{color:${st.accent};text-transform:uppercase;letter-spacing:.14em;font-size:28px}
h1{margin:0;font-family:${useFont};font-weight:${st.headingWeight};line-height:${cjk ? 1.25 : 1.08};letter-spacing:${cjk ? 0 : '-.02em'};max-width:1500px;text-wrap:balance}
.w{display:inline-block;opacity:0;transform:translateY(40px);animation:in .7s cubic-bezier(.2,.7,.2,1) forwards}
.sub{font-size:40px;line-height:1.35;color:${muted};margin:36px 0 0;max-width:1300px}
.btn{display:inline-block;margin-top:44px;padding:22px 44px;border-radius:14px;background:${st.accent};color:${isDark(st.accent) ? '#fff' : '#111'};font-size:38px;font-weight:600}
.bar{position:absolute;left:0;bottom:-70px;height:6px;width:0;background:${st.accent};animation:grow 1.2s cubic-bezier(.2,.7,.2,1) .3s forwards}
.a-up{opacity:0;transform:translateY(30px);animation:in .7s cubic-bezier(.2,.7,.2,1) forwards}
@keyframes in{to{opacity:1;transform:none}}
@keyframes grow{to{width:180px}}
@keyframes drift{from{transform:translate(0,0)}to{transform:translate(-120px,80px)}}
</style></head><body><div class="glow"></div><div class="wrap">${body}</div></body></html>`;
}

// Lower-left keyword over generated footage: a soft dark gradient for legibility, the product
// name as a small accent-colored eyebrow, one keyword in the site's heading font.
export function overlayHtml(shot, brief, cap) {
  const st = brief.style;
  const kw = shot.keyword || '';
  const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(kw);
  const size = kw.length > 18 ? 64 : kw.length > 10 ? 76 : 88;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${(st.fontFaces || []).join('\n')}
html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden;background:transparent}
.shade{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.55) 0%,rgba(0,0,0,.18) 32%,rgba(0,0,0,0) 55%)}
.wrap{position:absolute;left:120px;bottom:96px;color:#fff;font-family:${st.fontBody}}
.eyebrow{font-size:26px;letter-spacing:.16em;text-transform:uppercase;color:${st.accent};font-weight:700;margin-bottom:14px;text-shadow:0 2px 12px rgba(0,0,0,.5)}
.kw{font-family:${st.fontHeading};font-weight:${st.headingWeight};font-size:${size}px;line-height:1.1;letter-spacing:${cjk ? 0 : '-.02em'};text-shadow:0 4px 24px rgba(0,0,0,.55)}
.bar{width:120px;height:6px;background:${st.accent};margin-top:22px;border-radius:3px}
</style></head><body><div class="shade"></div><div class="wrap"><div class="eyebrow">${esc(brief.product)}</div><div class="kw">${esc(kw)}</div><div class="bar"></div></div></body></html>`;
}
