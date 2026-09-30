#!/usr/bin/env bash
# install Ouroboros inside the VM. run as the `ouro` user (it uses sudo where needed). idempotent.
#
#   ~/ouroboros/vm/provision/provision.sh
#
# installs: Node.js (checksum-verified), the harness dependencies (including the Pi agent harness),
# the last-resort boot supervisor (outside the repo, root-owned), the egress firewall, the systemd
# services and the `ouro` command. it does not start the agent: run `ouro init`, then `ouro start`.
set -euo pipefail

REPO="${OURO_CODE:-$HOME/ouroboros}"
NODE_MAJOR="${NODE_MAJOR:-22}"
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as the ouro user, not as root"
[ -f "$REPO/package.json" ] || die "the harness repository is not at $REPO (set OURO_CODE)"
command -v sudo >/dev/null || die "sudo is required"
[ "$(uname -s)" = Linux ] || die "this script is for the Linux VM"

say "Base packages"
if ! command -v git >/dev/null || ! command -v nft >/dev/null || ! command -v curl >/dev/null; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl git build-essential python3 python3-pip python3-venv jq sqlite3 unzip xz-utils nftables tmux htop ripgrep dnsutils netcat-openbsd less vim
fi

say "Node.js ${NODE_MAJOR}.x (22.22.2+ or 24.15+, with npm 12)"
node_ok() { command -v node >/dev/null && node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); process.exit((a===22&&(b>22||(b===22&&c>=2)))||(a===24&&b>=15)||a>=26?0:1)'; }
if ! node_ok; then
  case "$(uname -m)" in aarch64|arm64) narch=arm64 ;; x86_64) narch=x64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  file="$(printf '%s\n' "$sums" | awk -v a="linux-${narch}.tar.xz" '$2 ~ a"$" {print $2; exit}')"
  expected="$(printf '%s\n' "$sums" | awk -v f="$file" '$2==f {print $1}')"
  [ -n "$file" ] && [ -n "$expected" ] || die "could not find a Node ${NODE_MAJOR} tarball for ${narch}"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  echo "$expected  $tmp/$file" | sha256sum -c - >/dev/null || die "Node checksum mismatch"
  sudo mkdir -p /usr/local/lib/nodejs
  sudo tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
  dir="/usr/local/lib/nodejs/${file%.tar.xz}"
  for b in node npm npx corepack; do sudo ln -sf "$dir/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
fi
node_ok || die "Node is still too old"
# npm 12 honors the lockfile override instead of Pi's older published shrinkwrap.
if ! command -v npm >/dev/null || [ "$(npm --version)" != 12.2.0 ]; then
  sudo /usr/local/bin/npm install --global npm@12.2.0 --no-audit --no-fund
fi
echo "node $(node -v), npm $(npm -v)"

say "Harness repository and dependencies"
cd "$REPO"
git config --global --add safe.directory "$REPO" >/dev/null 2>&1 || true
if [ ! -d .git ]; then git init -q && git add -A && git -c user.name=Ouroboros -c user.email=ouroboros@localhost commit -q -m "initial import"; fi
git config user.name Ouroboros
git config user.email ouroboros@localhost
npm ci --no-audit --no-fund
node node_modules/typescript/bin/tsc --version >/dev/null

say "Directories and the last-resort boot supervisor"
sudo mkdir -p /opt/ouroboros/boot /opt/ouroboros/firewall /etc/ouroboros
sudo install -m 0755 -o root -g root "$REPO/boot/ouro-boot.mjs" /opt/ouroboros/boot/ouro-boot.mjs
sudo install -m 0755 -o root -g root "$REPO/boot/ouro-boot.mjs" /opt/ouroboros/boot/ouro-boot.lkg.mjs
sudo install -m 0755 -o root -g root "$REPO/vm/provision/run.sh" /opt/ouroboros/boot/run.sh
sudo install -m 0755 -o root -g root "$REPO/vm/provision/firewall.sh" /opt/ouroboros/firewall/firewall.sh
sudo install -m 0644 -o root -g root "$REPO/vm/provision/firewall.nft" /etc/ouroboros/firewall.nft
sudo install -m 0755 -o root -g root "$REPO/vm/provision/ouro-wrapper.sh" /usr/local/bin/ouro
sudo install -m 0644 -o root -g root "$REPO/vm/provision/ouroboros-profile.sh" /etc/profile.d/ouroboros.sh
sudo install -d -m 0700 -o "$USER" -g "$USER" "$HOME/.ouroboros"

say "Kernel settings"
printf 'net.ipv6.conf.all.disable_ipv6 = 1\nnet.ipv6.conf.default.disable_ipv6 = 1\n' | sudo tee /etc/sysctl.d/60-ouroboros.conf >/dev/null
sudo sysctl --system >/dev/null 2>&1 || true

say "Services"
sudo install -m 0644 "$REPO/vm/provision/ouroboros.service" /etc/systemd/system/ouroboros.service
sudo install -m 0644 "$REPO/vm/provision/ouroboros-firewall.service" /etc/systemd/system/ouroboros-firewall.service
sudo systemctl daemon-reload
sudo systemctl enable ouroboros-firewall.service ouroboros.service >/dev/null 2>&1

say "Egress firewall (blocks the VM from your Mac and local network)"
sudo /opt/ouroboros/firewall/firewall.sh apply || die "firewall self-test failed. See vm/provision/firewall.sh, then re-run provisioning"

say "Done"
cat <<MSG
Installed. Next, inside this VM:

  ouro init        # keys, budget, jurisdiction, notifications, wallet, charter seal, first release
  ouro doctor      # verify everything, including host/LAN isolation
  ouro start       # start the agent (it also starts on boot)
MSG
