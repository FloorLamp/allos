#!/bin/sh
# In-container notification scheduler — the Dockerized replacement for an external
# cron entry. Runs the tick (`node dist/notify.cjs`, the bundled scripts/notify.ts)
# once every TICK_SECONDS, epoch-aligned, so sub-hourly reminder times (#2121) are
# honoured — to the minute, when they sit on the cadence's grid (#2216). The tick
# itself decides what's actually due for the current profile-local minute and
# dedupes per day/slot — it also OBSERVES its own cadence (the
# notify_tick_last_run_at watermark) and sizes its slot windows from it, so this
# loop only needs to fire on a steady rhythm; changing TICK_SECONDS needs no app
# config.
#
# TICK_SECONDS is the operator's one knob (#2216), defaulting to 5 minutes. The
# OFFERED values are the divisors of 60 minutes — 60, 120, 180, 240, 300, 360,
# 600, 720, 900, 1200, 1800, 3600 seconds (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30,
# 60 minutes) — because this loop is epoch-aligned: a divisor cadence lands on the
# same minutes of every hour, which is the stable grid the time picker in
# Settings → Notifications renders. Other values still WORK (the app measures
# whatever rhythm this actually is), but land on different minutes each hour, so
# configured times fire late by up to one interval. An hourly host crontab
# (`0 * * * *`) remains fully supported: slots degrade to at-most-an-hour-late,
# exactly the pre-#2121 behavior, and Settings → Notifications warns when a
# configured time can't be hit exactly at the observed cadence. Run exactly ONE
# tick scheduler (this sidecar OR a crontab, never both).
#
# Sleeping to the next boundary (rather than a flat `sleep`) keeps ticks aligned
# to the wall clock and self-correcting against drift from each run's duration.
set -e

TICK_SECONDS=300 # 5 minutes; the app observes whatever rhythm this actually is

echo "[notify-scheduler] started; first tick at the next ${TICK_SECONDS}-second boundary"

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
  next=$(( (now / TICK_SECONDS + 1) * TICK_SECONDS ))
  sleep $(( next - now ))
  # Never let a single failed tick kill the loop — log and keep scheduling.
  node /app/dist/notify.cjs || echo "[notify-scheduler] tick failed (exit $?); continuing"
done
