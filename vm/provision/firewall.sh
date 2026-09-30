#!/bin/sh
# apply the Ouroboros egress policy, verify that it did not break connectivity (rolling back if it
# did), and report whether isolation from the host and LAN actually holds.
#
#   firewall.sh apply | remove | status
set -u
RULES=/etc/ouroboros/firewall.nft

remove() { nft delete table inet ouro_egress 2>/dev/null || true; }
connectivity() { getent hosts nodejs.org >/dev/null 2>&1 && curl -sS -m 15 -o /dev/null https://nodejs.org 2>/dev/null; }
gateway() { ip route show default 2>/dev/null | awk '/default/ {print $3; exit}'; }
# succeeds when a TCP connection to $1:$2 is refused, filtered or times out
blocked() { ! timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

case "${1:-apply}" in
  apply)
    if ! connectivity; then echo "firewall: no outbound connectivity before applying the rules; not applying" >&2; exit 1; fi
    nft -f "$RULES" || { echo "firewall: failed to load $RULES" >&2; exit 1; }
    if ! connectivity; then
      echo "firewall: connectivity broke after applying the rules; ROLLING BACK (host/LAN isolation is NOT active)" >&2
      remove
      exit 1
    fi
    leaks=""
    for h in host.lima.internal 192.168.5.2 "$(gateway)"; do
      [ -n "$h" ] || continue
      for p in 22 80 443; do blocked "$h" "$p" || leaks="$leaks $h:$p"; done
    done
    if [ -z "$leaks" ]; then echo "firewall: isolation active (host and LAN unreachable, internet works)"; else echo "firewall: WARNING still reachable:$leaks" >&2; fi
    ;;
  remove) remove ;;
  status) nft list table inet ouro_egress ;;
  *) echo "usage: firewall.sh apply|remove|status" >&2; exit 2 ;;
esac
