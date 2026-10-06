// Stage 1: capture. Opens the URL in headless Chromium and writes to work/:
//   capture.json  – text, colors, fonts, language, screenshot manifest
//   shot-*.png    – 1920x1080 viewport screenshots down the page
//   fullpage.png  – full-page screenshot (width 1920)
// Pure extraction, no interpretation; the understand stage decides what matters.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { log } from '../lib/log.js';

const VIEWPORT = { width: 1920, height: 1080 };
const MAX_SHOTS = 6;

// Button text that accepts/dismisses a consent banner, in common languages. Matched against
// short button labels only, so "accept" inside a paragraph never triggers.
const CONSENT_RE = /(accept|agree|allow|got it|^ok(ay)?$|dismiss|^close$|understood|同意|接受|我知道了|^确定$|akzeptieren|zustimmen|verstanden|einverstanden|accepter|j'accepte|aceptar|aceitar|accetta|accepteer|akkoord|godkänn|accepter alle|zgadzam|akceptuj|принять|同意する|許可|동의|수락)/i;

export async function capture(url, workDir) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'en-US',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  log('capture', `open ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => log('capture', 'networkidle timeout, continuing'));
  } catch (e) {
    throw new Error(`could not load ${url}: ${e.message}`);
  }
  await page.waitForTimeout(1200); // let hero animations settle

  await dismissConsent(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);

  const info = await page.evaluate(extractInPage);
  info.url = url;
  info.finalUrl = page.url();

  // Hero first, before any scrolling triggers lazy effects.
  const shots = [];
  await page.screenshot({ path: path.join(workDir, 'shot-00.png') });
  shots.push({ file: 'shot-00.png', scrollY: 0, kind: 'hero' });

  // Trigger lazy-loading by scrolling through once, then capture by viewport.
  const pageHeight = await autoScroll(page);
  const step = VIEWPORT.height;
  const positions = [];
  for (let y = step; y < pageHeight - step / 2 && positions.length < MAX_SHOTS - 1; y += step) positions.push(y);
  for (let i = 0; i < positions.length; i++) {
    await page.evaluate(y => window.scrollTo(0, y), positions[i]);
    await page.waitForTimeout(500);
    const file = `shot-${String(i + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: path.join(workDir, file) });
    shots.push({ file, scrollY: positions[i], kind: 'section' });
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  // Full page, capped so a 30-screen marketing site does not take forever.
  await page.screenshot({ path: path.join(workDir, 'fullpage.png'), fullPage: true }).catch(() => {});
  info.pageHeight = pageHeight;
  info.shots = shots;

  // Pixel-based palette from the hero screenshot (computed styles lie on gradient/image heroes).
  info.heroPalette = await paletteFromImage(context, path.join(workDir, 'shot-00.png'));

  await browser.close();
  await fs.writeFile(path.join(workDir, 'capture.json'), JSON.stringify(info, null, 2));
  log('capture', `${shots.length} shots, ${info.headings.length} headings, lang=${info.lang || '?'}`);
  return info;
}

// Click the accept button of a cookie banner (main document, shadow roots, and iframes).
// Prefers "accept all" style buttons; tries twice because many banners mount late.
async function dismissConsent(page) {
  const finder = (reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const all = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll('button, [role=button], a, input[type=button], input[type=submit]')) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    const cands = [];
    for (const el of all) {
      const txt = (el.innerText || el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 40 || !re.test(txt)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 14) continue;
      // Must live inside something that looks like a consent dialog, or be fixed-positioned.
      let node = el, inDialog = false, depth = 0;
      while (node && depth++ < 12) {
        const cs = node instanceof Element ? getComputedStyle(node) : null;
        const id = node instanceof Element ? `${node.id} ${node.className} ${node.getAttribute?.('aria-label') || ''}` : '';
        if (cs && (cs.position === 'fixed' || cs.position === 'sticky')) inDialog = true;
        if (/cookie|consent|gdpr|privacy|banner|cmp|onetrust|didomi|usercentrics|cookiebot|sp_message/i.test(id)) inDialog = true;
        node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement;
      }
      if (!inDialog) continue;
      const score = (/all|alle|alles|tout|todo|tutti|全部|すべて|모두/i.test(txt) ? 2 : 0) + (el.tagName === 'BUTTON' ? 1 : 0);
      cands.push({ el, txt, score });
    }
    cands.sort((a, b) => b.score - a.score);
    if (cands[0]) { cands[0].el.click(); return cands[0].txt; }
    return null;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let clicked = null;
    try { clicked = await page.evaluate(finder, CONSENT_RE.source); } catch { /* navigation etc. */ }
    if (!clicked) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try { clicked = await frame.evaluate(finder, CONSENT_RE.source); } catch { /* cross-origin frame gone */ }
        if (clicked) break;
      }
    }
    if (clicked) { log('capture', `dismissed consent: "${clicked}"`); await page.waitForTimeout(800); return; }
    await page.waitForTimeout(1000);
  }
}

