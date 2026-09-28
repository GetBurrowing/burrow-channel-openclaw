#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Override for testing the install path against a scratch directory.
EXT_DIR="${SUITE_CHANNEL_EXT_DIR:-$HOME/.openclaw/extensions/startup-suite-channel}"

if [ ! -d "$EXT_DIR" ]; then
  echo "Error: Plugin not installed at $EXT_DIR"
  echo "Run install.sh first."
  exit 1
fi

echo "Updating Startup Suite Channel plugin..."

# ── 1. Copy plugin files (preserves existing config.json) ─────────
mkdir -p "$EXT_DIR/src"

cp "$SCRIPT_DIR/package.json" \
   "$SCRIPT_DIR/openclaw.plugin.json" \
   "$SCRIPT_DIR/index.ts" \
   "$SCRIPT_DIR/config.example.json" \
   "$EXT_DIR/"

cp "$SCRIPT_DIR/src/"*.ts "$EXT_DIR/src/"

echo "  ✓ Copied plugin files to $EXT_DIR"

# ── Stamp the commit just copied ──────────────────────────────────
# The installed copy has no .git, so the plugin cannot ask git which commit it
# is. Record the sha of THIS checkout (the source just copied) next to it;
# src/build-identity.ts sends it as client_info.build. On failure no
# build-info.json is left behind (a stale one would name code that is no
# longer installed) and the plugin reports build_error instead.
rm -f "$EXT_DIR/build-info.json"
if node "$SCRIPT_DIR/scripts/write-build-info.mjs" "$EXT_DIR"; then
  echo "  ✓ Stamped build-info.json"
else
  echo "  ! Could not stamp build-info.json; the plugin will report build_error instead of a build" >&2
fi

# ── 2. Reinstall dependencies if package.json changed ─────────────
(cd "$EXT_DIR" && npm install --loglevel=warn)
echo "  ✓ Installed npm dependencies"

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "✅ Update complete! Restart the gateway to pick up changes:"
echo "  openclaw gateway restart"
