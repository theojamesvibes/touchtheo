# Changelog

All notable changes to TouchTheo are documented here.
TouchTheo is a Raspberry Pi 5 optimised fork of [TouchKio](https://github.com/leukipp/touchkio) by [@leukipp](https://github.com/leukipp).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions increment as: **major** for breaking changes, **minor** for new features, **patch** for bug fixes.

---

## [1.5.1] — 2026-04-11

### Added
- `migrate_from_touchkio.sh` — one-shot migration script for users upgrading
  from a fully-configured TouchKio installation:
  - Stops the `touchkio` systemd user service
  - Downloads and installs the latest TouchTheo `.deb` from GitHub Releases
  - Migrates `~/.config/touchkio/Arguments.json` to `~/.config/touchtheo/`,
    preserving all WEB and MQTT settings
  - Re-encrypts the MQTT password using the TouchTheo key derivation
    (`scryptSync(machineId, "touchtheo", 32)`) since the app name is part of
    the AES-256-CBC key — a direct file copy would fail to decrypt
  - Carries over any custom `ExecStart` flags from `touchkio.service`
    (e.g. `--disable-features=...`, `--disable-gpu`) into `touchtheo.service`
  - Copies the DDC brightness cache (`Cache/Brightness.vcp`) if present
  - Supports `--dry-run` flag to preview all actions without modifying anything
- `cleanup_touchkio.sh` — separate removal script to be run after confirming
  TouchTheo works correctly:
  - Stops and disables `touchkio.service`
  - Removes the `touchkio` apt/deb package (with `purge` for any residual
    dpkg config state)
  - Deletes `~/.config/touchkio/` and `~/.config/systemd/user/touchkio.service`
  - Guards against running before TouchTheo is confirmed working
  - Supports `--dry-run` and `--force` flags
- `README.md` — added **Migrating from TouchKio** section under Installation
  documenting both scripts with one-liner usage, `--dry-run` examples, and a
  collapsible detail block explaining every step each script performs

---

## [1.5.0] — 2026-04-11

Initial TouchTheo release. Forked from TouchKio v1.4.2 as a clean copy
(no upstream git history) under the `theojamesvibes` GitHub account.

### Added
- `rp1_thermal` thermal zone recognised in `getProcessorTemperature` — this is
  the primary temperature zone on Raspberry Pi 5 (RP1 I/O chip). Upstream only
  handled `cpu-thermal`, `x86_pkg_temp`, `k10temp`, `acpitz`, and `cpu`.
- `XDG_SESSION_TYPE` environment variable checked first in `sessionType` before
  falling back to `loginctl`. On Raspberry Pi OS Bookworm the env var is always
  set correctly at login; `loginctl` can be unresponsive if queried too early
  during startup.
- `start:rpi5` npm script with `--enable-features=VaapiVideoDecodeLinuxGL
  --disable-gpu-compositing` for hardware-accelerated video decode on RPi5.
- `CHANGELOG.md` (this file).
- `## Changes from TouchKio` and `## Credits` sections in `README.md`
  documenting all modifications and giving full attribution to the TouchKio
  project and its author.

### Changed
- Project renamed from `touchkio` → `touchtheo`, `TouchKio` → `TouchTheo`
  across all source files, templates, install script, and build config.
- GitHub owner updated from `leukipp` → `theojamesvibes` in `package.json`,
  `forge.config.js`, `install.sh`, `.github/` templates, and `README.md`.
- Service name in startup error messages updated to `touchtheo.service`.
- `getModel`, `getVendor`, `getSerialNumber`, `getMachineId` now memoize their
  result on first call. Each function spawns a `cat` process against a `/sys`
  or `/etc` path; the hardware identity never changes at runtime.
- `commandExists` caches results per command name. The function is called
  multiple times during init probing for `wlopm`, `kscreen-doctor`, `xset`,
  `ddcutil`, `loginctl`, `pactl`, and `apt`.
- `sudoRights` caches its result. The sudo check is run at init and referenced
  from `checkSupport`, `getDisplayBrightnessCommand`, and several guard clauses.
- `getProcessorUsage` switched from the 5-minute load average (`os.loadavg()[1]`)
  to the 1-minute average (`os.loadavg()[0]`) for more timely readings on a
  permanently-on kiosk display.
- `checkPackageUpgrades` now uses `cpr.spawnSync` with `stdio: ['ignore', 'pipe',
  'ignore']` instead of appending `"2>/dev/null"` as a string argument. The old
  approach worked only because `execSync` passes the joined argument string
  through a shell; using `spawnSync` is safer and does not rely on shell
  interpretation.
- `getNetworkAddresses` renamed the loop variable `interface` → `iface`.
  `interface` is a reserved word in strict-mode JavaScript and causes lint
  errors in some toolchains.
- TLS certificate error message in `webview.js` (`onlineStatus`) now references
  `APP.issues` dynamically instead of a hardcoded upstream GitHub URL.
- Version bumped from `1.4.2` → `1.5.0`.

---

## Upstream baseline — TouchKio v1.4.2

TouchTheo v1.5.0 is derived from TouchKio v1.4.2.
See the upstream changelog at:
https://github.com/leukipp/touchkio/releases
