import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';
import { expect, it } from 'vitest';

import { initialUiState, type UiState, type UiCommand } from '../../src/shared/ui-state.ts';

it('keeps local activity readable and keyboard control stable across state updates', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 680 } });
    const state: UiState = {
      ...initialUiState,
      status: 'working',
      deviceName: 'My-computer-with-a-long-name-that-must-wrap-without-scrolling',
      chrome: { available: true, version: '140.0' },
      modes: { veyquoProfile: true, everydayProfile: true },
      selectedModes: { veyquoProfile: false, everydayProfile: true },
      browserProfiles: [
        {
          viewId: '7ad19a89-822e-4b42-8f11-86d1c58b2a5a',
          name: 'Whole profile',
          chromeMode: 'veyquo_profile',
          hasProxy: false,
        },
        {
          viewId: 'b1616184-8261-48a3-97bb-f1ab8ad88d7a',
          name: 'Research roles',
          chromeMode: 'veyquo_profile',
          hasProxy: true,
        },
      ],
      activity: { kind: 'applying', takenOver: false, visibility: 'visible' },
    };
    await page.addInitScript((initial: UiState) => {
      let current = initial;
      let notify: (state: UiState) => void = () => undefined;
      Object.defineProperty(window, 'veyquo', {
        value: {
          getState: () => Promise.resolve(current),
          onState: (listener: (state: UiState) => void) => {
            notify = listener;
            window.addEventListener('test-state-update', (event) => {
              if (event instanceof CustomEvent && event.detail !== undefined) {
                current = event.detail as UiState;
              }
              notify(current);
            });
            return () => undefined;
          },
          command: (command: UiCommand) => {
            if (command.name === 'take_over' || command.name === 'hand_back') {
              current = {
                ...current,
                activity: {
                  kind: 'applying',
                  takenOver: command.name === 'take_over',
                  visibility: 'visible',
                },
              };
              notify(current);
            }
            if (command.name === 'set_browser_mode') {
              current = {
                ...current,
                browserProfiles: current.browserProfiles.map((profile) =>
                  profile.viewId === command.viewId
                    ? { ...profile, chromeMode: command.mode }
                    : profile,
                ),
              };
              notify(current);
            }
            return Promise.resolve();
          },
        },
      });
    }, state);
    const url = pathToFileURL(join(import.meta.dirname, '../../build/renderer/index.html'));
    await page.goto(url.href);
    expect(await page.getByTestId('mode-everyday').innerText()).toBe(
      'Selected in job profile settings',
    );
    expect(await page.getByTestId('mode-veyquo').innerText()).toBe('Available');
    await page.getByLabel('Whole profile').selectOption('everyday_profile');
    expect(await page.getByLabel('Whole profile').inputValue()).toBe('everyday_profile');
    expect(
      await page
        .getByLabel('Research roles')
        .locator('option[value="everyday_profile"]')
        .getAttribute('disabled'),
    ).not.toBeNull();
    const describedBy = await page.getByLabel('Research roles').getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(await page.locator(`#${String(describedBy)}`).innerText()).toContain('Remove the proxy');
    await page.getByRole('button', { name: 'Take over', exact: true }).click();
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Hand back' })
          .evaluate((node) => node === document.activeElement),
      )
      .toBe(true);
    expect(await page.locator('main').innerText()).toContain('You’ll submit it yourself.');
    await page.getByRole('button', { name: 'Hand back' }).click();
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Take over', exact: true })
          .evaluate((node) => node === document.activeElement),
      )
      .toBe(true);
    await page.getByRole('checkbox', { name: 'Pause local work' }).focus();
    await page.evaluate(() => window.dispatchEvent(new Event('test-state-update')));
    expect(
      await page
        .getByRole('checkbox', { name: 'Pause local work' })
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.evaluate((initial: UiState) => {
      window.dispatchEvent(
        new CustomEvent('test-state-update', {
          detail: {
            ...initial,
            browserModePending: initial.browserProfiles[0]?.viewId ?? null,
            notice: { tone: 'error', text: 'Could not change this job profile’s browser.' },
          },
        }),
      );
    }, state);
    expect(await page.getByLabel('Whole profile').isDisabled()).toBe(true);
    expect(await page.getByLabel('Research roles').isDisabled()).toBe(true);
    expect(await page.getByRole('status').innerText()).toBe('Saving browser choice…');
    expect(await page.getByRole('alert').innerText()).toContain('Could not change');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await expect
        .poll(() => page.locator('html').evaluate((node) => node.classList.contains('dark')))
        .toBe(colorScheme === 'dark');
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        360,
      );
    }
  } finally {
    await browser.close();
  }
});

it('shows browser sign-in without VPN changes and loads the local logo in both themes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 680 } });
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.addInitScript((initial: UiState) => {
      let current: UiState = {
        ...initial,
        access: { status: 'required', message: 'Sign in to connect to this environment.' },
      };
      let notify: (state: UiState) => void = () => undefined;
      const update = (access: UiState['access']) => {
        current = { ...current, access };
        notify(current);
      };
      Object.defineProperty(window, 'veyquo', {
        value: {
          getState: () => Promise.resolve(current),
          onState: (listener: (state: UiState) => void) => {
            notify = listener;
            window.addEventListener('test-access-success', () => {
              update({ status: 'connected', message: null });
            });
            window.addEventListener('test-access-error', () => {
              update({ status: 'error', message: 'Sign-in expired. Try again.' });
            });
            return () => undefined;
          },
          command: (command: UiCommand) => {
            if (command.name === 'access_sign_in') {
              update({ status: 'signing_in', message: 'Complete sign-in in your browser.' });
            } else if (command.name === 'access_cancel' || command.name === 'access_sign_out') {
              update({ status: 'required', message: null });
            }
            return Promise.resolve();
          },
        },
      });
    }, initialUiState);
    await page.goto(
      pathToFileURL(join(import.meta.dirname, '../../build/renderer/index.html')).href,
    );
    expect(await page.getByRole('button', { name: 'Pair this computer' }).count()).toBe(0);
    expect(await page.getByTestId('access').innerText()).toContain(
      'keep your current VPN connected',
    );
    await page.getByRole('button', { name: 'Sign in with browser' }).click();
    expect(await page.getByRole('status').innerText()).toContain('Complete sign-in');
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Cancel sign-in' })
          .evaluate((node) => node === document.activeElement),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Cancel sign-in' }).click();
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Sign in with browser' })
          .evaluate((node) => node === document.activeElement),
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Sign in with browser' }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-access-success')));
    await expect
      .poll(() =>
        page
          .getByRole('button', { name: 'Sign out of browser access' })
          .evaluate((node) => node === document.activeElement),
      )
      .toBe(true);
    expect(await page.getByRole('button', { name: 'Pair this computer' }).isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Sign out of browser access' }).click();
    expect(await page.getByRole('button', { name: 'Pair this computer' }).count()).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new Event('test-access-error')));
    expect(await page.getByRole('alert').innerText()).toBe('Sign-in expired. Try again.');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      const logo = page.getByRole('img', { name: 'Veyquo', exact: true });
      await expect
        .poll(() =>
          logo.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
        )
        .toBe(true);
      const expectedFile = colorScheme === 'dark' ? 'veyquo-logo-dark.png' : 'veyquo-logo.png';
      await expect
        .poll(() => logo.evaluate((node: HTMLImageElement) => node.currentSrc))
        .toContain(expectedFile);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        360,
      );
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
