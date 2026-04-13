#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rollback_to_touchkio.sh
#
# Reverts a TouchTheo migration back to TouchKio, provided cleanup_touchkio.sh
# has NOT yet been run (i.e. TouchKio is still installed and its config and
# service file are still present).
#
# What this script does:
#   1. Verifies TouchKio is still installed and its service file exists
#   2. Stops and disables touchtheo.service
#   3. Re-enables and starts touchkio.service
#   4. Optionally removes TouchTheo and its configuration
#
# Usage:
#   bash rollback_to_touchkio.sh
#   bash rollback_to_touchkio.sh --dry-run   # preview without changing anything
#   bash rollback_to_touchkio.sh --force     # skip confirmation prompts
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
  if $FORCE || $DRY_RUN; then return 0; fi
  read -r -p "$1 (y/N) " ans
  [[ "${ans:-n}" =~ ^[Yy]$ ]]
}

# ── Constants ─────────────────────────────────────────────────────────────────
TOUCHKIO_NAME="touchkio"
TOUCHKIO_CONFIG="$HOME/.config/touchkio"
TOUCHKIO_SERVICE_FILE="$HOME/.config/systemd/user/touchkio.service"

TOUCHTHEO_NAME="touchtheo"
TOUCHTHEO_CONFIG="$HOME/.config/touchtheo"
TOUCHTHEO_SERVICE_FILE="$HOME/.config/systemd/user/touchtheo.service"

# ─────────────────────────────────────────────────────────────────────────────
step "Pre-flight checks"
# ─────────────────────────────────────────────────────────────────────────────

[[ "$EUID" -eq 0 ]] && die "Run this script as your normal user, not root."

# TouchKio must still be installed
if ! dpkg -s "$TOUCHKIO_NAME" &>/dev/null 2>&1; then
  die "TouchKio is not installed — cleanup_touchkio.sh has likely already been run.\n" \
      "       A rollback is not possible without reinstalling TouchKio manually."
fi

TOUCHKIO_VER=$(dpkg-query -W -f='${Version}' "$TOUCHKIO_NAME" 2>/dev/null || echo "unknown")
success "TouchKio ${TOUCHKIO_VER} is installed."

# TouchKio service file must still exist
if [[ ! -f "$TOUCHKIO_SERVICE_FILE" ]]; then
  die "TouchKio service file not found at ${TOUCHKIO_SERVICE_FILE}.\n" \
      "       Cannot re-enable the service without it."
fi
success "TouchKio service file found."

# TouchKio config should still be present (warn, but don't block)
if [[ ! -d "$TOUCHKIO_CONFIG" ]]; then
  warn "TouchKio config directory not found at ${TOUCHKIO_CONFIG}."
  warn "TouchKio will start but may prompt for setup again."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Summary"
# ─────────────────────────────────────────────────────────────────────────────

echo
echo -e "  This will ${RED}stop and disable${RESET} touchtheo.service"
echo -e "  and ${GREEN}re-enable and start${RESET} touchkio.service."
echo

confirm "Proceed with rollback?" || { info "Rollback cancelled."; exit 0; }

# ─────────────────────────────────────────────────────────────────────────────
step "Stopping TouchTheo"
# ─────────────────────────────────────────────────────────────────────────────

if systemctl --user --quiet is-active touchtheo.service 2>/dev/null; then
  run "systemctl --user stop touchtheo.service"
  success "touchtheo.service stopped."
else
  info "touchtheo.service was not running."
fi

if systemctl --user --quiet is-enabled touchtheo.service 2>/dev/null; then
  run "systemctl --user disable touchtheo.service"
  success "touchtheo.service disabled."
else
  info "touchtheo.service was not enabled."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Restoring TouchKio"
# ─────────────────────────────────────────────────────────────────────────────

run "systemctl --user daemon-reload"
run "systemctl --user enable touchkio.service"
success "touchkio.service enabled."

run "systemctl --user start touchkio.service"
success "touchkio.service started."

sleep 2
if ! $DRY_RUN && ! systemctl --user --quiet is-active touchkio.service 2>/dev/null; then
  warn "TouchKio service does not appear to be running after start."
  warn "Check the logs with:  journalctl --user -u touchkio.service -n 50"
else
  success "touchkio.service is active."
fi

# ─────────────────────────────────────────────────────────────────────────────
step "Optional: remove TouchTheo"
# ─────────────────────────────────────────────────────────────────────────────

REMOVE_TOUCHTHEO=false
if ! $FORCE; then
  read -r -p "Remove the TouchTheo package and its configuration? (y/N) " _rm_ans
  [[ "${_rm_ans,,}" == "y" ]] && REMOVE_TOUCHTHEO=true
else
  REMOVE_TOUCHTHEO=true
fi

if $REMOVE_TOUCHTHEO; then
  if dpkg -s "$TOUCHTHEO_NAME" &>/dev/null 2>&1; then
    run "sudo apt remove -y '$TOUCHTHEO_NAME'"
    if dpkg -s "$TOUCHTHEO_NAME" &>/dev/null 2>&1; then
      run "sudo apt purge -y '$TOUCHTHEO_NAME'"
    fi
    success "TouchTheo package removed."
  else
    info "TouchTheo package not found — skipping apt remove."
  fi

  if [[ -f "$TOUCHTHEO_SERVICE_FILE" ]]; then
    run "rm -f '$TOUCHTHEO_SERVICE_FILE'"
    success "Removed: ${TOUCHTHEO_SERVICE_FILE}"
  fi

  if [[ -d "$TOUCHTHEO_CONFIG" ]]; then
    FILE_COUNT=$(find "$TOUCHTHEO_CONFIG" -type f | wc -l)
    info "Removing ${FILE_COUNT} file(s) under ${TOUCHTHEO_CONFIG}/"
    run "rm -rf '$TOUCHTHEO_CONFIG'"
    success "Removed: ${TOUCHTHEO_CONFIG}/"
  fi

  run "systemctl --user daemon-reload"
else
  info "TouchTheo left installed. You can remove it later with:"
  info "  sudo apt remove ${TOUCHTHEO_NAME}"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo -e "\n${GREEN}${BOLD}Rollback complete!${RESET}"
# ─────────────────────────────────────────────────────────────────────────────
echo
echo -e "  TouchKio config: ${CYAN}${TOUCHKIO_CONFIG}/${RESET}"
echo -e "  Service status:  ${CYAN}systemctl --user status touchkio.service${RESET}"
echo -e "  Live logs:       ${CYAN}journalctl --user -u touchkio.service -f${RESET}"
echo
