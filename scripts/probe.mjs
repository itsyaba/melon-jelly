import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:5391/';
const browser = await chromium.launch({ args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
await page.goto(url);
await page.waitForFunction(() => window.__melon?.sim);
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(700);
  console.log(await page.evaluate(() => { const m = window.__melon, s = m.sim; return JSON.stringify({ t: performance.now().toFixed(0), fps: m.fps.toFixed(0), keM: (s.kineticEnergy() / s.totalMass).toExponential(2), vol: s.volumeRatio().toFixed(4), minY: s.minY().toFixed(3), c: s.centroid().map(v => v.toFixed(3)) }); }));
}
await browser.close();
