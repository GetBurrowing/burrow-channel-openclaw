# Changelog

## v0.9.0

Straight rename of the identifiers OpenClaw config keys on. There is no alias and no dual-name support: this version recognises only the new names.

| What | Before (v0.8.x) | v0.9.0 |
|---|---|---|
| Plugin id (`openclaw.plugin.json` `id`, `index.ts`) | `startup-suite-channel-plugin` | `burrow-channel-plugin` |
| npm package name (`package.json`, `src/build-identity.ts` `PACKAGE_NAME`) | `startup-suite-channel-plugin` | `burrow-channel-plugin` |
| Channel id (manifest `channels`, configSchema / channelConfigs key, `package.json` `openclaw.channel.id`) | `startup-suite` | `burrow` |
| Config section | `channels.startup-suite` | `channels.burrow` |
| Route bindings | `match.channel: startup-suite` | `match.channel: burrow` |
| `plugins.allow` / `plugins.entries` | `startup-suite-channel-plugin` | `burrow-channel-plugin` |
| Extension dir (install.sh, update.sh, uninstall.sh) | `~/.openclaw/extensions/startup-suite-channel` | `~/.openclaw/extensions/burrow-channel-plugin` |
| Inbound `From` / `To` / `OriginatingTo`, outbound message id | `startup-suite:<id>` | `burrow:<id>` |
| Log prefixes (including token-ref lines) | `startup-suite:` / `startup-suite(<account>)` | `burrow:` / `burrow(<account>)` |

- **Sessions do not carry over.** Session keys extend OpenClaw's route key, which now reads `agent:<agentId>:burrow:group:<peer>` (was `agent:<agentId>:startup-suite:group:<peer>`). An existing OpenClaw session store keyed on the old channel id is not found under the new keys, so every space starts a fresh session.
- **An existing install is not migrated.** install.sh writes only the new names and no longer removes the pre-v0.8 `startup-suite-channel` entries; uninstall.sh removes only the new names. A host registered with v0.8.x or earlier must clear the old entries itself (`openclaw config unset channels.startup-suite`, and `plugins.allow` / `plugins.entries` `startup-suite-channel-plugin`), remove `~/.openclaw/extensions/startup-suite-channel`, then re-run install.sh. burrow-cli manages its own OpenClaw roots and pins this release.
- The extension dir is now named after the plugin id, the same directory `openclaw plugins install` derives from the id (it was `startup-suite-channel`, an older plugin id).
- The `llm_output` usage hook matches the channel id exactly and the `:burrow:` segment of the session key, instead of a bare substring.
- Unchanged: `client_info.product` `openclaw`, every tool name (`suite_*`), the `BURROW_*` / deprecated `SUITE_*` installer env vars, and the repository name.
- Removed check: `scripts/check-old-config.mjs`, with its helpers `scripts/_old-config-probe.mjs` and `scripts/_installed-copy-loader.mjs` and its fixtures `scripts/fixtures/openclaw-v0.7.0.json` and `config-v0.7.0.json`. Its claim was that an untouched v0.7.0 `openclaw.json` still loads after update.sh; a straight rename makes that false by design, so the check could only pass by testing old-name support.
- npm: the package is renamed, but the npm trusted publisher is configured per package name and `burrow-channel-plugin` has none yet, so this version is tagged and not published to npm. burrow-cli installs the plugin by git clone at a pinned commit, not from npm.

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
