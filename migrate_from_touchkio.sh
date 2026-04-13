#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# migrate_from_touchkio.sh
#
# One-shot migration from a fully-configured TouchKio installation to TouchTheo.
#
# What this script does:
#   1. Validates TouchKio is installed and detects system architecture
#   2. Stops the touchkio systemd user service
#   3. Downloads and installs the latest TouchTheo .deb from GitHub
#   4. Migrates ~/.config/touchkio/Arguments.json → ~/.config/touchtheo/
#      - All WEB and MQTT settings are preserved
#      - The MQTT password is decrypted with the TouchKio key and
#        re-encrypted with the TouchTheo key (AES-256-CBC via scrypt;
#        the app name is part of the key — a direct copy would not decrypt)
#   5. Carries over any custom ExecStart flags from touchkio.service
#      (e.g. --disable-features=..., --disable-gpu) into touchtheo.service
#   6. Creates and enables the touchtheo systemd user service
#   7. Starts TouchTheo
#
# After a successful migration, run cleanup_touchkio.sh to remove all
# TouchKio files, packages, and service definitions.
#
# Usage:
#   bash migrate_from_touchkio.sh
#   bash migrate_from_touchkio.sh --dry-run   # preview without changing anything
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }
step()    { echo -e "\n${BOLD}── $* ──${RESET}"; }

# ── Dry-run flag ─────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done
$DRY_RUN && warn "DRY-RUN mode — no changes will be made."

run() {
  if $DRY_RUN; then
    echo -e "  ${YELLOW}[dry-run]${RESET} $*"
  else
    eval "$@"
  fi
}

# ── Constants ─────────────────────────────────────────────────────────────────
TOUCHKIO_NAME="touchkio"
TOUCHKIO_BIN="/usr/bin/touchkio"
TOUCHKIO_CONFIG="$HOME/.config/touchkio"
TOUCHKIO_SERVICE_FILE="$HOME/.config/systemd/user/touchkio.service"

TOUCHTHEO_NAME="touchtheo"
TOUCHTHEO_BIN="/usr/bin/touchtheo"
TOUCHTHEO_CONFIG="$HOME/.config/touchtheo"
TOUCHTHEO_SERVICE_FILE="$HOME/.config/systemd/user/touchtheo.service"

GITHUB_REPO="theojamesvibes/touchtheo"
ARGS_FILE="Arguments.json"
BRIGHTNESS_CACHE="Cache/Brightness.vcp"

# ─────────────────────────────────────────────────────────────────────────────
step "Pre-flight checks"
# ─────────────────────────────────────────────────────────────────────────────

# Must not run as root
[[ "$EUID" -eq 0 ]] && die "Run this script as your normal user, not root."

# Must be 64-bit Linux
[[ "$(uname -s)" == "Linux" ]] || die "This script only runs on Linux."
BITS=$(getconf LONG_BIT)
[[ "$BITS" -eq 64 ]] || die "A 64-bit operating system is required (detected ${BITS}-bit)."

# Detect architecture
case "$(uname -m)" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $(uname -m)" ;;
esac
info "Architecture: ${ARCH} (${BITS}-bit)"

# TouchKio must be installed
if ! command -v "$TOUCHKIO_NAME" &>/dev/null && ! dpkg -s "$TOUCHKIO_NAME" &>/dev/null 2>&1; then
  die "TouchKio does not appear to be installed (binary not found, not in dpkg). Nothing to migrate."
fi
TOUCHKIO_VER=$(dpkg-query -W -f='${Version}' "$TOUCHKIO_NAME" 2>/dev/null || echo "unknown")
success "TouchKio found (version ${TOUCHKIO_VER})"

# Warn if TouchTheo already installed
if command -v "$TOUCHTHEO_NAME" &>/dev/null || dpkg -s "$TOUCHTHEO_NAME" &>/dev/null 2>&1; then
  warn "TouchTheo is already installed. Settings will be overwritten by this migration."
  read -r -p "Continue? (y/N) " confirm
  [[ "${confirm:-n}" =~ ^[Yy]$ ]] || { info "Migration cancelled."; exit 0; }
