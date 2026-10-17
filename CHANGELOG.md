# Changelog

## v0.7.0

- Tool calls send the underscore-first tool names (`epic_create`, `task_get`, ...) and fall back to the old dotted names when a server answers unknown-tool, so the plugin keeps working against older Suite servers.
- `epic_create` fixed against current core.
- README made generic: clone from this repository's URL instead of a hard-coded org.
