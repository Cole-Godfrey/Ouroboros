#!/usr/bin/env bash
# Create the Ouroboros VM on your Mac and install the agent inside it.
#
#   ./vm/mac/setup.sh [--name ouroboros] [--cpus 4] [--memory 8GiB] [--disk 80GiB] [--no-init] [--keep-awake]
#
# Requires macOS 13+ and Homebrew. Safe to re-run: it reuses an existing VM and repository copy.
set -euo pipefail

NAME="${OURO_VM_NAME:-ouroboros}"
CPUS=""; MEMORY=""; DISK=""; RUN_INIT=1; KEEP_AWAKE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --cpus) CPUS="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --no-init) RUN_INIT=0; shift ;;
    --keep-awake) KEEP_AWAKE=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "this script is for macOS (the VM itself runs Linux)"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO_DIR/vm/lima/ouroboros.yaml" ] || die "run this from a clone of the Ouroboros repository"

say "Lima"
if ! command -v limactl >/dev/null; then
  command -v brew >/dev/null || die "Homebrew is required to install Lima: https://brew.sh"
  brew install lima
fi
limactl --version
ver="$(limactl --version | awk '{print $NF}' | sed 's/^v//')"
[ "${ver%%.*}" -ge 2 ] 2>/dev/null || die "Lima 2.0 or newer is required (brew upgrade lima); found $ver"

say "The VM (${NAME})"
if limactl list -q 2>/dev/null | grep -qx "$NAME"; then
  echo "VM ${NAME} already exists"
  limactl list "$NAME" | tail -n +2 | grep -q Running || limactl start "$NAME"
else
  args=(--name "$NAME" --tty=false)
  [ -n "$CPUS" ] && args+=(--cpus "$CPUS")
  [ -n "$MEMORY" ] && args+=(--memory "${MEMORY%GiB}")
  [ -n "$DISK" ] && args+=(--disk "${DISK%GiB}")
  limactl create "${args[@]}" "$REPO_DIR/vm/lima/ouroboros.yaml"
  limactl start "$NAME"
fi

say "Copying the repository into the VM"
if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
  echo "note: you have uncommitted changes; only committed work is copied" >&2
fi
if limactl shell "$NAME" test -d /home/ouro/ouroboros/.git 2>/dev/null; then
  echo "repository already present in the VM (not overwritten: the agent may have modified it)"
else
  bundle="$(mktemp -d)/ouroboros.bundle"
  git -C "$REPO_DIR" bundle create "$bundle" --all >/dev/null 2>&1
  limactl copy "$bundle" "$NAME:/tmp/ouroboros.bundle"
  limactl shell "$NAME" bash -lc 'set -e; rm -rf ~/ouroboros; git clone -q /tmp/ouroboros.bundle ~/ouroboros; cd ~/ouroboros; git remote remove origin; git checkout -q -B main; rm -f /tmp/ouroboros.bundle'
fi

say "Installing inside the VM"
limactl shell "$NAME" bash -lc '~/ouroboros/vm/provision/provision.sh'

say "Start at login"
if ! limactl autostart "$NAME" 2>/dev/null; then limactl start-at-login "$NAME" 2>/dev/null || echo "note: could not enable autostart; start the VM with: limactl start $NAME"; fi

if [ "$KEEP_AWAKE" -eq 1 ]; then
  say "Keep-awake"
  "$REPO_DIR/vm/mac/keep-awake.sh" install
fi

say "Mac shortcut"
shim="$HOME/.local/bin/ouro"
mkdir -p "$HOME/.local/bin"
sed "s/@NAME@/$NAME/g" "$REPO_DIR/vm/mac/ouro" > "$shim"
chmod +x "$shim"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "add ~/.local/bin to your PATH to use \`ouro\` from your Mac terminal" ;; esac

cat <<MSG

The VM is ready. It has no access to your files, and cannot reach your Mac or local network.

  Enter it:               limactl shell ${NAME}
  Run commands from Mac:  ~/.local/bin/ouro status   (a shortcut for: limactl shell ${NAME} -- ouro status)
  Keep the Mac awake:     ./vm/mac/keep-awake.sh install   (a sleeping Mac pauses the agent)
MSG

if [ "$RUN_INIT" -eq 1 ]; then
  say "First-time setup (ouro init)"
  exec limactl shell "$NAME" -- ouro init
fi
