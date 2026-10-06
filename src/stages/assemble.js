// Stage: assemble. Crossfades the segments in order, lays music under them,
// and writes video.mp4 (1920x1080, H.264 + AAC).
import path from 'node:path';
import { FFMPEG, FFPROBE, ROOT } from '../lib/env.js';
import { run } from '../lib/run.js';
import { log } from '../lib/log.js';

const XFADE = 0.5;
const MUSIC = {
  upbeat: 'upbeat-120bpm.wav',
  driving: 'driving-128bpm.wav',
  chill: 'chill-96bpm.wav',
};

export async function assemble(segments, brief, outFile) {
  // segments: [{ file, duration }] in play order
  const n = segments.length;
  const total = segments.reduce((a, s) => a + s.duration, 0) - XFADE * (n - 1);
  const music = path.join(ROOT, 'assets', 'music', MUSIC[brief.tone] || MUSIC.upbeat);

  // Inputs: segments, then music, then one looped still per keyword overlay.
  const inputs = [];
  for (const s of segments) inputs.push('-i', s.file);
  inputs.push('-i', music);
  const ovIndex = {};
  let inputCount = n + 1; // segments + music
  segments.forEach((s, i) => {
    if (!s.overlay) return;
    ovIndex[i] = inputCount++;
    inputs.push('-loop', '1', '-framerate', '30', '-t', String(s.duration), '-i', s.overlay);
  });

  // Normalize every segment (Seedance output may differ in fps/size), then chain xfades.
  const parts = [];
  for (let i = 0; i < n; i++) {
    const d = segments[i].duration;
    if (ovIndex[i] !== undefined) {
      // Footage with a keyword: overlay fades in after 0.6s and out before the crossfade.
      parts.push(`[${i}:v]fps=30,scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,trim=duration=${d},setpts=PTS-STARTPTS[b${i}]`);
      parts.push(`[${ovIndex[i]}:v]format=rgba,fade=t=in:st=0.6:d=0.5:alpha=1,fade=t=out:st=${(d - 0.9).toFixed(2)}:d=0.4:alpha=1[o${i}]`);
      parts.push(`[b${i}][o${i}]overlay=0:0:shortest=1,format=yuv420p[v${i}]`);
    } else {
      parts.push(`[${i}:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,trim=duration=${d},setpts=PTS-STARTPTS[v${i}]`);
    }
  }
  let prev = 'v0', offset = 0;
  for (let i = 1; i < n; i++) {
    offset += segments[i - 1].duration - XFADE;
    const label = i === n - 1 ? 'vout' : `x${i}`;
    parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${label}]`);
    prev = label;
  }
  if (n === 1) parts.push('[v0]copy[vout]');
  // Music: gentle fade in, 2s fade out at the end, cut to video length.
  parts.push(`[${n}:a]atrim=duration=${total.toFixed(3)},afade=t=in:d=0.8,afade=t=out:st=${(total - 2).toFixed(3)}:d=2,volume=0.9[aout]`);

  const args = ['-y', ...inputs, '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
    '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), outFile];
  await run(FFMPEG, args);
  log('assemble', `${n} segments, ${total.toFixed(1)}s, music=${path.basename(music)}`);
  return total;
}

export async function probeDuration(file) {
  const { out } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.trim());
}
