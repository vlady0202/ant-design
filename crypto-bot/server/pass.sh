#!/usr/bin/env bash
# One trading pass: load the bot-data branch, run the engine, save it back as a single commit
# (keeping the newest settings.json the app may have written meanwhile).
set -u
REMOTE="${CB_REMOTE:-https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
DATA="$RUNNER_TEMP/data"
rm -rf "$DATA"
if git ls-remote --exit-code "$REMOTE" bot-data >/dev/null 2>&1; then
  git clone -q --depth 1 --branch bot-data "$REMOTE" "$DATA"
else
  mkdir -p "$DATA"
fi
STATE_FILE="$DATA/state.json" SETTINGS_FILE="$DATA/settings.json" node "$(dirname "$0")/runner.mjs"
RC=$?
[ -f "$DATA/state.json" ] || exit $RC
for attempt in 1 2 3; do
  OUT="$RUNNER_TEMP/out"; rm -rf "$OUT"; mkdir -p "$OUT"
  cp "$DATA/state.json" "$OUT/"
  ( cd "$OUT"
    git init -q -b bot-data
    git config user.name "crypto-bot"; git config user.email "crypto-bot@users.noreply.github.com"
    LEASE=""
    if git ls-remote --exit-code "$REMOTE" bot-data >/dev/null 2>&1; then
      git fetch -q --depth 1 "$REMOTE" bot-data
      LEASE=$(git rev-parse FETCH_HEAD)
      git show FETCH_HEAD:settings.json > settings.json 2>/dev/null || rm -f settings.json
    fi
    git add -A
    git commit -qm "Bot 24/7 $(date -u +%Y-%m-%dT%H:%MZ)"
    if [ -n "$LEASE" ]; then git push -q --force-with-lease=bot-data:"$LEASE" "$REMOTE" bot-data
    else git push -q "$REMOTE" bot-data; fi
  ) && exit $RC
  sleep 5
done
echo "No se pudo guardar el estado"; exit 1
