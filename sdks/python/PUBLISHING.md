# Publishing the Python SDK

## Package

- Distribution name: `ghostgate-sdk`
- Module import: `from ghostgate import GhostGate`

## Versioning

1. Update `version` in `sdks/python/pyproject.toml`.
2. Commit and push.

## GitHub Actions publish (recommended)

Workflow: `.github/workflows/publish-python-sdk.yml`

This workflow uses PyPI Trusted Publishing (OIDC), so no PyPI API token is required.
PyPI must be configured with a trusted publisher matching:

- Owner: `Ghost-Protocol-Infrastructure`
- Repository: `GHOST_PROTOCOL`
- Workflow: `publish-python-sdk.yml`
- Environment: `pypi`

Triggers:

- Manual run (`workflow_dispatch`)
- Tag push matching `python-sdk-v*`

## Local manual publish

```bash
cd sdks/python
python -m pip install --upgrade build twine
python -m build
python -m twine check dist/*
python -m twine upload dist/*
```
