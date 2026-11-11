import { defineConfig } from '@playwright/test';

// The built extension (yarn build -> dist/) in Playwright's bundled Chromium, one fresh
// profile per test, a stub native host and local fixture pages (tests/support/browser.ts).
// Headful: run under `xvfb-run -a` on Linux.
export default defineConfig({
  testDir: './tests/integration',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
});
