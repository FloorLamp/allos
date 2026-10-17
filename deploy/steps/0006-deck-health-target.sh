#!/bin/sh
# Deck Health's block proxies allos's own site upstream, not allos:3000 (spaceport#995).
# phase: after
# Caddy is not on allos_default, so 0005's allos:3000 never resolved: a 502.
# The upstream is read from allos's own site handler (@allos) (its one unmatched
# reverse_proxy), so no address lives here. Replaces 0005's marked block in
# place, at the gate line's indent; anything ambiguous fails closed.
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
    awk '
      NR == FNR {
        if ($0 ~ /^[[:space:]]*handle @allos[[:space:]]*\{[[:space:]]*$/) {site++; depth=1; next}
        if (depth) {
          if ($0 ~ /\{[[:space:]]*$/) depth++
          else if ($0 ~ /^[[:space:]]*\}[[:space:]]*$/) depth--
          else if ($1 == "reverse_proxy" && NF == 2 && $2 !~ /^@/) {upstreams++; upstream=$2}
        }
        next
      }
      FNR == 1 && (site != 1 || upstreams != 1) {exit 2}
      /# BEGIN allos-health/ {skip=1; begin++; next}
      /# END allos-health/ {if (!skip) exit 2; skip=0; end++; next}
      !skip {print}
      !skip && /^[[:space:]]*import member_gate deck[[:space:]]*$/ {
        gates++;
        match($0, /^[[:space:]]*/); ind = substr($0, 1, RLENGTH);
        in2 = ind (ind ~ /\t/ ? "\t" : "    ");
        print ind "# BEGIN allos-health";
        print ind "@allos_health path /health /health/*";
        print ind "handle @allos_health {";
        print in2 "reverse_proxy " upstream;
        print ind "}";
        print ind "# END allos-health";
      }
      END {if (gates != 1 || skip || begin != end || begin > 1) exit 2}
    ' "$config" "$config" > "$candidate"
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
