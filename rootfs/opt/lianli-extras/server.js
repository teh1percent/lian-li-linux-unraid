'use strict';

// Web dashboard and Unraid integration, running next to lianli-daemon. The HTTP
// API only exposes fixed operations with validated values: sensor commands
// cannot be set through it, because the daemon would run them as shell.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { DaemonClient } = require('./lib/daemon');
const { Engine, Store, mediaType, findEntry, ALERT_TEMPLATES } = require('./lib/engine');
const { History } = require('./lib/history');
const { buildTemplates } = require('./lib/templates');
const { COLOR_KEYS, PRESETS, DEFAULT_LIMITS, isColor, validColors, pickColors, validLimits, themeExists, themeColors } = require('./lib/themes');
const { readStats, selectStorage, writeStats } = require('./lib/unraid');

const STATS_INTERVAL_MS = 5000;
const ENGINE_INTERVAL_MS = 15000;
const HISTORY_INTERVAL_MS = 60000;
const HISTORY_SAVE_EVERY = 10;
const MAX_BODY = 64 * 1024;
const MAX_UPLOAD = 512 * 1024 * 1024;
const MIN_FAN_PERCENT = 20;
const MAX_MUTE_HOURS = 168;
const MAX_CURVES = 32;
const MAX_CURVE_POINTS = 8;
const BIND_TIMEOUT_MS = 20000;
const PIXEL_MINUTES = [15, 30, 60, 120];
const PIXEL_PREPARE_MS = 30000;
const AIO_FAMILIES = new Set(['Galahad2Trinity', 'HydroShiftLcd', 'Galahad2Lcd', 'HydroShift2Lcd', 'HydroShift2OledCurveLed', 'WirelessAio']);
// Below this a fixed pump speed gains nothing, and some pumps stall without their own floor.
const MIN_PUMP_PERCENT = 30;
const AIO_AUTO = 'off';
const AIO_MB_SYNC = '__mb_sync__';
const AIO_SENSORS = { cpuTemp: 'cpu_temp_source', cpuLoad: 'cpu_load_source', gpuTemp: 'gpu_temp_source', gpuLoad: 'gpu_load_source' };
const AIO_COLORS = { label: 'str_color', value: 'val_color', unit: 'unit_color' };
// Sources with the same shape in the daemon's sensor list and its AIO settings.
const AIO_SENSOR_TYPES = new Set(['hwmon', 'nvidia_gpu', 'amd_gpu_usage', 'wireless_coolant', 'cpu_usage', 'mem_usage']);
const HIDDEN_RGB_MODES = new Set(['Direct', 'Render', 'Paint', 'Voice']);
const DIRECTIONS = new Set(['Clockwise', 'CounterClockwise', 'Up', 'Down', 'Spread', 'Gather']);
const RESERVED_CURVE = /^(off$|__mb_sync__)/;
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

class BadRequest extends Error {}

