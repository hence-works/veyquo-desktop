# Veyquo desktop app and Chrome extension task runner. `just` lists the recipes. Every CI step runs one of these, so a
# CI failure reproduces locally with the same command. Run `just fetch` first: the build needs
# packages from the private repository (README.md).

set shell := ["bash", "-euo", "pipefail", "-c"]

# List recipes.
default:
    @just --list --unsorted

# Fetch the private packages at the pinned commit. Pass `--from ../veyquo` for a local checkout.
fetch *flags:
    bash scripts/fetch-private-packages.sh {{ flags }}

# Install the locked dependencies; fails if yarn.lock would change.
install-ts:
    yarn install --immutable

# Playwright's Chromium, which the desktop renderer and the extension integration tests use (one
# Playwright version for both). Pass `--with-deps` on CI.
browsers *flags:
    yarn workspace @veyquo/desktop exec playwright install {{ flags }} chromium

# Format check.
fmt-check:
    yarn prettier --check .

# ESLint, both apps. The private packages are checked in the private repository.
lint:
    yarn workspaces foreach -Av --include @veyquo/desktop --include @veyquo/chrome-extension run lint

# TypeScript, both apps.
typecheck:
    yarn workspaces foreach -Av --include @veyquo/desktop --include @veyquo/chrome-extension run typecheck

# Unit tests, both apps.
test-unit:
    yarn workspaces foreach -Av --include @veyquo/desktop --include @veyquo/chrome-extension run test

# The built desktop app under Electron against a fake gateway and real Chrome (CHROME_PATH, else
# /usr/bin/google-chrome), then the built extension in Playwright's Chromium with a stub native
# host. Linux without a display needs Xvfb.
test-integration:
    #!/usr/bin/env bash
    set -euo pipefail
    display() {
      if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then xvfb-run -a "$@"; else "$@"; fi
    }
    display yarn workspace @veyquo/desktop test:integration
    display yarn workspace @veyquo/chrome-extension test:integration

# Package the app for this OS, check its fuses and smoke-test it. Unsigned unless a signing
# identity is set (CSC_LINK, CSC_NAME, WIN_CSC_LINK). Installers need VEYQUO_BUILD_API_URL and
# VEYQUO_BUILD_WEB_URL (https); `--dir` builds the unpacked app only. Output in
# apps/desktop/release (git-ignored). Plain recipe lines so it runs the same under Git Bash.
desktop-package *flags:
    if [[ " {{ flags }} " == *" --dir "* ]]; then yarn workspace @veyquo/desktop dist:dir; else yarn workspace @veyquo/desktop dist; fi
    yarn workspace @veyquo/desktop verify:package
    if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then xvfb-run -a yarn workspace @veyquo/desktop smoke:package; else yarn workspace @veyquo/desktop smoke:package; fi

# Build the extension and zip it twice, into apps/chrome-extension/release/:
#   veyquo-chrome-extension-<version>-unpacked.zip  keeps the development `key`, so the id matches
#     `extensionIds` and the desktop app admits it. Unzip and "Load unpacked" to test locally.
#   veyquo-chrome-extension-<version>-store.zip     without `key`, for the Chrome Web Store, which
#     assigns its own id.
# <version> is manifest.json's.
extension-package:
    #!/usr/bin/env bash
    set -euo pipefail
    yarn workspace @veyquo/chrome-extension build
    cd apps/chrome-extension
    version="$(node -p "require('./manifest.json').version")"
    rm -rf release store && mkdir release
    (cd dist && zip -qrX "../release/veyquo-chrome-extension-$version-unpacked.zip" .)
    cp -R dist store
    node -e "const f='store/manifest.json', m=JSON.parse(require('fs').readFileSync(f)); delete m.key; require('fs').writeFileSync(f, JSON.stringify(m, null, 2) + '\n')"
    (cd store && zip -qrX "../release/veyquo-chrome-extension-$version-store.zip" .)
    rm -rf store
    ls release/*.zip
