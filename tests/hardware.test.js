"use strict";

// Logic-only unit tests for js/hardware.js.
//
// hardware.js requires only Node built-ins (os, fs, path, child_process), so it
// can be required and exercised in plain Node with no install and no Raspberry Pi
// hardware — we mock the fs/os boundary and assert the pure decision logic.
//
// These deliberately target the functions where TouchTheo DIVERGES from upstream
// TouchKio (rp1_thermal priority, 1-minute load average, the `iface` network walk)
// plus the merged upstream thermal-priority fix (#192). That way they also act as a
// guard: if a future "TouchKio X.Y catchup" merge clobbers a RPi5 divergence, a test
// here fails before it ships.

const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const cpr = require("child_process");

const hardware = require("../js/hardware");

// Silence the console.error that readFile() emits on a (mocked) read miss.
mock.method(console, "error", () => {});

/**
 * Mocks /sys/class/thermal with the given zones.
 * @param {object} t - the node:test context (auto-restores its mocks).
 * @param {object} zones - e.g. { thermal_zone0: { type: "acpitz", temp: "45000" } }
 *                         iteration order of this object is the directory order.
 */
function mockThermal(t, zones) {
  const root = "/sys/class/thermal";
  const lookup = (p) => {
    const parts = p.split("/");
    const file = parts.pop();
    const zone = parts.pop();
    return { file, zone };
  };
  t.mock.method(fs, "existsSync", (p) => {
    if (p === root) return true;
    const { file, zone } = lookup(p);
    return !!(zones[zone] && zones[zone][file] !== undefined);
  });
  t.mock.method(fs, "readdirSync", (p) => (p === root ? Object.keys(zones) : []));
  t.mock.method(fs, "readFileSync", (p) => {
    const { file, zone } = lookup(p);
    if (zones[zone] && zones[zone][file] !== undefined) return `${zones[zone][file]}\n`;
    throw new Error(`ENOENT: ${p}`);
  });
}

test("getProcessorTemperature: picks rp1_thermal on a Pi 5 (TouchTheo divergence)", (t) => {
  // RPi5 exposes rp1_thermal; upstream's list would miss it and return null.
  mockThermal(t, { thermal_zone0: { type: "rp1_thermal", temp: "52340" } });
  assert.equal(hardware.getProcessorTemperature(), 52.34);
});

test("getProcessorTemperature: prefers cpu-thermal over directory order (upstream #192)", (t) => {
  // acpitz appears first in directory order but cpu-thermal must win by priority.
  mockThermal(t, {
    thermal_zone0: { type: "acpitz", temp: "60000" },
    thermal_zone1: { type: "cpu-thermal", temp: "47000" },
  });
  assert.equal(hardware.getProcessorTemperature(), 47);
});

test("getProcessorTemperature: rp1_thermal outranks acpitz (acpitz deprioritised last)", (t) => {
  mockThermal(t, {
    thermal_zone0: { type: "acpitz", temp: "61000" },
    thermal_zone1: { type: "rp1_thermal", temp: "49500" },
  });
  assert.equal(hardware.getProcessorTemperature(), 49.5);
});

test("getProcessorTemperature: ignores out-of-range readings and unknown zones", (t) => {
  mockThermal(t, {
    thermal_zone0: { type: "cpu-thermal", temp: "999000" }, // 999C — bogus, skipped
    thermal_zone1: { type: "iwlwifi", temp: "40000" }, // unknown type, skipped
    thermal_zone2: { type: "acpitz", temp: "44000" }, // valid fallback
  });
  assert.equal(hardware.getProcessorTemperature(), 44);
});

test("getProcessorTemperature: returns null when /sys/class/thermal is absent", (t) => {
  t.mock.method(fs, "existsSync", (p) => p !== "/sys/class/thermal");
  assert.equal(hardware.getProcessorTemperature(), null);
});

test("getProcessorUsage: uses the 1-minute load average (TouchTheo divergence)", (t) => {
  // loadavg = [1min, 5min, 15min]; TouchTheo intentionally uses [0] for responsiveness.
  t.mock.method(os, "loadavg", () => [2.0, 8.0, 16.0]);
  t.mock.method(os, "cpus", () => new Array(4).fill({}));
  assert.equal(hardware.getProcessorUsage(), 50); // (2.0 / 4) * 100, NOT the 5-min 8.0
});

