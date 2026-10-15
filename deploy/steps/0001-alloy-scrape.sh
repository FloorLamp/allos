#!/bin/sh
# Install the Allos scrape configuration to collect operational metrics with this PR.
# phase: after
# repeat: yes
# files: deploy/allos.alloy
. "$STEP_LIB"
case "$1" in
  check) same_file "$STEP_FILES/deploy/allos.alloy" allos.alloy ;;
  run) install_file "$STEP_FILES/deploy/allos.alloy" allos.alloy ;;
esac
