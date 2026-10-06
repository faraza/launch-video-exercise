# Notes

## Setup

Works on macOS, Linux and Windows (Git Bash). Needs Node 20+ and Python 3 (for the output check).

```bash
npm install                      # also downloads Chromium for Playwright (postinstall)
cp .env.example .env             # fill in ANTHROPIC_API_KEY, optionally ARK_API_KEY (Seedance)
git config core.hooksPath .githooks   # optional: pre-commit guard against committing keys
./make-video https://example.com out/example
python3 scripts/check_output.py out/example
```

ffmpeg: the system `ffmpeg`/`ffprobe` is used when on PATH (`brew install ffmpeg` on macOS);
otherwise the `ffmpeg-static` npm package's bundled binary is used, so a bare `npm install` is enough.
`check_output.py` needs `ffprobe` on PATH, so install ffmpeg for the check even if the tool itself
would run without it.

Keys live only in `.env` (git-ignored, never exported into the shell, never logged). The pre-commit
hook refuses commits containing `.env` files or key-shaped strings.

Debug flags (bypass the wrapper): `node src/index.js <url> <out> [--no-ai] [--no-clips] [--brief file.json]`.

## How it works

Four stages; each reads and writes files in `<out_dir>/work/`, so any one can be re-run or swapped.

1. **capture** (`src/stages/capture.js`, Playwright). Loads the page at 1920×1080, dismisses cookie
   banners, scrolls once to trigger lazy content, then takes the hero shot, up to 5 more viewport
   shots down the page, and a full-page shot. Extracts headings, paragraphs, buttons (with their
   background color, including gradients), nav, logo, favicon, fonts (computed `font-family` plus
   readable `@font-face` rules), page colors, and a pixel-quantized palette of the hero. Writes
   `capture.json`. No interpretation happens here.
2. **understand** (`src/stages/understand.js`, Claude via the Anthropic SDK). Sends the capture
   summary plus up to 4 downscaled screenshots and asks for a *brief* as structured JSON
   (`output_config.format` with a JSON schema): product, tagline, audience, tone (picks the music),
   language, card colors, a fixed 6-shot story (title → screen → point → screen → point → cta) with
   all on-screen copy in the site's language, a camera prompt per screenshot, and the caption.
   `src/lib/brief.js` validates and normalizes whatever comes back and clamps total length to ~20s.
   Without a key, or if Claude fails, `heuristicBrief()` builds the same shape from the h1, meta
   description, section headings and the most button-like CTA, so the pipeline still completes.
3. **produce**. Runs in parallel:
   - *screen* shots → **Seedance** image-to-video (`src/stages/seedance.js`, Ark API, screenshot as
     first frame, 5s, 1080p, 16:9) with a hard timeout; any failure falls back to
     **ffmpeg motion** (`src/stages/motion.js`): zoom-in/zoom-out via `zoompan`, or a top-to-bottom
     `scroll` of the full-page screenshot.
   - *text* shots → **cards** (`src/stages/cards.js`): HTML in the site's bg/fg/accent, heading font
     (site `@font-face` files are proxied with a CORS header so they load), logo, word-by-word
     reveal. Frames are captured deterministically by pausing the Web Animations clock and seeking
     to each frame time, then encoded with ffmpeg. The poster is the title card's final frame.
4. **assemble** (`src/stages/assemble.js`, ffmpeg). Normalizes every segment to 1080p30, chains
   0.5s crossfades, trims the chosen music loop (`assets/music/` by tone) to length with fade
   in/out, encodes H.264 + AAC with faststart. Writes `caption.txt` from the brief.

Typical run without Seedance: ~30–50s. With Seedance: plus clip generation time (clips are
submitted first and cards render meanwhile), bounded by `CLIP_TIMEOUT_MS` (default 6 min).

## What I cut

- Voice-over / TTS: the brief has the copy, but syncing speech to 3s cards needs timing work.
- Scene-level animation beyond cards (device mockups, cursor paths): the site screenshot plus
  camera motion carries the "looks like the site" requirement at much lower risk.
- Per-site music generation: three loops by tone are enough and never fail.
- Headless font fidelity for cross-origin fonts that block even with the CORS proxy: falls back to
  the site's declared stack, then system fonts.

## What breaks

- Sites that block headless Chromium (bot walls, Cloudflare challenges) → capture fails and the run
  aborts with a clear error; there is no retry through a real browser profile.
- Cookie banners whose button text is not in the consent regex stay in the screenshots.
- Heavily animated heroes (video backgrounds, canvas) can produce a blurry or mid-transition hero
  frame; the 1.2s settle wait is a guess.
- Very long or very short headlines: the card layout scales font size by length but a 120-char
  h1 in the heuristic path gets truncated with an ellipsis.
- Seedance occasionally alters UI text slightly despite the prompt; the fallback motion is always
  faithful but less alive.
- The output check script prints `✗`/`✓`, which fails on a GBK Windows console; run it with
  `PYTHONIOENCODING=utf-8`.

## With another day

- A second Claude pass that *watches* the finished contact sheet and critiques copy length,
  contrast and shot choice, then regenerates the brief once.
- Logo-aware cards (vector logo scaled and recolored), and an end card that mirrors the site's
  actual button style.
- Per-shot music hits: align card entrances to beats (BPM is known for each loop).
- Mobile/9:16 variant from the same brief.
- Caching the capture and brief by URL so iterating on the look does not re-call Claude.
