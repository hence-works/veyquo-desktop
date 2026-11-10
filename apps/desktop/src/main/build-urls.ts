// The Veyquo URLs a packaged build talks to, fixed when it is built: `VEYQUO_BUILD_API_URL`
// and `VEYQUO_BUILD_WEB_URL` in the environment of `yarn dist` (scripts/build.ts bakes them
// in as `__VEYQUO_BUILD_URLS__`). Both or neither, https only, no credentials. A build
// without them falls back to the local dev stack only when it is not packaged.

import type { AppConfig } from './config.ts';

declare const __VEYQUO_BUILD_URLS__: AppConfig | null | undefined;

function httpsUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error(`${name} must be an https URL`);
  if (url.username || url.password) throw new Error(`${name} must be a URL without credentials`);
  return `${url.origin}${url.pathname}`.replace(/\/+$/u, '');
}

export function parseBuildUrls(env: Record<string, string | undefined>): AppConfig | null {
  const api = env.VEYQUO_BUILD_API_URL ?? '';
  const web = env.VEYQUO_BUILD_WEB_URL ?? '';
  if (api === '' && web === '') return null;
  if (api === '' || web === '') {
    throw new Error('set both VEYQUO_BUILD_API_URL and VEYQUO_BUILD_WEB_URL, or neither');
  }
  return {
    apiUrl: httpsUrl('VEYQUO_BUILD_API_URL', api),
    webUrl: httpsUrl('VEYQUO_BUILD_WEB_URL', web),
  };
}

/** The URLs this bundle was built with (null for a development build or a test). */
export function builtInUrls(): AppConfig | null {
  return typeof __VEYQUO_BUILD_URLS__ === 'undefined' ? null : __VEYQUO_BUILD_URLS__;
}
