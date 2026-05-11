// playwright.config.mjs — minimal config for the terminal-viewer test.
// We don't need a webServer because the test boots the terminal-server
// in-process, and we don't need projects because there's only one
// Chromium target.

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.playwright\.test\.mjs$/,
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: 'list',
  use: {
    headless: true,
    actionTimeout: 5_000,
  },
});