test("getNetworkAddresses: groups external addresses by interface + family, skips internal", (t) => {
  t.mock.method(os, "networkInterfaces", () => ({
    lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    eth0: [
      { family: "IPv4", address: "192.168.1.42", internal: false },
      { family: "IPv6", address: "fe80::1", internal: false },
    ],
  }));
  assert.deepEqual(hardware.getNetworkAddresses(), {
    Eth0: { IPv4: ["192.168.1.42"], IPv6: ["fe80::1"] },
  });
});

// setDisplayBrightness — guard the touchkio#190 divergence: brightness 0 must be a
// valid value (fully off) so a future upstream catchup can't silently re-clamp to 1.
// We stub the cpr.spawn boundary so nothing actually runs, and assert on what was
// passed through. (ddcutil path keeps it side-effect free: its fs.writeFileSync only
// runs from the proc "close" callback, which our stub never emits.)
const withBrightnessHardware = (t, command, max = 100, sudo = true) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  global.HARDWARE = {
    support: { displayBrightness: true, access: { sudo } },
    display: { brightness: { command, path: "/sys/class/backlight/x", value: { max } } },
  };
  const spawned = [];
  t.mock.method(cpr, "spawn", (cmd, args) => {
    spawned.push([cmd, ...args]);
    return { stdout: { on() {} }, stderr: { on() {} }, on() {}, stdin: { on() {}, write() {}, end() {} } };
  });
  return spawned;
};

test("setDisplayBrightness: accepts 0 to switch the display fully off (touchkio#190)", (t) => {
  const spawned = withBrightnessHardware(t, "ddcutil");
  let rejected = false;
  hardware.setDisplayBrightness(0, (_reply, error) => {
    if (error === "Invalid brightness") rejected = true;
  });
  assert.equal(rejected, false, "0 must not be rejected as invalid");
  assert.ok(
    spawned.some((args) => args.join(" ") === "sudo ddcutil setvcp 0x10 0"),
    "ddcutil should be told to set brightness 0",
  );
});

test("setDisplayBrightness: tee path writes 0 (not clamped to 1) for brightness 0 (touchkio#190)", (t) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  global.HARDWARE = {
    support: { displayBrightness: true, access: { sudo: true } },
    display: { brightness: { command: "tee", path: "/sys/class/backlight/x", value: { max: 255 } } },
  };
  let written = null;
  t.mock.method(cpr, "spawn", () => ({
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    stdin: {
      on() {},
      write(v) {
        written = v;
      },
      end() {},
    },
  }));
  hardware.setDisplayBrightness(0);
  assert.equal(written, "0", "sysfs backlight should receive 0, not a clamped 1");
});

test("setDisplayBrightness: still rejects out-of-range values (-1 and 101)", (t) => {
  withBrightnessHardware(t, "ddcutil");
  for (const bad of [-1, 101]) {
    let error = null;
    hardware.setDisplayBrightness(bad, (_reply, err) => {
      error = err;
    });
    assert.equal(error, "Invalid brightness", `${bad} should be rejected`);
  }
});

// --- TouchKio 1.5.1/1.5.2 catchup -----------------------------------------
// The upstream fixes ported in 1.6.3. These pin the behaviour so a later
// catchup cannot quietly re-clamp brightness to 1 (touchkio#190 divergence)
// or drop the standby/no-sudo handling again.

/**
 * Stubs cpr.execSync so execSyncCommand() returns a canned string.
 * @param {object} t - the node:test context.
 * @param {string} output - what the command should print.
 */
const withSyncOutput = (t, output) => {
  const calls = [];
  t.mock.method(cpr, "execSync", (cmd) => {
    calls.push(cmd);
    return output;
  });
  return calls;
};

