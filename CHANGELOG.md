# Changelog

## Unreleased

### Resume cleanup

- Repositioned the project as a hybrid terminal automation framework.
- Removed generated binary/demo artifacts from the working tree.
- Removed unfinished public Discord command stubs.
- Removed the unused Express dependency.

### Testing and CI

- Added Node.js unit tests with the built-in `node:test` runner.
- Added Rust unit tests for state-machine transitions and parsing helpers.
- Added GitHub Actions CI for Node and Rust checks.

### Configurable target URLs

- Added environment-backed target configuration for `GAME_URL`, `WS_BASE_URL`, and `TARGET_NAME`.
- Replaced hardcoded WebSocket origin/host headers with values derived from `GAME_URL`.
