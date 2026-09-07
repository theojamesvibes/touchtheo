const os = require("os");
const fs = require("fs");
const path = require("path");
const fsp = require("fs/promises");
const cpr = require("child_process");

// Memoization cache for static hardware values and one-time checks
const _cache = {};

global.HARDWARE = global.HARDWARE || {
  initialized: false,
  support: {},
  session: {},
  battery: {
    level: {
      path: null,
    },
  },
  illuminance: {
    level: {
      path: null,
    },
  },
  display: {
    status: {
      path: null,
      command: null,
      value: {},
    },
    brightness: {
      path: null,
      command: null,
      value: {},
    },
  },
  keyboard: {
    visible: null,
  },
  audio: {
    device: {
      output: null,
      input: null,
    },
  },
};

/**
 * Initializes the hardware with the provided arguments.
 *
 * @returns {bool} Returns true if the initialization was successful.
 */
const init = async () => {
  if (!compatibleSystem()) {
    console.error("Operating system is not supported");
    return false;
  }

  // Init globals
  HARDWARE.session.user = sessionUser();
  HARDWARE.session.type = sessionType();
  HARDWARE.session.desktop = sessionDesktop();
  HARDWARE.battery.level.path = getBatteryLevelPath();
  HARDWARE.illuminance.level.path = getIlluminanceLevelPath();
  HARDWARE.display.status.path = getDisplayStatusPath();
  HARDWARE.display.status.command = getDisplayStatusCommand();
  HARDWARE.display.brightness.path = getDisplayBrightnessPath();
  HARDWARE.display.brightness.command = getDisplayBrightnessCommand();
  HARDWARE.display.brightness.value.max = getDisplayBrightnessMax();
  HARDWARE.audio.device.output = getAudioOutput();
  HARDWARE.audio.device.input = getAudioInput();
  HARDWARE.support = checkSupport();
  HARDWARE.initialized = true;

  // Show supported features
  process.stdout.write("\n");
  console.info(`Supported: ${JSON.stringify(HARDWARE.support, null, 2)}`);

  // Show session infos
  process.stdout.write("\n");
  console.info("User:", HARDWARE.session.user);
  console.info("Session:", HARDWARE.session.type);
  console.info("Desktop:", HARDWARE.session.desktop);

  // Show device infos
  process.stdout.write("\n");
  console.info("Model:", getModel());
  console.info("Vendor:", getVendor());
  console.info("Serial Number:", getSerialNumber());
  console.info("Network Addresses:", getNetworkAddresses());
  console.info("Host Name:", getHostName());

  // Show system infos
  process.stdout.write("\n");
  console.info("Up Time:", getUpTime());
  console.info("Memory Size:", getMemorySize());
  console.info("Memory Usage:", getMemoryUsage());
  console.info("Processor Usage:", getProcessorUsage());
  console.info("Processor Temperature:", getProcessorTemperature());

  // Show hardware infos
  process.stdout.write("\n");
  const unsupported = "unsupported";
  const sudo = (cmd) => (["ddcutil", "tee"].includes(cmd) && HARDWARE.support.access?.sudo ? `sudo ${cmd}` : cmd);
  const batteryLevel = `${getBatteryLevel()} (sysfs)`;
  const batteryLevelInfo = HARDWARE.support.batteryLevel ? batteryLevel : unsupported;
  console.info(
    `Battery Level [${HARDWARE.support.batteryLevel ? HARDWARE.battery.level.path : unsupported}]:`,
    batteryLevelInfo,
  );
  const illuminanceLevel = `${getIlluminanceLevel()} (sysfs)`;
  const illuminanceLevelInfo = HARDWARE.support.illuminanceLevel ? illuminanceLevel : unsupported;
  console.info(
    `Illuminance Level [${HARDWARE.support.illuminanceLevel ? HARDWARE.illuminance.level.path : unsupported}]:`,
    illuminanceLevelInfo,
  );
  const displayStatus = `${getDisplayStatus()} (${sudo(HARDWARE.display.status.command)})`;
  const displayStatusInfo = HARDWARE.support.displayStatus ? displayStatus : unsupported;
  console.info(
    `Display Status [${HARDWARE.support.displayStatus ? HARDWARE.display.status.path : unsupported}]:`,
    displayStatusInfo,
  );
  const displayBrightness = `${getDisplayBrightness()} (${sudo(HARDWARE.display.brightness.command)})`;
  const displayBrightnessInfo = HARDWARE.support.displayBrightness ? displayBrightness : unsupported;
  console.info(
    `Display Brightness [${HARDWARE.support.displayBrightness ? HARDWARE.display.brightness.path : unsupported}]:`,
    displayBrightnessInfo,
  );
  const audioVolume = `${getAudioVolume()} (pactl)`;
  const audioVolumeInfo = HARDWARE.support.audioVolume ? audioVolume : unsupported;
  console.info(
    `Audio Volume [${HARDWARE.support.audioVolume ? HARDWARE.audio.device.output : unsupported}]:`,
    audioVolumeInfo,
  );
  const microphoneVolume = `${getMicrophoneVolume()} (pactl)`;
  const microphoneVolumeInfo = HARDWARE.support.microphoneVolume ? microphoneVolume : unsupported;
  console.info(
    `Microphone Volume [${HARDWARE.support.microphoneVolume ? HARDWARE.audio.device.input : unsupported}]:`,
    microphoneVolumeInfo,
  );
  const keyboardVisibility = `${getKeyboardVisibility()} (squeekboard)`;
  const keyboardVisibilityInfo = HARDWARE.support.keyboardVisibility ? keyboardVisibility : unsupported;
  console.info(
    `Keyboard Visibility [${HARDWARE.support.keyboardVisibility ? "dbus://sm/puri/OSK0" : unsupported}]:`,
    keyboardVisibilityInfo,
  );
  process.stdout.write("\n");

  // Monitor audio output and input volume
  if (HARDWARE.support.audioVolume || HARDWARE.support.microphoneVolume) {
    commandMonitor("pactl", ["subscribe"], (reply, error) => {
      if (!reply || error) {
        return;
      }
      if (HARDWARE.support.audioVolume && reply.includes("'change' on sink")) {
        console.info("Update Audio Volume:", getAudioVolume());
        EVENTS.emit("updateVolume");
      }
      if (HARDWARE.support.microphoneVolume && reply.includes("'change' on source")) {
        console.info("Update Microphone Volume:", getMicrophoneVolume());
        EVENTS.emit("updateMicrophone");
      }
    });
  }

  // Monitor keyboard visibility
  if (HARDWARE.support.keyboardVisibility) {
    setKeyboardVisibility("OFF", (reply, error) => {
      if (!reply || error) {
        return;
      }
      dbusMonitor("/sm/puri/OSK0", (property, error) => {
        if (!property || error) {
          return;
        }
        HARDWARE.keyboard.visibility = property.Visible === "true";
        console.info("Update Keyboard Visibility:", getKeyboardVisibility());
        EVENTS.emit("updateKeyboard");
      });
    });
  }

  // Monitor display changes (1s)
  setDisplayStatus("ON", () => {
    interval(update, 1 * 1000);
  });

  return true;
};