fi

# wget must be available (used in install.sh too)
command -v wget &>/dev/null || die "wget is required but not found. Install it with: sudo apt install wget"

# apt must be available
command -v apt &>/dev/null || die "apt package manager not found."

# Node.js must be available (for password re-encryption); offer to install if missing
if ! command -v node &>/dev/null; then
  warn "node is required for password migration but was not found."
  read -r -p "Install nodejs now via apt? [y/N] " _node_ans
  [[ "${_node_ans,,}" == "y" ]] || die "nodejs is required — install it manually with: sudo apt install nodejs"
  sudo apt-get install -y nodejs || die "Could not install nodejs. Install it manually with: sudo apt install nodejs"
  command -v node &>/dev/null || die "nodejs was installed but 'node' is still not in PATH — try opening a new shell and re-running."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Stopping TouchKio service"
# ─────────────────────────────────────────────────────────────────────────────

TOUCHKIO_WAS_ACTIVE=false
if systemctl --user --quiet is-active touchkio.service 2>/dev/null; then
  TOUCHKIO_WAS_ACTIVE=true
  info "Stopping touchkio.service..."
  run "systemctl --user stop touchkio.service"
  success "touchkio.service stopped."
else
  info "touchkio.service is not running — nothing to stop."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Downloading TouchTheo"
# ─────────────────────────────────────────────────────────────────────────────

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

info "Fetching release list from github.com/${GITHUB_REPO}..."
RELEASES_JSON=$(wget -qO- "https://api.github.com/repos/${GITHUB_REPO}/releases" | tr -d '\r\n') || \
  die "Failed to reach GitHub API. Check your network connection."

DEB_REG='"prerelease":\s*false.*?"browser_download_url":\s*"\K[^\"]*_'"${ARCH}"'\.deb'
DEB_URL=$(echo "$RELEASES_JSON" | grep -oP "$DEB_REG" | head -n 1)

if [[ -z "$DEB_URL" ]]; then
  die "No TouchTheo .deb release found for ${ARCH} at github.com/${GITHUB_REPO}/releases.\n" \
      "       Publish a release first, or install manually from the repository."
fi

DEB_FILE="${TMP_DIR}/$(basename "$DEB_URL")"
info "Downloading: $DEB_URL"
run "wget --show-progress -q -O '$DEB_FILE' '$DEB_URL'" || die "Download failed."
success "Downloaded: $(basename "$DEB_FILE")"

# ─────────────────────────────────────────────────────────────────────────────
step "Installing TouchTheo"
# ─────────────────────────────────────────────────────────────────────────────

run "sudo apt install -y '$DEB_FILE'" || die "apt install failed."
success "TouchTheo installed."

# ─────────────────────────────────────────────────────────────────────────────
step "Migrating configuration"
# ─────────────────────────────────────────────────────────────────────────────

SRC_ARGS="${TOUCHKIO_CONFIG}/${ARGS_FILE}"
DST_DIR="${TOUCHTHEO_CONFIG}"
DST_ARGS="${DST_DIR}/${ARGS_FILE}"
DST_CACHE="${DST_DIR}/Cache"

if [[ ! -f "$SRC_ARGS" ]]; then
  warn "No Arguments.json found at ${SRC_ARGS} — skipping config migration."
  warn "You will be guided through setup when TouchTheo first starts."
