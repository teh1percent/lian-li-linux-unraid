'use strict';

// Lighting beyond one effect per device: zones, regions, single LEDs, presets,
// Quick Sync and motherboard sync. Effects are saved in the daemon's config,
// which applies them. Regional devices refuse per-zone calls, so config is the
// only route that works on every device.

const { check, isInt, isText } = require('./check');
const { isColor } = require('./themes');

const DIRECTIONS = new Set(['Clockwise', 'CounterClockwise', 'Up', 'Down', 'Spread', 'Gather']);
const SCOPES = new Set(['Fan', 'All', 'Top', 'Bottom', 'Inner', 'Outer', 'Center', 'Pump', 'Front', 'Rear', 'Segment1', 'Segment2', 'Segment3', 'Segment4', 'Segment5', 'Segment6']);
const MATCHED_MODES = ['Rainbow', 'RainbowMorph', 'Static', 'Breathing', 'Meteor', 'Runway'];
const LED_PRESET = 'Custom LEDs';
const MAX_EFFECT_COLORS = 64;
const MAX_SYNC_COLORS = 6;
const MAX_SYNC_DEVICES = 64;

function allModes(caps) {
  return new Set([
    ...(caps.supported_modes || []), ...(caps.group_effect_modes || []), ...(caps.zone_effect_modes || []),
    ...(caps.region_parameters || []).flatMap((region) => (region.effects || []).map((item) => item.mode)),
  ]);
}

function cleanEffect(input, modes, previous = {}) {
  check(input && typeof input === 'object', 'Invalid effect');
  check(modes.has(input.mode), 'This device does not support that effect');
  const colors = input.colors ?? previous.colors ?? [[255, 255, 255]];
  check(Array.isArray(colors) && colors.length >= 1 && colors.length <= MAX_EFFECT_COLORS && colors.every(isColor), 'Invalid colour');
  const speed = input.speed ?? previous.speed ?? 2;
  const brightness = input.brightness ?? previous.brightness ?? 4;
  const direction = input.direction ?? previous.direction ?? 'Clockwise';
  const scope = input.scope ?? previous.scope ?? 'All';
  check(isInt(speed, 0, 4), 'Speed must be 0 to 4');
  check(isInt(brightness, 0, 4) || brightness === 255, 'Brightness must be 0 to 4');
  check(DIRECTIONS.has(direction), 'Unknown direction');
  check(SCOPES.has(scope), 'Unknown part of the fan');
  return { ...previous, mode: input.mode, colors, speed, brightness, direction, scope, disabled: false };
}

function presetName(name) {
  check(isText(name, 80) && name.trim(), 'Presets need a name');
  return name.trim();
}