/**
 * Updates the shared hardware properties.
 */
const update = async () => {
  if (!HARDWARE.initialized || APP.exiting) {
    return;
  }

  // Check if display status has changed
  if (HARDWARE.support.displayStatus) {
    let displayStatusChanged = false;

    // Use sysfs dpms path if available
    if (HARDWARE.display.status.path) {
      const power = await readFile(path.join(HARDWARE.display.status.path, "dpms"), false);
      const powerChanged = !!power && power !== HARDWARE.display.status.value.power;

      // Update internal status values
      HARDWARE.display.status.value.power = power;
      displayStatusChanged |= powerChanged;
    }

    // Use sysfs status path if available
    if (HARDWARE.display.status.path) {
      const connection = await readFile(path.join(HARDWARE.display.status.path, "status"), false);
      const connectionChanged = !!connection && connection !== HARDWARE.display.status.value.connection;

      // Update internal status values
      HARDWARE.display.status.value.connection = connection;
      displayStatusChanged |= connectionChanged;
    }

    // Emit display event if changed
    if (displayStatusChanged) {
      EVENTS.emit("updateDisplay");
      console.info("Update Display Status:", getDisplayStatus());
    }
  }

  // Check if display brightness has changed
  if (HARDWARE.support.displayBrightness) {
    let displayBrightnessChanged = false;

    // Use sysfs brightness path if available
    if (HARDWARE.display.brightness.path) {
      const brightness = await readFile(path.join(HARDWARE.display.brightness.path, "brightness"), false);
      const brightnessChanged = !!brightness && brightness !== HARDWARE.display.brightness.value.brightness;

      // Update internal brightness values
      HARDWARE.display.brightness.value.brightness = brightness;
      displayBrightnessChanged |= brightnessChanged;
    }

    // Emit display event if changed
    if (displayBrightnessChanged) {
      EVENTS.emit("updateDisplay");
      console.info("Update Display Brightness:", getDisplayBrightness());
    }
  }
};

/**
 * Verifies system compatibility by checking the presence of necessary sys paths.
 *
 * @returns {bool} Returns true if all paths exists.
 */
const compatibleSystem = () => {
  if (os.platform() !== "linux") {
    return false;
  }
  const paths = ["/sys/class/drm", "/sys/class/backlight"];
  return paths.every((path) => fs.existsSync(path));
};

/**
 * Gets the session user name using `os.userInfo()`.
 *
 * @returns {string|null} Returns session user name or null if an error occurs.
 */
const sessionUser = () => {
  try {
    return os.userInfo().username;
  } catch {}
  return null;
};

/**
 * Gets the session type for the user, preferring the XDG_SESSION_TYPE environment
 * variable (reliable on Raspberry Pi OS Bookworm / Wayland) with a loginctl fallback.
 *
 * @returns {string|null} Returns session type 'x11'/'wayland' or null if an error occurs.
 */
const sessionType = () => {
  const envType = (process.env.XDG_SESSION_TYPE || "").toLowerCase();
  if (envType === "wayland" || envType === "x11") {
    return envType;
  }
  let type = null;
  if (commandExists("loginctl")) {
    type =
      (
        execSyncCommand("loginctl", [
          "show-session",
          "$(loginctl show-user $(whoami) -p Display --value)",
          "-p Type --value",
        ]) || ""
      )
        .trim()
        .toLowerCase() || null;
  }
  if (type === "wayland" || type === "x11") {
    return type;
  }
  // A console-autologin session reports Type=tty even when labwc/Wayland is
  // running on top of it, and the display command mapping has no "tty" entry —
  // so displayStatus and displayBrightness came out permanently unsupported
  // (touchkio#239, still open upstream). The compositor socket variables are set
  // for the process that actually talks to the display server, so fall back to
  // those. index.js already refuses to start without one of them.
  if (process.env.WAYLAND_DISPLAY) {
    return "wayland";
  }
  if (process.env.DISPLAY) {
    return "x11";
  }
  return type;
};

/**
 * Gets the desktop environment name by checking environment variables.
 *
 * @returns {string} Returns desktop environment name or 'unknown' if not detected.
 */
const sessionDesktop = () => {
  const envs = ["XDG_CURRENT_DESKTOP", "XDG_DESKTOP_SESSION", "DESKTOP_SESSION"];
  const names = envs.map((env) => process.env[env]).filter(Boolean);
  return (names.join(":") || "unknown").toLowerCase();
};

/**
 * Checks supported features based on hardware and software.
 *
 * @returns {Object} Returns support object with boolean values.
 */
const checkSupport = () => {
  const audioOutput = !!HARDWARE.audio.device.output;
  const audioInput = !!HARDWARE.audio.device.input;
  const batteryPath = !!HARDWARE.battery.level.path;
  const illuminancePath = !!HARDWARE.illuminance.level.path;
  const statusPath = !!HARDWARE.display.status.path;
  const statusCommand = !!HARDWARE.display.status.command;
  const brightnessPath = !!HARDWARE.display.brightness.path && !!HARDWARE.display.brightness.value.max;
  const brightnessCommand = !!HARDWARE.display.brightness.command && !!HARDWARE.display.brightness.value.max;
  const keyboardProcess = processRuns("squeekboard");

  return {
    batteryLevel: batteryPath,
    illuminanceLevel: illuminancePath,
    displayStatus: statusPath && statusCommand,
    displayBrightness: statusPath && statusCommand && brightnessPath && brightnessCommand,
    keyboardVisibility: keyboardProcess,
    audioVolume: audioOutput,
    microphoneVolume: audioInput,
    access: {
      sudo: sudoRights(),
      reboot: rebootRights(),
      shutdown: shutdownRights(),
      install: installRights(),
      service: serviceRuns(APP.name),
      deb: APP.build.maker === "deb",
    },
  };
};

/**
 * Gets the model name using `/sys/firmware/devicetree/base/model` or `/sys/class/dmi/id/product_name`.
 * Result is memoized — the model never changes at runtime.
 *
 * @returns {string} The model name of the device or 'Generic' if not found.
 */
