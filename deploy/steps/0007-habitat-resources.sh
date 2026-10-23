#!/bin/sh
# Declare Allos's optional Habitat reader for practice thing links (FP-1769).
# area: habitat-read
# after:
# files: deploy/liftoff.json
set -eu
. "$STEP_LIB"
case "$1" in
  check) same_file "$STEP_FILES/deploy/liftoff.json" liftoff.json ;;
  run) install_file "$STEP_FILES/deploy/liftoff.json" liftoff.json ;;
  *) exit 2 ;;
esac
