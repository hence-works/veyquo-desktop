# Veyquo Desktop

The Veyquo desktop app (Electron, `apps/desktop`). It pairs a computer with Veyquo and runs the job agent in the person's own Google Chrome. The Veyquo Chrome extension (`apps/chrome-extension`) lets the app work in the person's everyday Chrome profile.

Copyright © Hence Works. All rights reserved. This repository is public so its installers can be built on GitHub's macOS, Windows and Linux runners. It is not open source, and no license is granted.

## Building

Both apps build against five workspaces from the private `hence-works/veyquo` repository. They are fetched into `packages/` (git-ignored) at the commit in `private-packages.ref`. **Without access to that repository neither app can be installed or built.**

You need Node 24, Corepack, [just](https://just.systems) and Google Chrome stable.

```bash
just fetch
just install-ts
yarn workspace @veyquo/desktop electron:install
yarn workspace @veyquo/desktop dev
```

To build against a local checkout, including uncommitted changes, use `just fetch --from ../veyquo`. Do not commit a `yarn.lock` produced from uncommitted package changes.

The private monorepo includes this repository as the submodule `external/veyquo-desktop`. There, run `just fetch --from ../..` inside the submodule; it builds as its own project, separate from the monorepo's workspaces.

Other recipes are listed by `just`. `VEYQUO_BUILD_API_URL` and `VEYQUO_BUILD_WEB_URL` (https) are required for an installer.

## Updating the private packages

After a change lands on the private repository's `main`:

```bash
bash scripts/bump-private-packages.sh
```

Open a pull request with the updated `private-packages.ref` and `yarn.lock`.

## Releasing the desktop app

Set `version` in `apps/desktop/package.json`, merge, and push a tag `v<version>` from `main`. A tag such as `v<version>-rc.1` makes a pre-release. CI builds macOS (`.dmg`, `.zip`), Windows (`.exe`) and Linux (`.AppImage`) and attaches them to a **draft** release. Installers are currently unsigned.

## Releasing the Chrome extension

Set `version` in `apps/chrome-extension/manifest.json` (the store needs dotted numbers, such as `0.2.0`), merge, and push a tag `extension-v<version>` from `main`. `extension.yml` attaches two zips to a **draft** release:

- `-unpacked.zip`, for testing: unzip it and choose the folder with **Load unpacked** in `chrome://extensions` (Developer mode on). It keeps the development key, so the desktop app accepts it.
- `-store.zip`, without that key, for the Chrome Web Store.

To build them locally instead, run `just extension-package`; they land in `apps/chrome-extension/release/`.

### Publishing to the Chrome Web Store

The `publish` job is off until the store account exists. A tag with a suffix (`extension-v0.2.0-rc.1`) never publishes. To turn it on:

1. Register the item in the Chrome Web Store Developer Dashboard by uploading a `-store.zip` by hand once. Note the item id and publisher id. Add the item id to `extensionIds` in the private `packages/local-executor/src/extension-protocol.ts`, then bump the private packages here.
2. In Google Cloud, create a service account, and a Workload Identity Federation provider that trusts this repository's GitHub OIDC tokens, limited to `repository == 'hence-works/veyquo-desktop'`. Allow this repository's principal to impersonate the service account (Service Account Token Creator). No key file is needed.
3. Add the service account's email in the Developer Dashboard, so it may publish the item.
4. Create the environment `chrome-web-store` here: deployment tags `extension-v*` only, a required reviewer. Set the repository or environment variables:
   - `CWS_WORKLOAD_IDENTITY_PROVIDER`: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`
   - `CWS_SERVICE_ACCOUNT`: the service account's email
   - `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`
   - `CWS_PUBLISH_TYPE` (optional): `STAGED_PUBLISH` (default; after review, a person publishes in the dashboard) or `DEFAULT_PUBLISH` (live as soon as it is approved)
   - `CHROME_WEB_STORE_ENABLED`: `true`

The job uploads the store zip through the Chrome Web Store API v2 and submits it for review (`scripts/chrome-web-store-publish.sh`).

## Contributing

Pull requests from forks do not run CI, because CI needs a credential forks must not receive.
