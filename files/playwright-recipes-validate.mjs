/**
 * playwright-recipes-validate.mjs
 *
 * End-to-end Playwright smoke-test for /api/recipes DB-first persistence.
 * Navigates to the Recipes tab, screenshots the result, and reports:
 *   - number of recipe instances visible
 *   - any browser console errors
 *   - /api/recipes round-trip latency (5 probes)
 *
 * Usage:
 *   npx playwright install --with-deps chromium
 *   node files/playwright-recipes-validate.mjs
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = 'http://127.0.0.1:5201';
const SCREENSHOT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'recipes-list-after.png');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

// Navigate to the app and click the Recipes tab
await page.goto(BASE_URL, { waitUntil: 'load', timeout: 15_000 });
await page.waitForTimeout(2000);

// Try to find the Recipes navigation item
const recipesTab = page.locator('a, button, [role="tab"]').filter({ hasText: /recipe/i }).first();
if (await recipesTab.count() > 0) {
  await recipesTab.click();
  await page.waitForTimeout(1500);
} else {
  // Navigate directly to /recipes if SPA routing supports it
  await page.goto(`${BASE_URL}/#/recipes`, { waitUntil: 'load', timeout: 10_000 });
  await page.waitForTimeout(1500);
}

// Count visible recipe instance cards / rows
const instanceCount = await page.locator('[data-testid="recipe-instance"], .recipe-instance, .recipe-row, .p-datatable-row, tr').count();

// Take screenshot
await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
console.log(`Screenshot saved: ${SCREENSHOT_PATH}`);
console.log(`Visible recipe elements: ${instanceCount}`);
console.log(`Console errors: ${consoleErrors.length === 0 ? 'none' : consoleErrors.join('; ')}`);

// Measure /api/recipes latency
const latencies = [];
for (let i = 0; i < 5; i++) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE_URL}/api/recipes`);
  const data = await resp.json();
  latencies.push(Date.now() - t0);
  if (i === 0) {
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    console.log(`/api/recipes returned ${items.length} instances`);
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`/api/recipes latencies (ms): ${latencies.join(', ')}`);
console.log(`  cold=${latencies[0]}ms  warm-avg=${Math.round(latencies.slice(1).reduce((a, b) => a + b, 0) / (latencies.length - 1))}ms`);

await browser.close();