const getModel = () => {
  if (_cache.model !== undefined) return _cache.model;
  const paths = ["/sys/firmware/devicetree/base/model", "/sys/class/dmi/id/product_name"];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      _cache.model = execSyncCommand("cat", [p]) || "Generic";
      return _cache.model;
    }
  }
  _cache.model = "Generic";
  return _cache.model;
};

/**
 * Gets the vendor name using `/sys/class/dmi/id/board_vendor`.
 * Result is memoized — the vendor never changes at runtime.
 *
 * @returns {string} The vendor name of the device or 'Generic' if not found.
 */
const getVendor = () => {
  if (_cache.vendor !== undefined) return _cache.vendor;
  const paths = ["/sys/class/dmi/id/board_vendor"];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      _cache.vendor = execSyncCommand("cat", [p]) || "Generic";
      return _cache.vendor;
    }
  }
  const model = getModel();
  _cache.vendor = model.includes("Raspberry Pi") ? "Raspberry Pi Ltd" : "Generic";
  return _cache.vendor;
};

/**
 * Gets the serial number using `/sys/firmware/devicetree/base/serial-number`.
 * Result is memoized — the serial number never changes at runtime.
 *
 * @returns {string} The serial number or machine id parts of the device or '123456' if not found.
 */
const getSerialNumber = () => {
  if (_cache.serialNumber !== undefined) return _cache.serialNumber;
  const paths = ["/sys/firmware/devicetree/base/serial-number"];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      _cache.serialNumber = execSyncCommand("cat", [p]) || "123456";
      return _cache.serialNumber;
    }
  }
  _cache.serialNumber = getMachineId().slice(-6);
  return _cache.serialNumber;
};

/**
 * Gets the machine id using `/etc/machine-id`.
 * Result is memoized — the machine id never changes at runtime.
 *
 * @returns {string} The machine id of the system or '123456' if not found.
 */
const getMachineId = () => {
  if (_cache.machineId !== undefined) return _cache.machineId;
  const paths = ["/etc/machine-id"];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      _cache.machineId = execSyncCommand("cat", [p]) || "123456";
      return _cache.machineId;
    }
  }
  _cache.machineId = "123456";
  return _cache.machineId;
};

/**
 * Gets the network interfaces addresses using `os.networkInterfaces()`.
 *
 * @returns {Object} The network addresses of all interfaces.
 */
const getNetworkAddresses = () => {
  const addresses = {};
  for (const [key, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.internal || !iface.family || !iface.address) {
        continue;
      }
      const name = key.charAt(0).toUpperCase() + key.slice(1);
      if (!addresses[name]) {
        addresses[name] = {};
      }
      const family = iface.family;
      if (!addresses[name][family]) {
        addresses[name][family] = [];
      }
      addresses[name][family].push(iface.address);
    }
  }
  return addresses;
};

/**
 * Gets the host name of the current system using `os.hostname()`.
 *
 * @returns {string} The host name of the system.
 */
const getHostName = () => {
  return os.hostname();
};

/**
 * Gets the up time of the system in minutes using `os.uptime()`.
 *
 * @returns {number} The up time of the system in minutes.
 */
const getUpTime = () => {
  return os.uptime() / 60;
};

/**
 * Gets the total available memory in gibibytes using `os.totalmem()`.
 *
 * @returns {number} The total available memory in GiB.
 */
const getMemorySize = () => {
  return os.totalmem() / 1024 ** 3;
};

/**
 * Gets the current memory usage as a percentage using `os.totalmem()` and `os.freemem()`.
 *
 * @returns {number} The percentage of used memory.
 */
const getMemoryUsage = () => {
  return ((os.totalmem() - os.freemem()) / os.totalmem()) * 100;
};

/**
 * Gets the CPU load average over the last 1 minute as a percentage using `os.loadavg()` and `os.cpus()`.
 * The 1-minute average is used for more responsive monitoring on kiosk displays.
 *
 * @returns {number} The CPU load average percentage over the last 1 minute.
 */
const getProcessorUsage = () => {
  return (os.loadavg()[0] / os.cpus().length) * 100;
};

/**
 * Gets the current CPU temperature using `/sys/class/thermal`.
 *
 * @returns {number|null} The CPU temperature in degrees celsius or null if nothing was found.
 */
const getProcessorTemperature = () => {
  const temperatures = {};
  const thermal = "/sys/class/thermal";
  if (!fs.existsSync(thermal)) {
    return null;
  }
  // Prioritised list of thermal zone types (upstream TouchKio #192): all matching
  // zones are read, then returned in this order rather than in arbitrary directory
  // order, so the most representative CPU zone wins. "acpitz" is deprioritised to
  // last because it is often the chipset/board sensor, not the CPU.
  // "rp1_thermal" is the RP1 I/O chip thermal zone present on Raspberry Pi 5; it
  // tracks the SoC temperature and is the primary zone on RPi5, so it sits right
  // after "cpu-thermal".
  const types = ["cpu-thermal", "rp1_thermal", "x86_pkg_temp", "k10temp", "TCPU", "cpu", "acpitz"];
  for (const zone of fs.readdirSync(thermal)) {
    const typeFile = path.join(thermal, zone, "type");
    const tempFile = path.join(thermal, zone, "temp");
    if (!fs.existsSync(typeFile) || !fs.existsSync(tempFile)) {
      continue;
    }
    const type = readFile(typeFile);
    if (!types.includes(type)) {
      continue;
    }
    const temp = readFile(tempFile);
    if (temp) {
      temperatures[type] = parseFloat(temp) / 1000;
    }
  }
  for (const type of types) {
    const temp = temperatures[type];
    if (Number.isFinite(temp) && temp >= 0 && temp <= 150) {
      return temp;
    }
  }
  return null;
};

/**
 * Gets the current battery power level path using `/sys/class/power_supply`.
 *
 * @returns {string|null} The battery power level path or null if nothing was found.
 */
const getBatteryLevelPath = () => {
  const power = "/sys/class/power_supply";
  if (!fs.existsSync(power)) {
    return null;
  }
  for (const supply of fs.readdirSync(power)) {
    const capacityFile = path.join(power, supply, "capacity");
    if (!fs.existsSync(capacityFile)) {
      continue;
    }
    return path.join(power, supply);
  }
  return null;
};

/**
 * Gets the current battery power level using `/sys/class/power_supply/.../capacity`.
 *
 * @returns {number|null} The battery power level in percentage or null if nothing was found.
 */
const getBatteryLevel = () => {
  if (!HARDWARE.support.batteryLevel) {
    return null;
  }
  const capacity = readFile(`${HARDWARE.battery.level.path}/capacity`);
  if (capacity) {
    return parseFloat(capacity);
  }
  return null;
};

