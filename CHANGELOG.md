# Changelog

All notable changes to TouchTheo are documented here.
TouchTheo is a Raspberry Pi 5 optimised fork of [TouchKio](https://github.com/leukipp/touchkio) by [@leukipp](https://github.com/leukipp).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions increment as: **major** for breaking changes, **minor** for new features, **patch** for bug fixes.

---

## [1.6.3] — 2026-09-07

Catch-up against upstream **TouchKio v1.5.1** (2026-08-30) and **v1.5.2**
(2026-09-07). TouchTheo was last aligned with upstream v1.5.0 in 1.6.0, so all
19 upstream commits since then were reviewed and the applicable ones ported.
Ships alongside an operational hardening pass on CI and process failure handling.

> **Not yet verified on hardware.** The code changes are covered by 16 unit tests
> in CI, but nothing in this release has been run on a Raspberry Pi. The Electron
> 42 → 44 bump in particular deserves a smoke test before this is rolled out.

### Added
- **Release indicator in the status bar (upstream TouchKio #70).** A blue download
  button appears in the framed status bar when a newer TouchTheo release is
  published, and opens the release page in the active view. Hidden while up to date.
- **Granular permission probing (upstream TouchKio #111).** `reboot`, `shutdown`
  and `apt install` rights are now probed individually with `sudo -n <cmd> --help`
  instead of being inferred from one blanket `sudo -n true`. A sudoers policy that
  only whitelists `reboot` now surfaces the Reboot button without having to grant
  everything else.
- **Six new unit tests** covering the ported behaviour: ddcutil standby states, the
  ddcutil brightness scaling in both directions, and the sudo/no-sudo `tee` split.
  These also pin the brightness-`0` divergence so a future catch-up cannot re-clamp it.
- **CI syntax and format gates.** `test.yml` now runs `node --check` over every
  source file and a `prettier --check` pass before the unit tests.
- **Process failure handlers (`index.js`).** Unhandled promise rejections are logged
  and survived rather than terminating the process — on a wall-mounted kiosk that
  previously meant a blank screen until systemd restarted the unit ten seconds
  later. Uncaught exceptions still exit, but with a logged stack and a non-zero code
  so `Restart=on-failure` has something to work with. `app.whenReady()` gained the
  rejection handler it never had.

### Changed
- **`HARDWARE.support.access` replaces `sudoRights` and `appUpdate` (breaking, MQTT
  attributes).** The Model sensor's attributes now carry an `access` object with
  `sudo`, `reboot`, `shutdown`, `install`, `service` and `deb`. The two old keys are
  gone. Attributes are informational, so nothing in Home Assistant breaks, but any
  template referencing `sudoRights` or `appUpdate` needs updating.
- **The App update entity is always published (upstream TouchKio #70).** Home
  Assistant now reports that a newer TouchTheo release exists even on devices that
  cannot install it themselves. The **Install** button only appears when the device
  was installed from the `.deb`, runs `touchtheo.service`, and has password-less
  `sudo apt` rights.
- **Screenshot and Heartbeat are published non-retained.** Retaining them meant a
  broker restart replayed a stale screenshot and a "last seen" timestamp that
  predated the device actually being up. Both republish on their normal interval.
- **Display light declares and reports a single color mode (upstream TouchKio
  #236).** The discovery config no longer declares `onoff` and then overwrite it
  with `brightness`; the active mode is published on `display/color_mode/state`.
- **ddcutil brightness is normalised against the display's own max.** A panel
  reporting on a 0–255 scale previously published its raw value, so 50% showed up
  as 127%. Reads and writes are both scaled now.
- **`app_reset` accepts `session` as well as `storage`.** Upstream renamed the key
  in 1.5.1; both spellings work here so existing `Arguments.json` files keep working.
- **Refresh and Home also clear service workers (upstream TouchKio #217).** A single
  `clearData()` helper replaces the three separate clearing paths; a full reset now
  uses `session.clearData()`.
- **Window chrome:** `hasShadow: false` and a larger minimum window size (136 → 188),
  matching upstream.
- **`release.yml` installs with `--frozen-lockfile` and runs the unit tests before
  publishing.** Previously a drifted `yarn.lock` could silently resolve different
  versions into the shipped `.deb`, and a tag push published without running a test.
- **`actions/checkout` and `actions/setup-node` bumped to v7** (supersedes Dependabot
  PRs #6 and #8).
- **Dependencies bumped to match upstream v1.5.2:** Electron `42.1.0` → `44.2.0`,
  axios `1.16.1` → `1.20.0`, mqtt `5.15.1` → `5.15.2`, prettier `3.8.3` → `3.9.6`,
  `@electron-forge/*` `7.11.1` → `7.11.2`. Kept as a separate commit so the Chromium
  jump can be reverted independently.
- **`index.js` and `js/integration.js` reformatted with prettier.** Both had drifted
  from the repo's own config, which inflated every upstream catch-up diff.

### Fixed
- **Display in standby reported as unavailable (upstream TouchKio #232).** The
  ddcutil DPMS regex only matched power states `x01` and `x04`, so a display in
  standby (`x02`, `x03`, `x05`) returned `null` and took the MQTT light entity
  unavailable instead of showing `OFF`.
- **Brightness control required sudo even when it wasn't needed (upstream TouchKio
  #233).** A udev rule that grants the session user write access to
  `/sys/class/backlight/*/brightness` is now detected, and `tee` runs without `sudo`.
- **Update progress `0` published as `null` (upstream TouchKio #241).** `in_progress`
  was `null` rather than a boolean during the first progress tick, which Home
  Assistant rejects.
- **Display control unsupported on console-autologin sessions (upstream TouchKio
  #239, still open upstream).** Raspberry Pi OS with console autologin starts
  labwc from a tty, so both `XDG_SESSION_TYPE` and `loginctl ... -p Type` report
  `tty`. The display command mapping only has `wayland`/`x11` entries, so
  `displayStatus` and `displayBrightness` came out permanently unsupported —
  no display power, no brightness — on a very common Pi setup. `sessionType()`
  now falls back to `WAYLAND_DISPLAY`/`DISPLAY`, which are set for the process
  that actually talks to the display server. Not an upstream port: upstream has
  not fixed this yet.
- **41 dead documentation links.** Every `#NNN` issue and PR reference in
  `HARDWARE.md` and `README.md` had been rewritten to `theojamesvibes/touchtheo`
  during the fork rename — a repository with no issue tracker, so all 41 were dead.
  They point back at `leukipp/touchkio` again.

### Deliberate divergences from upstream
- **Brightness `0` stays valid (TouchKio #190).** Upstream v1.5.1 re-clamps to a
  minimum of `1` in `getDisplayBrightness`, both `setDisplayBrightness` paths and the
  ddcutil scaling. All four were ported with a floor of `0`, and the unit tests fail
  if that regresses.
- **`initApp` only subscribes when a command topic exists.** Upstream passes an
  undefined topic to `mqtt.js` whenever install rights are missing.
- **`HARDWARE.support.access` is read with optional chaining throughout**, so a
  partially initialised support object degrades to "unsupported" rather than throwing
  inside the MQTT publish loop.
- **`latestRelease()` is not gated on `mqtt_app`** (pre-existing divergence, now load
  bearing) so the status-bar release indicator works with MQTT app updates disabled.

### Not ported
- **`mqtt_user` prompt default `kiosk` → `user`.** Cosmetic churn in the setup prompt
  for a fork that already ships under its own name.

### Docs
- `HARDWARE.md`: requirements table rewritten for the granular rights model, plus the
  previously missing Illuminance and Microphone rows; added the Official 10" Touch
  Display 2 (1200x1920) support row and the ddcutil/`wlopm` interaction note.
- `README.md`: documented the always-published App entity, the non-retained
  Screenshot/Heartbeat, and the `wayvnc` + `wlopm` conflict — display power control
  fails while a VNC client is connected ([touchkio#210](https://github.com/leukipp/touchkio/issues/210)).

---

## [1.6.2] — 2026-06-12

Open-issue catch-up against upstream **TouchKio** (v1.5.0 is the latest upstream
release and was already ported in 1.6.0, so there is no new release to absorb).
This release works through the items still **open** on the TouchKio tracker and
either implements them, mitigates them, or documents the workaround. Audit notes
for every open upstream issue are kept below under *Upstream issue status*.

### Added
- **Side-panel widget toggle via MQTT (upstream TouchKio #168).** A new **Widget**
  switch is exposed over MQTT auto-discovery. It shows/hides the floating
  side-panel widget at runtime so you can enable it to reproduce a dashboard issue
  and disable it again without editing `--web-widget` and restarting. Implemented
  as `WEBVIEW.window.setWidget()` (toggles `widget.setVisible()` + re-layout) and
  `initWidget()`/`updateWidget()` in the integration. Toggles only the widget
  overlay — the pager and navigation bar (also gated by `--web-widget` at startup)
  are intentionally left alone so the main view layout never shifts. Opt out with
  `mqtt_widget` in `app_disable`.

### Changed
- **Brightness `0` is now allowed (upstream TouchKio #190).** `setDisplayBrightness`
  previously clamped/validated to a `1`–`100` range, so PWM/sysfs backlights and
  `ddcutil` displays could only be dimmed to their minimum, never switched fully
  off from Home Assistant. The valid range is now `0`–`100` (validation, the `tee`
  write clamp, and the percentage reader all updated), matching Home Assistant's
  "brightness 0 = off" semantics.
- **Package Upgrades sensor no longer stuck at `0` on Raspberry Pi OS (upstream
  TouchKio #213).** `apt list --upgradable` only reflects the local apt index, which
  nothing refreshes automatically on headless Raspberry Pi OS — so the count stayed
  `0` even when upgrades existed. `checkPackageUpgrades` now triggers a **background,
  non-blocking** `apt-get update` (via `refreshAptCacheIfStale`) — fire-and-forget,
  guarded by a 12-hour staleness check and run **only when sudo rights are
  available**, so it touches the network at most twice a day and never blocks the
  main process. The refreshed index is picked up by the next hourly poll.

### Documentation
- **v3d GPU freeze on Raspberry Pi 4 / kernel 6.18.x documented (upstream TouchKio
  #211).** Added a `HARDWARE.md` troubleshooting entry for the `v3d_render_job_timedout`
  / GPU-reset deadlock that freezes the display after hours of uptime. The fix is the
  `--disable-gpu` Chromium flag; TouchTheo already forwards unrecognised flags to
  Chromium (since 1.5.13), so the entry shows how to add it to the service `ExecStart`.

### Upstream issue status

Audit of every **open** [TouchKio issue](https://github.com/leukipp/touchkio/issues)
against TouchTheo as of this release:

| Upstream | Status in TouchTheo |
| --- | --- |
| #213 Package upgrades always 0 | **Fixed** — background `apt-get update` (this release) |
| #211 v3d GPU hang (Pi 4, kernel 6.18.x) | **Documented + workaround** — `--disable-gpu` forwarded; HARDWARE.md entry (this release) |
| #197 Wake tap triggers HA via swayidle | **Already fixed** in 1.5.12 / 1.5.14 / 1.5.15 (display off/`waking` tap discard + CDP re-attach) |
| #190 Allow brightness 0 | **Fixed** — 0–100 range (this release) |
| #168 Side panel widget toggle via MQTT | **Implemented** — Widget switch (this release) |
| #169 Increased CPU since 1.2.0 | **Mitigated** — `mqtt_screenshot` disabled by default + per-minute capture gated when off |
| #96 Pre-release testers / early channel | **Supported** — `app_early` arg (early install, prerelease filter, `update early`) |
| #111 Granular sudoers | **Aligned** — TouchTheo avoids the blanket `NOPASSWD:ALL` pattern; detects rights via `sudo -n` and degrades gracefully |
| #188 Spotify/Disney+ DRM (Widevine) | **Not addressed** — stock Electron lacks the Widevine CDM; out of scope |
| #166 Gnome screen control | **Out of scope** — TouchTheo targets Wayland/labwc on Raspberry Pi, not GNOME/Ubuntu desktops |
| #165 X11 on-screen keyboard | **Out of scope** — TouchTheo targets Wayland (squeekboard), not X11 |
| #164 Bootable Raspberry Pi image | **Not planned** — packaging effort; `install.sh`/migration scripts cover setup |
| #183 Unifi Protect support | **Not addressed** — niche third-party webview login issue, not TouchKio-specific |

## [1.6.1] — 2026-05-25

Maintenance / tooling release. **No application code changed since 1.6.0**, so the
packaged `.deb`/`.zip` artifacts are functionally identical to 1.6.0 — this release
exists to ship the new project tooling and the committed lockfile from a clean tag.

### Added
- **Continuous testing** — a `node:test` unit suite (`tests/hardware.test.js`, Node
  built-ins only) now runs on every push and PR via `.github/workflows/test.yml`.
  It covers the thermal-priority logic (upstream #192) and locks in the Raspberry
  Pi 5 divergences (rp1_thermal priority, 1-minute load average, network-interface
  walk) so a future upstream catchup cannot silently regress them.
- **Dependabot** (`.github/dependabot.yml`) — weekly `github-actions` updates, plus
  weekly `npm` updates grouped into a single PR. (TouchTheo tracks upstream TouchKio
  dependency versions, so some npm bumps may be superseded by the next catchup; they
  are kept for security regardless.)

### Changed
- **CI actions bumped** — `actions/checkout` 4 → 6 and `actions/setup-node` 4 → 6
  across the release and test workflows (via Dependabot).
- `forge.config.js` excludes `tests/` from the packaged application.
- `yarn.lock` is now committed (regenerated for the 1.6.0 dependency set).

## [1.6.0] — 2026-05-25

Catch-up with upstream **TouchKio 1.5.0** (pre-release, 2026-05-15): the new
hardware sensors, the thermal-priority fix, and the full dependency bump are
ported in, each reconciled with TouchTheo's existing Raspberry Pi 5 divergences.

### Added
- **Ambient light (illuminance) sensor (upstream TouchKio #191)** — reads an IIO
  ambient light sensor from `/sys/bus/iio/devices/.../in_illuminance_raw` and, when
  present, publishes an `Illuminance Level` sensor to Home Assistant over MQTT.
  Hardware-gated (`support.illuminanceLevel`) so it is silently skipped on devices
  without a light sensor. **Disabled by default** via `app_disable`.
- **Microphone input volume (upstream TouchKio #195, MQTT path)** — adds detection
  of the default PulseAudio source and a `Microphone` volume control/sensor over
  MQTT, mirroring the existing audio-output volume support. `HARDWARE.audio.device`
  is now `{ output, input }` and the `pactl subscribe` monitor watches source as
  well as sink changes. Hardware-gated (`support.microphoneVolume`) and **disabled
  by default** via `app_disable`.
- **External display power/brightness via `ddcutil` (upstream TouchKio #194)** —
  display power and brightness control now falls back to `ddcutil` (DDC/CI) for
  HDMI-connected external monitors, in addition to the sysfs backlight path used by
  the official DSI touch display.

### Changed
- **Dependencies brought up to upstream TouchKio 1.5.0 (and current on npm):**
  `electron` ^39.2.4 → **^42.1.0** (three majors; Chromium security fixes),
  `axios` ^1.13.2 → ^1.16.1, `mqtt` ^5.14.1 → ^5.15.1, `electron-log` ^5.4.3 →
  ^5.4.4, `@electron-forge/*` ^7.10.2 → ^7.11.1, `prettier` ^3.6.2 → ^3.8.3. CI
  `setup-node` 20.x → 22.x.
- **`getProcessorTemperature` rewritten to collect-then-prioritise (upstream #192),
  merged with the RPi5 `rp1_thermal` zone.** Previously the first thermal zone in
  directory-read order won, regardless of which sensor it was; now all known zones
  are read and the most representative is chosen by a fixed priority
  (`cpu-thermal` → `rp1_thermal` → … → `acpitz` last), with a 0–150 °C sanity
  bound. TouchTheo's `rp1_thermal` zone is preserved at second priority.
- **`captureView` hardened (upstream)** — now guarded by `WEBVIEW.viewActive` and
  wrapped in try/catch, so a capture failure logs a warning instead of throwing.
  Retains the 800 px screenshot resize and the `mqtt_screenshot` `app_disable` gate.
- **Webview scrollbar hidden more robustly (upstream)** — adds
  `scrollbar-width: none` alongside the `::-webkit-scrollbar` rule, both `!important`.
- **Path-discovery hardening (upstream)** — `getProcessorTemperature`,
  `getBatteryLevelPath`, `getDisplayStatusPath` and `getDisplayBrightnessPath` now
  guard their root `/sys` paths with `fs.existsSync` before reading; `compatibleSystem`
  no longer hard-requires `/sys/class/thermal` and `/sys/class/power_supply`.
- **New sensors disabled by default** — `mqtt_microphone` and `mqtt_illuminance_level`
  were added to TouchTheo's default `app_disable` list, so they are opt-in (remove
  them from `app_disable` in `Arguments.json` to enable) in keeping with TouchTheo's
  lean-by-default sensor policy.

### Notes
- **Microphone _HTTP_ exposure (also part of upstream #195) was intentionally not
  ported.** Upstream bundled it with index.js refactors (removal of the `$DISPLAY`
  guard and the electron-log file handling) that conflict with TouchTheo's
  persistent-logging and SSH-guard divergences. The MQTT sensor — the Home Assistant
  integration path — is included.
- **Not build-tested in this environment** (no Pi 5 / yarn available). The ported
  code was verified by diffing every changed function against upstream v1.5.0 (only
  TouchTheo's known divergences differ) and by confirming the merge preserved all
  RPi5 optimisations. Validate with `yarn && yarn make` on a Pi 5 before tagging.
- `yarn.lock` was not regenerated (no yarn in this environment); the release
  workflow's `yarn install` resolves it. Regenerate locally for a reproducible lock.

## [1.5.18] — 2026-05-09

### Changed
- **Skip the screenshot capture entirely when `mqtt_screenshot` is disabled (upstream alignment, TouchKio #201)** — TouchTheo's default `app_disable` list includes `mqtt_screenshot`, but the periodic 60-second `captureView()` call was still running and discarding the result. The capture is now gated on the same `app_disable` check, so disabling the sensor actually saves the per-minute full-page render.
- **`app_reset` is now an array, not a string (upstream alignment, TouchKio #201)** — matches the upstream API contract, allowing multiple resets in one invocation (e.g. `"app_reset": ["storage", "arguments"]`). Existing string-style values continue to work — they're parsed as comma-separated and converted to an array on startup. Callers should now use `.includes(...)` and `.length` checks; the auto-trigger that resets arguments after an `Arguments.json` change uses `.push("arguments")` accordingly.

## [1.5.17] — 2026-04-17

### Added
- **`app_disable` — selectively disable MQTT sensors** — add an `"app_disable"` array to `Arguments.json` listing any sensors you don't want published to Home Assistant. On startup, disabled sensors are removed from HA's MQTT discovery so they disappear cleanly; periodic updates for those sensors are skipped entirely.

  Default (applied automatically when `app_disable` is absent from your config):
  ```json
  "app_disable": ["mqtt_screenshot", "mqtt_errors", "mqtt_app"]
  ```
  To enable all sensors: `"app_disable": []`. Full list of disableable sensor names:
  `mqtt_app`, `mqtt_shutdown`, `mqtt_reboot`, `mqtt_refresh`, `mqtt_kiosk`, `mqtt_theme`,
  `mqtt_display`, `mqtt_volume`, `mqtt_keyboard`, `mqtt_page_number`, `mqtt_page_zoom`,
  `mqtt_page_url`, `mqtt_model`, `mqtt_serial_number`, `mqtt_network_address`, `mqtt_host_name`,
  `mqtt_up_time`, `mqtt_memory_size`, `mqtt_memory_usage`, `mqtt_processor_usage`,
  `mqtt_processor_temperature`, `mqtt_battery_level`, `mqtt_package_upgrades`, `mqtt_last_active`,
  `mqtt_screenshot`, `mqtt_heartbeat`, `mqtt_errors`, `mqtt_version`

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