function createLights({ daemon, findDevice, store }) {
  async function capsOf(deviceId) {
    const device = await findDevice(deviceId);
    check(device.has_rgb && !device.is_unbound_wireless, 'This device has no controllable lighting');
    check(!store.data.lightsSnapshot, 'A schedule has the lights off right now. Change it on the Auto page first.');
    const caps = (await daemon.request('GetRgbCapabilities')).find((item) => item.device_id === device.device_id);
    check(caps, 'This device is still starting up');
    return { device, caps };
  }

  // Every read-modify-write of the lighting config comes through here.
  async function editEntry(deviceId, change) {
    const config = await daemon.request('GetConfig');
    const rgb = config.rgb || { enabled: true, openrgb_server: false, openrgb_port: 6743, openrgb_regions: false, openrgb_per_fan_zones: false, devices: [] };
    rgb.devices ||= [];
    let entry = rgb.devices.find((item) => item.device_id === deviceId);
    if (!entry) {
      entry = { device_id: deviceId, zones: [] };
      rgb.devices.push(entry);
    }
    entry.zones ||= [];
    const result = change(entry, rgb);
    entry.active_preset = null;
    await daemon.write('SetRgbConfig', { config: rgb });
    return result;
  }

  function padZones(entry, caps) {
    if (caps.hardware_group_effects) return;
    const allDirect = entry.zones.length > 0 && entry.zones.every((zone) => zone.effect?.mode === 'Direct');
    for (let index = 0; index < (caps.zones || []).length; index += 1) {
      if (entry.zones.some((zone) => zone.zone_index === index)) continue;
      entry.zones.push({ zone_index: index, effect: { mode: allDirect ? 'Direct' : 'Static', colors: [[255, 255, 255]], speed: 2, brightness: 4 } });
    }
    entry.zones.sort((one, two) => one.zone_index - two.zone_index);
  }

  async function setZone(body) {
    const { device, caps } = await capsOf(body.device_id);
    const zoneCount = (caps.zones || []).length;
    check(isInt(body.zone, 0, Math.max(zoneCount - 1, 0)), 'Unknown zone');
    const modes = allModes(caps);
    await editEntry(device.device_id, (entry) => {
      padZones(entry, caps);
      let zone = entry.zones.find((item) => item.zone_index === body.zone);
      if (!zone) {
        zone = { zone_index: body.zone, effect: {} };
        entry.zones.push(zone);
      }
      zone.effect = cleanEffect(body.effect, modes, zone.effect);
      if (body.applyToAll === true) {
        for (const other of entry.zones) other.effect = JSON.parse(JSON.stringify(zone.effect));
      }
    });
  }

  async function setRegions(body) {
    const { device, caps } = await capsOf(body.device_id);
    const allowed = caps.region_parameters || [];
    check(allowed.length > 0 || (caps.effect_regions || []).length > 0, 'This device has no regions');
    if (body.regions === null) return editEntry(device.device_id, (entry) => { entry.regions = null; });
    check(Array.isArray(body.regions) && body.regions.length > 0, 'Choose at least one region');
    const scopeNames = new Set(allowed.map((item) => item.scope));
    const regions = body.regions.map((region) => {
      const scope = region.effect?.scope;
      check(scopeNames.has(scope), 'Unknown region');
      const modes = new Set((allowed.find((item) => item.scope === scope).effects || []).map((item) => item.mode));
      return { effect: cleanEffect(region.effect, modes), flip: region.flip === true };
    });
    const used = regions.map((region) => region.effect.scope);
    check(new Set(used).size === used.length, 'Each region can only be set once');
    check(!used.includes('All') || used.length === 1, 'All must be the only region');
    return editEntry(device.device_id, (entry) => { entry.regions = regions; });
  }

  async function readLeds(url) {
    const zone = Number(url.searchParams.get('zone'));
    check(isInt(zone, 0, 255), 'Unknown zone');
    const device = await findDevice(url.searchParams.get('device_id'));
    return daemon.request('GetZoneColors', { device_id: device.device_id, zone });
  }

  // Live LED colours are lost on restart unless a preset holds them, and a
  // config entry only takes 64 colours, so they're kept in a preset.
  async function setLeds(body) {
    const { device, caps } = await capsOf(body.device_id);
    check(caps.supports_direct && (caps.software_modes || []).length > 0, 'This device cannot set single LEDs');
    const zoneInfo = caps.zones?.[body.zone];
    check(zoneInfo, 'Unknown zone');
    check(Array.isArray(body.colors) && body.colors.length >= 1 && body.colors.length <= zoneInfo.led_count && body.colors.every(isColor), 'Invalid LED colours');
    await editEntry(device.device_id, (entry) => {
      padZones(entry, caps);
      entry.regions = null;
      for (const zone of entry.zones) zone.effect = { ...zone.effect, mode: 'Direct' };
    });
    await daemon.write('SetRgbDirect', { device_id: device.device_id, zone: body.zone, colors: body.colors });
    await daemon.write('SaveRgbPreset', { name: LED_PRESET, device_id: device.device_id });
    await daemon.write('ApplyRgbPreset', { name: LED_PRESET, device_id: device.device_id });
  }

  async function setPreset(body) {
    const name = presetName(body.name);
    const { device } = await capsOf(body.device_id);
    const params = { name, device_id: device.device_id };
    if (body.action === 'save') return daemon.write('SaveRgbPreset', params);
    if (body.action === 'apply') return daemon.write('ApplyRgbPreset', params);
    check(body.action === 'delete', 'Unknown action');
    await daemon.write('DeleteRgbPreset', params);
    const config = await daemon.request('GetConfig');
    const entry = config.rgb?.devices?.find((item) => item.device_id === device.device_id);
    if (entry?.active_preset !== name) return null;
    return editEntry(device.device_id, () => {});
  }

  async function setSync(body) {
    check(body.kind === 'Continuous' || body.kind === 'Matched', 'Unknown sync style');
    const capabilities = await daemon.request('GetRgbCapabilities');
    const config = await daemon.request('GetConfig');
    const motherboard = new Set((config.rgb?.devices || []).filter((entry) => entry.mb_rgb_sync).map((entry) => entry.device_id));
    check(Array.isArray(body.devices) && body.devices.length <= MAX_SYNC_DEVICES, 'Too many devices');
    const eligible = (caps) => caps && !motherboard.has(caps.device_id) && !caps.rf_owned
      && (body.kind === 'Continuous' ? caps.sync_led_count !== null && caps.sync_led_count !== undefined : (caps.supported_modes || []).includes(body.mode));
    const chosen = body.devices.map((id) => capabilities.find((caps) => caps.device_id === id));
    check(chosen.every(eligible), 'One of those devices cannot join this sync');
    check(new Set(body.devices).size === body.devices.length, 'A device is listed twice');
    if (body.enabled) check(chosen.length >= 2, 'Choose at least two devices');
    if (body.kind === 'Continuous') {
      check(chosen.every((caps) => (caps.sync_effect_parameters || []).some((item) => item.mode === body.mode)), 'Not all of those devices support that effect');
    } else {
      check(MATCHED_MODES.includes(body.mode), 'Unsupported effect');
    }
    const colors = body.colors ?? [];
    check(Array.isArray(colors) && colors.length <= MAX_SYNC_COLORS && colors.every(isColor), 'Invalid colour');
    check(isInt(body.speed, 0, 4), 'Speed must be 0 to 4');
    check(isInt(body.brightness, 0, 4), 'Brightness must be 0 to 4');
    const reversed = new Set(Array.isArray(body.reversed) ? body.reversed : []);
    const others = capabilities.map((caps) => caps.device_id).filter((id) => !body.devices.includes(id));
    await daemon.write('SetMergeLightingConfig', {
      config: {
        ...config.rgb?.merge_lighting,
        enabled: body.enabled === true,
        kind: body.kind,
        device_order: body.devices,
        directions: body.devices.map((id) => (reversed.has(id) ? 'CounterClockwise' : 'Clockwise')),
        disabled_devices: others.slice(0, MAX_SYNC_DEVICES),
        effect: { mode: body.mode, colors, speed: body.speed, brightness: body.brightness, direction: 'Clockwise', scope: 'All', disabled: false },
      },
    });
  }

  async function setMotherboard(body) {
    const { device, caps } = await capsOf(body.device_id);
    check(caps.supports_mb_rgb_sync, 'This device has no motherboard lighting sync');
    await daemon.write('SetMbRgbSync', { device_id: device.device_id, enabled: body.enabled === true });
    await editEntry(device.device_id, (entry, rgb) => {
      const base = (id) => id.replace(/:(port|group)\d+$/, '');
      for (const item of rgb.devices) {
        if (base(item.device_id) !== base(device.device_id)) continue;
        item.mb_rgb_sync = body.enabled === true;
        item.active_preset = null;
        if (!caps.hardware_group_effects) {
          for (const zone of item.zones || []) zone.effect = { ...zone.effect, mode: 'Static' };
        }
      }
      entry.mb_rgb_sync = body.enabled === true;
    });
  }

  async function setSwap(body) {
    const { device, caps } = await capsOf(body.device_id);
    check(caps.supports_direction, 'This device has no direction setting');
    check(isInt(body.zone, 0, 255), 'Unknown zone');
    const swapLr = body.swapLr === true;
    const swapTb = body.swapTb === true;
    await editEntry(device.device_id, (entry) => {
      padZones(entry, caps);
      const zone = entry.zones.find((item) => item.zone_index === body.zone);
      check(zone, 'Unknown zone');
      zone.swap_lr = swapLr;
      zone.swap_tb = swapTb;
    });
    // A save only sends this when a flag is on, so turning both off needs the call.
    await daemon.write('SetFanDirection', { device_id: device.device_id, zone: body.zone, swap_lr: swapLr, swap_tb: swapTb });
  }

  async function setLedCount(body) {
    const { device, caps } = await capsOf(body.device_id);
    const control = caps.fan_led_count_control;
    check(control, 'This device has a fixed LED count');
    if (body.count !== null) check(isInt(body.count, control.min, control.max), `Choose ${control.min} to ${control.max} LEDs`);
    await editEntry(device.device_id, (entry) => {
      if (body.count === null) delete entry.fan_led_count;
      else entry.fan_led_count = body.count;
    });
  }

  return {
    routes: {
      '/api/rgb/zone': setZone, '/api/rgb/regions': setRegions, '/api/rgb/leds': setLeds, '/api/rgb/preset': setPreset,
      '/api/rgb/sync': setSync, '/api/rgb/motherboard': setMotherboard, '/api/rgb/swap': setSwap, '/api/rgb/led-count': setLedCount,
    },
    gets: { '/api/rgb/leds': readLeds },
    state: async ({ config, capabilities }) => ({
      rgbPresets: (await daemon.request('ListRgbPresets').catch(() => [])).map((preset) => ({ name: preset.name, deviceId: preset.device_id })),
      quickSync: config.rgb?.merge_lighting || null,
      matchedModes: MATCHED_MODES,
      syncDevices: capabilities.filter((caps) => !caps.rf_owned).map((caps) => ({
        id: caps.device_id,
        continuous: caps.sync_led_count !== null && caps.sync_led_count !== undefined,
        modes: caps.supported_modes || [],
        continuousModes: (caps.sync_effect_parameters || []).map((item) => item.mode),
      })),
    }),
    device: (device, { config, capabilities }) => {
      const caps = capabilities.find((item) => item.device_id === device.device_id);
      if (!caps) return { lighting: null };
      const entry = (config.rgb?.devices || []).find((item) => item.device_id === device.device_id);
      return {
        lighting: {
          zones: (caps.zones || []).map((zone, index) => {
            const saved = entry?.zones?.find((item) => item.zone_index === index);
            return { name: zone.name, leds: zone.led_count, effect: saved?.effect || null, swapLr: saved?.swap_lr === true, swapTb: saved?.swap_tb === true };
          }),
          regions: entry?.regions || null,
          regionOptions: caps.region_parameters || [],
          perZone: !(caps.effect_regions || []).length && !(caps.group_effect_modes || []).length,
          leds: caps.supports_direct === true && (caps.software_modes || []).length > 0,
          scopes: caps.supported_scopes || [],
          motherboardCapable: caps.supports_mb_rgb_sync === true,
          motherboard: entry?.mb_rgb_sync === true,
          swap: caps.supports_direction === true,
          ledCount: caps.fan_led_count_control ? { ...caps.fan_led_count_control, value: entry?.fan_led_count ?? null } : null,
          activePreset: entry?.active_preset || null,
          waiting: caps.deferred_reason || null,
        },
      };
    },
  };
}

module.exports = { createLights };
