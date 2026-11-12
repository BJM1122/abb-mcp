# Changelog

## Unreleased

- `abb_search_rapid` and `abb_derive_module` reuse module text for up to 30 seconds instead of re-reading the whole task on every call. The module list is always read live, any apply or disconnect clears the cache, and `abb_derive_module` always reads its template and target live. `abb_search_rapid` reports `CachedModules` and accepts `refresh=true` to force live reads.
- `abb_search_rapid` results are shorter and point at the local copies: routines are listed as `Name:start-end`, each match names its enclosing routine, and a pattern search lists only the modules that hit (pass `outline=true` for every module's routines). The routine format changed from `Name:line`.
- Plan, apply, verify and backup results no longer carry session counters and timings (`Metrics`, `PhaseTimingsMs`, `TotalElapsedMs` and similar) unless `ABB_MCP_DIAGNOSTICS=1`; read results also drop `QueueWaitMs` and `HttpElapsedMs`. Approval tokens, identity, state, diffs and verification evidence are unchanged.

Covered by offline tests only; not yet measured on a controller.

## 1.8.0 — 2026-11-10

- Changesets now default to the direct Node.js RWS backend (`direct-rws-preview`, RWS1 and RWS2) and no longer start PowerShell by default. The legacy PowerShell worker supports RWS1 only and stays available with an explicit `ABB_MCP_CHANGESET_BACKEND=legacy`, mainly for its `cfg_file_load` `add-with-reset` mode. Direct failures never fall back to legacy silently.
- `rapid_module_put` / `rapid_module_replace` refuse to produce a plan when the module source contains empty arguments (`,;`, `,)`, `,,`, `(,`, outside comments and strings), reporting line, column and text. Module text held in controller memory can compile there yet fail to load as a file, breaking the whole task. Placeholders such as `<SMT>` are not rejected.
- On an RWS2 certificate pin mismatch, the error names the local registry alias whose pin matches the certificate actually presented, which helps when several cabinets share one address. The comparison is local and sends no extra requests.
- `abb_controller_snapshot` reads `PROFINET_NETWORK` on RWS2 / RobotWare 7, which has no `INDUSTRIAL_NETWORK` type, and reports `IndustrialNetworkType`. If the network type is missing, the rest of the snapshot is still returned with `IndustrialNetworkError`.
- Retains all 22 tools, controller identity locks, stopped-RAPID and guardstop/motoroff preconditions, single-use approval tokens and independent verification. No private controller configuration, credentials, field exports or private Git history is included.

The direct backend has completed a RAPID module replacement with independent readback on one OmniCore controller (RobotWare 7.20). Configuration writes on OmniCore and the other RWS2 write paths remain covered by offline mocks only.

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
