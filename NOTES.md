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

Web demo (optional, same pipeline): `npm run web` then open http://localhost:3000. Cover page
with one URL field → a virtual progress bar (the real log is hidden; stages are timed guesses) →
`/result/<id>` plays the video with sound, holds on the poster for 10s when it ends, then loops;
the caption sits under the player. It shells out to `src/index.js` and serves `out/web/<id>/`;
one run at a time; finished runs are rehydrated on restart. The CLI is the deliverable; this is
only a viewer (`web/server.js`, no dependencies).

Public URL without deploying anywhere: keep `npm run web` running, then in a second terminal
`npm run tunnel` (needs `cloudflared`: `winget install Cloudflare.cloudflared` / `brew install
cloudflared`). It prints a `https://<random>.trycloudflare.com` address that proxies to the local
server; the machine, its keys and its proxy stay where they are. The address changes on every
restart. Set `WEB_PASSWORD` in `.env` first: the cover page then asks for an access code, so a
leaked link cannot burn API credit.

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
   (`output_config.format` with a JSON schema): product, tagline, audience, 3–6 distilled
   keywords, tone (picks the music), language, card colors plus a palette hint, the caption, and a
   fixed 5-shot story: title card → three generated *scenes* → cta card. Each scene has the one
   idea to show, a 40–80 word cinematic text-to-video prompt (subject, action, setting, camera,
   light, site palette; explicitly no text/logos/UI), one keyword caption, and a fallback
   screenshot + motion. `src/lib/brief.js` validates whatever comes back and clamps total length
   to ~20s. Without a key, or if Claude fails, `heuristicBrief()` builds the same shape from the
   h1, meta description and section headings (fallback path only: screenshots with motion).
3. **produce**. Runs in parallel:
   - *scenes* → **Seedance text-to-video** (`src/stages/seedance.js`, Ark API, 5s, 16:9). All
     three are submitted at once; if the account's concurrency limit pushes back, submissions queue
     and retry every 10s. The client tries 1080p → 720p → 480p and both parameter styles until the
     model accepts; polls with a hard timeout; retries network errors. A scene that fails falls back
     to **ffmpeg motion** on its fallback screenshot (`src/stages/motion.js`).
   - *keyword overlays* and *cards* (`src/stages/cards.js`): transparent PNG per scene (product
     eyebrow in the accent color + one keyword in the site's heading font over a soft bottom
     gradient) and the title/cta cards in the site's bg/fg/accent with logo and word-by-word reveal.
     Frames are captured deterministically by pausing the Web Animations clock. Poster = title card.
   - Why no screenshots in the main cut: they read as cheap, and the video model mangles small
     text and CJK glyphs. Screenshots now exist only so the pipeline never fails to produce output.
4. **assemble** (`src/stages/assemble.js`, ffmpeg). Normalizes every segment to 1080p30 (footage
   is cover-cropped, cards padded), composites each keyword overlay with a fade in/out, chains
   0.5s crossfades, trims the chosen music loop (`assets/music/` by tone) to length with fade
   in/out, encodes H.264 + AAC with faststart. Writes `caption.txt` from the brief.

Measured runs (Windows, proxied network):

| Site | Claude | Seedance | Total |
|---|---|---|---|
| playwright.dev | 11s | off | 45s |
| moonshot.cn (zh) | 10s | off | 45s |
| personio.de (de) | 13s | off | 69s |
| linear.app | 8s | 153s (2.0 fast, 720p, old screenshot i2v) | 190s |
| robotruck.jp | 19s | 3 × t2v in parallel, 111–136s (2.0 mini, 720p) | 180s |

Seedance timings for one 5s clip from the same screenshot: `2-0-fast` 720p 143–161s,
`2-0-mini` 720p 118s (similar sharpness, now the default), `2-0-fast` 480p 100s (864×496 output,
visibly soft at 1080p, rejected). The clip is submitted before the cards render so it overlaps. Bounded by `CLIP_TIMEOUT_MS` (default 6 min),
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

- Screenshot-driven shots in the main cut (first version). Replaced by generated scenes once it
  was clear that screenshots look cheap and that the video model cannot keep UI text intact.
- Seedance-generated audio (`generate_audio`): each 5s clip would get its own ambience that does
  not stitch across cuts, and the clips lose sync with crossfades. Music stays a tone-matched loop
  chosen by Claude (upbeat / driving / chill), which has varied correctly across every test site.
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
- Geo-redirects follow the machine's IP, not the URL: through a Tokyo exit, `stripe.com` became
  `stripe.com/jp` and the video came out in Japanese. Correct for that network, surprising if you
  expected English. Pass the explicit locale URL if a particular version matters.
- Seedance mangles Chinese/Japanese/Korean glyphs even in the headline (stripe.com/jp hero),
  where Latin headlines stay crisp. CJK sites therefore skip the video model entirely
  (`SEEDANCE_CJK=1` to override) and use ffmpeg motion for every screen shot.
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

- Generated music: a music model (or a longer library keyed by genre) so a logistics company,
  a payments API and a video community do not share three loops.
- A second Claude pass that *watches* the finished contact sheet and critiques copy length,
  contrast and shot choice, then regenerates the brief once.
- Logo-aware cards (vector logo scaled and recolored), and an end card that mirrors the site's
  actual button style.
- Per-shot music hits: align card entrances to beats (BPM is known for each loop).
- Mobile/9:16 variant from the same brief.
- Caching the capture and brief by URL so iterating on the look does not re-call Claude.
