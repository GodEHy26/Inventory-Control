#!/bin/bash
# Portfolio screenshots taken on a real Mac: real Terminal windows running the
# real commands, and the real app in Google Chrome. Nothing is drawn or mocked.
#
#   bash scripts/portfolio/shots.sh          (from the project root)
#
# Output: portfolio-shots/*.png
# macOS will ask once to let Terminal control Terminal/Chrome (Automation) and
# to allow Screen Recording for screencapture. Allow both, then run it again.
set -euo pipefail
[[ "$(uname)" == Darwin ]] || { echo "This script needs macOS (Terminal.app + screencapture)."; exit 1; }
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/portfolio-shots"; mkdir -p "$OUT"
WORK="$(mktemp -d)"
cd "$ROOT"
[ -d node_modules ] || npm install
[ -d node_modules/playwright-core ] || npm install --no-save playwright-core@1.47.2

# ---------- 1. real Terminal windows ----------
term_shot() {   # term_shot <file name> <command line>
  osascript <<OSA
tell application "Terminal"
  activate
  set t to do script "cd '$ROOT'; clear; $2"
  set w to front window
  set number of columns of w to 118
  set number of rows of w to 46
  delay 2
  repeat while busy of t
    delay 1
  end repeat
end tell
OSA
  sleep 1
  screencapture -o -l "$(osascript -e 'tell application "Terminal" to id of front window')" "$OUT/$1.png"
  echo "saved portfolio-shots/$1.png"
}

# Demo data for the audit trace: a messy CSV fixed by a reviewer, the same file
# re-sent and blocked, and a wrong import undone (docs/figures/src/demo_trace.js).
DATA_DIR="$WORK/trace" node scripts/seed.js >/dev/null
DATA_DIR="$WORK/trace" node docs/figures/src/demo_trace.js "$WORK/ids.json" >/dev/null 2>&1

term_shot terminal-1-tests "npm test 2>/dev/null | grep -E '^(ok|not ok|# (tests|pass|fail))'"
term_shot terminal-2-eval "npm run eval"
term_shot terminal-3-trace "export DATA_DIR=$WORK/trace; node scripts/trace.js --batch 1; node scripts/trace.js --batch 2; node scripts/trace.js BA325MT1GCM12X035F"

# ---------- 2. the real app in Google Chrome ----------
DATA_DIR="$WORK/app" node scripts/seed.js >/dev/null
DATA_DIR="$WORK/app" PORT=3311 node server/index.js >"$WORK/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -s -o /dev/null http://localhost:3311/ && break; sleep 0.5; done
node scripts/portfolio/browser_shots.js "$OUT" http://localhost:3311

echo; echo "Done. Screenshots are in $OUT"
open "$OUT"
