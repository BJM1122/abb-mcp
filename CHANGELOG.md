# Changelog

## 1.7.0 — 2026-10-30

- Adds `abb_search_rapid` for bounded-concurrency module reads, routine outlines, case-insensitive regex search, optional context and local source files.
- Adds `abb_derive_module` for local template-based product module generation with symbol renaming, optional point sequencing, conflict/reference reports and explicit target-value preservation. Template values are copied by default; controller writes still require an approved changeset.
- Expands the MCP surface from 20 to 22 tools and adds offline search/derivation regression coverage.
- Fixes RW7/OmniCore backups: uses the RWS2 `$BACKUP` root, appropriate FileService Accept headers and HTTP 201 completion handling, while preserving RW6/RWS1 behavior and backup verification.
- Retains controller identity locks, stopped-RAPID and guardstop/motoroff preconditions, single-use approval tokens, overwrite protection and independent verification. No private controller configuration, credentials, field exports or private Git history is included.

## 1.6.1 — 2026-10-22

- First standalone public distribution, based on the original 1.6.0 implementation including RWS pagination and completed-backup HTTP 303 handling.
- Preserves all 20 MCP tools, CLI/batch commands, direct RWS backends, legacy PowerShell support and optional PC SDK helper source.
- Adds Windows installation, empty local registry generation, interactive current-user DPAPI credentials and client instructions for Claude Code, Codex and DeepSeek through an MCP client.
- Includes the generic legacy transport locally and removes original host paths, captured controller identities and private Git history from the public distribution.
- Updates the MCP SDK to 1.32.1 and refreshes compatible transitive dependencies. Controller identity, approval, safety, mastership and independent verification logic are retained.
- Offline tests use synthetic local credentials. No real robot or model-provider API key is needed for the offline suite.
- CLI forwards ABB_MCP settings to its MCP subprocess, so explicit backend selection and custom registry paths take effect.

This release does not certify new controller/RobotWare compatibility or physical operation.
