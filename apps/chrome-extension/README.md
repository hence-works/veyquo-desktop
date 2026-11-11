# @veyquo/chrome-extension

The Veyquo extension for Google Chrome (Manifest V3). It lets the Veyquo desktop app work in the
person's **everyday** Chrome profile. Since Chrome 136, the default profile cannot be
remote-debugged, so an extension's `chrome.debugger` is the only way in (desktop plan §3, §4.3).

- The service worker (`src/background.ts`) connects to the desktop app with
  `chrome.runtime.connectNative("works.hence.veyquo")`. The app registers that native-messaging
  host (`apps/desktop/src/main/native-host/`).
- The relay (`src/relay.ts`) carries `cdp.attach/send/detach`, `tabs.open/close`,
  `permission.request/grant/revoke`, CDP events, `tab_closed` and the popup's Take over / Hand
  back. The wire contract is in `@veyquo/local-executor/extension-protocol`.
- Tab rules (`src/permissions.ts`) are checked here, whatever the app asks. Veyquo may use:
  - tabs it opened itself, in the unfocused Veyquo window and the "Veyquo" tab group;
  - a tab the person approved with **Let Veyquo use this tab**, for the web origin it showed then.
    The approval ends when the tab closes, when it leaves that origin, when the person takes it
    back, or when the attempt ends.
- The popup (`src/popup.html`, `src/popup.ts`) shows the connection, the active tab's state,
  Take over / Hand back, and a note about Chrome's "Veyquo started debugging this browser" bar.

The manifest asks for `debugger`, `tabs`, `tabGroups` and `nativeMessaging` only. It has no host
permissions, content scripts, web-accessible resources or `externally_connectable`, and
`tests/unit/manifest.test.ts` keeps it that way. Nothing is logged.

## Build and load it unpacked

```bash
yarn workspace @veyquo/chrome-extension build      # esbuild -> apps/chrome-extension/dist/
```

For extension development, run `yarn workspace @veyquo/chrome-extension dev`. Vite rebuilds
`dist/` when extension source, manifest, icons or bundled workspace code changes. An unpacked
development build connects to that local Vite server and reloads itself after a successful build.
Keep **Developer mode** enabled in `chrome://extensions`; Chrome needs it to reload an unpacked
extension. A full reload can close an open popup, so reopen it after a change. The development
WebSocket and its CSP allowance are absent from a normal `yarn build` package.

For a fast visual review of the popup, open `http://127.0.0.1:5187/preview.html` while Vite runs.
The preview has selectable sample states and mocked Chrome messages. Load `dist/` unpacked to
test the native host and real tab permissions. The Chromium integration suite below checks those
behaviors automatically.

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked** and pick
   `apps/chrome-extension/dist`. Branded Chrome 137+ ignores `--load-extension`, so this is the
   only way to load it before it is in the Chrome Web Store.
2. The extension id must be `kpibcngnjgkhakdjhaidgddbkhlocodn` (from the manifest `key`). The
   desktop app's host manifest admits only the ids in `extensionIds`
   (`packages/local-executor/src/extension-protocol.ts`).
3. Start the desktop app (`yarn workspace @veyquo/desktop dev`). On every start it writes
   `works.hence.veyquo.json` to Chrome's per-user `NativeMessagingHosts` folder (or, on Windows,
   points the HKCU registry key at it). A development build's launcher runs Electron on the app
   folder with `--native-host`.
4. Open the extension's popup. It should say "Connected to the Veyquo app". The extension
   reconnects with backoff while its service worker is alive, and again when Chrome wakes it
   (for example, when you open the popup).

To check "Let Veyquo use this tab", open a job page, press the button, and then start an
everyday-profile application whose sites include that page's host.

Uploads use `DOM.setFileInputFiles`, as in the Veyquo profile. In Playwright's Chromium 153 this
works through `chrome.debugger` without "Allow access to file URLs". That has not been checked
in branded Chrome. One CDP command is refused: `Page.setDownloadBehavior` counts as
browser-level for an extension. So during remote control, downloads in the everyday profile
follow the person's own Chrome settings.

## Zips for testing and for the store

`just extension-package` (from the repository root) builds two zips into
`apps/chrome-extension/release/`:

- `veyquo-chrome-extension-<version>-unpacked.zip` keeps the development `key`, so its id is
  `kpibcngnjgkhakdjhaidgddbkhlocodn` and the desktop app admits it. To test without building,
  unzip it into a folder and pick that folder with **Load unpacked** (step 1 above).
- `veyquo-chrome-extension-<version>-store.zip` has no `key`, for the Chrome Web Store, which
  gives the item its own id. Add that id to `extensionIds` before the store version can talk to
  the app.

A tag `extension-v<version>` (`version` from `manifest.json`) builds both and attaches them to a
draft GitHub release; see the root README for publishing.

## The development key

The manifest `key` is the public half of an RSA key generated for development, so the unpacked
extension's id stays the same on every machine. **The private half is not in the repository**,
and nothing in development needs it: Chrome derives the id from the public key alone. The Chrome
Web Store key replaces this one when the extension is published, and its id joins
`extensionIds`.

To make a new development key (for example, if you want to pack a `.crx` you can sign):

```bash
openssl genrsa -out dev-extension-key.pem 2048           # keep it outside the repo; *.pem is git-ignored
openssl rsa -in dev-extension-key.pem -pubout -outform DER | base64 -w0   # -> manifest.json "key"
openssl rsa -in dev-extension-key.pem -pubout -outform DER | sha256sum | head -c32 | tr 0-9a-f a-p
                                                         # -> the id, for extensionIds
```

Then update `manifest.json`'s `key` and `extensionIds`. `tests/unit/manifest.test.ts` checks that
they agree.

## Tests

```bash
yarn workspace @veyquo/chrome-extension test                          # Vitest: permissions, relay, manifest
xvfb-run -a yarn workspace @veyquo/chrome-extension test:integration  # build + Playwright
```

The integration suite runs Playwright's bundled Chromium (`launchPersistentContext` with
`--load-extension`) with one fresh profile per test. A stub native host
(`tests/support/stub-host.ts`) is registered in that profile's `NativeMessagingHosts` folder, and
the test plays the desktop app at the other end: a real `LocalExecutor` over the extension.
Pages come from a local fixture server only. The real host and its IPC handshake are tested in
`apps/desktop` (`native-host.test.ts`, and the lifecycle suite runs the built app with
`--native-host`).