else
  info "Source: ${SRC_ARGS}"
  info "Destination: ${DST_ARGS}"

  run "mkdir -p '$DST_DIR' '$DST_CACHE'"

  # ── Migrate Arguments.json with password re-encryption ─────────────────────
  # The MQTT password is AES-256-CBC encrypted using scryptSync(machineId, appName, 32).
  # Because the app name changed (touchkio → touchtheo), we must:
  #   1. Decrypt with the "touchkio" key
  #   2. Re-encrypt with the "touchtheo" key
  # This is done inline via Node.js, which is guaranteed present.

  NODE_MIGRATE_SCRIPT=$(cat <<'NODESCRIPT'
const fs   = require('fs');
const crypto = require('crypto');

const srcPath = process.argv[2];
const dstPath = process.argv[3];

let args;
try {
  args = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
} catch (e) {
  process.stderr.write('Failed to parse Arguments.json: ' + e.message + '\n');
  process.exit(1);
}

const machineId = (() => {
  try { return fs.readFileSync('/etc/machine-id', 'utf8').trim().replace(/\0/g, ''); }
  catch { return ''; }
})();

if (!machineId) {
  process.stderr.write('Could not read /etc/machine-id — password will be removed.\n');
  delete args.mqtt_password;
  fs.writeFileSync(dstPath, JSON.stringify(args, null, 2));
  process.stdout.write('NO_MACHINE_ID\n');
  process.exit(0);
}

const decrypt = (value, appName) => {
  const p   = Buffer.from(value, 'base64').toString('utf8').split(':');
  const iv  = Buffer.from(p.shift(), 'hex');
  const key = crypto.scryptSync(machineId, appName, 32);
  const dec = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const buf = Buffer.from(p.join(':'), 'hex');
  return dec.update(buf, 'binary', 'utf8') + dec.final('utf8');
};

const encrypt = (value, appName) => {
  const iv     = crypto.randomBytes(16);
  const key    = crypto.scryptSync(machineId, appName, 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc    = cipher.update(value, 'utf8', 'hex') + cipher.final('hex');
  return Buffer.from(iv.toString('hex') + ':' + enc).toString('base64');
};

if (args.mqtt_password) {
  try {
    const plain = decrypt(args.mqtt_password, 'touchkio');
    args.mqtt_password = encrypt(plain, 'touchtheo');
    fs.writeFileSync(dstPath, JSON.stringify(args, null, 2));
    process.stdout.write('REENCRYPTED\n');
  } catch (e) {
    process.stderr.write('Password re-encryption failed: ' + e.message + '\n');
    delete args.mqtt_password;
    fs.writeFileSync(dstPath, JSON.stringify(args, null, 2));
    process.stdout.write('PASSWORD_REMOVED\n');
  }
} else {
  fs.writeFileSync(dstPath, JSON.stringify(args, null, 2));
  process.stdout.write('NO_PASSWORD\n');
}
NODESCRIPT
)

  if $DRY_RUN; then
    info "[dry-run] Would run Node.js password re-encryption script"
    info "[dry-run] Source: ${SRC_ARGS}"
    info "[dry-run] Destination: ${DST_ARGS}"
  else
    RESULT=$(node -e "$NODE_MIGRATE_SCRIPT" -- "$SRC_ARGS" "$DST_ARGS" 2>&1) || true
    STATUS=$(echo "$RESULT" | tail -n1)
    case "$STATUS" in
      REENCRYPTED)
        success "Arguments.json migrated — MQTT password re-encrypted for TouchTheo." ;;
      NO_PASSWORD)
        success "Arguments.json migrated — no MQTT password was set." ;;
      PASSWORD_REMOVED)
        warn "Arguments.json migrated — MQTT password could not be re-encrypted and was removed."
        warn "You will need to re-enter your MQTT password. Run: touchtheo --setup" ;;
      NO_MACHINE_ID)
        warn "Arguments.json migrated — /etc/machine-id unreadable; MQTT password was removed."
        warn "You will need to re-enter your MQTT password. Run: touchtheo --setup" ;;
      *)
        warn "Unexpected output from migration script: ${RESULT}"
        warn "Please verify ${DST_ARGS} before starting TouchTheo." ;;
    esac
  fi

  # ── Copy brightness cache if it exists ─────────────────────────────────────
  SRC_BRIGHTNESS="${TOUCHKIO_CONFIG}/${BRIGHTNESS_CACHE}"
  DST_BRIGHTNESS="${DST_CACHE}/Brightness.vcp"
  if [[ -f "$SRC_BRIGHTNESS" ]]; then
    run "cp '$SRC_BRIGHTNESS' '$DST_BRIGHTNESS'"
    success "Brightness cache migrated."
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Migrating systemd service"
# ─────────────────────────────────────────────────────────────────────────────

