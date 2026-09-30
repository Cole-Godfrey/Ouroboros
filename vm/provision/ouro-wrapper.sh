#!/bin/sh
# /usr/local/bin/ouro: run the CLI from the live release (or from the working copy before the first release exists).
OURO_HOME="${OURO_HOME:-$HOME/.ouroboros}"
if [ -x "$OURO_HOME/current/bin/ouro" ]; then exec "$OURO_HOME/current/bin/ouro" "$@"; fi
exec "${OURO_CODE:-$HOME/ouroboros}/bin/ouro" "$@"
