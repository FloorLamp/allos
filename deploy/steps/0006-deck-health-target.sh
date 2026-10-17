#!/bin/sh
# Re-run 0005 on hosts it already ran on: its block proxied allos:3000, a name
# Caddy cannot resolve, so Deck Health was a 502 (spaceport#995).
# phase: after
set -eu
exec sh "$(dirname "$0")/0005-deck-health-route.sh" "$1"