test("getDisplayStatus: ddcutil standby power states report OFF (touchkio#232)", (t) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  // x02..x05 are the DPMS standby/suspend/off states; before the fix the regex
  // only matched x01/x04, so a display in standby returned null and the MQTT
  // light entity went unavailable instead of showing OFF.
  for (const [vcp, expected] of [
    ["x01", "ON"],
    ["x02", "OFF"],
    ["x04", "OFF"],
    ["x05", "OFF"],
  ]) {
    global.HARDWARE = {
      support: { displayStatus: true },
      display: { status: { command: "ddcutil" } },
    };
    withSyncOutput(t, `VCP D6 SNC ${vcp}\n`);
    assert.equal(hardware.getDisplayStatus(), expected, `${vcp} should read as ${expected}`);
    t.mock.restoreAll();
  }
});

test("getDisplayBrightness: ddcutil value is scaled against the display max (touchkio 1.5.1)", (t) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  // A display reporting 0..255 used to be published to Home Assistant verbatim,
  // so "50%" showed up as 127%. It must be normalised to a percentage.
  global.HARDWARE = {
    support: { displayBrightness: true },
    display: { brightness: { command: "ddcutil", path: "/x", value: { max: 255 } } },
  };
  withSyncOutput(t, "VCP 10 C 128 255\n");
  assert.equal(hardware.getDisplayBrightness(), 50);
});

test("getDisplayBrightness: ddcutil 0 stays 0, not clamped to 1 (touchkio#190)", (t) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  global.HARDWARE = {
    support: { displayBrightness: true },
    display: { brightness: { command: "ddcutil", path: "/x", value: { max: 255 } } },
  };
  withSyncOutput(t, "VCP 10 C 0 255\n");
  assert.equal(hardware.getDisplayBrightness(), 0);
});

test("setDisplayBrightness: ddcutil percent is mapped onto the display scale (touchkio 1.5.1)", (t) => {
  const spawned = withBrightnessHardware(t, "ddcutil", 255);
  hardware.setDisplayBrightness(50);
  assert.ok(
    spawned.some((args) => args.join(" ") === "sudo ddcutil setvcp 0x10 128"),
    `50% of a 0-255 display is 128, got ${JSON.stringify(spawned)}`,
  );
});

test("setDisplayBrightness: tee runs without sudo when the backlight is writable (touchkio#233)", (t) => {
  const spawned = withBrightnessHardware(t, "tee", 100, false);
  hardware.setDisplayBrightness(40);
  assert.deepEqual(spawned, [["tee", "/sys/class/backlight/x/brightness"]]);
});

test("setDisplayBrightness: tee still uses sudo when only sudo grants write access", (t) => {
  const spawned = withBrightnessHardware(t, "tee", 100, true);
  hardware.setDisplayBrightness(40);
  assert.deepEqual(spawned, [["sudo", "tee", "/sys/class/backlight/x/brightness"]]);
});

// sessionType — touchkio#239. Raspberry Pi OS with console autologin starts
// labwc from a tty session, so both XDG_SESSION_TYPE and `loginctl ... -p Type`
// report "tty". The display command mapping only has wayland/x11 entries, so
// display power and brightness came out unsupported on a very common Pi setup.

/**
 * Runs sessionType() with a controlled environment.
 * @param {object} t - the node:test context.
 * @param {object} env - environment variables to set (undefined deletes).
 * @param {string|null} loginctl - what `loginctl ... -p Type --value` returns.
 */
