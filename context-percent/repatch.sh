#!/usr/bin/env bash
# Re-apply the context-badge patch to the Claude Desktop asar.
# Idempotent, version-aware, and fails loudly rather than producing a
# silently-unpatched app. See README.md.
#
#   sudo ./repatch.sh            apply
#   sudo DRY_RUN=1 ./repatch.sh  build + verify, but do not install
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RES=/usr/lib/claude-desktop/resources
ASAR="$RES/app.asar"
PAYLOAD="$HERE/context-badge.js"
PATCHER="$HERE/asar_patch.py"
MARKER='>>> ctx-badge v1 >>>'

die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root:  sudo $0"
[ -f "$PAYLOAD" ]    || die "missing payload: $PAYLOAD"
[ -f "$PATCHER" ]    || die "missing patcher: $PATCHER"
[ -f "$ASAR" ]       || die "no asar at $ASAR - is claude-desktop installed?"
command -v python3 >/dev/null || die "python3 not found"

# The app memory-maps app.asar while running, and only reads the preload at
# launch, so patching a live app is both unsafe and pointless.
if [ "${DRY_RUN:-0}" != "1" ] && pgrep -f '/usr/lib/claude-desktop/claude-desktop' >/dev/null 2>&1; then
  die "claude-desktop is running. Quit it fully (check the tray icon), then re-run."
fi

VERSION="$(dpkg-query -W -f='${Version}' claude-desktop 2>/dev/null || echo unknown)"
BACKUP="$ASAR.orig-$VERSION"
echo "claude-desktop $VERSION"

# Never patch an already-patched archive: fall back to the pristine backup.
if grep -qa "$MARKER" "$ASAR"; then
  [ -f "$BACKUP" ] || die "app.asar is already patched but $BACKUP is missing.
  Restore a clean archive first:  sudo apt install --reinstall claude-desktop"
  echo "already patched - re-patching from $BACKUP"
  SRC="$BACKUP"
else
  if [ ! -f "$BACKUP" ]; then
    cp -a "$ASAR" "$BACKUP"
    echo "backed up  -> $BACKUP"
  else
    echo "backup     -> $BACKUP (existing)"
  fi
  SRC="$ASAR"
fi

TMP="$(mktemp /tmp/app.asar.XXXXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo; echo "--- inspect ---"
python3 "$PATCHER" check "$SRC"
echo; echo "--- patch ---"
python3 "$PATCHER" patch --src "$SRC" --dst "$TMP" --payload "$PAYLOAD"
echo; echo "--- verify ---"
python3 "$PATCHER" verify --orig "$SRC" --new "$TMP"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo; echo "DRY_RUN=1 - built and verified, nothing installed."
  exit 0
fi

install -o root -g root -m 644 "$TMP" "$ASAR"
echo; echo "installed -> $ASAR"

if apt-mark hold claude-desktop >/dev/null 2>&1; then
  echo "apt hold set (upgrades are now deliberate; 'sudo apt-mark unhold claude-desktop' to lift)"
else
  echo "warning: apt-mark hold failed - upgrades may silently revert this patch"
fi

cat <<EOF

Done. Relaunch the app; the label appears beside the ring within a few seconds.

To revert:
  sudo cp "$BACKUP" "$ASAR"
Worst case:
  sudo apt install --reinstall claude-desktop
EOF
