import { describe, expect, it } from 'vitest';

import type { ChromeLocation } from '../../src/main/chrome/locate.ts';
import { checkExecutor, runSmoke, smokeExit, type SmokeDeps } from '../../src/main/smoke.ts';

const found: ChromeLocation = {
  ok: true,
  path: '/home/ana/chrome/google-chrome',
  version: '152.0.7977.75',
  major: 152,
};

function harness(overrides: Partial<SmokeDeps> = {}): { deps: SmokeDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      locate: () => Promise.resolve(found),
      checkExecutor,
      write: (line) => lines.push(line),
      packaged: true,
      buildUrls: true,
      ...overrides,
    },
  };
}

function reported(lines: string[]): unknown {
  expect(lines).toHaveLength(1);
  expect(lines[0]?.endsWith('\n')).toBe(true);
  return JSON.parse(lines[0] ?? '');
}

describe('runSmoke', () => {
  it('exits 0 when Chrome found', async () => {
    const { deps, lines } = harness();
    expect(await runSmoke(deps)).toBe(smokeExit.ok);
    expect(smokeExit.ok).toBe(0);
    expect(reported(lines)).toEqual({
      event: 'smoke',
      result: 'ok',
      chrome_version: '152.0.7977.75',
      packaged: true,
      build_urls: true,
    });
  });

  it('exits 3 when Chrome missing', async () => {
    const { deps, lines } = harness({
      locate: () => Promise.resolve({ ok: false, error: 'chrome_unavailable', reason: 'missing' }),
    });
    expect(await runSmoke(deps)).toBe(smokeExit.chromeUnavailable);
    expect(smokeExit.chromeUnavailable).toBe(3);
    expect(reported(lines)).toEqual({
      event: 'smoke',
      result: 'chrome_unavailable',
      reason: 'missing',
    });
  });

  it('exits 3 when Chrome is older than the minimum, naming only its version', async () => {
    const { deps, lines } = harness({
      locate: () =>
        Promise.resolve({
          ok: false,
          error: 'chrome_unavailable',
          reason: 'too_old',
          path: '/home/ana/old/chrome',
          version: '135.0.7049.114',
        }),
    });
    expect(await runSmoke(deps)).toBe(3);
    expect(reported(lines)).toEqual({
      event: 'smoke',
      result: 'chrome_unavailable',
      reason: 'too_old',
      chrome_version: '135.0.7049.114',
    });
  });

  it('exits 1 when the executor does not load, naming only the error class', async () => {
    const { deps, lines } = harness({
      checkExecutor: () => {
        throw new TypeError('schema /home/ana/secret.json failed');
      },
    });
    expect(await runSmoke(deps)).toBe(smokeExit.failed);
    expect(smokeExit.failed).toBe(1);
    expect(reported(lines)).toEqual({ event: 'smoke', result: 'failed', error: 'TypeError' });
  });

  it('exits 1 when locating Chrome throws', async () => {
    const { deps, lines } = harness({ locate: () => Promise.reject(new RangeError('boom')) });
    expect(await runSmoke(deps)).toBe(1);
    expect(reported(lines)).toEqual({ event: 'smoke', result: 'failed', error: 'RangeError' });
  });

  it('never reports the Chrome path', async () => {
    const { deps, lines } = harness();
    await runSmoke(deps);
    expect(lines.join('')).not.toContain('/home/ana');
  });
});

describe('checkExecutor', () => {
  it('loads the bundled protocol validator', () => {
    expect(() => {
      checkExecutor();
    }).not.toThrow();
  });
});
