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

Proxy: if the machine reaches the internet through a proxy (`HTTPS_PROXY` set in the shell), the
wrapper tells Node to honor it (`NODE_USE_ENV_PROXY=1`). Node's `fetch` otherwise ignores it, and
api.anthropic.com answers `403 Request not allowed` from unsupported regions.

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
   - the *hero* screen shot → **Seedance** image-to-video (`src/stages/seedance.js`, Ark
     `contents/generations/tasks` API, screenshot as first frame, 5s, 16:9). The client tries
     1080p → 720p → 480p and both parameter styles (top-level fields for 2.x, inline `--flags` for
     1.0) until the model accepts; polls with a hard timeout; retries network errors. Any failure
     falls back to **ffmpeg motion** (`src/stages/motion.js`): zoom-in/zoom-out via `zoompan`, or a
     top-to-bottom `scroll` of the full-page screenshot.
   - the *second* screen shot always uses ffmpeg motion. Tested finding: the video model keeps big
     headlines crisp but garbles dense body text after ~3s, so it only gets the hero
     (`SEEDANCE_ALL_SHOTS=1` to override).
   - *text* shots → **cards** (`src/stages/cards.js`): HTML in the site's bg/fg/accent, heading font
     (site `@font-face` files are proxied with a CORS header so they load), logo, word-by-word
     reveal. Frames are captured deterministically by pausing the Web Animations clock and seeking
     to each frame time, then encoded with ffmpeg. The poster is the title card's final frame.
4. **assemble** (`src/stages/assemble.js`, ffmpeg). Normalizes every segment to 1080p30, chains
   0.5s crossfades, trims the chosen music loop (`assets/music/` by tone) to length with fade
   in/out, encodes H.264 + AAC with faststart. Writes `caption.txt` from the brief.

Measured runs (Windows, proxied network):

| Site | Claude | Seedance | Total |
|---|---|---|---|
| playwright.dev | 11s | off | 45s |
| moonshot.cn (zh) | 10s | off | 45s |
| personio.de (de) | 13s | off | 69s |
| linear.app | 8s | 153s (2.0 fast, 720p) | 190s |

Seedance clip generation is 150–160s for one 5s clip on `dreamina-seedance-2-0-fast-260128`; it is
submitted before the cards render so it overlaps. Bounded by `CLIP_TIMEOUT_MS` (default 6 min),
which keeps the worst case under the 10-minute budget. Claude cost per run is ~$0.05 (≈9k input
tokens, 4 downscaled screenshots); one Seedance clip is well under $1.

Model IDs confirmed against the BytePlus endpoint (the server distinguishes "not activated" from
"does not exist"): `seedance-1-0-pro-250528`, `seedance-1-0-pro-fast-251015`,
`dreamina-seedance-2-0-260128`, `dreamina-seedance-2-0-fast-260128`,
`dreamina-seedance-2-0-mini-260615`, `dreamina-seedance-2-5-260628`. Activate the one you set in
`SEEDANCE_MODEL` in the ModelArk console first.

Dev helpers (never print keys): `node src/_keytest.mjs` (Anthropic key + models),
`node src/_cliptest.mjs <workDir> [shot.png]` (one Seedance clip), `node src/_captest.mjs <url> <dir>`.

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
- Seedance alters small UI text despite the prompt (seen: "Full-featured" → "Full-festured" by
  second 4); the fallback motion is always faithful but less alive. Hence hero-only.
- Seedance content moderation rejects input images that "may contain real person" (bilibili.com's
  homepage, full of thumbnails with faces). The client stops retrying variants on that error and
  the hero falls back to ffmpeg motion; the run still finishes in ~45s.
- The 2.0 fast/mini models reject 1080p; clips come back 1280×720 at 24fps and are upscaled in
  assemble. Slight softness on the hero clip is the price of motion.
- Card fonts: sites that ship fonts via CSS the browser cannot read cross-origin (or via JS font
  loaders) render cards in the declared fallback stack (e.g. Linear's Inter → system sans).
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
