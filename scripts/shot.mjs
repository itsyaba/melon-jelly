// Usage: node scripts/shot.mjs [url] [out.png] [width] [height] [waitMs]
import { chromium } from 'playwright';
const [url = 'http://localhost:5173/', out = 'shot.png', w = '1440', h = '900', wait = '3500'] = process.argv.slice(2);
const browser = await chromium.launch({
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPU', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--enable-gpu'],
});
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 400)));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
const info = await page.evaluate(async () => {
  if (!navigator.gpu) return 'no navigator.gpu';
  const a = await navigator.gpu.requestAdapter();
  return a ? JSON.stringify(a.info || {}) : 'no adapter';
});
console.log('adapter:', info);
await page.waitForTimeout(+wait);
const st = await page.evaluate(() => ({ status: document.querySelector('.status')?.textContent, fps: window.__melon?.fps, pieces: window.__melon?.pieces }));
console.log('state:', JSON.stringify(st));
await page.screenshot({ path: out });
await browser.close();
