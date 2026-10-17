#!/bin/sh
# Reach Allos through its published prod port, as its public route does (flightplan 325).
# phase: after
set -eu
. "$STEP_LIB"
[ "$STEP_HOST" = prod ] || exit 0
caddy="$STEP_COMPOSE/../caddy"
config="$caddy/conf/Caddyfile"
[ -f "$config" ] || exit 2
# Reuse the public site's reachable upstream; Allos need not share Caddy's network.
upstream=$(awk '
  /handle @allos[[:space:]]*{/ {allos=1}
  allos {
    depth += gsub(/{/, "{") - gsub(/}/, "}");
    if ($1 == "reverse_proxy" && NF == 2) {print $2; found=1; exit}
    if (depth == 0) allos=0;
  }
  END {if (!found) exit 2}
' "$config")
case "$1" in
  check|run)
    candidate=$(mktemp)
    old=$(mktemp)
    trap 'rm -f "$candidate" "$old"' EXIT HUP INT TERM
    # The unique gate is the insertion point: never install an ungated proxy or
    # change bridge's fallback, sibling products, or Allos's public site.
    awk -v upstream="$upstream" '
      /# BEGIN allos-health/ {skip=1; begin++; next}
      /# END allos-health/ {if (!skip) exit 2; skip=0; end++; next}
      !skip {print}
      !skip && /^[[:space:]]*import member_gate deck[[:space:]]*$/ {
        gates++;
        print "        # BEGIN allos-health";
        print "        @allos_health path /health /health/*";
        print "        handle @allos_health {";
        print "            reverse_proxy " upstream;
        print "        }";
        print "        # END allos-health";
      }
      END {if (gates != 1 || skip || begin != end || begin > 1) exit 2}
    ' "$config" > "$candidate"
    if [ "$1" = check ]; then
      if cmp -s "$candidate" "$config"; then exit 0; else exit 1; fi
    fi
    cmp -s "$candidate" "$config" && exit 0
    cp "$config" "$old"
    install_file "$candidate" "$config"
    # reload.sh validates both Caddy syntax and gate ordering before reloading.
    if ! "$caddy/reload.sh"; then
      install_file "$old" "$config"
      "$caddy/reload.sh"
      exit 2
    fi
    ;;
  *) exit 2 ;;
esac