function check(condition, message) {
  if (!condition) throw new BadRequest(message);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isAio(device) {
  return AIO_FAMILIES.has(device.family) || device.has_pump === true || device.has_pump_control === true;
}

// The daemon lists an AIO's pump after its fans in the same array.
function splitRpms(device, telemetry) {
  const all = telemetry?.fan_rpms?.[device.device_id] || [];
  if (!isAio(device)) return { fans: all, pump: null };
  const count = device.fan_count || 0;
  return { fans: all.slice(0, count), pump: all[count] ?? null };
}

function listMedia(dir) {
  const found = [];
  const walk = (current, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.posix.join(current.split(path.sep).join('/'), entry.name);
      if (entry.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (entry.isFile() && mediaType(entry.name)) found.push(full);
    }
  };
  walk(dir, 0);
  return found.sort();
}

function createApp({ daemon, engine, store, options, history }) {
  const publicDir = path.join(__dirname, 'public');
  const alertIds = new Set(Object.values(ALERT_TEMPLATES));
  const selectable = (colors = PRESETS.default, limits = store.data.limits) => (
    buildTemplates(options.statsDir, engine.getStats().volumes, colors, limits).filter((item) => !alertIds.has(item.id))
  );
  const passwordHash = options.password
    ? crypto.createHash('sha256').update(options.password).digest()
    : null;
  const uploadDir = () => options.uploadDir.split(path.sep).join('/');
  const allMedia = () => [...listMedia(options.mediaDir), ...listMedia(options.uploadDir)];

  const findDevice = async (deviceId) => {
    const devices = await daemon.request('ListDevices');
    const device = devices.find((item) => item.device_id === deviceId);
    check(device, 'Unknown device');
    return device;
  };

  const knownTemplate = async (id) => {
    if (selectable().some((item) => item.id === id)) return true;
    const stored = await daemon.request('GetLcdTemplates');
    return stored.some((item) => item.id === id && !alertIds.has(id));
  };

  // Sensors a fan curve may follow. Commands only ever read our own stat files.
  async function curveSensors(known) {
    const stat = (key, name) => {
      const cmd = `cat ${options.statsDir}/${key}`;
      return { id: `unraid:${key}`, name, source: { type: 'command', cmd }, command: cmd };
    };
    const unraid = [stat('disk_temp_max', 'Hottest drive'), stat('disk_temp_avg', 'Average drive temperature')];
    for (const volume of engine.getStats().volumes) unraid.push(stat(`volume_${volume.key}_temp_max`, `Hottest drive in ${volume.name}`));
    const listed = known || await daemon.request('ListSensors').catch(() => []);
    const hardware = listed
      .filter((sensor) => sensor.unit === 'C' && sensor.source?.type !== 'command')
      .map((sensor) => ({
        id: JSON.stringify(sensor.source),
        name: sensor.display_name || `${sensor.sensor_name?.device_name || 'Sensor'}: ${sensor.sensor_name?.sensor_name || ''}`,
        source: sensor.source,
        command: '',
      }));
    return [...unraid, ...hardware];
  }

  function curveSensorId(curve, sensors) {
    const source = curve.temp_source;
    if (source?.type === 'command' || (!source && curve.temp_command)) {
      return sensors.find((sensor) => sensor.command && sensor.command === curve.temp_command)?.id || 'custom';
    }
    return source ? JSON.stringify(source) : 'custom';
  }

  const sensorName = (sensor) => sensor.display_name || `${sensor.sensor_name?.device_name || 'Sensor'}: ${sensor.sensor_name?.sensor_name || ''}`;
  const aioSensorList = (listed) => listed.filter((sensor) => AIO_SENSOR_TYPES.has(sensor.source?.type));

  function aioView(device, config, pumpRpm, telemetry) {
    const saved = config.aio?.[device.device_id] || {};
    const rgb = (color) => (color || [255, 255, 255]).slice(0, 3);
    return {
      pumpRpm,
      coolant: telemetry.coolant_temps?.[device.device_id] ?? null,
      pump: saved.pump_target_rpm ?? AIO_AUTO,
      fans: (saved.fan_speeds || []).slice(0, device.fan_count || 0),
      pumpMbSync: device.pump_mb_sync_support === true,
      fanMbSync: device.mb_sync_support === true,
      brightness: saved.brightness ?? 80,
      rotation: saved.rotation ?? 0,
      theme: saved.theme_index ?? 0,
      loopInterval: saved.loop_interval ?? 3,
      colors: Object.fromEntries(Object.entries(AIO_COLORS).map(([key, field]) => [key, rgb(saved[field])])),
      sensors: Object.fromEntries(Object.entries(AIO_SENSORS).map(([key, field]) => {
        const source = field === 'cpu_load_source' && saved[field] === undefined ? { type: 'cpu_usage' } : saved[field];
        return [key, source ? JSON.stringify(source) : ''];
      })),
    };
  }

  async function state() {
    const stats = selectStorage(engine.getStats(), store.data.storageVolume);
    const shown = store.data;
    const base = {
      time: engine.now().toISOString(),
      localTime: engine.now().toLocaleString(),
      timezone: process.env.TZ || 'UTC',
      fullAppPort: options.fullAppPort,
      stats,
      settings: {
        schedules: shown.schedules, alerts: shown.alerts, screens: shown.screens, theme: shown.theme,
        customColors: shown.customColors, lcdThemes: shown.lcdThemes, limits: shown.limits, names: shown.names,
      },
      status: engine.status(),
      media: allMedia(),
      uploadDir: uploadDir(),
      templates: selectable().map(({ id, name }) => ({ id, name })),
      themes: { keys: COLOR_KEYS, presets: PRESETS, defaultLimits: DEFAULT_LIMITS },
    };
    try {
      const [info, devices, config, telemetry, capabilities, listed, profiles] = await Promise.all([
        daemon.request('GetDaemonInfo'),
        daemon.request('ListDevices'),
        daemon.request('GetConfig'),
        daemon.request('GetTelemetry'),
        daemon.request('GetRgbCapabilities').catch(() => []),
        daemon.request('ListSensors').catch(() => []),
        daemon.request('ListDeviceProfiles').catch(() => []),
      ]);
      const sensors = await curveSensors(listed);
      const fans = config.fans?.speeds || [];
      const rgbDevices = config.rgb?.devices || [];
      return {
        ...base,
        daemon: { connected: true, version: info.version, mode: info.mode },
        curves: (config.fan_curves || []).map((curve) => curve.name),
        curveDetails: (config.fan_curves || []).map((curve) => ({ name: curve.name, points: curve.curve, sensor: curveSensorId(curve, sensors) })),
        sensors: sensors.map(({ id, name }) => ({ id, name })),
        aioSensors: aioSensorList(listed).map((sensor) => ({ id: JSON.stringify(sensor.source), name: sensorName(sensor) })),
        profiles: profiles.map((profile) => ({ name: profile.name, deviceId: profile.device_id })),
        pixelClean: Object.values(telemetry.pixel_clean_statuses || {}).filter((item) => item.active),
        daemonSettings: {
          turnOffLcds: config.turn_off_lcds_on_shutdown !== false,
          hardwareVideo: config.hardware_video === true,
          rgbDrift: config.rgb_drift_detection_enabled !== false,
          defaultFps: config.default_fps ?? null,
        },
        devices: devices.map((device) => {
          const caps = capabilities.find((item) => item.device_id === device.device_id);
          const zone = rgbDevices.find((item) => item.device_id === device.device_id)?.zones?.[0];
          const entry = findEntry(config, device.device_id);
          const rpms = splitRpms(device, telemetry);
          const aio = isAio(device);
          return {
            id: device.device_id,
            name: store.data.names[device.device_id] || device.name,
            model: device.name,
            serial: device.serial,
            hasFan: device.has_fan,
            hasRgb: device.has_rgb,
            hasLcd: device.has_lcd,
            unbound: device.is_unbound_wireless,
            bindStatus: device.wireless_bind_status || null,
            foreignOnline: device.foreign_master_online === true,
            firmware: device.firmware_version || null,
            fanCount: device.fan_count,
            rpms: rpms.fans,
            isAio: aio,
            hidden: Boolean(device.wireless_group_mac),
            aio: aio ? aioView(device, config, rpms.pump, telemetry) : null,
            speed: fans.find((group) => group.device_id === device.device_id)?.speeds?.[0] ?? null,
            effect: zone?.effect || null,
            rgbModes: (caps?.supported_modes || []).filter((mode) => !HIDDEN_RGB_MODES.has(mode)),
            rgbParams: caps?.sync_effect_parameters || [],
            brightness: entry?.brightness ?? 100,
            orientation: entry?.orientation ?? 0,
            hasEntry: Boolean(entry),
          };
        }),
      };
    } catch (error) {
      return { ...base, daemon: { connected: false, error: error.message }, curves: [], curveDetails: [], sensors: [], aioSensors: [], profiles: [], pixelClean: [], daemonSettings: null, devices: [] };
    }
  }

  async function setFan(body) {
    const device = await findDevice(body.device_id);
    check(device.has_fan && !device.is_unbound_wireless, 'This device has no controllable fans');
    check(!isAio(device), 'Set this one on the AIO page');
    const config = await daemon.request('GetConfig');
    let speed;
    if (body.mode === 'constant') {
      check(isInt(body.percent, MIN_FAN_PERCENT, 100), `Speed must be ${MIN_FAN_PERCENT} to 100%`);
      speed = Math.round((body.percent / 100) * 255);
    } else {
      check(body.mode === 'curve', 'Unknown fan mode');
      check((config.fan_curves || []).some((curve) => curve.name === body.curve), 'Unknown fan curve');
      speed = body.curve;
    }
    const slots = Math.min(device.fan_count || 4, 4);
    const speeds = Array.from({ length: 4 }, (_, slot) => (slot < slots ? speed : 0));
    const fans = config.fans || { speeds: [] };
    const others = (fans.speeds || []).filter((group) => group.device_id !== device.device_id);
    await daemon.write('SetFanConfig', { config: { ...fans, speeds: [...others, { device_id: device.device_id, speeds }] } });
  }

  async function saveCurve(body) {
    check(typeof body.name === 'string' && body.name.trim() && body.name.length <= 40, 'A curve needs a short name');
    const name = body.name.trim();
    check(!RESERVED_CURVE.test(name), 'That name is reserved');
    const points = body.points;
    check(Array.isArray(points) && points.length >= 2 && points.length <= MAX_CURVE_POINTS, `A curve needs 2 to ${MAX_CURVE_POINTS} points`);
    points.forEach((point, index) => {
      check(Array.isArray(point) && point.length === 2 && isInt(point[0], 0, 110), 'Temperatures must be 0 to 110 °C');
      check(isInt(point[1], MIN_FAN_PERCENT, 100), `Speeds must be ${MIN_FAN_PERCENT} to 100%`);
      if (index) check(point[0] > points[index - 1][0], 'Temperatures must go up from point to point');
    });
    const sensor = (await curveSensors()).find((item) => item.id === body.sensor);
    check(sensor, 'Unknown sensor');

    const config = await daemon.request('GetConfig');
    const curves = config.fan_curves || [];
    const original = typeof body.original === 'string' ? body.original : name;
    const index = curves.findIndex((curve) => curve.name === original);
    check(name === original || !curves.some((curve) => curve.name === name), 'A curve with that name already exists');
    check(index !== -1 || curves.length < MAX_CURVES, 'Too many curves');
    const curve = { name, temp_source: sensor.source, temp_command: sensor.command, curve: points };
    if (index === -1) curves.push(curve);
    else curves[index] = curve;
    if (name !== original && config.fans?.speeds) {
      for (const group of config.fans.speeds) {
        group.speeds = group.speeds.map((speed) => (speed === original ? name : speed));
      }
    }
    if (name !== original) {
      for (const aio of Object.values(config.aio || {})) {
        if (aio.pump_target_rpm === original) aio.pump_target_rpm = name;
        if (aio.fan_speeds) aio.fan_speeds = aio.fan_speeds.map((speed) => (speed === original ? name : speed));
      }
    }
    await daemon.write('SetConfig', { config: { ...config, fan_curves: curves } });
  }

  async function deleteCurve(body) {
    const config = await daemon.request('GetConfig');
    const curves = config.fan_curves || [];
    check(curves.some((curve) => curve.name === body.name), 'Unknown fan curve');
    const used = (config.fans?.speeds || []).some((group) => group.speeds.includes(body.name));
    check(!used, 'A fan group is using this curve. Switch it to something else first.');
    const usedByAio = Object.values(config.aio || {}).some((aio) => aio.pump_target_rpm === body.name || aio.fan_speeds?.includes(body.name));
    check(!usedByAio, 'An AIO is using this curve. Switch it to something else first.');
    await daemon.write('SetConfig', { config: { ...config, fan_curves: curves.filter((curve) => curve.name !== body.name) } });
  }

  // "Automatic" is the daemon's "off": it leaves the AIO to manage itself and
  // never stops the pump, so nothing here can send a pump speed of zero.
  function aioSpeed(spec, config, minPercent, mbSupported) {
    check(spec && typeof spec === 'object', 'Invalid speed');
    if (spec.mode === 'auto') return AIO_AUTO;
    if (spec.mode === 'constant') {
      check(isInt(spec.percent, minPercent, 100), `Speed must be ${minPercent} to 100%`);
      return Math.round((spec.percent / 100) * 255);
    }
    if (spec.mode === 'curve') {
      check((config.fan_curves || []).some((curve) => curve.name === spec.curve), 'Unknown fan curve');
      return spec.curve;
    }
    check(spec.mode === 'mb', 'Unknown speed mode');
    check(mbSupported, 'This AIO does not support motherboard sync');
    return AIO_MB_SYNC;
  }

  async function setAio(body) {
    const device = await findDevice(body.device_id);
    check(isAio(device) && !device.is_unbound_wireless, 'This device is not a paired AIO');
    const config = await daemon.request('GetConfig');
    const next = { pump_target_rpm: AIO_AUTO, fan_speeds: [AIO_AUTO, AIO_AUTO, AIO_AUTO, AIO_AUTO], ...config.aio?.[device.device_id] };
    if (body.pump !== undefined) {
      check(device.has_pump || device.has_pump_control, 'This AIO has no controllable pump');
      next.pump_target_rpm = aioSpeed(body.pump, config, MIN_PUMP_PERCENT, device.pump_mb_sync_support === true);
    }
    if (body.fans !== undefined) {
      check(device.has_fan && device.fan_count > 0, 'This AIO has no controllable fans');
      const speed = aioSpeed(body.fans, config, MIN_FAN_PERCENT, device.mb_sync_support === true);
      next.fan_speeds = next.fan_speeds.map((current, slot) => (slot < device.fan_count ? speed : current));
    }
    if (body.brightness !== undefined) {
      check(isInt(body.brightness, 0, 100), 'Brightness must be 0 to 100');
      next.brightness = body.brightness;
    }
    if (body.rotation !== undefined) {
      check(isInt(body.rotation, 0, 3), 'Invalid rotation');
      next.rotation = body.rotation;
    }
    if (body.theme !== undefined) {
      check(isInt(body.theme, 0, 12), 'Invalid theme');
      next.theme_index = body.theme;
    }
    if (body.loopInterval !== undefined) {
      check(isInt(body.loopInterval, 1, 30), 'Page time must be 1 to 30 seconds');
      next.loop_interval = body.loopInterval;
    }
    for (const [key, field] of Object.entries(AIO_COLORS)) {
      if (body.colors?.[key] === undefined) continue;
      check(isColor(body.colors[key]), 'Invalid colour');
      next[field] = [...body.colors[key], 255];
    }
    if (body.sensors !== undefined) {
      const allowed = aioSensorList(await daemon.request('ListSensors').catch(() => []));
      for (const [key, value] of Object.entries(body.sensors)) {
        check(Object.hasOwn(AIO_SENSORS, key), 'Unknown sensor slot');
        // Picked from the daemon's own list, so a command can never come in here.
        const sensor = allowed.find((item) => JSON.stringify(item.source) === value);
        check(value === null || sensor, 'Unknown sensor');
        next[AIO_SENSORS[key]] = sensor ? sensor.source : null;
      }
    }
    await daemon.write('SetConfig', { config: { ...config, aio: { ...config.aio, [device.device_id]: next } } });
  }

  async function setRgb(body) {
    const device = await findDevice(body.device_id);
    check(device.has_rgb && !device.is_unbound_wireless, 'This device has no controllable lighting');
    check(!store.data.lightsSnapshot, 'A schedule has the lights off right now. Change it on the Automation page first.');
    const capabilities = await daemon.request('GetRgbCapabilities');
    const caps = capabilities.find((item) => item.device_id === device.device_id);
    check(caps?.supported_modes?.includes(body.mode) && !HIDDEN_RGB_MODES.has(body.mode), 'Unsupported effect');
    const colors = body.colors || [body.color];
    check(Array.isArray(colors) && colors.length >= 1 && colors.length <= 4 && colors.every(isColor), 'Invalid colour');
    check(isInt(body.brightness, 0, 4), 'Brightness must be 0 to 4');
    if (body.speed !== undefined) check(isInt(body.speed, 0, 4), 'Speed must be 0 to 4');
    if (body.direction !== undefined) check(DIRECTIONS.has(body.direction), 'Unknown direction');

    const config = await daemon.request('GetConfig');
    const rgb = config.rgb || { enabled: true, devices: [] };
    const devices = rgb.devices || [];
    let entry = devices.find((item) => item.device_id === device.device_id);
    if (!entry) {
      entry = { device_id: device.device_id, zones: [] };
      devices.push(entry);
    }
    const options_ = { mode: body.mode, colors, brightness: body.brightness, disabled: false };
    if (body.speed !== undefined) options_.speed = body.speed;
    if (body.direction !== undefined) options_.direction = body.direction;
    const zoneCount = Math.max(device.rgb_zone_count || 1, 1);
    for (let zone = 0; zone < zoneCount; zone += 1) {
      const existing = entry.zones.find((item) => item.zone_index === zone);
      const effect = { ...(existing?.effect || {}), ...options_ };
      if (existing) existing.effect = effect;
      else entry.zones.push({ zone_index: zone, effect });
      await daemon.write('SetRgbEffect', { device_id: device.device_id, zone, effect });
    }
    await daemon.write('SetRgbConfig', { config: { ...rgb, devices } });
  }

  async function setProfile(body) {
    check(typeof body.name === 'string' && /^[\w .-]{1,40}$/.test(body.name) && !/^\.+$/.test(body.name), 'Profile names can use letters, numbers, spaces, dots and dashes');
    if (body.action === 'delete') return daemon.write('DeleteDeviceProfile', { name: body.name });
    const device = await findDevice(body.device_id);
    check(body.action === 'save' || body.action === 'apply', 'Unknown action');
    const method = body.action === 'save' ? 'SaveDeviceProfile' : 'ApplyDeviceProfile';
    return daemon.write(method, { name: body.name, device_id: device.device_id });
  }

  async function setDevice(body) {
    const device = await findDevice(body.device_id);
    if (body.action === 'identify') return daemon.write('PingDevice', { device_id: device.device_id, zone: 0 });
    if (body.action === 'rename') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      check(name.length <= 40, 'Names can be up to 40 characters');
      if (name) store.data.names[device.device_id] = name;
      else delete store.data.names[device.device_id];
      return store.save();
    }
    check(body.action === 'bind' || body.action === 'unbind', 'Unknown action');
    check(device.device_id.startsWith('wireless:'), 'Only wireless devices can be paired');
    check(!device.foreign_master_online, 'Another controller owns this device and is switched on. Turn that controller off first.');
    const mac = device.device_id.slice('wireless:'.length);
    const queued = await daemon.write(body.action === 'bind' ? 'BindWirelessDevice' : 'UnbindWirelessDevice', { mac });
    if (!queued?.operation_id) return null;
    const deadline = Date.now() + BIND_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = await daemon.request('GetWirelessOperation', { operation_id: queued.operation_id });
      if (result.status === 'succeeded') return null;
      if (result.status === 'failed') throw new Error(result.message || 'Pairing failed');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('Pairing is taking too long. Check the device list in a moment.');
  }

  async function setScreen(body) {
    const device = await findDevice(body.device_id);
    check(device.has_lcd, 'This device has no screen');
    const screen = body.screen || {};
    if (screen.kind === 'keep') {
      delete store.data.screens[device.device_id];
    } else if (screen.kind === 'template') {
      check(await knownTemplate(screen.templateId), 'Unknown screen');
      store.data.screens[device.device_id] = { kind: 'template', templateId: screen.templateId };
    } else if (screen.kind === 'color') {
      check(isColor(screen.rgb), 'Invalid colour');
      store.data.screens[device.device_id] = { kind: 'color', rgb: screen.rgb };
    } else {
      check(screen.kind === 'media' && allMedia().includes(screen.path), 'Unknown media file');
      store.data.screens[device.device_id] = { kind: 'media', path: screen.path };
    }
    store.save();
    await engine.tick();
  }

  async function setLcd(body) {
    const device = await findDevice(body.device_id);
    check(device.has_lcd, 'This device has no screen');
    if (body.theme !== undefined) {
      check(body.theme === null || themeExists(store.data, body.theme), 'Unknown theme');
      if (body.theme === null) delete store.data.lcdThemes[device.device_id];
      else store.data.lcdThemes[device.device_id] = body.theme;
      store.save();
      await engine.tick();
    }
    if (body.brightness === undefined && body.orientation === undefined) return;
    const config = await daemon.request('GetConfig');
    const entry = findEntry(config, device.device_id);
    if (body.brightness !== undefined) {
      check(isInt(body.brightness, 0, 100), 'Brightness must be 0 to 100');
      if (device.device_id in store.data.baseBrightness) {
        store.data.baseBrightness[device.device_id] = body.brightness;
        store.save();
      } else {
        await daemon.write('SetLcdBrightness', { device_id: device.device_id, brightness: body.brightness });
      }
    }
    if (body.orientation !== undefined) {
      check([0, 90, 180, 270].includes(body.orientation), 'Rotation must be 0, 90, 180 or 270');
      check(entry, 'Choose what this screen shows first');
    }
    if (entry) {
      const next = { ...entry };
      if (body.brightness !== undefined) next.brightness = body.brightness;
      if (body.orientation !== undefined) next.orientation = body.orientation;
      await daemon.write('SetLcdMedia', { device_id: `serial:${entry.serial}`, config: next });
    }
  }

  async function setTheme(body) {
    if (body.customColors !== undefined) {
      check(validColors(body.customColors), 'Invalid colours');
      store.data.customColors = pickColors(body.customColors);
    }
    if (body.theme !== undefined) {
      check(themeExists(store.data, body.theme), 'Unknown theme');
      store.data.theme = body.theme;
    }
    if (body.limits !== undefined) {
      check(validLimits(body.limits), 'The warning limit must be below the danger limit');
      store.data.limits = Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((key) => [key, body.limits[key]]));
    }
    store.save();
    await engine.tick();
  }

  async function setPixel(body) {
    if (body.action === 'stop') return daemon.write('StopPixelClean', { device_id: null, session_id: null });
    check(body.action === 'start' && PIXEL_MINUTES.includes(body.minutes), 'Choose 15, 30, 60 or 120 minutes');
    // The daemon may prepare the screens first; it starts only once told they're ready.
    const start = (preparation) => daemon.write('StartPixelClean', { device_id: null, duration_minutes: body.minutes, preparation_id: preparation });
    const first = await start(null);
    if (first.started) return null;
    const deadline = Date.now() + PIXEL_PREPARE_MS;
    let started = false;
    try {
      while (Date.now() < deadline) {
        const status = await daemon.request('GetPixelCleanPreparation', { session_id: first.session_id });
        if (status.error) throw new Error(status.error);
        if (status.ready) {
          started = (await start(first.session_id)).started === true;
          if (!started) throw new Error('The daemon did not confirm the start');
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('The screens took too long to get ready');
    } finally {
      if (!started) await daemon.write('StopPixelClean', { device_id: null, session_id: first.session_id }).catch(() => {});
    }
  }

  async function setDaemonSettings(body) {
    const config = await daemon.request('GetConfig');
    const next = { ...config };
    if (body.turnOffLcds !== undefined) next.turn_off_lcds_on_shutdown = body.turnOffLcds === true;
    if (body.hardwareVideo !== undefined) next.hardware_video = body.hardwareVideo === true;
    if (body.rgbDrift !== undefined) next.rgb_drift_detection_enabled = body.rgbDrift === true;
    if (body.defaultFps !== undefined) {
      check(isInt(body.defaultFps, 1, 60), 'Frame rate must be 1 to 60');
      next.default_fps = body.defaultFps;
    }
    await daemon.write('SetConfig', { config: next });
  }

  async function setStorage(body) {
    check(body.volume === 'all' || engine.getStats().volumes.some((item) => item.key === body.volume), 'Unknown pool');
    store.data.storageVolume = body.volume;
    store.save();
  }

  async function setSchedules(body) {
    check(Array.isArray(body.schedules) && body.schedules.length <= 16, 'Too many schedules');
    const clean = [];
    for (const item of body.schedules) {
      check(typeof item.name === 'string' && item.name.trim() && item.name.length <= 40, 'Each schedule needs a short name');
      check(/^([01]\d|2[0-3]):[0-5]\d$/.test(item.start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.end), 'Times must be HH:MM');
      check(Array.isArray(item.days) && item.days.every((day) => isInt(day, 0, 6)), 'Invalid days');
      check(isInt(item.brightness, 0, 100), 'Brightness must be 0 to 100');
      const templateId = item.templateId || null;
      if (templateId) check(await knownTemplate(templateId), 'Unknown screen');
      clean.push({
        name: item.name.trim(), start: item.start, end: item.end, days: [...new Set(item.days)],
        brightness: item.brightness, templateId, lightsOff: item.lightsOff === true, enabled: item.enabled === true,
      });
    }
    store.data.schedules = clean;
    store.save();
    await engine.tick();
  }

  async function setAlerts(body) {
    check(isInt(body.diskTempC, 30, 70), 'Temperature must be 30 to 70 °C');
    const storagePct = body.storagePct ?? store.data.alerts.storagePct;
    check(isInt(storagePct, 50, 100), 'Storage limit must be 50 to 100%');
    const coolantC = body.coolantC ?? store.data.alerts.coolantC;
    check(isInt(coolantC, 30, 70), 'Coolant limit must be 30 to 70 °C');
    Object.assign(store.data.alerts, {
      enabled: body.enabled === true,
      diskTempC: body.diskTempC,
      diskProblem: body.diskProblem === true,
      parityErrors: body.parityErrors === true,
      storageFull: body.storageFull === true,
      storagePct,
      coolantHot: body.coolantHot === undefined ? store.data.alerts.coolantHot : body.coolantHot === true,
      coolantC,
    });
    store.save();
    await engine.tick();
  }

  async function muteAlerts(body) {
    check(isInt(body.hours, 0, MAX_MUTE_HOURS), 'Invalid mute time');
    store.data.alerts.muteUntil = body.hours ? engine.now().getTime() + body.hours * 3600000 : 0;
    store.save();
    await engine.tick();
  }

  async function deleteMedia(body) {
    const file = String(body.path || '');
    check(listMedia(options.uploadDir).includes(file), 'Only uploaded files can be deleted here');
    const inUse = Object.values(store.data.screens).some((screen) => screen.path === file);
    check(!inUse, 'A screen is using this file. Choose something else for it first.');
    fs.unlinkSync(file);
  }

  // Streams to a temporary file so a large video never sits in memory.
  function upload(req, url) {
    const name = path.basename(String(url.searchParams.get('name') || '')).replace(/[^\w.-]/g, '_').replace(/^\.+/, '');
    check(name && mediaType(name), 'Use an image, GIF or video file');
    check(Number(req.headers['content-length'] || 0) <= MAX_UPLOAD, 'Files can be up to 512 MB');
    fs.mkdirSync(options.uploadDir, { recursive: true });
    const target = path.join(options.uploadDir, name);
    const temporary = `${target}.${crypto.randomBytes(4).toString('hex')}.part`;
    return new Promise((resolve, reject) => {
      const out = fs.createWriteStream(temporary, { flags: 'wx' });
      let size = 0;
      const fail = (error) => {
        out.destroy();
        fs.rm(temporary, { force: true }, () => reject(error));
      };
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_UPLOAD) {
          req.destroy();
          fail(new BadRequest('Files can be up to 512 MB'));
        }
      });
      req.on('error', fail);
      out.on('error', fail);
      out.on('finish', () => {
        fs.rename(temporary, target, (error) => (error ? fail(error) : resolve({ path: target.split(path.sep).join('/') })));
      });
      req.pipe(out);
    });
  }

  async function preview(url) {
    const id = url.searchParams.get('id');
    const stored = await daemon.request('GetLcdTemplates');
    let template = stored.find((item) => item.id === id);
    const raw = url.searchParams.get('colors');
    const named = url.searchParams.get('theme');
    let colors = null;
    if (raw) {
      try {
        colors = JSON.parse(raw);
      } catch {
        throw new BadRequest('Invalid colours');
      }
      check(validColors(colors), 'Invalid colours');
    } else if (named) {
      check(themeExists(store.data, named), 'Unknown theme');
      colors = themeColors(store.data, named);
    }
    if (colors) template = selectable(colors).find((item) => item.id === id) || template;
    return template ? daemon.request('RenderTemplatePreview', { template, width: 400, height: 400 }) : null;
  }

  // These read the whole config and write it back, so they must not overlap each
  // other or the engine. Handlers that wait for engine.tick() can't go through here.
  const queued = (handler) => (body) => engine.enqueue(() => handler(body));

  const routes = {
    '/api/fan': queued(setFan),
    '/api/curve': queued(saveCurve),
    '/api/curve/delete': queued(deleteCurve),
    '/api/rgb': queued(setRgb),
    '/api/aio': queued(setAio),
    '/api/profile': setProfile,
    '/api/device': setDevice,
    '/api/screen': setScreen,
    '/api/lcd': setLcd,
    '/api/theme': setTheme,
    '/api/pixel': setPixel,
    '/api/settings': queued(setDaemonSettings),
    '/api/storage': setStorage,
    '/api/schedules': setSchedules,
    '/api/alerts': setAlerts,
    '/api/alerts/mute': muteAlerts,
    '/api/media/delete': deleteMedia,
  };

  function send(res, status, type, body, headers = {}) {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      ...headers,
    });
    res.end(body);
  }

  const sendJson = (res, status, value) => send(res, status, 'application/json', JSON.stringify(value));

  function authorized(req) {
    if (!passwordHash) return true;
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const given = crypto.createHash('sha256').update(decoded.slice(decoded.indexOf(':') + 1)).digest();
    return crypto.timingSafeEqual(given, passwordHash);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new BadRequest('Request too large'));
          req.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          check(parsed && typeof parsed === 'object', 'Invalid request');
          resolve(parsed);
        } catch (error) {
          reject(error instanceof BadRequest ? error : new BadRequest('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  return http.createServer(async (req, res) => {
    try {
      if (!authorized(req)) {
        return send(res, 401, 'text/plain', 'Password required', { 'WWW-Authenticate': 'Basic realm="Lian Li"' });
      }
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && STATIC_FILES[url.pathname]) {
        const [file, type] = STATIC_FILES[url.pathname];
        return send(res, 200, type, fs.readFileSync(path.join(publicDir, file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, await state());
      }
      if (req.method === 'GET' && url.pathname === '/api/history') {
        return sendJson(res, 200, history ? history.points : []);
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, await daemon.request('GetInstallationHealth'));
      }
      if (req.method === 'GET' && url.pathname === '/api/export') {
        const backup = { exportedAt: engine.now().toISOString(), daemonConfig: await daemon.request('GetConfig'), dashboard: store.data };
        return send(res, 200, 'application/json', JSON.stringify(backup, null, 2), { 'Content-Disposition': 'attachment; filename="lian-li-backup.json"' });
      }
      if (req.method === 'GET' && url.pathname === '/api/preview') {
        const rendered = await preview(url);
        if (!rendered) return sendJson(res, 404, { error: 'Unknown screen' });
        return send(res, 200, 'image/jpeg', Buffer.from(rendered.jpeg_base64, 'base64'));
      }
      if (req.method === 'POST' && (routes[url.pathname] || url.pathname === '/api/upload')) {
        // A custom header cannot be sent cross-site without a CORS approval,
        // which this server never gives, so other web pages cannot post here.
        if (req.headers['x-lianli-dashboard'] !== '1') return sendJson(res, 403, { error: 'Forbidden' });
        if (url.pathname === '/api/upload') return sendJson(res, 200, await upload(req, url));
        await routes[url.pathname](await readBody(req));
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (error instanceof BadRequest) return sendJson(res, 400, { error: error.message });
      return sendJson(res, 502, { error: error.message });
    }
  });
}

function main() {
  const env = process.env;
  const options = {
    socket: env.LIANLI_SOCKET || '/run/lianli/lianli-daemon.sock',
    emhttpDir: env.EMHTTP_DIR || '/host/emhttp',
    statsDir: env.STATS_DIR || '/run/lianli-stats',
    settingsFile: env.EXTRAS_FILE || '/var/lib/lianli/extras/settings.json',
    historyFile: env.HISTORY_FILE || '/var/lib/lianli/extras/history.json',
    mediaDir: env.MEDIA_DIR || '/media/lianli',
    uploadDir: env.UPLOAD_DIR || '/var/lib/lianli/extras/media',
    port: Number(env.WEB_PORT) || 6090,
    fullAppPort: Number(env.FULL_APP_PORT) || 6080,
    password: env.WEB_PASSWORD || '',
  };

  const store = new Store(options.settingsFile);
  // The hottest AIO's coolant, for the alert and its LCD screen. 0 means no reading.
  let coolant = 0;
  let stats = { ...readStats(options.emhttpDir), coolantMax: coolant };
  const collect = () => {
    stats = { ...readStats(options.emhttpDir), coolantMax: coolant };
    try {
      writeStats(options.statsDir, { ...selectStorage(stats, store.data.storageVolume).values, coolant_temp: coolant });
    } catch (error) {
      stats.error = `Cannot write ${options.statsDir}: ${error.message}`;
    }
  };
  collect();
  setInterval(collect, STATS_INTERVAL_MS);

  const daemon = new DaemonClient(options.socket);
  const engine = new Engine({ daemon, store, statsDir: options.statsDir, getStats: () => stats });
  engine.tick();
  setInterval(() => engine.tick(), ENGINE_INTERVAL_MS);

  const readCoolant = (telemetry) => Math.max(0, ...Object.values(telemetry?.coolant_temps || {}));
  setInterval(async () => {
    coolant = readCoolant(await daemon.request('GetTelemetry').catch(() => null));
  }, STATS_INTERVAL_MS);

  const history = new History(options.historyFile);
  let samples = 0;
  setInterval(async () => {
    const [telemetry, devices] = await Promise.all([
      daemon.request('GetTelemetry').catch(() => null),
      daemon.request('ListDevices').catch(() => []),
    ]);
    const rpms = devices.flatMap((device) => splitRpms(device, telemetry).fans).filter((rpm) => rpm > 0);
    const hottestCoolant = readCoolant(telemetry);
    history.add({
      t: Date.now(),
      coolant: hottestCoolant > 0 ? hottestCoolant : null,
      temp: stats.hasTemps ? stats.values.disk_temp_max : null,
      used: stats.available ? stats.values.storage_used_pct : null,
      rpm: rpms.length ? Math.round(rpms.reduce((sum, rpm) => sum + rpm, 0) / rpms.length) : 0,
    });
    samples += 1;
    if (samples % HISTORY_SAVE_EVERY === 0) {
      try {
        history.save();
      } catch (error) {
        console.error(`extras: cannot save history: ${error.message}`);
      }
    }
  }, HISTORY_INTERVAL_MS);

  createApp({ daemon, engine, store, options, history }).listen(options.port, () => {
    console.log(`lianli-extras: dashboard listening on port ${options.port}`);
  });
}

if (require.main === module) main();

module.exports = { createApp };
