#!/usr/bin/env bash
set -euo pipefail

APP_PATH="/Applications/QClaw.app"
ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
WORK_DIR="$(mktemp -d)"
WAS_RUNNING=false

if pgrep -f "QClaw" > /dev/null 2>&1; then
  WAS_RUNNING=true
  echo "==> QClaw is running, stopping..."
  pkill -f "QClaw" || true
  sleep 1
fi

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "==> Extracting app.asar..."
npx --yes @electron/asar extract "$ASAR_PATH" "$WORK_DIR/app"

ASSETS_DIR="$WORK_DIR/app/out/renderer/assets"

# Find the JS file containing inviteCode logic
TARGET_JS=$(grep -rl 'inviteCodeVerified\|showInviteCodeModal\|inviteVerified' "$ASSETS_DIR"/ 2>/dev/null | head -1)

# Fallback: try Chat-*.js (v0.1.1)
if [ -z "$TARGET_JS" ]; then
  TARGET_JS=$(find "$ASSETS_DIR" -name 'Chat-*.js' ! -name '*.css' | head -1)
fi

if [ -z "$TARGET_JS" ]; then
  echo "ERROR: No JS file containing invite verification logic found"
  exit 1
fi
echo "==> Found: $(basename "$TARGET_JS")"

# Patch using node for reliable cross-line matching
RESULT=$(node -e "
const fs = require('fs');
let code = fs.readFileSync('$TARGET_JS', 'utf8');

// Match pattern: Z(!1) followed by async function that checks .value and awaits
// Works across minification styles (with/without newlines)
const pattern = /(const \w+=Z\()!1(\),\s*\w+=async \w+=>\{var \w+,\w+,\w+;\s*if\(\w+\.value\)\{await \w+\(\);return\})/;
const patchedCheck = /(const \w+=Z\()!0(\),\s*\w+=async \w+=>\{var \w+,\w+,\w+;\s*if\(\w+\.value\)\{await \w+\(\);return\})/;

if (patchedCheck.test(code)) {
  console.log('ALREADY_PATCHED');
} else if (pattern.test(code)) {
  code = code.replace(pattern, '\$1!0\$2');
  fs.writeFileSync('$TARGET_JS', code);
  console.log('PATCHED');
} else {
  console.log('NOT_FOUND');
}
")

case "$RESULT" in
  PATCHED)
    echo "==> Patched: inviteVerified default set to true"
    ;;
  ALREADY_PATCHED)
    echo "==> Already patched, skipping"
    ;;
  *)
    echo "ERROR: Patch pattern not found in $(basename "$TARGET_JS")"
    echo "       The app version may have changed. Manual inspection needed."
    exit 1
    ;;
esac

echo "==> Repacking app.asar..."
npx --yes @electron/asar pack "$WORK_DIR/app" "$WORK_DIR/app-patched.asar"

echo "==> Backing up original app.asar..."
cp "$ASAR_PATH" "$ASAR_PATH.bak"

echo "==> Replacing with patched app.asar..."
cp "$WORK_DIR/app-patched.asar" "$ASAR_PATH"

echo "==> Done! Backup saved at: $ASAR_PATH.bak"

if [ "$WAS_RUNNING" = true ]; then
  echo "==> Restarting QClaw..."
  open "$APP_PATH"
fi
