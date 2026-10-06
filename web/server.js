// Demo web shell around the same pipeline: a form takes a URL, the server runs
// `node src/index.js <url> out/web/<id>` and the page polls the log until done,
// then shows video.mp4, poster.png and caption.txt. No extra dependencies.
//   npm run web   ->  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out', 'web');
const PORT = Number(process.env.PORT || 3000);
const jobs = new Map(); // id -> { url, status, log, outDir, started }
let running = null;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname.startsWith('/result/'))) return html(res);
    if (req.method === 'POST' && u.pathname === '/run') return start(req, res);
    if (req.method === 'GET' && u.pathname.startsWith('/jobs/')) return job(res, u.pathname.slice(6));
    if (req.method === 'GET' && u.pathname.startsWith('/out/')) return file(req, res, u.pathname.slice(5));
    res.writeHead(404).end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(e.message));
  }
});

function start(req, res) {
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    let url;
    try { url = new URL(JSON.parse(body).url.trim()); } catch { return json(res, 400, { error: 'invalid url' }); }
    if (!/^https?:$/.test(url.protocol)) return json(res, 400, { error: 'http(s) only' });
    if (running) return json(res, 409, { error: 'a run is already in progress', id: running });
    const id = `${url.hostname.replace(/[^a-z0-9.-]/gi, '')}-${Date.now().toString(36)}`;
    const outDir = path.join(OUT, id);
    fs.mkdirSync(outDir, { recursive: true });
    const j = { url: url.href, status: 'running', log: [], outDir, started: Date.now() };
    jobs.set(id, j); running = id;
    const p = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), url.href, outDir],
      { cwd: ROOT, env: { ...process.env, NODE_USE_ENV_PROXY: '1' } });
    const push = d => { for (const line of String(d).split(/\r?\n/)) if (line.trim()) j.log.push(line); };
    p.stdout.on('data', push); p.stderr.on('data', push);
    p.on('close', code => { j.status = code === 0 ? 'done' : 'failed'; j.code = code; running = null; });
    p.on('error', e => { j.log.push(String(e.message)); j.status = 'failed'; running = null; });
    json(res, 200, { id });
  });
}

function job(res, id) {
  const j = jobs.get(id);
  if (!j) return json(res, 404, { error: 'unknown job' });
  const files = {};
  for (const f of ['video.mp4', 'poster.png', 'caption.txt']) {
    const p = path.join(j.outDir, f);
    if (fs.existsSync(p)) files[f] = `/out/${id}/${f}`;
  }
  let caption = '';
  if (files['caption.txt']) caption = fs.readFileSync(path.join(j.outDir, 'caption.txt'), 'utf8');
  json(res, 200, { id, url: j.url, status: j.status, log: j.log, files, caption, elapsed: Math.round((Date.now() - j.started) / 1000) });
}

