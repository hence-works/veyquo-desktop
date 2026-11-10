// Where the app finds Veyquo: `VEYQUO_API_URL` and `VEYQUO_WEB_URL` from the environment,
// else `userData/config.json`, else the URLs the build carries (`build-urls.ts`), else (only
// when not packaged) the local dev stack on http://localhost:8400 and :3400. A packaged build
// never falls back to localhost, and skips saved plain-http URLs (a development run's, in a
// shared folder). Only what the environment sets is saved to the file, so a later release's
// built-in URLs apply after an update.

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { writeFileDurably } from './durable-file.ts';

export interface AppConfig {
  apiUrl: string;
  webUrl: string;
}

export const defaultConfig: AppConfig = {
  apiUrl: 'http://localhost:8400',
  webUrl: 'http://localhost:3400',
};

const saved = z.object({ api_url: z.string().optional(), web_url: z.string().optional() });

const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An http(s) origin-and-path URL without credentials, with no trailing slash. A packaged
 * build talks to anything but this computer over https only. */
function webUrl(name: string, value: string, packaged: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error(`${name} must be an http(s) URL without credentials`);
  }
  if (packaged && url.protocol === 'http:' && !localHosts.has(url.hostname)) {
    throw new Error(`${name} must use https outside this computer`);
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, '');
}

export interface LoadConfigOptions {
  packaged?: boolean;
  /** The URLs the build carries; null for a build without them. */
  defaults?: AppConfig | null;
}

export async function loadConfig(
  file: string,
  env: Record<string, string | undefined>,
  options: LoadConfigOptions = {},
): Promise<AppConfig> {
  const packaged = options.packaged ?? false;
  const fallback = options.defaults ?? (packaged ? null : defaultConfig);
  let stored: z.infer<typeof saved> = {};
  try {
    const parsed = saved.safeParse(JSON.parse(await readFile(file, 'utf8')));
    if (parsed.success) stored = parsed.data;
  } catch {
    // Missing or unreadable: nothing set explicitly.
  }
  // A packaged build skips a saved plain-http URL: in a userData folder shared with a
  // development run, that run's localhost URLs would otherwise pin the build to it. The file
  // keeps them for the development run; the environment may still set http to localhost.
  const usable = (value: string | undefined): string | undefined =>
    packaged && value !== undefined && /^http:/iu.test(value.trim()) ? undefined : value;
  const explicitApi = env.VEYQUO_API_URL ?? usable(stored.api_url);
  const explicitWeb = env.VEYQUO_WEB_URL ?? usable(stored.web_url);
  const pick = (name: string, explicit: string | undefined, built: string | undefined): string => {
    const value = explicit ?? built;
    if (value === undefined)
      throw new Error(`${name} is not set, and this build has no Veyquo address`);
    return webUrl(name, value, packaged);
  };
  const config: AppConfig = {
    apiUrl: pick('VEYQUO_API_URL', explicitApi, fallback?.apiUrl),
    webUrl: pick('VEYQUO_WEB_URL', explicitWeb, fallback?.webUrl),
  };
  if (env.VEYQUO_API_URL !== undefined || env.VEYQUO_WEB_URL !== undefined) {
    // What the environment set is remembered; other saved values stay as they were.
    const remembered = {
      ...stored,
      ...(env.VEYQUO_API_URL === undefined ? {} : { api_url: config.apiUrl }),
      ...(env.VEYQUO_WEB_URL === undefined ? {} : { web_url: config.webUrl }),
    };
    await writeFileDurably(file, `${JSON.stringify(remembered, null, 2)}\n`);
  }
  return config;
}