/**
 * Gets the ambient light sensor level path using `/sys/bus/iio/devices`.
 *
 * @returns {string|null} The illuminance sensor level path or null if nothing was found.
 */
const getIlluminanceLevelPath = () => {
  const iio = "/sys/bus/iio/devices";
  if (!fs.existsSync(iio)) {
    return null;
  }
  for (const device of fs.readdirSync(iio)) {
    const nameFile = path.join(iio, device, "name");
    const illuminanceFile = path.join(iio, device, "in_illuminance_raw");
    if (!fs.existsSync(nameFile) || !fs.existsSync(illuminanceFile)) {
      continue;
    }
    const name = readFile(nameFile);
    if (name === "als") {
      return path.join(iio, device);
    }
  }
  return null;
};

/**
 * Gets the current ambient light level in lux using `/sys/bus/iio/devices/.../in_illuminance_raw`.
 *
 * @returns {number|null} The illuminance level in lux or null if nothing was found.
 */
const getIlluminanceLevel = () => {
  if (!HARDWARE.support.illuminanceLevel) {
    return null;
  }
  const illuminance = readFile(`${HARDWARE.illuminance.level.path}/in_illuminance_raw`);
  if (illuminance) {
    return parseFloat(illuminance);
  }
  return null;
};

/**
 * Gets the current display status path using `/sys/class/drm`.
 *
 * @returns {string|null} The display status path or null if nothing was found.
 */
const getDisplayStatusPath = () => {
  const drm = "/sys/class/drm";
  if (!fs.existsSync(drm)) {
    return null;
  }
  for (const card of fs.readdirSync(drm)) {
    const statusFile = path.join(drm, card, "status");
    if (!fs.existsSync(statusFile)) {
      continue;
    }
    const status = readFile(statusFile);
    if (status === "connected") {
      return path.join(drm, card);
    }
  }
  return null;
};

/**
 * Gets the available display status command checking for `ddcutil`, `wlopm`, `kscreen-doctor` and `xset`.
 *
 * @returns {string|null} The display status command or null if nothing was found.
 */
const getDisplayStatusCommand = () => {
  const type = HARDWARE.session.type;
  const desktop = HARDWARE.session.desktop;
  const mapping = {
    wayland: [
      { command: "ddcutil", desktops: ["*"] },
      { command: "wlopm", desktops: ["labwc", "wayfire", "unknown"] },
      { command: "kscreen-doctor", desktops: ["kde", "plasma", "unknown"] },
    ],
    x11: [
      { command: "ddcutil", desktops: ["*"] },
      { command: "xset", desktops: ["*"] },
    ],
  }[type];
  for (const map of mapping || []) {
    if (commandExists(map.command) && map.desktops.some((d) => d === "*" || desktop.includes(d))) {
      switch (map.command) {
        case "ddcutil":
          if (!sudoRights()) {
            break;
          }
          const ddcutil = execSyncCommand("sudo", ["ddcutil", "capabilities"]);
          if (ddcutil !== null && ddcutil.includes("Feature: D6")) {
            HARDWARE.display.status.path = path.join(APP.cache, "Display");
            fs.mkdirSync(HARDWARE.display.status.path, { recursive: true });
            fs.writeFileSync(path.join(HARDWARE.display.status.path, "dpms"), "");
            fs.writeFileSync(path.join(HARDWARE.display.status.path, "status"), "");
            return map.command;
          }
          break;
        case "wlopm":
          const wlopm = execSyncCommand("wlopm", []);
          if (wlopm !== null) {
            return map.command;
          }
          break;
        case "kscreen-doctor":
          const kdoc = execSyncCommand("kscreen-doctor", ["--dpms", "show"]);
          if (kdoc !== null) {
            return map.command;
          }
          break;
        case "xset":
          const xset = execSyncCommand("xset", ["-q"]);
          if (xset !== null) {
            return map.command;
          }
          break;
      }
    }
  }
  return null;
};

/**
 * Gets the current display power status using the available command.
 *
 * @returns {string|null} The display status as 'ON'/'OFF' or null if an error occurs.
 */
const getDisplayStatus = () => {
  if (!HARDWARE.support.displayStatus) {
    return null;
  }
  switch (HARDWARE.display.status.command) {
    case "ddcutil":
      const ddcutil = execSyncCommand("sudo", ["ddcutil", "getvcp", "0xD6", "--brief"]);
      const match = ddcutil !== null ? ddcutil.match(/VCP D6 \S+ x0?([1-5])/) : null;
      if (match) {
        const output = match[1] === "1";
        return output ? "ON" : "OFF";
      }
      break;
    case "wlopm":
      const wlopm = execSyncCommand("wlopm", []);
      if (wlopm !== null) {
        const output = wlopm.split("\n")[0].split(" ");
        return output.pop().toUpperCase();
      }
      break;
    case "kscreen-doctor":
      const kdoc = execSyncCommand("kscreen-doctor", ["--dpms", "show"]);
      if (kdoc !== null) {
        const output = kdoc.split("\n")[0].split(" ");
        return output.pop().toUpperCase();
      }
      break;
    case "xset":
      const xset = execSyncCommand("xset", ["-q"]);
      if (xset !== null) {
        const output = xset.includes("Monitor is On");
        return output ? "ON" : "OFF";
      }
      break;
  }
  return null;
};

/**
 * Sets the display power status using the available command.
 *
 * This function takes a desired status ('ON' or 'OFF') and executes
 * the appropriate command to set the display status.
 *
 * @param {string} status - The desired status ('ON' or 'OFF').
 * @param {Function} callback - A callback function that receives the output or error.
 */
const setDisplayStatus = (status, callback = null) => {
  if (!HARDWARE.support.displayStatus) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  if (!["ON", "OFF"].includes(status)) {
    console.error("Status must be 'ON' or 'OFF'");
    if (typeof callback === "function") callback(null, "Invalid status");
    return;
  }
  switch (HARDWARE.display.status.command) {
    case "ddcutil":
      execAsyncCommand("sudo", ["ddcutil", "setvcp", "0xD6", status === "ON" ? "1" : "4"], (reply, error) => {
        fs.writeFileSync(path.join(HARDWARE.display.status.path, "dpms"), status.toLowerCase());
        fs.writeFileSync(path.join(HARDWARE.display.status.path, "status"), status.toLowerCase());
        if (typeof callback === "function") callback(reply, error);
      });
      break;
    case "wlopm":
      execAsyncCommand("wlopm", [`--${status.toLowerCase()}`, "*"], callback);
      break;
    case "kscreen-doctor":
      execAsyncCommand("kscreen-doctor", ["--dpms", status.toLowerCase()], callback);
      break;
    case "xset":
      execAsyncCommand("xset", ["dpms", "force", status.toLowerCase()], callback);
      break;
  }
};

