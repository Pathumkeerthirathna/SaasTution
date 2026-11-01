#!/usr/bin/env bash
# Read-only preflight for the Jibri stop worker (run on the VPS, in the app
# directory, BEFORE `pm2 start deploy/jibri-worker/ecosystem.config.cjs`).
#
#   deploy/jibri-worker/preflight.sh /etc/slclassroom/jibri-worker.env [app-env-file]
#
# Checks only: it starts nothing, connects to nothing (no database, no Jitsi,
# no YouTube, no network) and never prints a value from an env file (only
# variable NAMES, and "matches" / "differs" for the app comparison).
# Exit 0: no blocker found. Exit 1: at least one FAIL.

set -u

ENV_FILE="${1:-/etc/slclassroom/jibri-worker.env}"
APP_ENV_FILE="${2:-}"
fails=0
pass() { printf 'PASS  %s\n' "$1"; }
warn() { printf 'WARN  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# A variable's value from an env file, for comparisons only (never printed).
value_of() { grep -E "^$2=" "$1" 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

# ---- Runtime ---------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 22 ]; then pass "Node $(node -v) (>= 22: --env-file and --import)"; else fail "Node $(node -v): 22 or newer is required"; fi
else
  fail "node not found"
fi

[ -f package.json ] && grep -q '"jibri:worker"' package.json && pass "app directory (package.json with jibri:worker)" || fail "run this from the app directory"

for mod in tsx @xmpp/client @prisma/client; do
  if node -e "require.resolve('$mod/package.json')" >/dev/null 2>&1; then
    pass "$mod is installed ($(node -p "require('$mod/package.json').version"))"
  else
    fail "$mod is not installed (tsx: devDependencies must be installed; @xmpp/client: the lockfile of the package manager in use must include it)"
  fi
done

schema=$(find node_modules -maxdepth 6 -path '*/.prisma/client/schema.prisma' 2>/dev/null | head -n 1)
if [ -n "$schema" ] && grep -q 'lastXmppAuthAt' "$schema" && grep -q 'jibriStopOrigin' "$schema"; then
  pass "generated Prisma client includes the Jibri fence models (prisma generate ran after this code)"
else
  fail "generated Prisma client is older than this code: run prisma generate"
fi

# Which package manager installed node_modules (evidence only).
[ -f node_modules/.modules.yaml ] && warn "node_modules has a pnpm layout (.modules.yaml): confirm this is the production install method"
[ -f node_modules/.package-lock.json ] && pass "node_modules was installed by npm (.package-lock.json)"

# ---- Worker environment file -------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  fail "worker env file not found: $ENV_FILE"
else
  case "$(cd "$(dirname "$ENV_FILE")" && pwd)" in
    "$(pwd)"*) fail "the worker env file is inside the app directory (keep it outside the repository)" ;;
    *) pass "worker env file is outside the app directory" ;;
  esac
  [ "$(basename "$ENV_FILE")" = ".env" ] && fail "the worker env file must not be a .env file"

  perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo "?")
  case "$perms" in
    600|400) pass "worker env file permissions $perms" ;;
    *) fail "worker env file permissions $perms (use 600)" ;;
  esac

  for name in JIBRI_SERVER_STOP DATABASE_URL JITSI_DOMAIN JITSI_ENABLE_JWT_AUTH JITSI_JWT_SECRET JITSI_JWT_ISS JITSI_JWT_AUD \
    GOOGLE_YOUTUBE_CLIENT_ID GOOGLE_YOUTUBE_CLIENT_SECRET YOUTUBE_TOKEN_ENCRYPTION_KEY; do
    if [ -n "$(value_of "$ENV_FILE" "$name")" ]; then pass "$name is set"; else fail "$name is missing or empty"; fi
  done

  [ "$(value_of "$ENV_FILE" JIBRI_SERVER_STOP)" = "on" ] || fail "JIBRI_SERVER_STOP must be on"
  [ "$(value_of "$ENV_FILE" JITSI_ENABLE_JWT_AUTH)" = "true" ] || fail "JITSI_ENABLE_JWT_AUTH must be true"
  ws=$(value_of "$ENV_FILE" JITSI_XMPP_WEBSOCKET_URL)
  case "$ws" in ""|wss://*) ;; *) fail "JITSI_XMPP_WEBSOCKET_URL must use wss://" ;; esac
fi

# ---- Same Jitsi settings as the app (optional: the app's env file) -----------
if [ -n "$APP_ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  if [ ! -f "$APP_ENV_FILE" ]; then
    fail "app env file not found: $APP_ENV_FILE"
  else
    for name in JITSI_DOMAIN JITSI_JWT_SECRET JITSI_JWT_ISS JITSI_JWT_AUD JITSI_JWT_SUB JITSI_XMPP_WEBSOCKET_URL JITSI_MUC_DOMAIN \
      JITSI_RECORDER_DOMAIN JITSI_FOCUS_JID; do
      if [ "$(value_of "$ENV_FILE" "$name")" = "$(value_of "$APP_ENV_FILE" "$name")" ]; then
        pass "$name matches the app"
      else
        fail "$name differs from the app (the app will report config-mismatch)"
      fi
    done
  fi
else
  warn "app env file not given: the identity comparison is left to the admin page"
fi

# ---- PM2 ---------------------------------------------------------------------
if command -v pm2 >/dev/null 2>&1; then
  pass "pm2 $(pm2 -v 2>/dev/null)"
  pm2 jlist 2>/dev/null | grep -q '"name":"pm2-logrotate"' && pass "pm2-logrotate is installed" || warn "pm2-logrotate is not installed (see README.md)"
  pm2 jlist 2>/dev/null | grep -q '"name":"slclassroom-jibri-worker"' && warn "slclassroom-jibri-worker is already registered in PM2"
else
  fail "pm2 not found"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "Preflight: no blocker found. Start the worker, then check the admin page (Ready for mode on: Yes) BEFORE switching the mode on."
  exit 0
fi
echo "Preflight: $fails blocker(s). Do not start the worker."
exit 1
