#!/bin/sh
# Installs the applet for the current user: ./install.sh [--link]
set -e
cd "$(dirname "$0")"
UUID=win11-workspace-switcher@cinnamon
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/cinnamon/applets/$UUID"
LOCALE_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/locale/pt_BR/LC_MESSAGES/$UUID.mo"
./scripts/build-locale.sh >/dev/null 2>&1 || true
mkdir -p "$(dirname "$DEST")" "$(dirname "$LOCALE_DEST")"
if [ -f "locale/pt_BR/LC_MESSAGES/$UUID.mo" ]; then
    cp "locale/pt_BR/LC_MESSAGES/$UUID.mo" "$LOCALE_DEST.tmp"
    mv -f "$LOCALE_DEST.tmp" "$LOCALE_DEST"
fi
rm -rf "$DEST"
if [ "$1" = "--link" ]; then
    ln -sfn "$(pwd)" "$DEST"
else
    mkdir -p "$DEST"
    cp -r *.js *.json *.css locale po "$DEST"/
fi
echo "Installed to $DEST"