/**
 * Gets the current display brightness path using `/sys/class/backlight`.
 *
 * @returns {string|null} The display brightness path or null if nothing was found.
 */
const getDisplayBrightnessPath = () => {
  const backlight = "/sys/class/backlight";
  if (!fs.existsSync(backlight)) {
    return null;
  }
  for (const address of fs.readdirSync(backlight)) {
    const brightnessFile = path.join(backlight, address, "brightness");
    if (!fs.existsSync(brightnessFile)) {
      continue;
    }
    return path.join(backlight, address);
  }
  return null;
};

/**
 * Gets the available display brightness command checking for `ddcutil` and `tee`.
 *
 * @returns {string|null} The display brightness command or null if nothing was found.
 */
const getDisplayBrightnessCommand = () => {
  const type = HARDWARE.session.type;
  const desktop = HARDWARE.session.desktop;
  const mapping = {
    wayland: [
      { command: "ddcutil", desktops: ["*"] },
      { command: "tee", desktops: ["*"] },
    ],
    x11: [
      { command: "ddcutil", desktops: ["*"] },
      { command: "tee", desktops: ["*"] },
    ],
  }[type];
  for (const map of mapping || []) {
    if (commandExists(map.command) && map.desktops.some((d) => d === "*" || desktop.includes(d))) {
      switch (map.command) {
        case "ddcutil":
          if (!sudoRights()) {
            break;
          }
          const ddcutil = execSyncCommand("sudo", ["ddcutil", "capabilities"]);
          if (ddcutil !== null && ddcutil.includes("Feature: 10")) {
            HARDWARE.display.brightness.path = path.join(APP.cache, "Display");
            fs.mkdirSync(HARDWARE.display.brightness.path, { recursive: true });
            fs.writeFileSync(path.join(HARDWARE.display.brightness.path, "brightness"), "");
            return map.command;
          }
          break;
        case "tee":
          if (!HARDWARE.display.brightness.path) {
            break;
          }
          // udev rules can hand the session user write access to the backlight
          // sysfs node, in which case no sudo is needed at all (touchkio#233).
          const file = path.join(HARDWARE.display.brightness.path, "brightness");
          if (sudoRights() || writeRights(file)) {
            return map.command;
          }
          break;
      }
    }
  }
  return null;
};

/**
 * Gets the maximum display brightness value using the available command.
 *
 * @returns {number|null} The brightness maximum value or null if an error occurs.
 */
const getDisplayBrightnessMax = () => {
  switch (HARDWARE.display.brightness.command) {
    case "ddcutil":
      const ddcutil = execSyncCommand("sudo", ["ddcutil", "getvcp", "0x10", "--brief"]);
      const match = ddcutil !== null ? ddcutil.match(/VCP 10 C (\d+) (\d+)/) : null;
      if (match) {
        return parseInt(match[2], 10);
      }
      return null;
    case "tee":
      const max = readFile(path.join(HARDWARE.display.brightness.path, "max_brightness"));
      if (max) {
        return parseInt(max, 10);
      }
      return null;
  }
  return null;
};

/**
 * Gets the current display brightness level using the available command.
 *
 * @returns {number|null} The brightness level as a percentage or null if an error occurs.
 */
const getDisplayBrightness = () => {
  if (!HARDWARE.support.displayBrightness) {
    return null;
  }
  const max = HARDWARE.display.brightness.value.max || 1;
  switch (HARDWARE.display.brightness.command) {
    case "ddcutil":
      const ddcutil = execSyncCommand("sudo", ["ddcutil", "getvcp", "0x10", "--brief"]);
      const match = ddcutil !== null ? ddcutil.match(/VCP 10 C (\d+) (\d+)/) : null;
      if (match) {
        return Math.max(0, Math.min(Math.round((parseInt(match[1], 10) / max) * 100), 100));
      }
      return null;
    case "tee":
      const brightness = readFile(path.join(HARDWARE.display.brightness.path, "brightness"));
      if (brightness) {
        return Math.max(0, Math.min(Math.round((parseInt(brightness, 10) / max) * 100), 100));
      }
  }
  return null;
};

/**
 * Sets the display brightness level using the available command.
 *
 * This function takes a brightness value between 0 to 100 percent,
 * maps it to the proper range and writes it to the system. A value of 0 is
 * allowed so PWM/sysfs backlights and `ddcutil` displays can be switched fully
 * off from Home Assistant (touchkio#190), not just dimmed to the minimum.
 *
 * @param {number} brightness - The desired brightness level (0-100).
 * @param {Function} callback - A callback function that receives the output or error.
 */
const setDisplayBrightness = (brightness, callback = null) => {
  if (!HARDWARE.support.displayBrightness) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  if (typeof brightness !== "number" || brightness < 0 || brightness > 100) {
    console.error("Brightness must be a number between 0 and 100");
    if (typeof callback === "function") callback(null, "Invalid brightness");
    return;
  }
  const max = HARDWARE.display.brightness.value.max || 1;
  const value = Math.max(0, Math.min(Math.round((brightness / 100) * max), max));
  switch (HARDWARE.display.brightness.command) {
    case "ddcutil":
      execAsyncCommand("sudo", ["ddcutil", "setvcp", "0x10", `${value}`], (reply, error) => {
        fs.writeFileSync(path.join(HARDWARE.display.brightness.path, "brightness"), `${value}`);
        if (typeof callback === "function") callback(reply, error);
      });
      return;
    case "tee":
      const file = path.join(HARDWARE.display.brightness.path, "brightness");
      const [cmd, args] = HARDWARE.support.access?.sudo ? ["sudo", ["tee", file]] : ["tee", [file]];
      const proc = execAsyncCommand(cmd, args, callback);
      proc.stdin.write(`${value}`);
      proc.stdin.end();
      return;
  }
};

/**
 * Gets the default audio output using `pactl`.
 *
 * @returns {string|null} The default audio output or null if an error occurs.
 */
const getAudioOutput = () => {
  if (!commandExists("pactl")) {
    return null;
  }
  const output = execSyncCommand("pactl", ["get-default-sink"]);
  if (!output) {
    return null;
  }
  const sink = output.trim();
  if (!sink.includes("auto_null") && !sink.endsWith(".monitor")) {
    return sink;
  }
  return null;
};

/**
 * Gets the default audio output volume using `pactl`.
 *
 * @returns {number|null} The default audio output volume as a percentage or null if an error occurs.
 */
