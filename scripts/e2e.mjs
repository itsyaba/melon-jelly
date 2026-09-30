// End-to-end checks (guide M11) against a running dev/preview server.
// Usage: node scripts/e2e.mjs [url] [shotDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://localhost:5391/';
const dir = process.argv[3] || 'e2e-shots';
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist'],
});
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => window.__melon?.sim && document.body.classList.contains('ready'), null, { timeout: 20000 });

// screen position of a world point
const toScreen = (p) => page.evaluate((p) => {
  const m = window.__melon.cam.viewProj, r = document.getElementById('gl').getBoundingClientRect();
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [r.left + ((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w * 0.5 + 0.5) * r.width,
    r.top + (0.5 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w * 0.5) * r.height];
}, p);
const sim = (fn) => page.evaluate(fn);

// 1. settles: KE ≈ 0, volume within 2 %
await page.waitForFunction(() => {
  const s = window.__melon.sim;
  return s.kineticEnergy() / s.totalMass < 1e-4 && performance.now() > 3000;
}, null, { timeout: 30000 }).catch(() => {});
const settle = await sim(() => {
  const s = window.__melon.sim;
  return { ke: s.kineticEnergy() / s.totalMass, vol: s.volumeRatio() };
});
check('settles at rest', settle.ke < 1e-4 && settle.vol > 0.98 && settle.vol < 1.02, `KE/M ${settle.ke.toExponential(1)}, vol ${(settle.vol * 100).toFixed(2)}%`);
await page.screenshot({ path: `${dir}/01-rest.png` });

// 5. backdrop: corner pixel equals #E2DFDA ± 1
const px = await page.evaluate(async () => {
  const f = await window.__melon.renderer.capture();
  const at = (x, y) => Array.from(f.data.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 3));
  return { tl: at(2, 2), br: at(f.width - 3, f.height - 3) };
});
const near = (c) => Math.abs(c[0] - 0xe2) <= 1 && Math.abs(c[1] - 0xdf) <= 1 && Math.abs(c[2] - 0xda) <= 1;
check('backdrop matches --bg', near(px.tl) && near(px.br), `tl ${px.tl} br ${px.br}`);

// 2. grab the tip and pull hard: no inverted tets
const tip = await sim(() => {
  const s = window.__melon.sim;
  let best = 0;
  for (let i = 0; i < s.n; i++) if (s.x[3 * i + 2] < s.x[3 * best + 2]) best = i;
  return [s.x[3 * best], s.x[3 * best + 1] + 0.05, s.x[3 * best + 2] + 0.12];
});
const [tx, ty] = await toScreen(tip);
await page.mouse.move(tx, ty);
await page.mouse.down();
let minVR = 1;
for (let k = 1; k <= 20; k++) {
  await page.mouse.move(tx - k * 14, ty - k * 16);
  await page.waitForTimeout(40);
}
await page.waitForTimeout(600);
const grabbed = await sim(() => window.__melon.sim.grabbing);
minVR = await sim(() => window.__melon.sim.minVolumeRatio());
await page.screenshot({ path: `${dir}/02-stretch.png` });
await page.mouse.up();
check('grab engages on the tip', grabbed);
check('stretch keeps tets un-inverted', minVR > 0, `min volume ratio ${minVR.toFixed(3)}`);
await page.waitForTimeout(2500);
await page.screenshot({ path: `${dir}/03-released.png` });

// reset, then cut with the knife tool through the middle
await page.keyboard.press('r');
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Knife' }).click();
const mid = await sim(() => window.__melon.sim.centroid());
const [ax, ay] = await toScreen([mid[0] - 1.3, 0.58, mid[2]]);
const [bx, by] = await toScreen([mid[0] + 1.3, 0.58, mid[2]]);
await page.mouse.move(ax, ay);
await page.waitForTimeout(400);
await page.screenshot({ path: `${dir}/04-knife-hover.png` });
await page.mouse.down();
for (let k = 1; k <= 16; k++) await page.mouse.move(ax + ((bx - ax) * k) / 16, ay + ((by - ay) * k) / 16);
await page.screenshot({ path: `${dir}/05-stroke.png` });
await page.mouse.up();
// capture the press and the split mid-animation (on the sim clock)
await page.waitForFunction(() => window.__melon.knifeAnim && window.__melon.knifeAnim.t > 0.3, null, { timeout: 10000 }).catch(() => {});
await page.screenshot({ path: `${dir}/06-press.png` });
await page.waitForFunction(() => window.__melon.knifeAnim && window.__melon.knifeAnim.t > 0.62, null, { timeout: 10000 }).catch(() => {});
await page.screenshot({ path: `${dir}/07-through.png` });
await page.waitForFunction(() => !window.__melon.knifeAnim, null, { timeout: 15000 }).catch(() => {});
const c0 = await sim(() => window.__melon.compStats().map((c) => c.centroid));
await page.waitForTimeout(2000);
const cut = await sim(() => ({ pieces: window.__melon.pieces, cs: window.__melon.compStats().map((c) => c.centroid), commit: window.__melon.lastCommitMs }));
const sepd = cut.cs.length === 2 ? Math.hypot(cut.cs[0][0] - cut.cs[1][0], cut.cs[0][2] - cut.cs[1][2]) : 0;
check('knife cut makes 2 pieces', cut.pieces === 2, `pieces ${cut.pieces}, commit ${cut.commit?.toFixed(1)} ms`);
check('pieces separate', sepd > 0.1, `centroid distance ${sepd.toFixed(3)} (right after: ${c0.length})`);
await page.screenshot({ path: `${dir}/08-cut.png` });

