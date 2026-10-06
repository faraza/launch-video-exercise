// The "brief" is the contract between understanding and production.
// understand.js (Claude) produces one; heuristicBrief() produces a weaker one
// without any API so the pipeline always has something to render.
//
// {
//   product:   "Playwright",
//   tagline:   "Reliable end-to-end testing",      // <= 8 words, opening card
//   oneLiner:  "...",                               // what it is, for whom
//   audience:  "...",
//   tone:      "upbeat" | "driving" | "chill",      // picks the music
//   language:  "en",                                // on-screen text language
//   style:     { bg, fg, accent, fontHeading, fontBody, headingWeight, fontFaces: [] },
//   shots: [                                        // ~20s total after transitions
//     { kind: "title",  headline, sub, duration },
//     { kind: "screen", shot: "shot-00.png", motion: "zoom-in"|"zoom-out"|"scroll", caption, duration, prompt },
//     { kind: "point",  headline, sub, duration },
//     { kind: "cta",    headline, sub, duration },
//   ],
//   caption:   "social post text"
// }

export const TONES = ['upbeat', 'driving', 'chill'];
export const MOTIONS = ['zoom-in', 'zoom-out', 'scroll'];
export const KINDS = ['title', 'scene', 'screen', 'point', 'cta'];

export function luminance(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 1;
  const [r, g, b] = [m[1], m[2], m[3]].map(h => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function saturation(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map(h => parseInt(h, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

export function isDark(hex) { return luminance(hex) < 0.35; }

// Style purely from capture data. Claude may override any field.
export function styleFromCapture(cap) {
  const pal = cap.heroPalette || [];
  const dominant = pal[0]?.share > 0.3 ? pal[0].hex : cap.colors.bodyBg;
  const bg = dominant || '#111111';
  const fg = isDark(bg) ? '#ffffff' : '#111111';
  const saturated = pal.filter(p => saturation(p.hex) > 0.4 && p.share > 0.002).sort((a, b) => saturation(b.hex) * Math.sqrt(b.share) - saturation(a.hex) * Math.sqrt(a.share))[0]?.hex;
  const accent = cap.colors.ctaBg || saturated || cap.colors.linkColor || (isDark(bg) ? '#8ab4ff' : '#2563eb');
  return {
    bg, fg, accent,
    fontHeading: cap.fonts?.heading || 'system-ui, sans-serif',
    fontBody: cap.fonts?.body || 'system-ui, sans-serif',
    headingWeight: cap.fonts?.headingWeight || '700',
    fontFaces: cap.fonts?.faces || [],
  };
}

// No-API fallback: lifts the site's own words into a fixed story shape.
export function heuristicBrief(cap) {
  const h1 = cap.headings.find(h => h.tag === 'h1')?.text || cap.ogTitle || cap.title;
  const product = cap.siteName || guessName(cap);
  const sub = cap.description || cap.paragraphs[0]?.text || '';
  const points = cap.headings.filter(h => h.tag !== 'h1' && h.text.length <= 70 && h.y > 300).slice(0, 2);
  const shots = cap.shots.map(s => s.file);
  const host = safeHost(cap.finalUrl || cap.url);
  const ctaText = (cap.ctas.filter(c => !/\b(search|menu|login|log in|sign in|star|cookie|close|skip to)\b/i.test(c.text) && c.text.length <= 28)
    .sort((a, b) => (b.bg ? 1 : 0) + (b.inHero ? 1 : 0) - ((a.bg ? 1 : 0) + (a.inHero ? 1 : 0)))[0]?.text) || 'Try it today';
  return {
    product,
    tagline: trim(h1, 70),
    oneLiner: trim(sub, 140),
    audience: '',
    tone: isDark(styleFromCapture(cap).bg) ? 'driving' : 'upbeat',
    language: (cap.lang || 'en').slice(0, 2),
    style: styleFromCapture(cap),
    shots: [
      { kind: 'title', headline: trim(h1, 60), sub: trim(sub, 90), duration: 3 },
      { kind: 'scene', keyword: points[0]?.text ? trim(points[0].text, 28) : product, concept: '', prompt: '', shot: shots[0], motion: 'zoom-in', duration: 5 },
      { kind: 'scene', keyword: points[1]?.text ? trim(points[1].text, 28) : trim(sub, 28), concept: '', prompt: '', shot: shots.length > 1 ? 'fullpage.png' : shots[0], motion: 'scroll', duration: 5 },
      { kind: 'scene', keyword: cap.ctas[0]?.text ? trim(cap.ctas[0].text, 28) : host, concept: '', prompt: '', shot: shots[Math.min(2, shots.length - 1)], motion: 'zoom-out', duration: 5 },
      { kind: 'cta', headline: ctaText, sub: host, duration: 3.5 },
    ],
    caption: `${product}: ${trim(sub, 160)} ${cap.finalUrl || cap.url}`.trim(),
  };
}

export function safeHost(u) { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } }
function trim(s, n) { s = (s || '').trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; }
function guessName(cap) {
  const t = cap.title || '';
  const part = t.split(/\s[|\-–—:]\s/).map(s => s.trim()).filter(Boolean);
  const short = part.sort((a, b) => a.length - b.length)[0];
  if (short && short.length <= 30) return short;
  const host = safeHost(cap.finalUrl || cap.url).split('.')[0];
  return host.charAt(0).toUpperCase() + host.slice(1);
}

// Normalize whatever came back (Claude or heuristic) so production never sees junk.
export function validateBrief(b, cap) {
  const fallback = heuristicBrief(cap);
  const out = { ...fallback, ...b, style: { ...fallback.style, ...(b.style || {}) } };
  if (!TONES.includes(out.tone)) out.tone = fallback.tone;
  const files = new Set(cap.shots.map(s => s.file).concat('fullpage.png'));
  out.shots = (Array.isArray(out.shots) && out.shots.length >= 3 ? out.shots : fallback.shots)
    .filter(s => s && KINDS.includes(s.kind))
    .map(s => {
      const d = Number(s.duration);
      s.duration = Number.isFinite(d) ? Math.min(Math.max(d, 2), 8) : 3.5;
      if (s.kind === 'screen' || s.kind === 'scene') {
        if (!files.has(s.shot)) s.shot = cap.shots[0].file;
        if (s.shot === 'fullpage.png') s.motion = 'scroll';
        else if (!MOTIONS.includes(s.motion) || s.motion === 'scroll') s.motion = 'zoom-in';
        s.duration = Math.min(s.duration, 5); // Seedance clips are 5s
      }
      return s;
    });
  // Keep total in the 15–25s window after 0.5s crossfades.
  const total = out.shots.reduce((a, s) => a + s.duration, 0) - 0.5 * (out.shots.length - 1);
  const target = 20;
  if (total < 16 || total > 24) {
    const k = target / total;
    for (const s of out.shots) s.duration = +(s.duration * k).toFixed(2);
  }
  if (!out.caption || out.caption.length < 10) out.caption = fallback.caption;
  return out;
}