const getAudioVolume = () => {
  if (!HARDWARE.support.audioVolume) {
    return null;
  }
  const mute = execSyncCommand("pactl", ["get-sink-mute", "@DEFAULT_SINK@"]);
  const volume = execSyncCommand("pactl", ["get-sink-volume", "@DEFAULT_SINK@"]);
  if (!mute || !volume) {
    return null;
  }
  const match = volume.match(/\/(\s*(\d+)%)/);
  if (match) {
    return Math.max(0, Math.min(100, mute.includes("yes") ? 0 : parseInt(match[2], 10)));
  }
  return null;
};

/**
 * Sets the default audio output volume using `pactl`.
 *
 * This function takes a volume value between 0 to 100 percent and sends it to the output device.
 *
 * @param {number} volume - The desired volume level (0-100).
 * @param {Function} callback - A callback function that receives the output or error.
 */
const setAudioVolume = (volume, callback = null) => {
  if (!HARDWARE.support.audioVolume) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  if (typeof volume !== "number" || volume < 0 || volume > 100) {
    console.error("Volume must be a number between 0 and 100");
    if (typeof callback === "function") callback(null, "Invalid volume");
    return;
  }
  execAsyncCommand("pactl", ["set-sink-mute", "@DEFAULT_SINK@", volume === 0 ? "1" : "0"]);
  execAsyncCommand("pactl", ["set-sink-volume", "@DEFAULT_SINK@", `${volume}%`], callback);
};

/**
 * Gets the default audio input using `pactl`.
 *
 * @returns {string|null} The default audio input or null if an error occurs.
 */
const getAudioInput = () => {
  if (!commandExists("pactl")) {
    return null;
  }
  const output = execSyncCommand("pactl", ["get-default-source"]);
  if (!output) {
    return null;
  }
  const source = output.trim();
  if (!source.includes("auto_null") && !source.endsWith(".monitor")) {
    return source;
  }
  return null;
};

/**
 * Gets the default audio input volume using `pactl`.
 *
 * @returns {number|null} The default audio input volume as a percentage or null if an error occurs.
 */
const getMicrophoneVolume = () => {
  if (!HARDWARE.support.microphoneVolume) {
    return null;
  }
  const mute = execSyncCommand("pactl", ["get-source-mute", "@DEFAULT_SOURCE@"]);
  const volume = execSyncCommand("pactl", ["get-source-volume", "@DEFAULT_SOURCE@"]);
  if (!mute || !volume) {
    return null;
  }
  const match = volume.match(/\/(\s*(\d+)%)/);
  if (match) {
    return Math.max(0, Math.min(100, mute.includes("yes") ? 0 : parseInt(match[2], 10)));
  }
  return null;
};

/**
 * Sets the default audio input volume using `pactl`.
 *
 * This function takes a volume value between 0 to 100 percent and sends it to the input device.
 *
 * @param {number} volume - The desired volume level (0-100).
 * @param {Function} callback - A callback function that receives the output or error.
 */
const setMicrophoneVolume = (volume, callback = null) => {
  if (!HARDWARE.support.microphoneVolume) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  if (typeof volume !== "number" || volume < 0 || volume > 100) {
    console.error("Volume must be a number between 0 and 100");
    if (typeof callback === "function") callback(null, "Invalid volume");
    return;
  }
  execAsyncCommand("pactl", ["set-source-mute", "@DEFAULT_SOURCE@", volume === 0 ? "1" : "0"]);
  execAsyncCommand("pactl", ["set-source-volume", "@DEFAULT_SOURCE@", `${volume}%`], callback);
};

/**
 * Gets the keyboard visibility using global properties.
 *
 * @returns {string|null} The keyboard visibility as 'ON'/'OFF' or null if an error occurs.
 */
const getKeyboardVisibility = () => {
  if (!HARDWARE.support.keyboardVisibility) {
    return null;
  }
  return HARDWARE.keyboard.visibility ? "ON" : "OFF";
};

/**
 * Sets the keyboard visibility using `dbus-send`.
 *
 * This function takes a desired visibility ('ON' or 'OFF') and executes
 * the appropriate command to show or hide the keyboard.
 *
 * @param {bool} visibility - The desired visibility ('ON' or 'OFF').
 * @param {Function} callback - A callback function that receives the output or error.
 */
const setKeyboardVisibility = (visibility, callback = null) => {
  if (!HARDWARE.support.keyboardVisibility) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  if (!["ON", "OFF"].includes(visibility)) {
    console.error("Visibility must be 'ON' or 'OFF'");
    if (typeof callback === "function") callback(null, "Invalid visibility");
    return;
  }
  const visible = visibility === "ON";
  HARDWARE.keyboard.visibility = visible;
  dbusCall("/sm/puri/OSK0", "SetVisible", [`boolean:${visible}`], callback);
};

