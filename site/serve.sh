#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'Usage: site/serve.sh (serves only this site on 127.0.0.1:8801)' >&2
  exit 2
fi
for dependency in node cloudflared; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "Missing dependency: $dependency. Install it on the owner box first." >&2
    exit 1
  fi
done
site_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec node "$site_dir/serve.mjs" --tunnel
