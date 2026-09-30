#!/bin/sh
# entry point of the ouroboros service. runs the boot supervisor, if the supervisor itself dies within
# seconds of starting (a bad copy), falls back to the previous known-good copy.
BOOT=/opt/ouroboros/boot
start=$(date +%s)
node "$BOOT/ouro-boot.mjs" "$@"
rc=$?
[ "$rc" -eq 0 ] && exit 0
now=$(date +%s)
if [ $((now - start)) -lt 20 ] && [ -f "$BOOT/ouro-boot.lkg.mjs" ]; then
  echo "boot supervisor failed fast (exit $rc); running the known-good copy" >&2
  exec node "$BOOT/ouro-boot.lkg.mjs" "$@"
fi
exit "$rc"