// cut again, perpendicular, through one half
const m2 = await sim(() => window.__melon.sim.centroid(0));
const [cx0, cy0] = await toScreen([m2[0], 0.58, m2[2] - 0.9]);
const [cx1, cy1] = await toScreen([m2[0], 0.58, m2[2] + 0.9]);
await page.mouse.move(cx0, cy0);
await page.mouse.down();
for (let k = 1; k <= 12; k++) await page.mouse.move(cx0 + ((cx1 - cx0) * k) / 12, cy0 + ((cy1 - cy0) * k) / 12);
await page.mouse.up();
await page.waitForFunction(() => !window.__melon.knifeAnim, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
const cut2 = await sim(() => ({ pieces: window.__melon.pieces, toast: document.getElementById('toast').textContent }));
check('second cut splits again', cut2.pieces >= 3, `pieces ${cut2.pieces} ${cut2.toast}`);
await page.screenshot({ path: `${dir}/09-cut2.png` });

// 4. many instant cuts across the whole group: stops at the piece cap (or when what's
//    left is too small to split), and refuses cleanly
const many = await sim(() => {
  const m = window.__melon, r = document.getElementById('gl').getBoundingClientRect();
  const vp = m.cam.viewProj;
  const proj = (p) => {
    const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return [r.left + ((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / w * 0.5 + 0.5) * r.width,
      r.top + (0.5 - (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / w * 0.5) * r.height];
  };
  const log = [];
  for (let k = 0; k < 60 && m.pieces < 14; k++) {
    const s = m.sim, c = s.centroid();
    const ang = k * 2.39996, off = ((k * 0.618) % 1 - 0.5) * 1.2;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const o = [c[0] - dz * off, 0.5, c[2] + dx * off];
    const a = proj([o[0] - dx * 3, 0.5, o[2] - dz * 3]), b = proj([o[0] + dx * 3, 0.5, o[2] + dz * 3]);
    const res = m.performCut(a[0], a[1], b[0], b[1]);
    log.push(`${m.pieces}:${res.ok ? 'ok' : res.miss}`);
    for (let i = 0; i < 20; i++) s.step();
  }
  const refused = m.performCut(r.left + 100, r.top + r.height / 2, r.right - 100, r.top + r.height / 2);
  return { pieces: m.pieces, refused, log };
});
if (process.env.DEBUG) console.log(many.log.join(' '));
check('cuts all the way to the 14-piece cap', many.pieces === 14 && !many.refused.ok && /plenty/i.test(many.refused.miss) && !many.log.some((l) => /thin/i.test(l)), `pieces ${many.pieces}, "${many.refused.miss}"`);
await page.waitForTimeout(2500);
check('many pieces stay stable', await sim(() => Number.isFinite(window.__melon.sim.minY()) && window.__melon.sim.minVolumeRatio() > 0));
await page.screenshot({ path: `${dir}/10-many.png` });

// reset returns to one piece
await page.getByRole('button', { name: 'Reset' }).click();
await page.waitForTimeout(300);
check('reset restores one piece', (await sim(() => window.__melon.pieces)) === 1);

// controls
await page.getByRole('radio', { name: 'Golden' }).click();
await page.getByLabel('Show mesh').check({ force: true });
await page.getByRole('button', { name: 'Hand' }).click();
await page.waitForTimeout(2200);
await page.screenshot({ path: `${dir}/11-golden-mesh.png` });
await page.getByLabel('Show mesh').uncheck({ force: true });
await page.getByRole('radio', { name: 'Rosé' }).click();
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press('Space');
const paused = await sim(() => window.__melon.state.paused && document.querySelector('.status').dataset.state === 'paused');
check('space pauses', paused);
await page.keyboard.press('Space');
await page.waitForTimeout(600);
await page.screenshot({ path: `${dir}/12-rose.png` });
check('fps is reasonable', (await sim(() => window.__melon.fps)) > 20, `fps ${(await sim(() => window.__melon.fps)).toFixed(0)}`);

// layouts
for (const [w, h, name] of [[1280, 700, '13-short'], [390, 844, '14-phone']]) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: name.includes('phone') ? 2 : 1 });
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 20000 });
  await p.waitForTimeout(2500);
  const hscroll = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(`${name}: no horizontal scroll`, !hscroll);
  await p.screenshot({ path: `${dir}/${name}.png`, fullPage: name.includes('phone') });
  await p.close();
}

check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
