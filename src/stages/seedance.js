// Stage: seedance. Image-to-video clips via the Ark "contents/generations/tasks" API
// (BytePlus ModelArk or Volcengine). Each screen shot's screenshot is the first frame;
// the brief's prompt describes camera motion. All shots are submitted in parallel,
// polled until done, downloaded to work/. Anything that fails or times out returns
// nothing for that shot, and the caller falls back to ffmpeg motion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';

const POLL_MS = 5000;

export async function generateClips(brief, cap, workDir, screenIdx) {
  const deadline = Date.now() + env.clipTimeoutMs;
  const jobs = screenIdx
    .filter(i => brief.shots[i].shot !== 'fullpage.png') // needs a 16:9 first frame
    .map(i => oneClip(brief.shots[i], i, workDir, deadline).then(f => [i, f]).catch(e => {
      log('seedance', `shot ${i} failed: ${String(e.message).slice(0, 200)}`);
      return [i, null];
    }));
  const results = Object.fromEntries((await Promise.all(jobs)).filter(([, f]) => f));
  log('seedance', `${Object.keys(results).length}/${jobs.length} clips ok`);
  return results;
}

async function oneClip(shot, index, workDir, deadline) {
  const img = await fs.readFile(path.join(workDir, shot.shot));
  const prompt = (shot.prompt || 'Slow, smooth push-in on the interface. Keep all text crisp and unchanged.').trim();
  const dur = shot.duration > 5 ? 10 : 5;
  const body = {
    model: env.seedanceModel,
    content: [
      { type: 'text', text: `${prompt} --resolution 1080p --ratio 16:9 --duration ${dur} --watermark false` },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${img.toString('base64')}` }, role: 'first_frame' },
    ],
  };
  const t0 = Date.now();
  const task = await api('POST', '/contents/generations/tasks', body);
  const id = task.id;
  if (!id) throw new Error(`no task id: ${JSON.stringify(task).slice(0, 200)}`);
  log('seedance', `shot ${index} task ${id} submitted`);

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const st = await api('GET', `/contents/generations/tasks/${id}`);
    if (st.status === 'succeeded') {
      const url = st.content?.video_url;
      if (!url) throw new Error('succeeded without video_url');
      const out = path.join(workDir, `clip-${String(index).padStart(2, '0')}.mp4`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      await fs.writeFile(out, Buffer.from(await res.arrayBuffer()));
      log('seedance', `shot ${index} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return out;
    }
    if (st.status === 'failed' || st.status === 'cancelled' || st.status === 'expired') {
      throw new Error(`task ${st.status}: ${st.error?.message || JSON.stringify(st).slice(0, 200)}`);
    }
  }
  throw new Error(`timed out after ${env.clipTimeoutMs / 1000}s`);
}

async function api(method, p, body) {
  const res = await fetch(env.arkBaseUrl + p, {
    method,
    headers: { 'Authorization': `Bearer ${env.arkKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${json.error?.message || json.message || text.slice(0, 300)}`);
  return json;
}
