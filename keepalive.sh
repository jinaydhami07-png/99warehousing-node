#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# Watchdog for the Node process.
#
# This hosting has no "Setup Node.js App" and no Passenger, so nothing
# starts or restarts the API. Shared hosts also reap long-running user
# processes. A cron entry runs this every two minutes:
#
#   */2 * * * *   $HOME/nodeapp/keepalive.sh >/dev/null 2>&1
#
# It asks /health over HTTP rather than checking for a running process,
# because the failure that actually happens here is a process that is alive
# and wedged — database connection lost, event loop blocked — which a PID
# check reports as perfectly healthy.
#
# POSIX sh, not bash: cron on shared hosting runs a minimal shell.
# ─────────────────────────────────────────────────────────────────────────
set -u

APP_DIR="$HOME/nodeapp"
PORT=5050                 # must match PORT in server/env
HEALTH="http://127.0.0.1:$PORT/api/v1/health"
LOG="$APP_DIR/keepalive.log"
PIDFILE="$APP_DIR/keepalive.pid"
LOCKDIR="$APP_DIR/.keepalive.lock"
STARTED="$APP_DIR/.keepalive.started"

# Node is a home-directory install; cron's PATH will not have it.
NODE_BIN="$HOME/nodejs/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || echo)"

# mkdir either creates the directory or fails, atomically, with no window
# between the two. Two overlapping runs cannot both take the lock and both
# decide to start the app.
mkdir "$LOCKDIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCKDIR" 2>/dev/null' EXIT INT TERM

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null; }

# This account has a disk quota, and a log nobody trims is its own outage.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
  tail -n 300 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
  log "log trimmed"
fi

if [ -z "$NODE_BIN" ]; then
  log "FATAL: no node binary found (looked in \$HOME/nodejs/bin and \$PATH)"
  exit 1
fi

# Healthy: nothing to do. This is the overwhelmingly common path, so it stays
# cheap — one local request, no process listing.
if curl -fsS --max-time 10 "$HEALTH" >/dev/null 2>&1; then
  exit 0
fi

# Not answering. Find the process, preferring the pidfile and falling back to
# a search by command line. The fallback matters: the pidfile goes missing
# whenever the app is started by hand, and a wedged process still holding the
# port would then have every run spawn a replacement that cannot bind and
# exits immediately — a restart loop that never recovers.
PID="$(cat "$PIDFILE" 2>/dev/null || echo)"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  PID="$(pgrep -f "$APP_DIR/app.js" 2>/dev/null | head -n 1 || echo)"
  [ -n "$PID" ] || PID="$(pgrep -f 'node app.js' 2>/dev/null | head -n 1 || echo)"
fi

if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  # Allow for a start still in progress: the app has to reach MongoDB Atlas
  # before /health answers, and killing it mid-connect produces a restart
  # loop that never converges.
  if [ -n "$(find "$STARTED" -mmin -2 2>/dev/null)" ]; then
    exit 0          # started in the last two minutes; give it this round
  fi
  log "pid $PID alive but not answering on $PORT — replacing it"
  kill "$PID" 2>/dev/null
  sleep 3
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" 2>/dev/null
fi

cd "$APP_DIR" || { log "FATAL: cannot enter $APP_DIR"; exit 1; }

# NODE_ENV is set here as well as in server/env: development mode pulls in
# pino-pretty, which `npm ci --omit=dev` does not install, and the process
# dies at startup. dotenv does not override a variable already set, so this
# one wins and the two cannot disagree.
NODE_ENV=production nohup "$NODE_BIN" app.js >> "$LOG" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
touch "$STARTED"
log "started pid $NEW_PID"
