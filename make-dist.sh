#!/usr/bin/env bash
# Rebuild dist/ with only the files Chrome needs to load Short Straw.
# Usage: ./make-dist.sh   then load dist/ unpacked at chrome://extensions
set -euo pipefail
cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/icons
cp manifest.json popup.html popup.css popup.js cities.js dist/
cp icons/icon16.png icons/icon32.png icons/icon48.png icons/icon128.png dist/icons/

echo "dist/ ready:"
find dist -type f | sort
