#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$HOME/.openclaw/extensions/burrow-channel-plugin"
OC_CONFIG="$HOME/.openclaw/openclaw.json"

echo "Uninstalling Burrow Channel plugin for OpenClaw..."
echo ""

# ── 1. Remove extension directory ─────────────────────────────────
if [ -d "$EXT_DIR" ]; then
  rm -rf "$EXT_DIR"
  echo "  Removed $EXT_DIR"
else
  echo "  Extension directory not found (already removed?)"
fi

# ── 2. Remove config from openclaw.json ───────────────────────────
remove_with_cli() {
  openclaw config unset channels.burrow 2>/dev/null
}

remove_with_python() {
  python3 - "$OC_CONFIG" <<'PYEOF'
import json, sys

path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    print("  openclaw.json not found or invalid — skipping")
    sys.exit(0)

# Remove channels.burrow
cfg.get("channels", {}).pop("burrow", None)

# Remove from plugins.allow
plugins = cfg.get("plugins", {})
if "burrow-channel-plugin" in plugins.get("allow", []):
    plugins["allow"].remove("burrow-channel-plugin")

# Remove from plugins.entries (dict or list)
entries = plugins.get("entries", {})
if isinstance(entries, dict):
    entries.pop("burrow-channel-plugin", None)
elif isinstance(entries, list):
    if "burrow-channel-plugin" in entries:
        entries.remove("burrow-channel-plugin")

with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PYEOF
}

if command -v openclaw &>/dev/null && remove_with_cli; then
  openclaw config unset plugins.allow.burrow-channel-plugin 2>/dev/null || true
  openclaw config unset plugins.entries.burrow-channel-plugin 2>/dev/null || true
  echo "  Removed plugin config via CLI"
else
  remove_with_python
  echo "  Removed plugin config via python3"
fi

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo "Uninstall complete!"
echo ""
echo "Restart the gateway to apply changes:"
echo "  openclaw gateway restart"
