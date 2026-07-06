#!/bin/bash
# Usage: ./deploy.sh <version-tag>   e.g. ./deploy.sh 20260707-fix1
set -euo pipefail
cd "$(dirname "$0")"
VER="${1:?need a version tag, e.g. 20260707-fix1}"
sed -i '' -E "s|(styles\.css\?v=)[A-Za-z0-9-]+|\1${VER}|; s|(app\.js\?v=)[A-Za-z0-9-]+|\1${VER}|" public/index.html
printf '{ "build": "%s" }\n' "$VER" > public/version.json
grep '?v=' public/index.html
npx wrangler pages deploy public --project-name gemini-live-translate --branch=main --commit-dirty=true
