#!/usr/bin/env bash
# Living Canvas acceptance script.
#
# Usage:
#   bash demo/acceptance.sh [--renderer pixi|l2dwidget|vector]
#
# Environment:
#   PLAYWRIGHT_ENABLED=true   — also take screenshots via Playwright (requires
#                               `npm install -D playwright` + `npx playwright install chromium`)
#   SCREENSHOTS_DIR           — where to save screenshots (default: demo/screenshots)
#   HTTP_PORT                 — static server port for screenshot step (default: 3950)
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RENDERER_MODE=""

# ── parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --renderer)   RENDERER_MODE="$2"; shift 2 ;;
    --renderer=*) RENDERER_MODE="${1#*=}"; shift ;;
    *)            echo "Unknown argument: $1"; exit 1 ;;
  esac
done

if [[ -n "$RENDERER_MODE" ]] && \
   [[ "$RENDERER_MODE" != "pixi" && "$RENDERER_MODE" != "l2dwidget" && "$RENDERER_MODE" != "vector" ]]; then
  echo "Invalid --renderer value: $RENDERER_MODE (must be pixi | l2dwidget | vector)"
  exit 1
fi

SCREENSHOTS_DIR="${SCREENSHOTS_DIR:-$ROOT_DIR/demo/screenshots}"
HTTP_PORT="${HTTP_PORT:-3950}"

echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│         Living Canvas — Acceptance Check                │"
echo "└─────────────────────────────────────────────────────────┘"
[[ -n "$RENDERER_MODE" ]] && echo "  renderer override : $RENDERER_MODE"
echo ""

PASS=0
FAIL=0
FAILED_TESTS=()

# ── helpers ───────────────────────────────────────────────────────────────────
ok()   { echo "  ✓  $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗  $1"; FAIL=$((FAIL+1)); FAILED_TESTS+=("$1"); }

# ── step 1: existing test suite (run BEFORE smoke — smoke-first pollutes global
# state and causes flaky test-runner IPC failures in skill suites; matches CI
# matrix order: npm test then living-canvas smoke) ───────────────────────────
echo "Step 1 — Existing test suite (npm test)"
echo "─────────────────────────────────────────────"
if (cd "$ROOT_DIR" && npm test) > /tmp/acceptance-unit.log 2>&1; then
  UNIT_PASS=$(grep -c '^ok' /tmp/acceptance-unit.log || true)
  ok "unit tests ($UNIT_PASS cases passed)"
else
  fail "unit tests (see /tmp/acceptance-unit.log for details)"
  tail -40 /tmp/acceptance-unit.log
fi

# ── step 2: structural smoke test ─────────────────────────────────────────────
echo ""
echo "Step 2 — Structural smoke test (node --test)"
echo "─────────────────────────────────────────────"
if node --test "$ROOT_DIR/tests/living-canvas.smoke.test.js" > /tmp/acceptance-smoke.log 2>&1; then
  SMOKE_PASS=$(grep -c '^ok' /tmp/acceptance-smoke.log || true)
  ok "smoke test ($SMOKE_PASS cases passed)"
else
  fail "smoke test (see /tmp/acceptance-smoke.log for details)"
  cat /tmp/acceptance-smoke.log
fi

# ── step 3: optional playwright screenshot ────────────────────────────────────
if [[ "${PLAYWRIGHT_ENABLED:-false}" == "true" ]]; then
  echo ""
  echo "Step 3 — Playwright screenshots"
  echo "─────────────────────────────────────────────"

  if ! command -v npx &>/dev/null; then
    fail "playwright: npx not found"
  elif ! npx --yes playwright --version &>/dev/null 2>&1; then
    fail "playwright: not installed (run: npm install -D playwright && npx playwright install chromium)"
  else
    mkdir -p "$SCREENSHOTS_DIR"

    _RENDERER_PARAM=""
    [[ -n "$RENDERER_MODE" ]] && _RENDERER_PARAM="&renderer=${RENDERER_MODE}"

    # Start static server
    python3 -m http.server "$HTTP_PORT" --directory "$ROOT_DIR" >/tmp/acceptance-http.log 2>&1 &
    _HTTP_PID=$!
    sleep 1

    _VIEWPORTS=("1280x800" "375x812")
    for VP in "${_VIEWPORTS[@]}"; do
      _W="${VP%%x*}"
      _H="${VP##*x}"
      _SLUG="${RENDERER_MODE:-default}"
      _OUT="$SCREENSHOTS_DIR/living-canvas-${_SLUG}-${_W}x${_H}.png"
      _URL="http://127.0.0.1:${HTTP_PORT}/demo/living-canvas.html?state=./living-canvas.direct.json${_RENDERER_PARAM}"

      if npx playwright screenshot \
           --browser chromium \
           --viewport-size "${_W},${_H}" \
           --wait-for-timeout 3500 \
           "$_URL" "$_OUT" >/tmp/acceptance-pw-${VP}.log 2>&1; then
        ok "screenshot ${VP} → ${_OUT#$ROOT_DIR/}"
      else
        fail "screenshot ${VP} (see /tmp/acceptance-pw-${VP}.log)"
      fi
    done

    kill "$_HTTP_PID" 2>/dev/null || true
  fi
else
  echo ""
  echo "Step 3 — Playwright screenshots (skipped; set PLAYWRIGHT_ENABLED=true to enable)"
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────────────"
echo "  Passed : $PASS"
echo "  Failed : $FAIL"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "Failed checks:"
  for T in "${FAILED_TESTS[@]}"; do
    echo "    • $T"
  done
  echo ""
  echo "RESULT: FAIL"
  exit 1
else
  echo ""
  echo "RESULT: PASS"
  exit 0
fi