// Serves out/web/<id>/<file> with Range support so <video> can seek.
function file(req, res, rel) {
  const p = path.join(OUT, rel);
  if (!p.startsWith(OUT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return res.writeHead(404).end();
  const types = { '.mp4': 'video/mp4', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
  const type = types[path.extname(p)] || 'application/octet-stream';
  const size = fs.statSync(p).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && type === 'video/mp4') {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  fs.createReadStream(p).pipe(res);
}

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(obj)); }

function html(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Launch Video</title>
<style>
  :root{--bg:#07080c;--fg:#f4f5f7;--muted:rgba(244,245,247,.55);--line:rgba(255,255,255,.12);--accent:#7c5cff;--accent2:#19c6ff}
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  body{overflow-x:hidden}
  .orb{position:fixed;border-radius:50%;filter:blur(110px);opacity:.55;pointer-events:none;z-index:0;animation:float 18s ease-in-out infinite alternate}
  .orb.a{width:720px;height:720px;left:-220px;top:-260px;background:radial-gradient(circle,var(--accent),transparent 65%)}
  .orb.b{width:640px;height:640px;right:-200px;bottom:-240px;background:radial-gradient(circle,var(--accent2),transparent 65%);animation-delay:-9s}
  @keyframes float{from{transform:translate(0,0) scale(1)}to{transform:translate(60px,40px) scale(1.08)}}
  .view{position:relative;z-index:1;min-height:100vh;display:none;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px}
  .view.on{display:flex}
  .brand{position:fixed;top:28px;left:36px;z-index:2;font-weight:600;letter-spacing:.14em;font-size:12px;text-transform:uppercase;color:var(--muted);text-decoration:none}
  /* cover */
  h1{font-size:clamp(44px,7vw,96px);line-height:.98;letter-spacing:-.035em;margin:0 0 20px;text-align:center;font-weight:700;max-width:14ch;text-wrap:balance}
  h1 em{font-style:normal;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
  .lede{color:var(--muted);font-size:clamp(16px,1.6vw,20px);text-align:center;max-width:46ch;margin:0 0 44px;line-height:1.5}
  form{width:min(760px,100%);display:flex;padding:8px;border:1px solid var(--line);border-radius:999px;background:rgba(255,255,255,.04);backdrop-filter:blur(14px);box-shadow:0 30px 80px rgba(0,0,0,.45)}
  form:focus-within{border-color:rgba(255,255,255,.3)}
  input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:var(--fg);font-size:20px;padding:14px 22px;font-family:inherit}
  input::placeholder{color:rgba(244,245,247,.35)}
  button{border:0;border-radius:999px;padding:0 30px;font-size:17px;font-weight:600;color:#0b0b10;background:linear-gradient(90deg,#fff,#dfe3ff);cursor:pointer;font-family:inherit;transition:transform .15s}
  button:hover{transform:translateY(-1px)} button:disabled{opacity:.5;cursor:default;transform:none}
  .hint{margin-top:18px;color:var(--muted);font-size:13px;letter-spacing:.02em}
  .err{margin-top:18px;color:#ff8c8c;font-size:14px;min-height:1em}
  /* progress */
  .site{color:var(--muted);font-size:14px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:26px}
  .stage{font-size:clamp(26px,3.6vw,40px);font-weight:600;letter-spacing:-.02em;min-height:1.3em;text-align:center}
  .bar{width:min(560px,90vw);height:3px;background:rgba(255,255,255,.1);border-radius:3px;margin:34px 0 14px;overflow:hidden}
  .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:3px;transition:width .9s cubic-bezier(.2,.7,.2,1)}
  .pct{color:var(--muted);font-variant-numeric:tabular-nums;font-size:13px}
  /* result */
  .player{width:min(1180px,100%);aspect-ratio:16/9;position:relative;border-radius:18px;overflow:hidden;background:#000;box-shadow:0 40px 120px rgba(0,0,0,.6),0 0 0 1px var(--line)}
  .player video,.player img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
  .player img{opacity:0;transition:opacity .8s ease;pointer-events:none}
  .player.poster img{opacity:1} .player.poster video{visibility:hidden}
  .unmute{position:absolute;right:16px;bottom:16px;z-index:3;padding:10px 16px;font-size:13px;background:rgba(0,0,0,.6);color:#fff;border:1px solid rgba(255,255,255,.25);display:none}
  .player.muted .unmute{display:block}
  .caption{width:min(900px,100%);margin:40px auto 0;text-align:center;font-size:clamp(17px,1.5vw,21px);line-height:1.6;color:rgba(244,245,247,.85);white-space:pre-wrap}
  .caption a{color:var(--accent2);text-decoration:none}
  .actions{margin-top:34px;display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
  .ghost{border:1px solid var(--line);background:transparent;color:var(--fg);padding:12px 22px;border-radius:999px;font-size:14px;text-decoration:none;font-family:inherit;cursor:pointer}
  .ghost:hover{border-color:rgba(255,255,255,.4)}
</style></head><body>
<div class="orb a"></div><div class="orb b"></div>
<a class="brand" href="/">Launch Video</a>

<section class="view on" id="cover">
  <h1>Every website deserves a <em>launch video</em>.</h1>
  <p class="lede">Paste a URL. We read the site, decide the story, animate it in the site's own colors and words, and cut it to music. About three minutes.</p>
  <form id="f"><input id="url" placeholder="https://your-product.com" autocomplete="off" spellcheck="false" required autofocus><button id="go" type="submit">Make video</button></form>
  <div class="hint">1920 × 1080 · 20 seconds · poster + caption included</div>
  <div class="err" id="err"></div>
</section>

<section class="view" id="progress">
  <div class="site" id="psite"></div>
  <div class="stage" id="pstage">Reading the site</div>
  <div class="bar"><i id="pbar"></i></div>
  <div class="pct" id="ppct">0%</div>
</section>

<section class="view" id="result">
  <div class="player" id="player">
    <video id="video" playsinline preload="auto"></video>
    <img id="poster" alt="">
    <button class="unmute ghost" id="unmute" type="button">Tap for sound</button>
  </div>
  <div class="caption" id="caption"></div>
  <div class="actions">
    <a class="ghost" id="dl" download>Download video</a>
    <a class="ghost" id="open" target="_blank" rel="noopener">Open site</a>
    <a class="ghost" href="/">Make another</a>
  </div>
</section>

<script>
const $ = id => document.getElementById(id);
const show = id => { for (const v of document.querySelectorAll('.view')) v.classList.toggle('on', v.id === id); };
const POSTER_HOLD_MS = 10000;

$('f').onsubmit = async e => {
  e.preventDefault();
  $('err').textContent = '';
  let url = $('url').value.trim();
  if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;
  $('go').disabled = true;
  const r = await fetch('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) });
  const j = await r.json();
  $('go').disabled = false;
  if (!r.ok) { $('err').textContent = j.error === 'a run is already in progress' ? 'Another video is being made right now. Try again in a minute.' : 'Please enter a valid website address.'; return; }
  history.pushState({}, '', '/result/' + j.id);
  runProgress(j.id, url);
};

// Virtual progress: eases toward 92% over ~3 minutes, jumps to 100% on completion.
function runProgress(id, url) {
  show('progress');
  $('psite').textContent = new URL(url).host.replace(/^www\\./, '');
  const stages = [[0, 'Reading the site'], [12, 'Deciding the story'], [25, 'Writing the words'], [40, 'Generating footage'], [120, 'Setting it to music'], [165, 'Almost there']];
  const t0 = Date.now();
  let failed = false;
  const tick = setInterval(async () => {
    const t = (Date.now() - t0) / 1000;
    const p = 92 * (1 - Math.exp(-t / 85));
    $('pbar').style.width = p + '%'; $('ppct').textContent = Math.floor(p) + '%';
    $('pstage').textContent = stages.filter(s => s[0] <= t).pop()[1];
    let s; try { s = await (await fetch('/jobs/' + id)).json(); } catch { return; }
    if (s.status === 'running') return;
    clearInterval(tick);
    if (s.status !== 'done' || !s.files['video.mp4']) {
      $('pstage').textContent = "We couldn't make a video for this site.";
      $('ppct').innerHTML = '<a class="ghost" href="/">Try another URL</a>';
      return;
    }
    $('pbar').style.width = '100%'; $('ppct').textContent = '100%'; $('pstage').textContent = 'Ready';
    setTimeout(() => showResult(s, true), 900);
  }, 1000);
}

let holdTimer = null;
function showResult(s, afterGesture) {
  show('result');
  const v = $('video'), player = $('player');
  v.src = s.files['video.mp4']; $('poster').src = s.files['poster.png'];
  $('caption').innerHTML = linkify(s.caption || '');
  $('dl').href = s.files['video.mp4']; $('dl').download = new URL(s.url).host + '-launch.mp4';
  $('open').href = s.url;
  v.loop = false; v.muted = false;
  const play = () => { player.classList.remove('poster'); v.currentTime = 0; v.play().catch(() => { v.muted = true; player.classList.add('muted'); v.play().catch(() => {}); }); };
  $('unmute').onclick = () => { v.muted = false; player.classList.remove('muted'); };
  v.onended = () => { player.classList.add('poster'); clearTimeout(holdTimer); holdTimer = setTimeout(play, POSTER_HOLD_MS); };
  player.onclick = e => { if (e.target.id === 'unmute') return; if (player.classList.contains('poster')) { clearTimeout(holdTimer); play(); } else if (v.paused) v.play(); else v.pause(); };
  if (!afterGesture) { v.muted = true; player.classList.add('muted'); }
  play();
}
function linkify(t) {
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return esc(t).replace(/(https?:\\/\\/[^\\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// Direct load / refresh of /result/<id>: show the result (muted autoplay, since there was no gesture) or the progress view.
const m = location.pathname.match(/^\\/result\\/([^/]+)$/);
if (m) {
  fetch('/jobs/' + m[1]).then(r => r.ok ? r.json() : null).then(s => {
    if (!s) { history.replaceState({}, '', '/'); return; }
    if (s.status === 'running') runProgress(m[1], s.url);
    else if (s.status === 'done' && s.files['video.mp4']) showResult(s, false);
    else history.replaceState({}, '', '/');
  });
}
window.onpopstate = () => { if (location.pathname === '/') { show('cover'); $('video').pause(); clearTimeout(holdTimer); } };
</script></body></html>`);
}

// Rehydrate finished runs so /result/<id> links survive a server restart.
fs.mkdirSync(OUT, { recursive: true });
for (const id of fs.readdirSync(OUT)) {
  const dir = path.join(OUT, id);
  if (!fs.existsSync(path.join(dir, 'video.mp4'))) continue;
  let url = 'https://' + id.replace(/-[a-z0-9]+$/, '');
  try { url = JSON.parse(fs.readFileSync(path.join(dir, 'work', 'capture.json'), 'utf8')).finalUrl || url; } catch { /* keep guess */ }
  jobs.set(id, { url, status: 'done', log: [], outDir: dir, started: fs.statSync(dir).mtimeMs });
}
server.listen(PORT, () => console.log(`launch-video web demo: http://localhost:${PORT}`));
