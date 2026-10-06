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
    if (req.method === 'GET' && u.pathname === '/') return html(res);
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
<html><head><meta charset="utf-8"><title>Launch video</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;color:#111;background:#fafafa}
  h1{font-size:28px;margin:0 0 6px} p.sub{color:#666;margin:0 0 24px}
  form{display:flex;gap:10px} input{flex:1;font-size:18px;padding:12px 14px;border:1px solid #ccc;border-radius:8px}
  button{font-size:18px;padding:12px 22px;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}
  button:disabled{background:#999}
  pre{background:#111;color:#ddd;padding:14px;border-radius:8px;font-size:13px;max-height:260px;overflow:auto;white-space:pre-wrap}
  .result{display:none;margin-top:24px} video{width:100%;border-radius:10px;background:#000}
  .row{display:flex;gap:20px;margin-top:16px;flex-wrap:wrap} .row>div{flex:1;min-width:300px}
  img{width:100%;border-radius:10px;border:1px solid #ddd} blockquote{margin:0;padding:14px;background:#fff;border:1px solid #ddd;border-radius:10px;white-space:pre-wrap}
  .status{margin:14px 0 8px;color:#444}
</style></head><body>
<h1>Launch video</h1>
<p class="sub">Paste a website URL. Same pipeline as <code>./make-video</code>: capture → understand → produce → assemble. Takes 1–4 minutes.</p>
<form id="f"><input id="url" placeholder="https://example.com" required autofocus><button id="go">Make video</button></form>
<div class="status" id="status"></div>
<pre id="log" style="display:none"></pre>
<div class="result" id="result">
  <video id="video" controls playsinline></video>
  <div class="row">
    <div><h3>Poster</h3><img id="poster"></div>
    <div><h3>Caption</h3><blockquote id="caption"></blockquote><p><a id="dl" download>Download video.mp4</a></p></div>
  </div>
</div>
<script>
const $ = id => document.getElementById(id);
$('f').onsubmit = async e => {
  e.preventDefault();
  $('go').disabled = true; $('result').style.display = 'none'; $('log').style.display = 'block'; $('log').textContent = '';
  $('status').textContent = 'Starting…';
  const r = await fetch('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: $('url').value }) });
  const j = await r.json();
  if (!r.ok) { $('status').textContent = 'Error: ' + j.error; $('go').disabled = false; return; }
  const timer = setInterval(async () => {
    const s = await (await fetch('/jobs/' + j.id)).json();
    $('log').textContent = s.log.join('\\n'); $('log').scrollTop = 1e9;
    $('status').textContent = s.status === 'running' ? 'Running… ' + s.elapsed + 's' : s.status + ' in ' + s.elapsed + 's';
    if (s.status !== 'running') {
      clearInterval(timer); $('go').disabled = false;
      if (s.files['video.mp4']) {
        $('video').src = s.files['video.mp4']; $('poster').src = s.files['poster.png']; $('caption').textContent = s.caption;
        $('dl').href = s.files['video.mp4']; $('result').style.display = 'block'; $('video').play().catch(() => {});
      }
    }
  }, 1500);
};
</script></body></html>`);
}

fs.mkdirSync(OUT, { recursive: true });
server.listen(PORT, () => console.log(`launch-video web demo: http://localhost:${PORT}`));
