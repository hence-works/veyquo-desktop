import { expect, it, vi } from 'vitest';

import { DevicesApi } from '../../src/main/api.ts';
import { parseCommand } from '../../src/main/commands.ts';

const viewId = '7ad19a89-822e-4b42-8f11-86d1c58b2a5a';

it('changes only an attached profile mode through the device bearer route', async () => {
  const fetch = vi.fn((url: string, init: RequestInit) => {
    expect(url).toBe(`https://api.veyquo.test/v1/devices/self/browser-settings/${viewId}`);
    expect(init.method).toBe('PATCH');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer device-token' });
    expect(init.body).toBe('{"chrome_mode":"everyday_profile"}');
    return Promise.resolve(
      new Response(
        JSON.stringify({
          selected_modes: ['everyday_profile'],
          profiles: [
            {
              view_id: viewId,
              name: 'Whole profile',
              chrome_mode: 'everyday_profile',
              has_proxy: false,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });
  const api = new DevicesApi('https://api.veyquo.test', fetch);

  const settings = await api.updateBrowserMode('device-token', viewId, 'everyday_profile');

  expect(settings.profiles[0]?.chrome_mode).toBe('everyday_profile');
  expect(fetch).toHaveBeenCalledOnce();
});

it('keeps aggregate browser status readable from an older API response', async () => {
  const api = new DevicesApi('https://api.veyquo.test', () =>
    Promise.resolve(new Response(JSON.stringify({ selected_modes: ['veyquo_profile'] }))),
  );

  expect(await api.browserSettings('device-token')).toEqual({
    selected_modes: ['veyquo_profile'],
    profiles: [],
  });
});

it('accepts only an exact browser mode command from the desktop status page', () => {
  expect(parseCommand({ name: 'set_browser_mode', viewId, mode: 'everyday_profile' })).toEqual({
    name: 'set_browser_mode',
    viewId,
    mode: 'everyday_profile',
  });
  expect(
    parseCommand({ name: 'set_browser_mode', viewId: 'not-a-uuid', mode: 'veyquo_profile' }),
  ).toBeNull();
  expect(parseCommand({ name: 'set_browser_mode', viewId, mode: 'unknown' })).toBeNull();
});
