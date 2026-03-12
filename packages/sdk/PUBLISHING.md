# Publishing `@ghostgate/sdk`

This package is published from `packages/sdk`.

## Trusted Publishing (Recommended)

npm trusted publishing is configured through GitHub OIDC and does not require OTP or an npm token in CI.

### One-time npm setup

In npm package settings for `@ghostgate/sdk`, add a trusted publisher with:

1. Provider: `GitHub Actions`
2. Owner: `Ghost-Protocol-Infrastructure`
3. Repository: `GHOST_PROTOCOL`
4. Workflow file: `publish-node-sdk.yml`
5. Environment name: `npm`

This must match `.github/workflows/publish-node-sdk.yml` exactly.

### Publish methods

1. Tag-based release (recommended):

```bash
git tag sdk-v0.1.3
git push origin sdk-v0.1.3
```

2. Manual run:
Run the `Publish Node SDK` workflow from GitHub Actions with `npm_tag=latest` (or another dist-tag).

### Preflight

Run from repo root before triggering publish:

```bash
npm run build:sdk
npm run typecheck
npm run lint
```

### Post-publish verification

```bash
npm view @ghostgate/sdk version
npm view @ghostgate/sdk dist-tags
npm view @ghostgate/sdk repository.url
```

Then smoke test:

```bash
mkdir -p /tmp/ghostgate-sdk-smoke
cd /tmp/ghostgate-sdk-smoke
npm init -y
npm install @ghostgate/sdk
```

## Manual Local Publish (Fallback)

If trusted publishing is unavailable, publish from `packages/sdk` using npm CLI auth:

```bash
npm publish --access public --provenance
```
