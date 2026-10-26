// Renders build/icon.svg to the PNGs electron-builder and the app use. `npm run icons`
import { chromium } from 'playwright';
import fs from 'node:fs';
const svg = fs.readFileSync(new URL('../build/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
const shot = await page.locator('svg').screenshot({ omitBackground: true });
fs.writeFileSync(new URL('../build/icon.png', import.meta.url), shot);
fs.writeFileSync(new URL('../src/renderer/img/icon.png', import.meta.url), shot);
await browser.close();
console.log('icons written');
