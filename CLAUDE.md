# TouchTheo — Claude Code directives

## What this project is

TouchTheo is a Node.js/Electron kiosk application for Home Assistant dashboards, optimised for Raspberry Pi 5 with a DSI or HDMI touch display. It is a fork of [TouchKio](https://github.com/leukipp/touchkio) by [@leukipp](https://github.com/leukipp), published under `theojamesvibes/touchtheo`.

**Stack:** Node.js + Electron, packaged as `.deb` (arm64 and x64), distributed via GitHub Releases  
**Config:** `~/.config/touchtheo/Arguments.json` — stores WEB URL, MQTT settings, encrypted MQTT password  
**Service:** systemd user service (`~/.config/systemd/user/touchtheo.service`)  
**Encryption:** MQTT password is AES-256-CBC encrypted using `scryptSync(machineId, "touchtheo", 32)` — the app name is part of the key derivation

---

## Key changes from TouchKio

- `rp1_thermal` thermal zone recognised in `getProcessorTemperature` (primary zone on RPi5; upstream only handled `cpu-thermal`, `x86_pkg_temp`, etc.)
- `XDG_SESSION_TYPE` env var checked before `loginctl` in `sessionType` — on RPi OS Bookworm the env var is always set correctly at login; `loginctl` can be unresponsive if queried too early during startup
- `start:rpi5` npm script with `--enable-features=VaapiVideoDecodeLinuxGL --disable-gpu-compositing` for hardware-accelerated video decode on RPi5

---

## Workflow — after any code change

1. **Bump the version** in both `package.json` and `VERSION` (they must always match).
2. **Add a `CHANGELOG.md` entry** at the top — version, date, what changed and why.
3. **Update `README.md`** if features, configuration options, or installation steps changed.
4. **Commit** all changed files together (`package.json`, `VERSION`, `CHANGELOG.md`, and the code).
5. **Push to `main`** and verify the GitHub Actions release workflow is queued.

`VERSION` is a plain text file containing only the version number (e.g. `1.5.1`). It is the single human-readable source of truth and must stay in sync with `package.json`.

---

## Migration scripts

Two bash scripts handle migration from an existing TouchKio installation:

### `migrate_from_touchkio.sh`
One-shot migration. What it does:
1. Validates TouchKio is installed; detects architecture (x64 / arm64)
2. Stops `touchkio.service`
3. Downloads and installs the latest TouchTheo `.deb` from GitHub Releases
4. Migrates `~/.config/touchkio/Arguments.json` → `~/.config/touchtheo/`:
   - All WEB and MQTT settings preserved
   - MQTT password is **decrypted with the TouchKio key and re-encrypted with the TouchTheo key** (app name is part of AES-256-CBC key derivation — a direct file copy would fail to decrypt)
5. Carries over custom `ExecStart` flags from `touchkio.service` (e.g. `--disable-features=...`, `--disable-gpu`)
6. Copies DDC brightness cache (`Cache/Brightness.vcp`) if present
7. Writes, enables (`systemctl --user enable touchtheo.service`), and starts `touchtheo.service`

Supports `--dry-run` to preview without making changes.

### `cleanup_touchkio.sh`
Run **after** confirming TouchTheo works. What it does:
- Stops and disables `touchkio.service`
- Removes the `touchkio.service` unit file
- `sudo apt remove/purge touchkio`
- Removes `~/.config/touchkio/`

Supports `--dry-run` and `--force`.

**Design intent:** Keep TouchKio installed until TouchTheo is verified, then clean up separately. Autostart is correct: `migrate_from_touchkio.sh` enables `touchtheo.service`; `cleanup_touchkio.sh` disables `touchkio.service`.

---

## Project layout (key files)

```
install.sh                  # Fresh install — downloads .deb, creates systemd service, runs --setup
migrate_from_touchkio.sh    # One-shot migration from TouchKio
cleanup_touchkio.sh         # Remove TouchKio after migration is confirmed
index.js                    # Electron main process entry point
js/                         # Application JS modules
html/                       # UI templates
forge.config.js             # Electron Forge build config (produces .deb and .zip)
VERSION                     # Single source of truth for version number (must match package.json)
CHANGELOG.md
README.md
HARDWARE.md                 # Compatible hardware list
```

---

## Things to avoid

- Do **not** use `loginctl` as the sole source of `XDG_SESSION_TYPE` — check the env var first.
- Do **not** copy `Arguments.json` directly from TouchKio config — MQTT password must be re-encrypted with the TouchTheo key.
- Do **not** bump `package.json` version without also updating `VERSION`, or vice versa.
- Do **not** add features, refactor, or clean up code beyond what was asked.