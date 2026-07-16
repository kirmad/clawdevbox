/**
 * gen-pwa-icons.mjs — regenerate the PNG app icons.
 *
 * The clawdevbox glyph lives as SVG in src/pwa-assets.ts, but a real
 * standalone PWA install needs PNGs: iOS ignores SVG `apple-touch-icon`,
 * and Android WebAPK minting wants PNG 192 + 512 manifest icons. Rather
 * than ship binary files, we rasterize the glyph here (via the Playwright
 * chromium that's already a dependency) and write the bytes as base64
 * constants into src/pwa-icons.ts, which the server decodes + serves.
 *
 * Run:  node scripts/gen-pwa-icons.mjs   (from mcp-server/)
 * Then: npm run build
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '..', 'src', 'pwa-icons.ts');

const BG = '#14161b', FG = '#88c0d0', FG_DIM = '#5e93a0';

// Rounded-square glyph, `rx` controls corner radius (0 = full square).
function squareSvg(rx) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" rx="${rx}" fill="${BG}"/>
    <g transform="translate(106 84)">
      <path d="M222 80 a172 172 0 1 0 0 188" fill="none" stroke="${FG}" stroke-width="60" stroke-linecap="round"/>
      <circle cx="244" cy="100" r="22" fill="${FG_DIM}"/>
    </g>
  </svg>`;
}
// Maskable: ~20% safe-zone padding so platform masks don't clip the glyph.
function maskableSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
    <rect width="512" height="512" fill="${BG}"/>
    <g transform="translate(160 132) scale(0.78)">
      <rect width="512" height="512" rx="96" fill="${BG}"/>
      <g transform="translate(106 84)">
        <path d="M222 80 a172 172 0 1 0 0 188" fill="none" stroke="${FG}" stroke-width="60" stroke-linecap="round"/>
        <circle cx="244" cy="100" r="22" fill="${FG_DIM}"/>
      </g>
    </g>
  </svg>`;
}

const jobs = [
  { key: 'ICON_192', size: 192, svg: squareSvg(36), opaque: false },
  { key: 'ICON_512', size: 512, svg: squareSvg(96), opaque: false },
  { key: 'ICON_MASKABLE_512', size: 512, svg: maskableSvg(), opaque: false },
  { key: 'APPLE_TOUCH_180', size: 180, svg: squareSvg(0), opaque: true }, // iOS: full-bleed, opaque
];

const browser = await chromium.launch();
const consts = {};
for (const j of jobs) {
  const page = await browser.newPage({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 });
  const svg = j.svg.replace('<svg ', `<svg width="${j.size}" height="${j.size}" `);
  await page.setContent(`<!doctype html><html><body style="margin:0;padding:0">${svg}</body></html>`);
  const buf = await page.screenshot({ omitBackground: !j.opaque });
  consts[j.key] = buf.toString('base64');
  console.log(`${j.key}: ${j.size}px, ${buf.length} bytes`);
  await page.close();
}
await browser.close();

const banner = `/**
 * pwa-icons.ts — AUTO-GENERATED. Do not edit by hand.
 *
 * PNG app icons (base64) rasterized from the SVG glyph in pwa-assets.ts.
 * Regenerate with: node scripts/gen-pwa-icons.mjs && npm run build
 */
`;
const body = Object.entries(consts)
  .map(([k, v]) => `const ${k}_B64 =\n  '${v}';`)
  .join('\n\n');
const exports = `
export const icon192Png = (): Buffer => Buffer.from(ICON_192_B64, 'base64');
export const icon512Png = (): Buffer => Buffer.from(ICON_512_B64, 'base64');
export const iconMaskable512Png = (): Buffer => Buffer.from(ICON_MASKABLE_512_B64, 'base64');
export const appleTouch180Png = (): Buffer => Buffer.from(APPLE_TOUCH_180_B64, 'base64');
`;
writeFileSync(OUT, `${banner}\n${body}\n${exports}`);
console.log('wrote', OUT);
