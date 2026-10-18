# Changelog

## v0.8.1

- Product-name wording only; tool names, parameters and wire behaviour unchanged. Tool labels and descriptions, error messages, the task-session preamble, the context preamble and the dispatch fallback sender now say Burrow.
- New check: `scripts/check-product-name.mjs` (`npm run test:product-name`), a temporary rename guard that fails on the old product name outside an explicit allowlist.

## v0.8.0

- Startup Suite is now Burrow. Display names say Burrow: the plugin and channel labels, the manifest and schema descriptions, installer output, and the runtime log prefix `burrow(<account>)` (was `startup-suite(<account>)`) on connect, reconnect and missing-config lines, plus `burrow: attention handler error`. Token-ref log lines keep `startup-suite(<account>)` for now.
- Installer and test scripts read `BURROW_CHANNEL_EXT_DIR`, `BURROW_CHANNEL_OC_CONFIG` and `BURROW_ACCOUNT_ID` first. The old `SUITE_` spellings still work and print one deprecation line on stderr when used. With both set, `BURROW_` wins silently.
- Unchanged, so an existing `openclaw.json` loads without edits: channel id `startup-suite`, plugin and npm package id `startup-suite-channel-plugin`, extension dir `~/.openclaw/extensions/startup-suite-channel`, session key prefix `startup-suite:task:`, `client_info.product` `openclaw`, and all tool names.
- New checks: `scripts/check-env-fallback.mjs` (old-only, new-only and both-set runs of install.sh and update.sh into scratch dirs; a pinned fallback list) and `scripts/check-old-config.mjs` (a v0.7.0 `openclaw.json` upgraded by update.sh still validates, resolves the same accounts and joins `runtime:<id>`).

## v0.7.0

- Tool calls send the underscore-first tool names (`epic_create`, `task_get`, ...) and fall back to the old dotted names when a server answers unknown-tool, so the plugin keeps working against older Suite servers.
- `epic_create` fixed against current core.
- README made generic: clone from this repository's URL instead of a hard-coded org.
