#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
# Deploys the API and the static pages on GoDaddy cPanel.
#
#   sh ~/nodeapp/deploy-cpanel.sh
#
# Run it from the cPanel Terminal (or over SSH). It is safe to re-run: every
# step either converges on the same state or is a plain copy.
#
# BEFORE the first run, `~/nodeapp/server/env` must exist with the DynamoDB
# credentials in it. That file is deliberately not in the repository — it
# holds an AWS secret key and the repository is public — so it is uploaded
# by hand through File Manager and then `chmod 600`.
# ─────────────────────────────────────────────────────────────────────────
set -eu

APP_DIR="$HOME/nodeapp"
PORT=5050

# Node is a home-directory install here, so it is not on a login shell's PATH.
PATH="$HOME/nodejs/bin:$PATH"
export PATH

cd "$APP_DIR"

echo "── node ──────────────────────────────────────────"
node --version
npm --version

echo
echo "── pull ──────────────────────────────────────────"
# keepalive.sh is tracked in the repository now. The copy written by hand on
# this server is untracked, and Git refuses to overwrite an untracked file,
# so the first pull after it became tracked fails with no other explanation.
if [ -f keepalive.sh ] && ! git ls-files --error-unmatch keepalive.sh >/dev/null 2>&1; then
  mv keepalive.sh keepalive.sh.local
  echo "moved the hand-written keepalive.sh aside as keepalive.sh.local"
fi
git pull origin main

echo
echo "── env ───────────────────────────────────────────"
if [ ! -f server/env ]; then
  echo "  ✖ server/env is missing. Upload it before running this."
  exit 1
fi
chmod 600 server/env
# Never print the file. Just prove the two settings the data store depends on
# are present, because a silent default here is a site that answers 503.
for key in DB_DRIVER AWS_REGION AWS_S3_BUCKET MEDIA_DRIVER; do
  if grep -q "^$key=" server/env; then
    printf '  %-16s set\n' "$key"
  else
    printf '  %-16s MISSING\n' "$key"
    exit 1
  fi
done

echo
echo "── install ───────────────────────────────────────"
npm ci --omit=dev

echo
echo "── database ──────────────────────────────────────"
# Confirms every table and index exists and is reachable from this host before
# anything is started. DescribeTable's ItemCount lags by hours, so a table that
# was just filled can report zero rows — that is not a failure.
npm run dynamo:verify

echo
echo "── start ─────────────────────────────────────────"
chmod +x keepalive.sh
./keepalive.sh
# The app has to open its first HTTPS connection to DynamoDB in Sydney before
# /health answers, which is slower than a local database would be.
sleep 12
CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:$PORT/api/v1/health" || echo 000)"
echo "  local /health → $CODE"
if [ "$CODE" = "000" ]; then
  echo "  ✖ nothing answered on $PORT. Last lines of the log:"
  tail -n 30 "$APP_DIR/keepalive.log" 2>/dev/null || true
  exit 1
fi

echo
echo "── static pages ──────────────────────────────────"
# Includes .htaccess, which carries the /api proxy and the CSP, so the pages
# and the rules that serve them always move together.
cp -R public/. "$HOME/public_html/"
echo "  copied public/ → public_html/"

echo
echo "── done ──────────────────────────────────────────"
echo "Add this cron entry once, if it is not already there:"
echo "  */2 * * * *  \$HOME/nodeapp/keepalive.sh >/dev/null 2>&1"
