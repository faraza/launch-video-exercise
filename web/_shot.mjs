// Dev helper: screenshot the demo's cover, progress, result and poster states.
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:3999';
const id = process.argv[3];
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(base + '/'); await p.waitForTimeout(500);
await p.screenshot({ path: 'out/ui-cover.png' });
await p.evaluate(() => { document.getElementById('cover').classList.remove('on'); document.getElementById('progress').classList.add('on'); document.getElementById('psite').textContent = 'vercel.com'; document.getElementById('pstage').textContent = 'Generating footage'; document.getElementById('pbar').style.width = '47%'; document.getElementById('ppct').textContent = '47%'; });
await p.waitForTimeout(1200);
await p.screenshot({ path: 'out/ui-progress.png' });
if (id) {
  await p.goto(base + '/result/' + id); await p.waitForTimeout(2500);
  await p.screenshot({ path: 'out/ui-result.png' });
  await p.evaluate(() => { const v = document.getElementById('video'); v.currentTime = v.duration - 0.2; });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: 'out/ui-poster.png' });
  console.log('poster state:', await p.evaluate(() => document.getElementById('player').className));
}
await b.close();
