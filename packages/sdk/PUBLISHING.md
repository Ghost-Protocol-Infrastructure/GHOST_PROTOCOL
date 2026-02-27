# Publishing `@ghostgate/sdk`

This package is published from `packages/sdk`.

## Prerequisites

1. You are logged into npm with publish rights for the `@ghostgate` scope.
2. `npm whoami` returns the expected npm account.
3. `npm access ls-packages ghostgate` shows access to `@ghostgate/sdk`.
4. Local repo is clean other than intended changes.

## Preflight

Run from repo root:

```bash
npm run build:sdk
npm run typecheck
npm run lint
```

Optional tarball check:

```bash
npm pack ./packages/sdk
```

Inspect the tarball contents, then delete it.

## First Public Release

Run from `packages/sdk`:

```bash
npm publish --access public
```

Recommended for stronger supply-chain metadata when supported by your npm account/environment:

```bash
npm publish --access public --provenance
```

## Post-Publish Verification

```bash
npm view @ghostgate/sdk version
npm view @ghostgate/sdk dist-tags
npm view @ghostgate/sdk repository.url
```

Then test a clean install:

```bash
mkdir -p /tmp/ghostgate-sdk-smoke
cd /tmp/ghostgate-sdk-smoke
npm init -y
npm install @ghostgate/sdk
```

## Release Hygiene

For the first external release:

1. Keep version at `0.1.0` only if the API should be treated as pre-1.0.
2. Bump version before each publish:

```bash
npm version patch
```

3. Push the version tag after publish:

```bash
git push
git push --tags
```
