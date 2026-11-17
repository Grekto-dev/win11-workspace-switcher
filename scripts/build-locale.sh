#!/bin/sh
set -e
cd "$(dirname "$0")/.."
UUID=win11-workspace-switcher@cinnamon
mkdir -p locale/pt_BR/LC_MESSAGES
msgfmt --check -o "locale/pt_BR/LC_MESSAGES/$UUID.mo" po/pt_BR.po
echo "built locale/pt_BR/LC_MESSAGES/$UUID.mo"
