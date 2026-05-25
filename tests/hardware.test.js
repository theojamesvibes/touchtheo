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
