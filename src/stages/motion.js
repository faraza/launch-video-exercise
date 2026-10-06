// Stage: motion. Turns a screenshot into a moving clip with ffmpeg.
// This is the no-API path for "screen" shots and the fallback when Seedance fails.
import path from 'node:path';
import { FFMPEG } from '../lib/env.js';
import { run } from '../lib/run.js';
import { log } from '../lib/log.js';

const FPS = 30;

export async function motionClip(shot, workDir, index) {
  const input = path.join(workDir, shot.shot);
  const out = path.join(workDir, `seg-${String(index).padStart(2, '0')}.mp4`);
  const d = shot.duration;
  const frames = Math.round(d * FPS);
  let vf;
  if (shot.motion === 'scroll') {
    // Full-page screenshot scrolled top→down at a readable pace, never past the end.
    const speed = 220; // px/s
    vf = `scale=1920:-2,crop=1920:1080:0:'min(t*${speed},ih-1080)'`;
  } else {
    // Upscale first so zoompan has sub-pixel headroom (avoids jitter).
    const zoomExpr = shot.motion === 'zoom-out'
      ? `1.12-0.12*on/${frames - 1}`
      : `1+0.12*on/${frames - 1}`;
    vf = `scale=3840:-1,zoompan=z='${zoomExpr}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=${FPS}`;
  }
  const args = ['-y', '-loop', '1', '-framerate', String(FPS), '-i', input,
    '-vf', `${vf},format=yuv420p`, '-t', String(d), '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-an', out];
  await run(FFMPEG, args);
  log('motion', `${shot.motion} on ${shot.shot} -> ${path.basename(out)}`);
  return out;
}