// Refresh the apt package index at most this often (12h). `apt list --upgradable`
// only reports what is already in the local cache, so on headless Raspberry Pi OS
// — where nothing runs `apt update` automatically — the upgrade count stays 0
// even when upgrades exist (touchkio#213). We refresh it ourselves, but rarely.
const APT_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * Refreshes the apt package index in the background when it is stale.
 *
 * Runs `apt-get update` fire-and-forget (never blocks the main process) and only
 * when sudo rights are available and the cache is older than `APT_CACHE_MAX_AGE_MS`.
 * The refreshed index is picked up by the next `checkPackageUpgrades` poll, so the
 * Package Upgrades sensor stops being stuck at 0 on Raspberry Pi OS (touchkio#213).
 */
const refreshAptCacheIfStale = () => {
  if (!sudoRights() || _cache.aptUpdating) {
    return;
  }
  try {
    // Prefer unattended-upgrades' success stamp, fall back to the lists dir mtime.
    const stamp = "/var/lib/apt/periodic/update-success-stamp";
    const lists = "/var/lib/apt/lists";
    let mtime = 0;
    if (fs.existsSync(stamp)) {
      mtime = fs.statSync(stamp).mtimeMs;
    } else if (fs.existsSync(lists)) {
      mtime = fs.statSync(lists).mtimeMs;
    }
    if (mtime && Date.now() - mtime < APT_CACHE_MAX_AGE_MS) {
      return;
    }
    _cache.aptUpdating = true;
    const proc = cpr.spawn("sudo", ["apt-get", "update"], {
      stdio: "ignore",
      detached: true,
    });
    proc.on("error", () => {
      _cache.aptUpdating = false;
    });
    proc.on("close", () => {
      _cache.aptUpdating = false;
    });
    proc.unref();
  } catch {
    _cache.aptUpdating = false;
  }
};

/**
 * Checks if system upgrades are available using `apt`.
 *
 * @returns {Array<string>} A list of package names that are available for upgrade.
 */
const checkPackageUpgrades = () => {
  if (!commandExists("apt")) {
    return [];
  }
  // Keep the local apt index fresh so the count reflects reality (touchkio#213).
  refreshAptCacheIfStale();
  try {
    // Suppress apt warnings via stdio rather than shell redirection in args.
    const result = cpr.spawnSync("apt", ["list", "--upgradable"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const packages = (result.stdout || "").trim().split("\n");
    packages.shift(); // Remove "Listing..." header line
    return packages.filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Shuts down the system using `sudo shutdown -h now`.
 *
 * This function executes the command asynchronously.
 * The output of the command will be provided through the callback function.
 *
 * @param {Function} callback - A callback function that receives the output or error.
 */
const shutdownSystem = (callback = null) => {
  if (!HARDWARE.support.access?.shutdown) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  execAsyncCommand("sudo", ["shutdown", "-h", "now"], callback);
};

/**
 * Reboots the system using `sudo reboot`.
 *
 * This function executes the command asynchronously.
 * The output of the command will be provided through the callback function.
 *
 * @param {Function} callback - A callback function that receives the output or error.
 */
const rebootSystem = (callback = null) => {
  if (!HARDWARE.support.access?.reboot) {
    if (typeof callback === "function") callback(null, "Not supported");
    return;
  }
  execAsyncCommand("sudo", ["reboot"], callback);
};

/**
 * Checks if sudo commands can run without a password.
 * Result is cached for the lifetime of the process.
 *
 * @returns {bool} Returns true if password-less sudo rights exists.
 */
const sudoRights = () => {
  if (_cache.sudoRights !== undefined) return _cache.sudoRights;
  try {
    cpr.execSync(`sudo -n true`, { encoding: "utf8", stdio: "ignore" });
    _cache.sudoRights = true;
  } catch {
    _cache.sudoRights = false;
  }
  return _cache.sudoRights;
};

/**
 * Checks if `apt install` can run via sudo without a password.
 *
 * @returns {boolean} True if password-less apt install rights exist.
 */
const installRights = () => {
  try {
    cpr.execSync(`sudo -n apt install --help`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {}
  return false;
};

/**
 * Checks if `reboot` can run via sudo without a password.
 *
 * @returns {boolean} True if password-less reboot rights exist.
 */
const rebootRights = () => {
  try {
    cpr.execSync(`sudo -n reboot --help`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {}
  return false;
};

/**
 * Checks if `shutdown` can run via sudo without a password.
 *
 * @returns {boolean} True if password-less shutdown rights exist.
 */
const shutdownRights = () => {
  try {
    cpr.execSync(`sudo -n shutdown --help`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {}
  return false;
};

/**
 * Checks if a file path has write access rights.
 *
 * @param {string} path - The file path to check.
 * @returns {boolean} True if write access rights exist.
 */
const writeRights = (path) => {
  try {
    fs.accessSync(path, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {}
  return false;
};

/**
 * Checks if a service is running using `systemctl`.
 *
 * @param {string} name - The service name to check.
 * @returns {bool} Returns true if the service runs.
 */
const serviceRuns = (name) => {
  try {
    cpr.execSync(`systemctl --user is-active ${name}`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {}
  return false;
};

/**
 * Checks if a process is running using `pidof`.
 *
 * @param {string} name - The process name to check.
 * @returns {bool} Returns true if the process runs.
 */
const processRuns = (name) => {
  try {
    cpr.execSync(`pidof ${name}`, { encoding: "utf8", stdio: "ignore" });
    return true;
  } catch {}
  return false;
};

/**
 * Checks if a command is available using `which`.
 * Results are cached since installed commands don't change at runtime.
 *
 * @param {string} name - The command name to check.
 * @returns {bool} Returns true if the command is available.
 */
const commandExists = (name) => {
  if (_cache[`cmd_${name}`] !== undefined) return _cache[`cmd_${name}`];
  try {
    cpr.execSync(`which ${name}`, { encoding: "utf8", stdio: "ignore" });
    _cache[`cmd_${name}`] = true;
  } catch {
    _cache[`cmd_${name}`] = false;
  }
  return _cache[`cmd_${name}`];
};

/**
 * Executes a command synchronously and returns the output.
 *
 * @param {string} cmd - The command to execute.
 * @param {Array<string>} args - The arguments for the command.
 * @returns {string|null} The output of the command or null if an error occurs.
 */
const execSyncCommand = (cmd, args) => {
  try {
    console.debug(`hardware.js: execSyncCommand(${[cmd, ...args].join(" ")})`);
    const output = cpr.execSync([cmd, ...args].join(" "), { encoding: "utf8" });
    return output.trim().replace(/\0/g, "");
  } catch (error) {
    console.error(`Execute Sync: '${[cmd, ...args].join(" ")}' --> ${error.message}`.trim());
  }
  return null;
};

/**
 * Executes a command asynchronously.
 *
 * @param {string} cmd - The command to execute.
 * @param {Array<string>} args - The arguments for the command.
 * @param {Function} callback - A callback function that receives the output or error.
 * @returns {Object} The spawned process object.
 */
const execAsyncCommand = (cmd, args, callback = null) => {
  console.debug(`hardware.js: execAsyncCommand(${[cmd, ...args].join(" ")})`);
  let errorOutput = "";
  let successOutput = "";
  let proc = cpr.spawn(cmd, args);
  proc.stderr.on("data", (data) => {
    if (data) {
      errorOutput += data.toString();
    }
  });
  proc.stdout.on("data", (data) => {
    if (data) {
      successOutput += data.toString();
    }
  });
  proc.on("close", (code) => {
    const error = errorOutput.trim().replace(/\0/g, "");
    const reply = successOutput.trim().replace(/\0/g, "");
    if (code !== 0 || error) {
      console.error(`Execute Async: '${[cmd, ...args].join(" ")}' --> ${error} (${code})`);
      if (typeof callback === "function") callback(null, error);
    } else {
      if (typeof callback === "function") callback(reply, null);
    }
  });
  return proc;
};

/**
 * Executes a script command asynchronously.
 *
 * @param {string} cmd - The script to execute.
 * @param {Array<string>} args - The arguments for the command.
 * @param {Function} callback - A callback function that receives the progress or error.
 * @returns {Object} The spawned process object.
 */
const execScriptCommand = (cmd, args, callback = null) => {
  console.debug(`hardware.js: execScriptCommand(${[cmd, ...args].join(" ")})`);
  let progress = 1;
  let proc = cpr.spawn(cmd, args);
  if (typeof callback === "function") callback(progress, null);
  proc.stdout.on("data", (data) => {
    if (data) {
      const output = data.toString().trim();
      const lines = output.replace(/\n+/g, "\n").replace(/^\n+|\n+$|\0/g, "");
      for (const line of lines.split("\n").filter(Boolean)) {
        console.info(line);
      }
    }
  });
  proc.stderr.on("data", (data) => {
    if (data) {
      const output = data.toString().trim();
      const lines = output.replace(/\n+/g, "\n").replace(/^\n+|\n+$|\0/g, "");
      for (const line of lines.split("\n").filter(Boolean)) {
        const matches = line.match(/(\d{1,3})%/g);
        if (matches) {
          const match = Math.max(...matches.map((p) => parseInt(p, 10)));
          const percent = Math.floor(match / 10) * 10;
          if (percent > 10 && percent > progress) {
            progress = percent;
            if (typeof callback === "function") callback(progress - 10, null);
          }
        }
      }
    }
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error(`Script exited with error code (${code}).`);
      if (typeof callback === "function") callback(null, code);
    } else {
      console.info("Script exited successfully.");
      if (typeof callback === "function") callback(100, null);
    }
  });
};

/**
 * Monitors a command asynchronously.
 *
 * @param {string} cmd - The command to monitor.
 * @param {Array<string>} args - The arguments for the command.
 * @param {Function} callback - A callback function that receives the output or error.
 * @returns {Object} The spawned process object.
 */
const commandMonitor = (cmd, args, callback = null) => {
  console.debug(`hardware.js: commandMonitor(${[cmd, ...args].join(" ")})`);
  const proc = cpr.spawn(cmd, args);
  proc.stdout.on("data", (data) => {
    if (data) {
      const output = data.toString().trim().replace(/\0/g, "");
      if (typeof callback === "function") callback(output, null);
    }
  });
  proc.stderr.on("data", (data) => {
    if (data) {
      const output = data.toString().trim().replace(/\0/g, "");
      if (typeof callback === "function") callback(null, output);
    }
  });
  return proc;
};

/**
 * Monitors D-Bus property changes asynchronously using `dbus-monitor`.
 *
 * @param {string} path - The D-Bus object path.
 * @param {Function} callback - A callback function that receives the changed property.
 * @returns {Object} The spawned process object.
 */
const dbusMonitor = (path, callback = null) => {
  const cmd = "dbus-monitor";
  const args = [`interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${path}'`];
  console.debug(`hardware.js: dbusMonitor(${[cmd, ...args].join(" ")})`);
  const proc = cpr.spawn(cmd, args);
  proc.stdout.on("data", (data) => {
    try {
      const signal = data.toString();
      if (signal.includes(`string "Visible"`)) {
        const dicts = [...signal.matchAll(/dict entry\(\s*([^)]*?)\)/g)].map((dict) => dict[1].trim());
        if (dicts.length) {
          dicts.forEach((dict) => {
            const key = dict.match(/string "(.*?)"/);
            const value = dict.match(/(?<=variant\s+)(.*)/);
            if (key && value) {
              const property = { [key[1].trim()]: value[1].trim().split(" ").pop() };
              if (typeof callback === "function") callback(property, null);
            }
          });
        } else {
          const property = { Visible: `${HARDWARE.keyboard.visibility}` };
          if (typeof callback === "function") callback(property, null);
        }
      }
    } catch (error) {
      console.error("Monitor D-Bus:", error.message);
      if (typeof callback === "function") callback(null, error.message);
    }
  });
  proc.stderr.on("data", (data) => {
    if (data) {
      console.error("Monitor D-Bus:", data.toString());
      if (typeof callback === "function") callback(null, data.toString());
    }
  });
  return proc;
};

/**
 * Executes a D-Bus method call synchronously using `dbus-send`.
 *
 * @param {string} path - The D-Bus object path.
 * @param {string} method - The D-Bus method name.
 * @param {Array<string>} values - The argument values for the D-Bus method.
 * @param {Function} callback - A callback function that receives the output or error.
 */
const dbusCall = (path, method, values, callback = null) => {
  const cmd = "dbus-send";
  const iface = path.slice(1).replace(/\//g, ".");
  const dest = `${iface} ${path} ${iface}.${method} ${values.join(" ")}`;
  const args = ["--print-reply", "--type=method_call", `--dest=${dest}`];
  try {
    console.debug(`hardware.js: dbusCall(${[cmd, ...args].join(" ")})`);
    const output = cpr.execSync([cmd, ...args].join(" ").trim(), { encoding: "utf8" });
    if (typeof callback === "function") callback(output.trim().replace(/\0/g, ""), null);
  } catch (error) {
    console.error("Call D-Bus:", error.message);
    if (typeof callback === "function") callback(null, error.message);
  }
};

/**
 * Reads file content synchronously or asynchronously from the filesystem.
 *
 * @param {string} path - Path of the file.
 * @param {boolean} sync - If true, reads the file synchronously, otherwise asynchronously.
 * @returns {string|null|Promise<string|null>} The file content or null if an error occurs.
 */
const readFile = (path, sync = true) => {
  if (!sync) {
    return fsp
      .readFile(path, "utf8")
      .then((content) => content.trim())
      .catch((error) => {
        console.error(`Read File ${path} Async:`, error.message);
        return null;
      });
  }
  try {
    return fs.readFileSync(path, "utf8").trim();
  } catch (error) {
    console.error(`Read File ${path} Sync:`, error.message);
  }
  return null;
};

/**
 * Helper function for asynchronous interval calls.
 *
 * @param {Function} callback - An async callback function.
 * @param {number} ms - Sleep time in milliseconds.
 */
const interval = (callback, ms) => {
  const run = () => {
    setTimeout(async () => {
      try {
        await callback();
      } catch (error) {
        console.error("Interval Async:", error.message);
      }
      run();
    }, ms);
  };
  run();
};

module.exports = {
  init,
  update,
  sessionType,
  getModel,
  getVendor,
  getSerialNumber,
  getMachineId,
  getNetworkAddresses,
  getHostName,
  getUpTime,
  getMemorySize,
  getMemoryUsage,
  getProcessorUsage,
  getProcessorTemperature,
  getBatteryLevel,
  getIlluminanceLevel,
  getDisplayStatus,
  setDisplayStatus,
  getDisplayBrightness,
  setDisplayBrightness,
  getAudioVolume,
  setAudioVolume,
  getMicrophoneVolume,
  setMicrophoneVolume,
  getKeyboardVisibility,
  setKeyboardVisibility,
  checkPackageUpgrades,
  shutdownSystem,
  rebootSystem,
  execSyncCommand,
  execAsyncCommand,
  execScriptCommand,
};
