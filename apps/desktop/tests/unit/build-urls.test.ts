import { describe, expect, it } from 'vitest';

import { parseBuildUrls } from '../../src/main/build-urls.ts';

describe('parseBuildUrls', () => {
  it('a build without URLs has none', () => {
    expect(parseBuildUrls({})).toBeNull();
    expect(parseBuildUrls({ VEYQUO_BUILD_API_URL: '', VEYQUO_BUILD_WEB_URL: '' })).toBeNull();
  });

  it('takes both https URLs, without a trailing slash', () => {
    expect(
      parseBuildUrls({
        VEYQUO_BUILD_API_URL: 'https://api.veyquo.com/',
        VEYQUO_BUILD_WEB_URL: 'https://veyquo.com',
      }),
    ).toEqual({ apiUrl: 'https://api.veyquo.com', webUrl: 'https://veyquo.com' });
  });

  it.each([
    [{ VEYQUO_BUILD_API_URL: 'https://api.veyquo.com' }, /both/u],
    [{ VEYQUO_BUILD_WEB_URL: 'https://veyquo.com' }, /both/u],
    [
      { VEYQUO_BUILD_API_URL: 'http://localhost:8400', VEYQUO_BUILD_WEB_URL: 'https://veyquo.com' },
      /VEYQUO_BUILD_API_URL must be an https URL/u,
    ],
    [
      { VEYQUO_BUILD_API_URL: 'https://api.veyquo.com', VEYQUO_BUILD_WEB_URL: 'http://veyquo.com' },
      /VEYQUO_BUILD_WEB_URL must be an https URL/u,
    ],
    [
      {
        VEYQUO_BUILD_API_URL: 'https://u:p@api.veyquo.com',
        VEYQUO_BUILD_WEB_URL: 'https://veyquo.com',
      },
      /without credentials/u,
    ],
    [
      { VEYQUO_BUILD_API_URL: 'not a url', VEYQUO_BUILD_WEB_URL: 'https://veyquo.com' },
      /VEYQUO_BUILD_API_URL is not a URL/u,
    ],
  ])('refuses %o', (env, message) => {
    expect(() => parseBuildUrls(env)).toThrow(message);
  });
});
