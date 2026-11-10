import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/main/config.ts';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'veyquo-config-'));
  file = join(dir, 'config.json');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('defaults to the local dev stack without pinning it', async () => {
    expect(await loadConfig(file, {})).toEqual({
      apiUrl: 'http://localhost:8400',
      webUrl: 'http://localhost:3400',
    });
    await expect(readFile(file, 'utf8')).rejects.toThrow(/ENOENT/u);
  });

  it('remembers what the environment set', async () => {
    await loadConfig(file, { VEYQUO_API_URL: 'http://127.0.0.1:9999' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ api_url: 'http://127.0.0.1:9999' });
    expect(await loadConfig(file, {})).toEqual({
      apiUrl: 'http://127.0.0.1:9999',
      webUrl: 'http://localhost:3400',
    });
  });

  it('a packaged build uses the URLs it was built with, and never pins them', async () => {
    const built = { apiUrl: 'https://api.veyquo.com', webUrl: 'https://veyquo.com' };
    expect(await loadConfig(file, {}, { packaged: true, defaults: built })).toEqual(built);
    await expect(readFile(file, 'utf8')).rejects.toThrow(/ENOENT/u);
    // The next release's URLs apply after an update.
    const next = { apiUrl: 'https://api2.veyquo.com', webUrl: 'https://veyquo.com' };
    expect(await loadConfig(file, {}, { packaged: true, defaults: next })).toEqual(next);
  });

  it('a packaged build without built-in URLs never falls back to localhost', async () => {
    await expect(loadConfig(file, {}, { packaged: true, defaults: null })).rejects.toThrow(
      /VEYQUO_API_URL is not set, and this build has no Veyquo address/u,
    );
    expect(
      await loadConfig(
        file,
        { VEYQUO_API_URL: 'http://localhost:8400', VEYQUO_WEB_URL: 'http://localhost:3400' },
        { packaged: true, defaults: null },
      ),
    ).toEqual({ apiUrl: 'http://localhost:8400', webUrl: 'http://localhost:3400' });
  });

  it('reads the saved file, and the environment wins over it', async () => {
    await writeFile(
      file,
      JSON.stringify({ api_url: 'https://api.veyquo.com', web_url: 'https://veyquo.com' }),
    );
    expect(await loadConfig(file, {})).toEqual({
      apiUrl: 'https://api.veyquo.com',
      webUrl: 'https://veyquo.com',
    });
    expect(await loadConfig(file, { VEYQUO_API_URL: 'http://127.0.0.1:9999/' })).toEqual({
      apiUrl: 'http://127.0.0.1:9999',
      webUrl: 'https://veyquo.com',
    });
  });

  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'not a url',
    'https://user:pw@api.veyquo.com',
  ])('refuses %s as a URL', async (url) => {
    await expect(loadConfig(file, { VEYQUO_API_URL: url })).rejects.toThrow(/VEYQUO_API_URL/u);
  });

  it.each([
    { url: 'http://api.veyquo.com', packaged: true, ok: false },
    { url: 'http://10.0.0.5:8400', packaged: true, ok: false },
    { url: 'https://api.veyquo.com', packaged: true, ok: true },
    { url: 'http://localhost:8400', packaged: true, ok: true },
    { url: 'http://127.0.0.1:8400', packaged: true, ok: true },
    { url: 'http://[::1]:8400', packaged: true, ok: true },
    { url: 'http://api.veyquo.test', packaged: false, ok: true },
  ])('packaged=$packaged accepts $url: $ok', async ({ url, packaged, ok }) => {
    const loading = loadConfig(file, { VEYQUO_API_URL: url, VEYQUO_WEB_URL: url }, { packaged });
    if (ok) await expect(loading).resolves.toHaveProperty('apiUrl');
    else await expect(loading).rejects.toThrow(/must use https/u);
  });

  it('a packaged build ignores the http URLs a development run saved, and keeps them', async () => {
    const devFile = `${JSON.stringify({
      api_url: 'http://localhost:8400',
      web_url: 'http://localhost:3400',
    })}\n`;
    await writeFile(file, devFile);
    const built = { apiUrl: 'https://api.veyquo.com', webUrl: 'https://veyquo.com' };
    expect(await loadConfig(file, {}, { packaged: true, defaults: built })).toEqual(built);
    await expect(loadConfig(file, {}, { packaged: true, defaults: null })).rejects.toThrow(
      /this build has no Veyquo address/u,
    );
    // The development run that wrote them still finds them.
    expect(await readFile(file, 'utf8')).toBe(devFile);
    expect((await loadConfig(file, {})).apiUrl).toBe('http://localhost:8400');
  });

  it('a packaged build keeps a saved https URL and an http one the environment sets', async () => {
    await writeFile(
      file,
      JSON.stringify({ api_url: 'https://api.eu.veyquo.com', web_url: 'http://localhost:3400' }),
    );
    const built = { apiUrl: 'https://api.veyquo.com', webUrl: 'https://veyquo.com' };
    expect(await loadConfig(file, {}, { packaged: true, defaults: built })).toEqual({
      apiUrl: 'https://api.eu.veyquo.com',
      webUrl: 'https://veyquo.com',
    });
    expect(
      await loadConfig(
        file,
        { VEYQUO_WEB_URL: 'http://localhost:3400' },
        { packaged: true, defaults: built },
      ),
    ).toEqual({ apiUrl: 'https://api.eu.veyquo.com', webUrl: 'http://localhost:3400' });
  });

  it('a broken saved file falls back to the defaults', async () => {
    await writeFile(file, '{oops');
    expect((await loadConfig(file, {})).apiUrl).toBe('http://localhost:8400');
  });
});