async function autoScroll(page) {
  return page.evaluate(async () => {
    const h = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    const limit = Math.min(h(), 1080 * 12);
    for (let y = 0; y < limit; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    window.scrollTo(0, 0);
    return Math.min(h(), 1080 * 12);
  });
}

// Runs inside the page. Returns plain JSON.
function extractInPage() {
  const meta = n => document.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content?.trim() || '';
  const visible = el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  };
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const rgbToHex = (rgb) => {
    const m = rgb && rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('');
  };

  // A CTA background is "brand" if it is not the page bg and not a grey.
  const pickCtaBg = (list, pageBg) => {
    const sat = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b); return mx ? (mx - Math.min(r, g, b)) / mx : 0; };
    const c = list.filter(x => x.bg && x.bg !== pageBg && sat(x.bg) > 0.25 && !/\b(search|menu|login|log in|sign in|star|skip to)\b/i.test(x.text));
    return (c.find(x => x.inHero) || c[0])?.bg || null;
  };

  const headings = [];
  for (const el of document.querySelectorAll('h1, h2, h3')) {
    if (!visible(el)) continue;
    const text = clean(el.innerText);
    if (text.length < 2 || text.length > 200) continue;
    const r = el.getBoundingClientRect();
    headings.push({ tag: el.tagName.toLowerCase(), text, y: Math.round(r.top + window.scrollY), fontSize: parseFloat(getComputedStyle(el).fontSize) });
    if (headings.length >= 40) break;
  }

  const paragraphs = [];
  for (const el of document.querySelectorAll('p, li')) {
    if (!visible(el)) continue;
    const text = clean(el.innerText);
    if (text.length < 25 || text.length > 400) continue;
    const r = el.getBoundingClientRect();
    paragraphs.push({ text, y: Math.round(r.top + window.scrollY) });
    if (paragraphs.length >= 40) break;
  }

  const ctas = [];
  for (const el of document.querySelectorAll('a, button')) {
    if (!visible(el)) continue;
    const text = clean(el.innerText);
    if (text.length < 2 || text.length > 40) continue;
    const cs = getComputedStyle(el);
    // Solid color, else first color of a gradient background-image.
    const bg = rgbToHex(cs.backgroundColor) || (cs.backgroundImage !== 'none' ? rgbToHex(cs.backgroundImage) : null);
    const r = el.getBoundingClientRect();
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    const isButtonish = el.tagName === 'BUTTON' || /\b(btn|button|cta)\b/i.test(cls) || (bg && r.height >= 28 && r.height <= 100);
    if (isButtonish && r.height >= 24 && r.height <= 120) {
      ctas.push({ text, bg, color: rgbToHex(cs.color), y: Math.round(r.top + window.scrollY), href: el.href || null, inHero: r.top + window.scrollY < 1000 });
    }
    if (ctas.length >= 20) break;
  }

  const navLinks = [...document.querySelectorAll('nav a, header a')]
    .filter(visible).map(a => clean(a.innerText)).filter(t => t && t.length < 30).slice(0, 15);

  // Logo guess: header image/svg with "logo" in alt/class/src, else first header img.
  let logo = null;
  const headerEls = document.querySelectorAll('header img, nav img, header svg, nav svg, [class*="logo" i] img, [class*="logo" i] svg, a[href="/"] img, a[href="/"] svg');
  for (const el of headerEls) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 12 || r.height > 160) continue;
    if (el.tagName.toLowerCase() === 'svg') { logo = { type: 'svg', svg: el.outerHTML.slice(0, 20000), w: r.width, h: r.height }; }
    else logo = { type: 'img', src: el.currentSrc || el.src, alt: el.alt || '', w: r.width, h: r.height };
    break;
  }
  const icon = document.querySelector('link[rel*="icon"]')?.href || null;

  // Fonts actually used by the headline and body.
  const h1 = document.querySelector('h1');
  const fontHeading = h1 ? getComputedStyle(h1).fontFamily : '';
  const fontBody = getComputedStyle(document.body).fontFamily;
  const headingWeight = h1 ? getComputedStyle(h1).fontWeight : '700';
  // @font-face rules we can read (same-origin or CORS-enabled sheets).
  const fontFaces = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules; } catch { continue; }
    if (!rules) continue;
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) {
        let css = rule.cssText;
        // Make relative url() absolute against the sheet.
        const base = sheet.href || location.href;
        css = css.replace(/url\((['"]?)([^'")]+)\1\)/g, (_, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch { return `url(${q}${u}${q})`; } });
        fontFaces.push(css);
        if (fontFaces.length >= 24) break;
      }
    }
  }

  // Colors from computed styles of large surfaces.
  const bodyBg = rgbToHex(getComputedStyle(document.body).backgroundColor) || rgbToHex(getComputedStyle(document.documentElement).backgroundColor) || '#ffffff';
  const headlineColor = h1 ? rgbToHex(getComputedStyle(h1).color) : rgbToHex(getComputedStyle(document.body).color);
  const bodyColor = rgbToHex(getComputedStyle(document.body).color);
  const linkColor = (() => { const a = document.querySelector('main a, a'); return a ? rgbToHex(getComputedStyle(a).color) : null; })();

  return {
    title: clean(document.title),
    lang: document.documentElement.lang || '',
    description: meta('description') || meta('og:description'),
    ogTitle: meta('og:title'),
    ogImage: meta('og:image'),
    siteName: meta('og:site_name') || meta('application-name'),
    headings, paragraphs, ctas, navLinks, logo, icon,
    fonts: { heading: fontHeading, body: fontBody, headingWeight, faces: fontFaces },
    colors: { bodyBg, headlineColor, bodyColor, linkColor, ctaBg: pickCtaBg(ctas, bodyBg) },
  };
}

// Quantize the hero screenshot in a blank page via canvas: returns dominant colors by share.
async function paletteFromImage(context, file) {
  const page = await context.newPage();
  const b64 = (await fs.readFile(file)).toString('base64');
  const palette = await page.evaluate(async (dataUrl) => {
    const img = new Image(); img.src = dataUrl; await img.decode();
    const c = document.createElement('canvas'); c.width = 192; c.height = 108;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i] >> 4, g = d[i + 1] >> 4, b = d[i + 2] >> 4; // 16 levels per channel
      const k = (r << 8) | (g << 4) | b;
      const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; bins.set(k, e);
    }
    const total = d.length / 4;
    const hex = v => Math.round(v).toString(16).padStart(2, '0');
    return [...bins.values()].sort((a, b) => b.n - a.n).slice(0, 24)
      .map(e => ({ hex: `#${hex(e.r / e.n)}${hex(e.g / e.n)}${hex(e.b / e.n)}`, share: +(e.n / total).toFixed(3) }));
  }, `data:image/png;base64,${b64}`);
  await page.close();
  return palette;
}
