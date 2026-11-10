# Veyquo desktop task runner. `just` lists the recipes. Every CI step runs one of these, so a
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

# Playwright's Chromium, which the renderer integration tests use. Pass `--with-deps` on CI.
browsers *flags:
    yarn workspace @veyquo/desktop exec playwright install {{ flags }} chromium

# Format check.
fmt-check:
    yarn prettier --check .

# ESLint.
lint:
    yarn workspace @veyquo/desktop lint

# TypeScript.
typecheck:
    yarn workspace @veyquo/desktop typecheck

# Unit tests.
test-unit:
    yarn workspace @veyquo/desktop test

# The built app under Electron against a fake gateway and real Chrome (CHROME_PATH, else
# /usr/bin/google-chrome). Linux without a display needs Xvfb.
test-integration:
    if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then xvfb-run -a yarn workspace @veyquo/desktop test:integration; else yarn workspace @veyquo/desktop test:integration; fi

# Package the app for this OS, check its fuses and smoke-test it. Unsigned unless a signing
# identity is set (CSC_LINK, CSC_NAME, WIN_CSC_LINK). Installers need VEYQUO_BUILD_API_URL and
# VEYQUO_BUILD_WEB_URL (https); `--dir` builds the unpacked app only. Output in
# apps/desktop/release (git-ignored). Plain recipe lines so it runs the same under Git Bash.
desktop-package *flags:
    if [[ " {{ flags }} " == *" --dir "* ]]; then yarn workspace @veyquo/desktop dist:dir; else yarn workspace @veyquo/desktop dist; fi
    yarn workspace @veyquo/desktop verify:package
    if [ "$(uname -s)" = Linux ] && [ -z "${DISPLAY:-}" ]; then xvfb-run -a yarn workspace @veyquo/desktop smoke:package; else yarn workspace @veyquo/desktop smoke:package; fi
