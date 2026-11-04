'use strict';

// Fan speed per group and per fan, motherboard sync and curve smoothing.

const { check, isInt, isNumber } = require('./check');

const MIN_FAN_PERCENT = 20;
const MB_SYNC = '__mb_sync__';
const SLOTS = 4;

function createFans({ daemon, findDevice, isAio }) {
  function speedOf(spec, config) {
    if (spec.mode === 'constant') {
      check(isInt(spec.percent, MIN_FAN_PERCENT, 100), `Speed must be ${MIN_FAN_PERCENT} to 100%`);
      return Math.round((spec.percent / 100) * 255);
    }
    check(spec.mode === 'curve', 'Unknown fan mode');
    check((config.fan_curves || []).some((curve) => curve.name === spec.curve), 'Unknown fan curve');
    return spec.curve;
  }

  async function mbSpeed(device, header) {
    if (device.mb_sync_support === true) return MB_SYNC;
    // Without hardware sync, a bare sync value would run the fans at full speed.
    const headers = await daemon.request('ListPwmHeaders').catch(() => []);
    check(headers.some((item) => item.id === header), 'Choose a motherboard fan header');
    return `${MB_SYNC}:${header}`;
  }

  async function setFan(body) {
    const device = await findDevice(body.device_id);
    check(device.has_fan && !device.is_unbound_wireless, 'This device has no controllable fans');
    check(!isAio(device), 'Set this one on the AIO page');
    const config = await daemon.request('GetConfig');
    const count = Math.min(device.fan_count || SLOTS, SLOTS);
    let speeds;
    if (body.mode === 'mb') {
      speeds = Array(SLOTS).fill(await mbSpeed(device, body.header));
    } else if (body.slots !== undefined) {
      check(Array.isArray(body.slots) && body.slots.length === count, 'One speed is needed for each fan');
      speeds = Array.from({ length: SLOTS }, (_, slot) => (slot < count ? speedOf(body.slots[slot] || {}, config) : 0));
    } else {
      const speed = speedOf(body, config);
      speeds = Array.from({ length: SLOTS }, (_, slot) => (slot < count ? speed : 0));
    }
    const fans = config.fans || { speeds: [] };
    const others = (fans.speeds || []).filter((group) => group.device_id !== device.device_id);
    await daemon.write('SetFanConfig', { config: { ...fans, speeds: [...others, { device_id: device.device_id, speeds }] } });
  }

  async function setTuning(body) {
    const config = await daemon.request('GetConfig');
    const fans = { speeds: [], ...config.fans };
    if (body.updateIntervalMs !== undefined) {
      check(isInt(body.updateIntervalMs, 100, 10000), 'Update interval must be 100 to 10000 ms');
      fans.update_interval_ms = body.updateIntervalMs;
    }
    if (body.hysteresisTemp !== undefined) {
      check(isNumber(body.hysteresisTemp, 0, 10), 'Temperature smoothing must be 0 to 10 °C');
      fans.hysteresis_temp = body.hysteresisTemp;
    }
    if (body.hysteresisPercent !== undefined) {
      check(isNumber(body.hysteresisPercent, 0, 19.6), 'Speed smoothing must be 0 to 19.6%');
      fans.hysteresis_pwm = Math.min(Math.round((body.hysteresisPercent / 100) * 255), 50);
    }
    await daemon.write('SetFanConfig', { config: fans });
  }

  async function setQuantity(body) {
    const device = await findDevice(body.device_id);
    check(device.has_fan && device.max_fan_quantity > 0, 'This device has a fixed number of fans');
    check(isInt(body.quantity, 1, device.max_fan_quantity), `Choose 1 to ${device.max_fan_quantity} fans`);
    await daemon.write('SetEne6k77FanQuantity', { device_id: device.device_id, quantity: body.quantity });
  }

  return {
    routes: { '/api/fan': setFan, '/api/fan/tuning': setTuning, '/api/fan/quantity': setQuantity },
    state: async ({ config }) => ({
      pwmHeaders: await daemon.request('ListPwmHeaders').catch(() => []),
      fanTuning: {
        updateIntervalMs: config.fans?.update_interval_ms ?? 1000,
        hysteresisTemp: config.fans?.hysteresis_temp ?? 1,
        hysteresisPercent: Math.round(((config.fans?.hysteresis_pwm ?? 5) / 255) * 1000) / 10,
      },
    }),
    device: (device, { config }) => ({
      speeds: (config.fans?.speeds || []).find((group) => group.device_id === device.device_id)?.speeds?.slice(0, Math.min(device.fan_count || SLOTS, SLOTS)) ?? [],
      perFan: device.per_fan_control === true,
      mbHardware: device.mb_sync_support === true,
      maxFanQuantity: device.max_fan_quantity || 0,
    }),
  };
}

module.exports = { createFans, MIN_FAN_PERCENT };
