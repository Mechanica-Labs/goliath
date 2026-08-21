#!/bin/bash
# Local development script for goliath
# Usage: ./run.sh [-p port]
# Example: ./run.sh -p 3001

GOLIATH_PORT=3000
while getopts "p:" opt; do
  case $opt in
    p) GOLIATH_PORT="$OPTARG" ;;
    *) echo "Usage: $0 [-p port]"; exit 1 ;;
  esac
done
export GOLIATH_PORT

# Install dependencies and the browser runtime. Both steps are idempotent:
# npm run setup reports what is already present and only downloads what is missing.
npm run setup || exit 1

# Install nodemon globally if not available
if ! command -v nodemon &> /dev/null; then
    echo "Installing nodemon..."
    npm install -g nodemon
fi

echo "Starting goliath on http://localhost:$GOLIATH_PORT (with auto-reload)"
echo "Logs: /tmp/goliath.log"
nodemon --watch server.js --exec "node --max-old-space-size=128 server.js" 2>&1 | while IFS= read -r line; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $line"
done | tee -a /tmp/goliath.log
