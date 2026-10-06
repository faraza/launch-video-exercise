# Launch video exercise

You built a product. Now it needs a launch video.

**Your task:** build a tool that takes a website URL and produces a ~20-second launch video for
that site, with motion and music, plus a short caption someone could post alongside it.

```bash
./make-video https://example.com out/example
```

should leave you with:

| File | What |
|---|---|
| `out/example/video.mp4` | 1920×1080, 15–25 seconds, H.264, with an audio track |
| `out/example/poster.png` | a still that represents the video, 1920×1080 |
| `out/example/caption.txt` | a social post to go with it (a few sentences, no more) |

The video should feel made *for that site*: its product, its words, its look. A generic template
with the site's name dropped in isn't the goal.

## Time

3 hours. At the end we'll run `./make-video` together on **two URLs you haven't seen**, so build
a tool, not a video for one site. Each run should finish in under 10 minutes.

## What you can use

- **Any language, any libraries, any coding agent.** Use Claude Code, Codex, Cursor or whatever you
  like, as much as you like. We expect you to.
- **Any model API:** LLMs, vision models, image models, text-to-speech, and text-to-video or
  image-to-video models (Sora, Veo, Runway, etc.) to generate individual clips. Keys are in
  `.env` (see `.env.example`).
- **Building blocks:** headless browsers (Playwright, Puppeteer), ffmpeg, rendering and animation
  libraries (Remotion, Motion Canvas, canvas, HTML/CSS), image and audio libraries.
- **Music:** a few royalty-free tracks are in `assets/music/`. You can also generate or source
  your own.

## The one rule

Don't use anything that already turns a website, repo or product into a launch, promo or demo
video. That covers open-source projects (for example `latent-spaces/brag`), agent skills and
plugins, templates, prompt packs and hosted services that do this. It applies whether or not
the tool is named here, and it applies to your coding agent too. `CLAUDE.md` and `AGENTS.md` tell
agents the same thing; keep them in place and start your agent from this folder.

Understanding the site, deciding the story, and putting the final video together has to be your
own work (with your agent). If you're not sure whether something is allowed, ask.

## What to hand in

1. This repo, with your commits. Commit as you go; we read the history.
2. A working `./make-video <url> <out_dir>`. Replace the stub that's there now, and keep the
   interface. Put setup steps in `NOTES.md`.
3. `NOTES.md`: how your pipeline works, what you cut, what breaks, and what you'd do with
   another day. Bullet points are fine.
4. Your coding agent's transcript or session export, if your tool can produce one.

Before you finish, run the output check:

```bash
python3 scripts/check_output.py out/example
```

## What we care about

- **The videos.** Do they understand what the site is and who it's for, look like the site, and
  have a point of view?
- **Range.** Does it hold up on sites you didn't test against: different stacks, layouts and
  languages?
- **The pipeline.** Is it clear how it works, and could you change one part without breaking the
  rest?
- **Judgment.** What you chose to build, what you skipped, and how you checked your own output.

Have fun with it.
