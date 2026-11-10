import { defineConfig } from 'vitest/config';

// The built app (`yarn build`) under Electron, driven by Playwright's `_electron`, against a
// local fake gateway and real Chrome (CHROME_PATH, else /usr/bin/google-chrome). Needs a
// display: run under `xvfb-run -a` on Linux.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
