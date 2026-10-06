// Stage: seedance. Generated footage via the Ark "contents/generations/tasks" API
// (BytePlus ModelArk or Volcengine). "scene" shots are text-to-video from the brief's
// cinematic prompt; legacy "screen" shots are image-to-video with the screenshot as first
// frame. All shots are submitted in parallel (queued if the account's concurrency limit
// pushes back), polled until done, downloaded to work/. Anything that fails or times out
// returns nothing for that shot, and the caller falls back to ffmpeg motion.
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../lib/env.js';
import { log } from '../lib/log.js';

const POLL_MS = 5000;

export async function generateClips(brief, cap, workDir, screenIdx) {
  const deadline = Date.now() + env.clipTimeoutMs;
  const jobs = screenIdx
    .filter(i => brief.shots[i].kind === 'scene' || brief.shots[i].shot !== 'fullpage.png') // i2v needs a 16:9 first frame
    .map(i => oneClip(brief.shots[i], i, workDir, deadline).then(f => [i, f]).catch(e => {
      log('seedance', `shot ${i} failed: ${String(e.message).slice(0, 200)}`);
      return [i, null];
    }));
  const results = Object.fromEntries((await Promise.all(jobs)).filter(([, f]) => f));
  log('seedance', `${Object.keys(results).length}/${jobs.length} clips ok`);
  return results;
}

async function oneClip(shot, index, workDir, deadline) {
  const t2v = shot.kind === 'scene' && shot.prompt;
  if (!t2v && !shot.prompt && shot.kind === 'scene') throw new Error('scene without prompt');
  const prompt = t2v
    ? `${shot.prompt.trim()} No text, no captions, no logos, no watermarks, no user interface on screen.`
    : (shot.prompt || 'Slow, smooth push-in on the interface. Keep all text crisp and unchanged.').trim();
  const dur = Math.max(4, Math.min(10, Math.round(shot.duration)));
  const media = [];
  if (!t2v) {
    const img = await fs.readFile(path.join(workDir, shot.shot));
    media.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${img.toString('base64')}` }, role: 'first_frame' });
  }
  // Seedance 2.x documents top-level fields; 1.0 documents inline "--flag" text. Smaller
  // models only offer 720p/480p (assemble upscales). Try combinations until one is accepted.
  const resolutions = env.seedanceResolution ? [env.seedanceResolution] : ['1080p', '720p', '480p'];
  const attempts = [];
  for (const res of resolutions) {
    attempts.push({ label: `${res} structured`, body: {
      model: env.seedanceModel, content: [{ type: 'text', text: prompt }, ...media],
      resolution: res, ratio: '16:9', duration: dur, generate_audio: false, watermark: false } });
    attempts.push({ label: `${res} inline`, body: {
      model: env.seedanceModel,
      content: [{ type: 'text', text: `${prompt} --resolution ${res} --ratio 16:9 --duration ${dur} --watermark false` }, ...media] } });
  }
  const t0 = Date.now();
  let task, lastErr;
  for (const a of attempts) {
    try { task = await submitWithQueue(a.body, deadline, index); log('seedance', `shot ${index} accepted as ${a.label}`); break; }
    catch (e) {
      lastErr = e;
      if (!/-> 400/.test(e.message)) throw e; // auth, quota, network: no point retrying variants
      log('seedance', `${a.label} rejected: ${e.message.replace(/^.*-> 400: /, '').slice(0, 90)}`);
      // Content moderation on the input image will reject every variant; stop early.
      if (/real person|sensitive|moderation|input image/i.test(e.message)) throw e;
    }
  }
  if (!task) throw lastErr;
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

// Submit a task; when the account's concurrency/rate limit pushes back, wait and resubmit.
async function submitWithQueue(body, deadline, index) {
  let waited = false;
  while (true) {
    try { return await api('POST', '/contents/generations/tasks', body); }
    catch (e) {
      const limited = /429|concurren|rate limit|too many|quota.*exceed|QuotaExceeded/i.test(e.message);
      if (!limited || Date.now() + 15_000 > deadline) throw e;
      if (!waited) { log('seedance', `shot ${index} queued (concurrency limit)`); waited = true; }
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

// Retries network failures and 5xx with backoff; 4xx errors (including 429) are returned immediately.
async function api(method, p, body, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(env.arkBaseUrl + p, {
        method,
        headers: { 'Authorization': `Bearer ${env.arkKey}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
      if (res.ok) return json;
      const err = new Error(`${method} ${p} -> ${res.status}: ${json.error?.message || json.message || text.slice(0, 300)}`);
      if (res.status < 500) throw err;
      lastErr = err;
    } catch (e) {
      if (/-> 4\d\d/.test(e.message)) throw e;
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(`${method} ${p}: ${lastErr?.message || 'failed'} (after ${tries} tries)`);
}