const withSession = (t, env, loginctl) => {
  const keys = ["XDG_SESSION_TYPE", "WAYLAND_DISPLAY", "DISPLAY"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  t.mock.method(cpr, "execSync", (cmd) => {
    if (cmd.startsWith("which ")) return "/usr/bin/loginctl\n";
    return loginctl === null ? "" : `${loginctl}\n`;
  });
};

test("sessionType: XDG_SESSION_TYPE wins when it is a real display session", (t) => {
  withSession(t, { XDG_SESSION_TYPE: "wayland", DISPLAY: ":0" }, "tty");
  assert.equal(hardware.sessionType(), "wayland");
});

test("sessionType: loginctl wins over the socket fallback", (t) => {
  withSession(t, { XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-0" }, "x11");
  assert.equal(hardware.sessionType(), "x11");
});

test("sessionType: tty autologin falls back to WAYLAND_DISPLAY (touchkio#239)", (t) => {
  withSession(t, { XDG_SESSION_TYPE: "tty", WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, "tty");
  assert.equal(hardware.sessionType(), "wayland", "labwc on a tty session must not report tty");
});

test("sessionType: tty autologin under X11 falls back to DISPLAY (touchkio#239)", (t) => {
  withSession(t, { XDG_SESSION_TYPE: "tty", DISPLAY: ":0" }, "tty");
  assert.equal(hardware.sessionType(), "x11");
});

test("sessionType: no display server at all still reports what loginctl said", (t) => {
  withSession(t, { XDG_SESSION_TYPE: "tty" }, "tty");
  assert.equal(hardware.sessionType(), "tty");
});

// NaN slips past a `typeof x !== "number"` guard (typeof NaN === "number", and
// NaN < 0 / NaN > 100 are both false), so a non-numeric MQTT payload run through
// parseInt() would reach the hardware write. The guards use Number.isFinite().
test("setDisplayBrightness: rejects NaN (non-numeric MQTT payload)", (t) => {
  withBrightnessHardware(t, "ddcutil");
  let error = null;
  hardware.setDisplayBrightness(parseInt("not-a-number", 10), (_reply, err) => {
    error = err;
  });
  assert.equal(error, "Invalid brightness", "NaN should be rejected");
});

test("setAudioVolume / setMicrophoneVolume: reject NaN", (t) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  global.HARDWARE = {
    support: { audioVolume: true, microphoneVolume: true },
    audio: { device: { output: "sink", input: "source" } },
  };
  for (const fn of ["setAudioVolume", "setMicrophoneVolume"]) {
    let error = null;
    hardware[fn](parseInt("x", 10), (_reply, err) => {
      error = err;
    });
    assert.equal(error, "Invalid volume", `${fn} should reject NaN`);
  }
});

// ---------------------------------------------------------------------------
// TouchKio 1.6.0 catchup guards (touchtheo 1.7.0)
// ---------------------------------------------------------------------------

const withIioDevice = (t, name) => {
  const root = "/sys/bus/iio/devices";
  const device = `${root}/iio:device0`;
  t.mock.method(fs, "existsSync", (p) => p === root || p === `${device}/name` || p === `${device}/in_illuminance_raw`);
  t.mock.method(fs, "readdirSync", (p) => (p === root ? ["iio:device0"] : []));
  t.mock.method(fs, "readFileSync", (p) => {
    if (p === `${device}/name`) return `${name}\n`;
    throw new Error(`ENOENT: ${p}`);
  });
  return device;
};

test("getIlluminanceLevelPath: accepts the acpi-als driver name (upstream PR #262)", (t) => {
  const device = withIioDevice(t, "acpi-als");
  assert.equal(hardware.getIlluminanceLevelPath(), device);
});

test("getIlluminanceLevelPath: still accepts als and ignores other iio devices", (t) => {
  const device = withIioDevice(t, "als");
  assert.equal(hardware.getIlluminanceLevelPath(), device);
  t.mock.restoreAll();
  withIioDevice(t, "bmp280");
  assert.equal(hardware.getIlluminanceLevelPath(), null);
});

test("getDisplayStatusCommand: wlopm is a wayland fallback on any desktop (touchkio#233)", (t) => {
  const prev = global.HARDWARE;
  t.after(() => {
    global.HARDWARE = prev;
  });
  // Before the fix wlopm/kscreen-doctor were only tried on labwc/wayfire/kde/
  // plasma/"unknown"; a desktop such as "gnome" without ddcutil ended with no
  // display command at all and the Display entity went missing from MQTT.
  global.HARDWARE = {
    support: {},
    session: { type: "wayland", desktop: "gnome" },
    display: { status: { path: null, command: null, value: {} } },
  };
  t.mock.method(cpr, "execSync", (cmd) => {
    if (cmd.startsWith("which ")) {
      if (cmd.endsWith(" wlopm")) return "/usr/bin/wlopm\n";
      throw new Error(`not found: ${cmd}`);
    }
    if (cmd.startsWith("wlopm")) return "DSI-1 on\n";
    throw new Error(`unexpected: ${cmd}`);
  });
  assert.equal(hardware.getDisplayStatusCommand(), "wlopm");
});
