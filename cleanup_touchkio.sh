#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cleanup_touchkio.sh
#
# Removes all TouchKio files, package, service, and configuration from the
# system after a successful migration to TouchTheo.
#
# Run migrate_from_touchkio.sh first and confirm TouchTheo is working before
# running this script. Removals here are irreversible.
#
# What this removes:
#   • touchkio systemd user service (stopped, disabled, and deleted)
#   • touchkio apt/deb package (via sudo apt remove)
#   • ~/.config/touchkio/ directory (Arguments.json, logs, cache)
#
# Usage:
#   bash cleanup_touchkio.sh
#   bash cleanup_touchkio.sh --dry-run   # preview without changing anything
#   bash cleanup_touchkio.sh --force     # skip confirmation prompts
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

# ── Flags ─────────────────────────────────────────────────────────────────────
DRY_RUN=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --force)   FORCE=true ;;
  esac
done
$DRY_RUN && warn "DRY-RUN mode — no changes will be made."

run() {
  if $DRY_RUN; then
    echo -e "  ${YELLOW}[dry-run]${RESET} $*"
  else
    eval "$@"
  fi
}

confirm() {
  # $1 = prompt text
  if $FORCE || $DRY_RUN; then
    return 0
  fi
  read -r -p "$1 (y/N) " ans
  [[ "${ans:-n}" =~ ^[Yy]$ ]]
}

# ── Constants ─────────────────────────────────────────────────────────────────
TOUCHKIO_NAME="touchkio"
TOUCHKIO_CONFIG="$HOME/.config/touchkio"
TOUCHKIO_SERVICE_FILE="$HOME/.config/systemd/user/touchkio.service"

TOUCHTHEO_NAME="touchtheo"

# ─────────────────────────────────────────────────────────────────────────────
step "Pre-flight checks"
# ─────────────────────────────────────────────────────────────────────────────

[[ "$EUID" -eq 0 ]] && die "Run this script as your normal user, not root."

# TouchTheo should be installed and running before we delete TouchKio
if ! command -v "$TOUCHTHEO_NAME" &>/dev/null && ! dpkg -s "$TOUCHTHEO_NAME" &>/dev/null 2>&1; then
  die "TouchTheo does not appear to be installed. Run migrate_from_touchkio.sh first."
fi

if ! systemctl --user --quiet is-active touchtheo.service 2>/dev/null; then
  warn "TouchTheo service is not currently running."
  warn "It is strongly recommended to verify TouchTheo works before removing TouchKio."
  confirm "Proceed with cleanup anyway?" || { info "Cleanup cancelled."; exit 0; }
else
  success "TouchTheo service is running — safe to clean up TouchKio."
fi

# Check whether touchkio is even present (graceful no-op if already gone)
TOUCHKIO_INSTALLED=false
if dpkg -s "$TOUCHKIO_NAME" &>/dev/null 2>&1; then
  TOUCHKIO_INSTALLED=true
  TOUCHKIO_VER=$(dpkg-query -W -f='${Version}' "$TOUCHKIO_NAME" 2>/dev/null || echo "unknown")
  info "TouchKio found (version ${TOUCHKIO_VER}) — will be removed."
else
  warn "TouchKio package is not installed (may have been removed already)."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Summary of what will be deleted"
# ─────────────────────────────────────────────────────────────────────────────

echo
echo -e "  ${RED}Package:${RESET}  ${TOUCHKIO_NAME} (via sudo apt remove)"
echo -e "  ${RED}Service:${RESET}  ${TOUCHKIO_SERVICE_FILE}"
echo -e "  ${RED}Config:${RESET}   ${TOUCHKIO_CONFIG}/"
echo -e "             (includes Arguments.json, Cache/, logs/)"
echo

confirm "Delete all of the above?" || { info "Cleanup cancelled."; exit 0; }

# ─────────────────────────────────────────────────────────────────────────────
step "Stopping and disabling touchkio service"
# ─────────────────────────────────────────────────────────────────────────────

if systemctl --user --quiet is-active touchkio.service 2>/dev/null; then
  run "systemctl --user stop touchkio.service"
  success "touchkio.service stopped."
else
  info "touchkio.service was not running."
fi

if systemctl --user --quiet is-enabled touchkio.service 2>/dev/null; then
  run "systemctl --user disable touchkio.service"
  success "touchkio.service disabled."
else
  info "touchkio.service was not enabled."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Removing touchkio.service file"
# ─────────────────────────────────────────────────────────────────────────────

if [[ -f "$TOUCHKIO_SERVICE_FILE" ]]; then
  run "rm -f '$TOUCHKIO_SERVICE_FILE'"
  success "Removed: ${TOUCHKIO_SERVICE_FILE}"
else
  info "Service file not found — already removed."
fi

run "systemctl --user daemon-reload"

# ─────────────────────────────────────────────────────────────────────────────
step "Removing TouchKio package"
# ─────────────────────────────────────────────────────────────────────────────

if $TOUCHKIO_INSTALLED; then
  run "sudo apt remove -y '$TOUCHKIO_NAME'"
  success "TouchKio package removed."

  # Optionally purge residual config left by dpkg
  if dpkg -s "$TOUCHKIO_NAME" &>/dev/null 2>&1; then
    # Package still has config state (rc) — purge it
    run "sudo apt purge -y '$TOUCHKIO_NAME'"
    success "TouchKio package purged (residual config cleared)."
  fi
else
  info "Package not installed — skipping apt remove."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Removing TouchKio configuration directory"
# ─────────────────────────────────────────────────────────────────────────────

if [[ -d "$TOUCHKIO_CONFIG" ]]; then
  # List what's inside before deleting so the user can see what's gone
  FILE_COUNT=$(find "$TOUCHKIO_CONFIG" -type f | wc -l)
  info "Removing ${FILE_COUNT} file(s) under ${TOUCHKIO_CONFIG}/"
  run "rm -rf '$TOUCHKIO_CONFIG'"
  success "Removed: ${TOUCHKIO_CONFIG}/"
else
  info "Config directory not found — already removed."
fi

# ─────────────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}TouchKio cleanup complete!${RESET}"
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "  TouchTheo config: ${CYAN}$HOME/.config/touchtheo/${RESET}"
echo -e "  Service status:   ${CYAN}systemctl --user status touchtheo.service${RESET}"
echo -e "  Live logs:        ${CYAN}journalctl --user -u touchtheo.service -f${RESET}"
echo