run "mkdir -p '$(dirname "$TOUCHTHEO_SERVICE_FILE")'"

# Extract any extra ExecStart flags from the existing touchkio.service.
# e.g. --disable-features=UseDNSHttps,AsyncDns  or  --disable-gpu
EXTRA_FLAGS=""
if [[ -f "$TOUCHKIO_SERVICE_FILE" ]]; then
  EXISTING_EXEC=$(grep -E '^ExecStart=' "$TOUCHKIO_SERVICE_FILE" | head -n1 || true)
  # Strip the binary name; keep only the flags that follow it
  RAW_FLAGS="${EXISTING_EXEC#ExecStart=/usr/bin/touchkio}"
  RAW_FLAGS="${RAW_FLAGS#ExecStart=/usr/bin/${TOUCHKIO_NAME}}"
  EXTRA_FLAGS=$(echo "$RAW_FLAGS" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
  if [[ -n "$EXTRA_FLAGS" ]]; then
    info "Detected custom ExecStart flags: ${EXTRA_FLAGS}"
    info "These will be carried over to touchtheo.service."
  fi
fi

EXEC_START="/usr/bin/touchtheo${EXTRA_FLAGS:+ $EXTRA_FLAGS}"

SERVICE_CONTENT="[Unit]
Description=TouchTheo
After=graphical-session.target
Wants=graphical-session.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-0
Environment=XDG_RUNTIME_DIR=/run/user/%U
ExecStart=${EXEC_START}
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=graphical-session.target"

if [[ -f "$TOUCHTHEO_SERVICE_FILE" ]]; then
  warn "Service file already exists: ${TOUCHTHEO_SERVICE_FILE}"
  warn "Overwriting with migrated configuration."
fi

if $DRY_RUN; then
  info "[dry-run] Would write service file:"
  echo "$SERVICE_CONTENT" | sed 's/^/  /'
else
  echo "$SERVICE_CONTENT" > "$TOUCHTHEO_SERVICE_FILE" || die "Failed to write ${TOUCHTHEO_SERVICE_FILE}."
  success "Service file written: ${TOUCHTHEO_SERVICE_FILE}"
fi

run "systemctl --user daemon-reload"
run "systemctl --user enable touchtheo.service"
success "touchtheo.service enabled."

# ─────────────────────────────────────────────────────────────────────────────
step "Starting TouchTheo"
# ─────────────────────────────────────────────────────────────────────────────

# Set display variables if not already set (needed for headless/SSH launch)
export DISPLAY="${DISPLAY:-:0}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"

run "systemctl --user start touchtheo.service"
success "touchtheo.service started."

# Brief pause to catch immediate failures
sleep 2
if ! $DRY_RUN && ! systemctl --user --quiet is-active touchtheo.service 2>/dev/null; then
  warn "TouchTheo service does not appear to be running after start."
  warn "Check the logs with:  journalctl --user -u touchtheo.service -n 50"
else
  success "touchtheo.service is active."
fi

# ─────────────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}Migration complete!${RESET}"
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "  TouchTheo config: ${CYAN}${TOUCHTHEO_CONFIG}/${RESET}"
echo -e "  Service status:   ${CYAN}systemctl --user status touchtheo.service${RESET}"
echo -e "  Live logs:        ${CYAN}journalctl --user -u touchtheo.service -f${RESET}"
echo
echo -e "  TouchKio is still installed. To remove it run:"
echo -e "    ${YELLOW}bash cleanup_touchkio.sh${RESET}"
echo
