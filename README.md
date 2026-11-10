# Veyquo Desktop

The Veyquo desktop app (Electron). It pairs a computer with Veyquo and runs the job agent in the person's own Google Chrome.

Copyright © Hence Works. All rights reserved. This repository is public so its installers can be built on GitHub's macOS, Windows and Linux runners. It is not open source, and no license is granted.

## Building

The app builds against five workspaces from the private `hence-works/veyquo` repository. They are fetched into `packages/` (git-ignored) at the commit in `private-packages.ref`. **Without access to that repository the app cannot be installed or built.**

You need Node 24, Corepack, [just](https://just.systems) and Google Chrome stable.

```bash
just fetch
just install-ts
yarn workspace @veyquo/desktop electron:install
yarn workspace @veyquo/desktop dev
```

To build against a local checkout, including uncommitted changes, use `just fetch --from ../veyquo`. Do not commit a `yarn.lock` produced from uncommitted package changes.

Other recipes are listed by `just`. `VEYQUO_BUILD_API_URL` and `VEYQUO_BUILD_WEB_URL` (https) are required for an installer.

## Updating the private packages

After a change lands on the private repository's `main`:

```bash
bash scripts/bump-private-packages.sh
```

Open a pull request with the updated `private-packages.ref` and `yarn.lock`.

## Releasing

Set `version` in `apps/desktop/package.json`, merge, and push a tag `v<version>` from `main`. A tag such as `v<version>-rc.1` makes a pre-release. CI builds macOS (`.dmg`, `.zip`), Windows (`.exe`) and Linux (`.AppImage`) and attaches them to a **draft** release. Installers are currently unsigned.

## Contributing

Pull requests from forks do not run CI, because CI needs a credential forks must not receive.
