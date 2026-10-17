#!/bin/sh
# Mount only Deck Health behind Deck's Boarding gate (allos#6127, spaceport#860).
# phase: after
set -eu
. "$STEP_LIB"
[ "$STEP_HOST" = prod ] || exit 0
caddy="$STEP_COMPOSE/../caddy"
config="$caddy/conf/Caddyfile"
[ -f "$config" ] || exit 2
case "$1" in
  check|run)
    candidate=$(mktemp)
    old=$(mktemp)
    trap 'rm -f "$candidate" "$old"' EXIT HUP INT TERM
    # The unique gate is the insertion point: never install an ungated proxy or
    # change bridge's fallback, sibling products, or Allos's public site.
    awk '
      /# BEGIN allos-health/ {skip=1; begin++; next}
      /# END allos-health/ {if (!skip) exit 2; skip=0; end++; next}
      !skip {print}
      !skip && /^[[:space:]]*import member_gate deck[[:space:]]*$/ {
        gates++;
        # The gate line'"'"'s own indent; Caddy reaches allos at prod'"'"'s address,
        # as allos.wang.team does: the allos_default network has no caddy.
        match($0, /^[[:space:]]*/); ind = substr($0, 1, RLENGTH);
        in2 = ind (ind ~ /\t/ ? "\t" : "    ");
        print ind "# BEGIN allos-health";
        print ind "@allos_health path /health /health/*";
        print ind "handle @allos_health {";
        print in2 "reverse_proxy 10.69.6.200:3000";
        print ind "}";
        print ind "# END allos-health";
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
