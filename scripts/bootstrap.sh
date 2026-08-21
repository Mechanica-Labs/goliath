#!/usr/bin/env bash
#
# Goliath bootstrap: clone the repository, install everything, and leave a
# server running in the background.
#
#   curl -fsSL https://raw.githubusercontent.com/Mechanica-Labs/goliath/main/scripts/bootstrap.sh | bash
#
# The script is idempotent. Pointed at an existing checkout it fast-forwards
# that checkout instead of cloning again, and it never deletes or overwrites a
# directory it did not create -- if the target exists and is not a Goliath
# checkout, it stops and says so.
#
# Options (flag or environment variable):
#   --dir <path>    GOLIATH_DIR     Install location        (default ~/goliath)
#   --ref <ref>     GOLIATH_REF     Branch or tag           (default main)
#   --repo <url>    GOLIATH_REPO    Source repository
#   --port <port>   GOLIATH_PORT    Listen port             (default 9377)
#   --foreground                    Run in the foreground instead of detaching
#   --no-start                      Install only; do not start the server

set -euo pipefail

REPO="${GOLIATH_REPO:-https://github.com/Mechanica-Labs/goliath.git}"
DIR="${GOLIATH_DIR:-$HOME/goliath}"
REF="${GOLIATH_REF:-main}"
PORT="${GOLIATH_PORT:-9377}"
START_MODE="detached"
MIN_NODE_MAJOR=22

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --foreground) START_MODE="foreground"; shift ;;
    --no-start) START_MODE="none"; shift ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
  if [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
    SLIME=$'\033[38;2;184;255;0m'
    PURPLE=$'\033[38;2;193;60;255m'
    ORANGE=$'\033[38;2;255;106;0m'
    DANGER=$'\033[38;2;255;49;88m'
    MUTED=$'\033[38;2;167;139;184m'
  else
    SLIME=$'\033[92m'
    PURPLE=$'\033[95m'
    ORANGE=$'\033[33m'
    DANGER=$'\033[31m'
    MUTED=$'\033[90m'
  fi
else
  BOLD=''; RESET=''; SLIME=''; PURPLE=''; ORANGE=''; DANGER=''; MUTED=''
fi

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$SLIME" "$RESET" "$*"; }
warn() { printf '  %s▲%s %s\n' "$ORANGE" "$RESET" "$*"; }
die()  { printf '  %s✖%s %s\n' "$DANGER" "$RESET" "$*" >&2; exit 1; }
step() { printf '\n  %s%s%s\n' "$PURPLE$BOLD" "$*" "$RESET"; }

printf '\n  %sGOLIATH%s %s· bootstrap%s\n' "$SLIME$BOLD" "$RESET" "$MUTED" "$RESET"

# --- Preflight --------------------------------------------------------------
step "Checking prerequisites"

command -v git >/dev/null 2>&1 || die "git is required but not installed."
command -v node >/dev/null 2>&1 || die "Node.js ${MIN_NODE_MAJOR}+ is required but not installed — see https://nodejs.org"
command -v npm >/dev/null 2>&1 || die "npm is required but not installed."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node $(node -v) is too old — Goliath needs Node ${MIN_NODE_MAJOR} or newer."
fi
ok "git $(git --version | awk '{print $3}')"
ok "Node $(node -v)"

# --- Clone or reuse ---------------------------------------------------------
step "Preparing $DIR"

if [ -d "$DIR/.git" ]; then
  # Confirm this really is Goliath before running any command inside it.
  if ! grep -q '"@mechanica-labs/goliath"' "$DIR/package.json" 2>/dev/null; then
    die "$DIR is a git repository but does not look like Goliath. Choose another --dir."
  fi
  ok "Existing checkout found"
  # A fast-forward only: never discard local commits or uncommitted work.
  if git -C "$DIR" diff --quiet && git -C "$DIR" diff --cached --quiet; then
    if git -C "$DIR" fetch --quiet origin "$REF" 2>/dev/null &&
       git -C "$DIR" merge --ff-only "origin/$REF" --quiet 2>/dev/null; then
      ok "Updated to latest $REF"
    else
      warn "Could not fast-forward to origin/$REF; continuing with the current checkout."
    fi
  else
    warn "Local changes present; skipping update."
  fi
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR already exists and is not empty. Refusing to overwrite it — pass --dir to choose another location."
else
  say "Cloning $REPO ${MUTED}(branch $REF)${RESET}"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR" --quiet
  ok "Cloned into $DIR"
fi

cd "$DIR"

# --- Install ----------------------------------------------------------------
npm run setup

# --- Start ------------------------------------------------------------------
case "$START_MODE" in
  none)
    step "Skipping start (--no-start)"
    say "${MUTED}Start it later with:${RESET} cd $DIR && npm run up"
    ;;
  foreground)
    step "Starting server in the foreground"
    GOLIATH_PORT="$PORT" exec npm start
    ;;
  detached)
    GOLIATH_PORT="$PORT" npm run up
    ;;
esac
