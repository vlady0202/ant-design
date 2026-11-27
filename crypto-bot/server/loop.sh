#!/usr/bin/env bash
# Runs a pass every CB_INTERVAL seconds for CB_LOOP_MINUTES, then hands over to a fresh workflow run,
# so the bot keeps going around the clock (GitHub's own schedule only fires every few hours).
set -u
INTERVAL="${CB_INTERVAL:-300}"
END=$(( $(date +%s) + ${CB_LOOP_MINUTES:-340} * 60 ))
HERE="$(cd "$(dirname "$0")" && pwd)"
while :; do
  [ "${GITHUB_ACTIONS:-}" = "true" ] && { git -C "$HERE/../.." pull -q --ff-only 2>/dev/null || true; }   # pick up code updates between passes
  bash "$HERE/pass.sh" || echo "La pasada terminó con error (se reintenta en la siguiente)"
  [ $(( $(date +%s) + INTERVAL )) -lt "$END" ] || break
  sleep "$INTERVAL"
done
if [ -n "${GITHUB_REPOSITORY:-}" ] && [ "${CB_NO_HANDOVER:-}" != "1" ]; then
  curl -fsS -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$GITHUB_REPOSITORY/actions/workflows/crypto-bot.yml/dispatches" \
    -d "{\"ref\":\"${GITHUB_REF_NAME:-master}\"}" && echo "Relevo lanzado" || echo "No se pudo lanzar el relevo (lo retoma el horario de respaldo)"
fi
