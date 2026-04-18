# Changelog

All notable changes to TouchTheo are documented here.
TouchTheo is a Raspberry Pi 5 optimised fork of [TouchKio](https://github.com/leukipp/touchkio) by [@leukipp](https://github.com/leukipp).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions increment as: **major** for breaking changes, **minor** for new features, **patch** for bug fixes.

---

## [1.5.16] — 2026-04-17

### Fixed
- **Touch events ignored after display wake (upstream fix, TouchKio #148)** — after a touch woke the display, the next touch could be incorrectly filtered as "display off" because the `tracker.display.on` timestamp was only updated by the async `updateDisplay` event, which fires after the next `mouseDown` had already been evaluated. Fixed by synchronously setting `tracker.display.on = new Date()` immediately after calling `setDisplayStatus("ON")` in the touch handler.

### Changed
- **Screenshot MQTT sensor capped at 800px** — screenshots published to Home Assistant via MQTT are now resized to a maximum of 800px on either dimension before encoding, reducing payload size on high-resolution displays.
- **Uptime sensor adds `app` start timestamp** — the Up Time sensor's attributes now include both `app` (time TouchTheo was last started) and `boot` (system boot time), powered by a new `APP.start` timestamp recorded at application init.

## [1.5.15] — 2026-04-16

### Fixed
- **Touch input slow or unresponsive after display wake (regression in 1.5.14)** —
  the v1.5.14 fix unconditionally detached and re-attached the CDP debugger on
  every `OFF → ON` display transition, even for short sleeps where the session was
  still alive. Two bugs in that implementation caused the regression:
  (1) `debugger.sendCommand()` is async but was not awaited — the `try/catch`
  cannot catch Promise rejections, so if the command failed the emulation mode
  was silently never applied and the rejection went unhandled in Electron's
  Node.js layer; (2) the unconditional `detach()` on healthy sessions left a
  window between detach and the completion of the async re-attach where raw touch
  events arrived without emulation, causing Chromium's input queue to back up and
  the whole system to feel sluggish. Fix: on wake, first try re-sending
  `setEmitTouchEventsForMouse` to the existing session (no disruption if it is
  healthy); only fall back to detach + re-attach if that command fails (session
  genuinely stale). All `sendCommand` calls are now properly awaited.

---

## [1.5.14] — 2026-04-16

### Fixed
- **Touch input stops working after extended display sleep** — after 5+ hours of
  idle with the display off (swayidle + wlopm), touching the screen to wake it
  would restore the display but the app would no longer respond to touch. Root
  cause: the Chrome DevTools Protocol (CDP) debugger session attached at startup
  (used to convert raw touch events to mouse clicks via
  `Emulation.setEmitTouchEventsForMouse`) silently went stale during extended
  idle. The kernel continued receiving touch events (confirmed via
  `libinput debug-events`) and Electron continued rendering (HA state updates
  appeared on screen), but touch never converted to clicks. Fix: on every
  `OFF → ON` display transition, detach and re-attach the CDP debugger for each
  webview before the first touch is processed.

---

## [1.5.13] — 2026-04-14

### Fixed
- **Chromium flags passed via `ExecStart` or CLI are forwarded correctly** —
  the `KNOWN_ARGS` filter introduced in v1.5.8 silently dropped any flag not
  in the app argument whitelist, breaking user-facing Chromium flags documented
  in `HARDWARE.md` such as `--disable-gpu` and
  `--disable-features=UseDNSHttps,AsyncDns`. Unrecognised flags are now
  forwarded to Chromium via `app.commandLine.appendSwitch()` at startup
  instead of being dropped. Flags managed internally (`--no-sandbox`,
  `--no-zygote`) are excluded from forwarding to avoid double-application.

---

## [1.5.12] — 2026-04-14

### Fixed
- **Wake tap no longer triggers HA actions when using swayidle** — when
  `swayidle` blanks the screen and a touch wakes it, the Wayland compositor
  turns the display on immediately. If the 1-second polling cycle happened to
  run between the physical wake and Electron processing the `mouseDown` event,
  the tracker would already show the display as ON and the tap protection would
  fail, passing the wake tap through to the webview. Fixed by setting a
  `waking` flag on every OFF→ON transition detected by polling. The first
  `mouseDown` after a wake consumes and clears the flag, discarding the tap
  regardless of polling timing. Only one tap per wake cycle is discarded;
  subsequent touches work normally. (Fixes
  [TouchKio #197](https://github.com/leukipp/touchkio/issues/197))

---

## [1.5.11] — 2026-04-14

### Fixed
- **`--no-zygote` replaces `--disable-dev-shm-usage`** — with `--no-sandbox`,
  Chromium's zygote process forks renderer processes that end up in a different
  PID namespace from the browser process, causing `ESRCH` on shared memory
  creation regardless of whether `/dev/shm` or `/tmp` is used, leaving the
  window blank white. `--no-zygote` makes Chromium spawn renderer processes
  directly instead of via zygote forks, avoiding the namespace mismatch.
  This is the standard fix for running Chromium in systemd service / container
  environments.

---

## [1.5.10] — 2026-04-14

### Fixed
- **`--disable-dev-shm-usage` added alongside `--no-sandbox`** — without the
  Chromium sandbox, renderer processes can end up in a different PID namespace
  from the process that created the `/dev/shm` shared memory file, causing
  `ESRCH` ("no such process") errors that crash every renderer immediately after
  launch. `--disable-dev-shm-usage` redirects Chromium's shared memory to `/tmp`,
  bypassing the namespace mismatch entirely.

---

## [1.5.9] — 2026-04-14

### Fixed
- **`/dev/shm` permissions set during install and migration** — Chromium running
  without the seccomp sandbox (`--no-sandbox`) accesses `/dev/shm` directly for
  inter-process shared memory. If the directory lacks `1777` permissions, renderer
  subprocesses crash immediately with `ESRCH` on shared memory creation. Both
  `install.sh` and `migrate_from_touchkio.sh` now run `sudo chmod 1777 /dev/shm`
  and write `/etc/tmpfiles.d/shm.conf` so the correct permissions are restored on
  every boot.

---

## [1.5.8] — 2026-04-14

### Fixed
- **Unrecognised flags no longer corrupt argument handling** — `parseArgs` now
  filters its output against a whitelist of known argument keys (`KNOWN_ARGS`).
  Previously, Chromium flags that leaked into `process.argv` (e.g. `no-sandbox`
  when passed via `ExecStart`) were treated as app arguments, setting
  `argsProvided = true` and preventing setup from running, which left
  `web_url` empty and caused a crash loop. Any flag not in `KNOWN_ARGS` is now
  silently dropped before it can affect argument handling or saved config.

---

## [1.5.7] — 2026-04-14

### Fixed
- **`update` and `update-service` modes no longer download the `.deb` unnecessarily** —
  `update-service` now exits immediately after rewriting the service file without
  ever hitting the GitHub API or downloading anything. `update` checks the installed
  version (`dpkg-query`) against the latest GitHub release version and skips the
  download if they already match.

---

## [1.5.6] — 2026-04-14

### Fixed
- **`--no-sandbox` moved from service file into app code** — passing `--no-sandbox`
  via `ExecStart` caused it to appear in `process.argv` where the app's own argument
  parser treated it as a config key, clearing the `web_url` setting and crashing on
  every start. The flag is now applied via `app.commandLine.appendSwitch('no-sandbox')`
  in `index.js` before `app.whenReady()`, so Chromium receives it without it ever
  touching `process.argv`.
- **Service file templates updated** — `--no-sandbox` removed from `ExecStart` in
  `install.sh` and `migrate_from_touchkio.sh`.

---

## [1.5.5] — 2026-04-14

### Fixed
- **Logging now reliably appears in journalctl** — electron-log's default console
  transport routes output through Electron's V8 console object which does not
  consistently flush to the file descriptor that systemd/journald watches. The
  console transport is now replaced with a custom function that calls
  `process.stdout.write()` / `process.stderr.write()` directly, bypassing
  Electron's console layer entirely. The startup version line also writes via
  `process.stdout.write()` so it appears before the rest of the log pipeline
  is fully initialised.

---

## [1.5.4] — 2026-04-13

### Fixed
- **Logging now goes to systemd journal** — `app.commandLine.appendSwitch("log-file", ...)`
  was redirecting the entire process stdout to `~/.config/touchtheo/logs/electron.log`,
  which caused `journalctl --user -u touchtheo.service` to receive nothing. Removed the
  Chromium log-file redirect and disabled electron-log's file transport entirely. All
  output now goes to stdout/stderr, captured by systemd as intended. The
  `~/.config/touchtheo/logs/` directory is no longer created.
- **Version logged on every startup** — `TouchTheo vX.Y.Z starting` is now the first
  info-level log entry after initialisation, visible in the journal immediately.
- **MQTT connection logged** — MQTT Connecting / Connected / Disconnected / Error events
  were already in the code but were invisible due to the stdout redirect; they now appear
  in the journal correctly.

---

## [1.5.3] — 2026-04-13

### Fixed
- `migrate_from_touchkio.sh` / `install.sh`: add `XAUTHORITY=%h/.Xauthority` to
  the service file template. Without this, X11 refuses connections from user
  services (no auth cookie), which causes Electron to fail silently — the
  journal shows "Started" but nothing appears on screen.

---

## [1.5.2] — 2026-04-13

### Fixed
- `migrate_from_touchkio.sh` / `install.sh`: changed service `WantedBy` from
  `graphical-session.target` to `default.target` — `graphical-session.target`
  is not automatically activated on Raspberry Pi OS so the service would never
  start. Using `default.target` with `StartLimitBurst=30` / `StartLimitIntervalSec=300`
  lets systemd retry every 10 s for up to 5 minutes until the display is ready.
- `migrate_from_touchkio.sh`: use `systemctl --user restart` instead of `start`
  when the service is already running, so re-running the script actually
  applies the new service file.
- `migrate_from_touchkio.sh`: skip `.deb` download and install when the latest
  GitHub release version already matches the installed version.
- `migrate_from_touchkio.sh` / `install.sh`: added `systemd-tmpfiles --create`
  and a `Storage=persistent` journald drop-in so `journalctl --user -u
  touchtheo.service` works correctly after a reboot (a reboot is required for
  the persistent journal to take effect on existing installs).

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
