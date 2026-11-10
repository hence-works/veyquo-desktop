// `--smoke`: the packaged-app check CI runs on every operating system (desktop plan §10).
// The binary starts, finds the person's Google Chrome stable (at least the minimum version)
// and loads the executor with its bundled protocol schema, then exits:
//
//   0  Chrome found and the executor loaded
//   1  something else failed (the error's class is named)
//   3  Chrome is missing, too old or of unknown version
//
// It writes one JSON line to stdout, ids and versions only (never a path), touches no app
// state, opens no window and connects to nothing.

import { parseDeviceRequest } from '@veyquo/local-executor';

import type { ChromeLocation } from './chrome/locate.ts';

export const smokeExit = { ok: 0, failed: 1, chromeUnavailable: 3 } as const;

export interface SmokeDeps {
  locate: () => Promise<ChromeLocation>;
  /** Throws when the executor or its protocol schema cannot be loaded. */
  checkExecutor: () => void;
  write: (line: string) => void;
  packaged: boolean;
  /** Whether this build carries its Veyquo URLs (`VEYQUO_BUILD_API_URL` at build time). */
  buildUrls: boolean;
}

const sampleId = '00000000-0000-4000-8000-000000000001';

/** The executor's request validator, compiled from the bundled schema, admits a well-formed
 * request and refuses a malformed one. */
export function checkExecutor(): void {
  const valid = parseDeviceRequest({
    request_id: sampleId,
    session_id: null,
    op: { name: 'journal_ack', grant_ids: [sampleId] },
  });
  const invalid = parseDeviceRequest({ request_id: sampleId, session_id: null, op: {} });
  if (!valid.ok || invalid.ok) throw new Error('the executor did not load its protocol');
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export async function runSmoke(deps: SmokeDeps): Promise<number> {
  const report = (fields: Record<string, unknown>): void => {
    deps.write(`${JSON.stringify({ event: 'smoke', ...fields })}\n`);
  };
  try {
    deps.checkExecutor();
    const chrome = await deps.locate();
    if (!chrome.ok) {
      report({
        result: 'chrome_unavailable',
        reason: chrome.reason,
        ...(chrome.version === undefined ? {} : { chrome_version: chrome.version }),
      });
      return smokeExit.chromeUnavailable;
    }
    report({
      result: 'ok',
      chrome_version: chrome.version,
      packaged: deps.packaged,
      build_urls: deps.buildUrls,
    });
    return smokeExit.ok;
  } catch (error) {
    report({ result: 'failed', error: errorName(error) });
    return smokeExit.failed;
  }
}
