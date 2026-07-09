#!/bin/sh
# In-container notification scheduler — the Dockerized replacement for an external
# `0 * * * *` cron entry. Runs the hourly tick (`node dist/notify.cjs`, the
# bundled scripts/notify.ts) once at the top of every hour. The tick itself
# decides what's actually due for the current hour and dedupes per day/slot, so
# this loop only needs to fire reliably once per clock hour.
#
# Sleeping to the next hour boundary (rather than a flat `sleep 3600`) keeps ticks
# aligned to the wall clock and self-correcting against drift from each run's
# duration. Hour matching uses local time, so set TZ (see docker-compose.yml).
set -e

echo "[notify-scheduler] started; first tick at the top of the next hour"

# Telegram button-tap poller (getUpdates long poll), for deployments without a
# public URL. Safe to run unconditionally: it idles unless Settings →
# Notifications is in polling mode. Restarted here if it ever crashes.
(
  while true; do
    node /app/dist/notify.cjs poll || echo "[notify-scheduler] poller exited (exit $?); restarting in 30s"
    sleep 30
  done
) &

while true; do
  now=$(date +%s)
  next=$(( (now / 3600 + 1) * 3600 ))
  sleep $(( next - now ))
  # Never let a single failed tick kill the loop — log and keep scheduling.
  node /app/dist/notify.cjs || echo "[notify-scheduler] tick failed (exit $?); continuing"
done
