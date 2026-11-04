'use strict';

// Decides what each LCD should show (alert > schedule > chosen screen) and
// applies the difference through the daemon. Only LCDs given a screen here, or
// taken over by an alert or schedule, are touched; anything else stays as set
// in the desktop app.

const fs = require('fs');
const path = require('path');
const { installTemplates, wantedTemplates, themedId } = require('./templates');
const { DEFAULT_LIMITS } = require('./themes');

const TEMP_CLEAR_MARGIN = 2;
const MEDIA_TYPES = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.bmp': 'image',
  '.gif': 'gif',
  '.mp4': 'video', '.mkv': 'video', '.webm': 'video', '.mov': 'video', '.avi': 'video',
};
const ALERT_TEMPLATES = {
  disk: 'unraid_alert_disk',
  parity: 'unraid_alert_parity',
  storage: 'unraid_alert_storage',
  temp: 'unraid_alert_temp',
  coolant: 'unraid_alert_coolant',
};

const defaults = () => ({
  screens: {},
  storageVolume: 'all',
  schedules: [],
  alerts: { enabled: false, diskTempC: 50, diskProblem: true, parityErrors: true, storageFull: true, storagePct: 90, coolantHot: true, coolantC: 50, muteUntil: 0 },
  theme: 'default',
  customColors: null,
  lcdThemes: {},
  limits: { ...DEFAULT_LIMITS },
  names: {},
  snapshots: {},
  baseBrightness: {},
  lightsSnapshot: null,
});

class Store {
  constructor(file) {
    this.file = file;
    this.data = defaults();
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...defaults(), ...saved, alerts: { ...defaults().alerts, ...saved.alerts } };
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`extras: ignoring unreadable ${file}: ${error.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

function minutes(text) {
  const [hours, mins] = text.split(':').map(Number);
  return hours * 60 + mins;
}

function scheduleActive(schedule, now) {
  if (!schedule.enabled) return false;
  const start = minutes(schedule.start);
  const end = minutes(schedule.end);
  const current = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const onDay = (day) => !schedule.days?.length || schedule.days.includes(day);
  if (start === end) return onDay(today);
  if (start < end) return onDay(today) && current >= start && current < end;
  return (onDay(today) && current >= start) || (onDay(yesterday) && current < end);
}

function normalizeId(id) {
  return String(id || '').replace(/^hid:/, '');
}

function mediaType(file) {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] || null;
}

function screenMatches(entry, screen) {
  if (!entry) return false;
  if (screen.kind === 'template') return entry.type === 'custom' && entry.template_id === screen.templateId;
  if (screen.kind === 'media') return entry.type === mediaType(screen.path) && entry.path === screen.path;
  if (screen.kind === 'color') return entry.type === 'color' && String(entry.rgb) === String(screen.rgb);
  return false;
}

function lcdConfig(entry, device, screen) {
  const base = { ...(entry || { serial: device.device_id, orientation: 0 }), path: null, fps: null, rgb: null, template_id: null };
  if (screen.kind === 'template') return { ...base, type: 'custom', template_id: screen.templateId };
  if (screen.kind === 'color') return { ...base, type: 'color', rgb: screen.rgb };
  return { ...base, type: mediaType(screen.path), path: screen.path };
}

function findEntry(config, deviceId) {
  const wanted = normalizeId(deviceId);
  return (config.lcds || []).find((lcd) => normalizeId(lcd.serial) === wanted) || null;
}

class Engine {
  constructor({ daemon, store, statsDir, getStats, now = () => new Date() }) {
    this.daemon = daemon;
    this.store = store;
    this.statsDir = statsDir;
    this.getStats = getStats;
    this.now = now;
    this.tempAlert = false;
    this.coolantAlert = false;
    this.lastError = null;
    this.instance = null;
    this.installed = null;
    this.brightness = new Map();
    this.queue = Promise.resolve();
  }

  // Everything that writes to the daemon runs one at a time.
  enqueue(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  alert() {
    const { alerts } = this.store.data;
    const { values, available, hasTemps, coolantMax = 0 } = this.getStats();
    this.tempAlert = available && hasTemps && values.disk_temp_max >= alerts.diskTempC - (this.tempAlert ? TEMP_CLEAR_MARGIN : 0);
    this.coolantAlert = coolantMax > 0 && coolantMax >= alerts.coolantC - (this.coolantAlert ? TEMP_CLEAR_MARGIN : 0);
    if (!alerts.enabled) return null;
    if (alerts.muteUntil > this.now().getTime()) return null;
    if (available && alerts.diskProblem && (values.disks_bad > 0 || values.disk_errors > 0)) return 'disk';
    // AIO readings don't depend on Unraid's files, so this one works without them.
    if (alerts.coolantHot && this.coolantAlert) return 'coolant';
    if (!available) return null;
    if (alerts.parityErrors && values.parity_errors > 0) return 'parity';
    if (alerts.storageFull && values.volume_max_used_pct >= alerts.storagePct) return 'storage';
    return this.tempAlert ? 'temp' : null;
  }

  activeSchedule() {
    return this.store.data.schedules.find((schedule) => scheduleActive(schedule, this.now())) || null;
  }

  // The copy of a screen in this LCD's own theme, when it has one.
  themed(deviceId, templateId) {
    const { lcdThemes, theme } = this.store.data;
    const own = lcdThemes[deviceId];
    if (!own || own === theme || !templateId.startsWith('unraid_')) return templateId;
    return themedId(templateId, own);
  }

  // What should be on this LCD right now and why.
  plan(device, alert, schedule) {
    const base = this.store.data.screens[device.device_id] || { kind: 'keep' };
    const themedScreen = (screen) => (screen.kind === 'template'
      ? { ...screen, templateId: this.themed(device.device_id, screen.templateId) } : screen);
    if (alert) return { screen: { kind: 'template', templateId: ALERT_TEMPLATES[alert] }, brightness: 100, override: true, reason: `alert:${alert}` };
    if (schedule) {
      const screen = schedule.templateId ? { kind: 'template', templateId: schedule.templateId } : base;
      return { screen: themedScreen(screen), brightness: schedule.brightness ?? null, override: Boolean(schedule.templateId), reason: `schedule:${schedule.name}` };
    }
    return { screen: themedScreen(base), brightness: null, override: false, reason: base.kind === 'keep' ? 'desktop app' : 'chosen screen' };
  }

  tick() {
    return this.enqueue(async () => {
      try {
        await this.run();
        this.lastError = null;
      } catch (error) {
        this.lastError = error.message;
      }
    });
  }

  async run() {
    const info = await this.daemon.request('GetDaemonInfo');
    if (info.instance_id !== this.instance) this.brightness.clear();
    // Screens are generated, so new pools and new colours need installing too.
    const { volumes = [] } = this.getStats();
    const { theme, customColors, lcdThemes, limits } = this.store.data;
    const installed = JSON.stringify([info.instance_id, volumes.map((volume) => volume.key), theme, customColors, lcdThemes, limits]);
    if (installed !== this.installed) {
      await installTemplates(this.daemon, wantedTemplates(this.statsDir, volumes, this.store.data));
      this.installed = installed;
    }
    this.instance = info.instance_id;
    const [devices, config] = await Promise.all([
      this.daemon.request('ListDevices'),
      this.daemon.request('GetConfig'),
    ]);
    const alert = this.alert();
    const schedule = this.activeSchedule();
    const errors = [];
    for (const device of devices.filter((item) => item.has_lcd)) {
      try {
        await this.applyTo(device, config, alert, schedule);
      } catch (error) {
        errors.push(`${device.name}: ${error.message}`);
      }
    }
    try {
      await this.applyLights(devices, config, Boolean(schedule?.lightsOff));
    } catch (error) {
      errors.push(`Lights: ${error.message}`);
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  async applyTo(device, config, alert, schedule) {
    const { snapshots, baseBrightness } = this.store.data;
    const key = device.device_id;
    const entry = findEntry(config, key);
    const plan = this.plan(device, alert, schedule);

    if (plan.override && !(key in snapshots)) {
      snapshots[key] = entry;
      this.store.save();
    }

    if (plan.screen.kind === 'keep') {
      if (key in snapshots) {
        const previous = snapshots[key] || { serial: device.device_id, type: 'color', rgb: [0, 0, 0], path: null, fps: null, orientation: 0 };
        await this.daemon.write('SetLcdMedia', { device_id: `serial:${previous.serial}`, config: previous });
        delete snapshots[key];
        this.store.save();
      }
    } else {
      if (!plan.override && key in snapshots) {
        delete snapshots[key];
        this.store.save();
      }
      if (!screenMatches(entry, plan.screen)) {
        const next = lcdConfig(entry, device, plan.screen);
        await this.daemon.write('SetLcdMedia', { device_id: `serial:${next.serial}`, config: next });
      }
    }

    if (plan.brightness !== null) {
      if (!(key in baseBrightness)) {
        baseBrightness[key] = entry?.brightness ?? 100;
        this.store.save();
      }
      if (this.brightness.get(key) !== plan.brightness) {
        await this.daemon.write('SetLcdBrightness', { device_id: key, brightness: plan.brightness });
        this.brightness.set(key, plan.brightness);
      }
    } else if (key in baseBrightness) {
      await this.daemon.write('SetLcdBrightness', { device_id: key, brightness: baseBrightness[key] });
      delete baseBrightness[key];
      this.brightness.delete(key);
      this.store.save();
    }
  }

  // Lights-off schedules save the lighting setup, and put it back afterwards.
  async applyLights(devices, config, off) {
    const { store } = this;
    const lights = devices.filter((device) => device.has_rgb && !device.is_unbound_wireless);
    const send = async (rgb) => {
      await this.daemon.write('SetRgbConfig', { config: rgb });
      for (const device of rgb.devices) {
        if (!lights.some((item) => item.device_id === device.device_id)) continue;
        for (const zone of device.zones) {
          await this.daemon.write('SetRgbEffect', { device_id: device.device_id, zone: zone.zone_index, effect: zone.effect });
        }
      }
    };

    if (off && !store.data.lightsSnapshot) {
      const rgb = config.rgb || { enabled: true, devices: [] };
      store.data.lightsSnapshot = rgb;
      store.save();
      const known = rgb.devices || [];
      const dark = lights.map((device) => {
        const existing = known.find((item) => item.device_id === device.device_id);
        const zones = existing?.zones?.length
          ? existing.zones
          : Array.from({ length: Math.max(device.rgb_zone_count || 1, 1) }, (_, zone) => ({ zone_index: zone, effect: {} }));
        return { ...(existing || { device_id: device.device_id }), zones: zones.map((zone) => ({ ...zone, effect: { ...zone.effect, mode: 'Off' } })) };
      });
      const others = known.filter((item) => !dark.some((device) => device.device_id === item.device_id));
      await send({ ...rgb, devices: [...others, ...dark] });
    } else if (!off && store.data.lightsSnapshot) {
      await send(store.data.lightsSnapshot);
      store.data.lightsSnapshot = null;
      store.save();
    }
  }

  status() {
    const alert = this.alert();
    const schedule = this.activeSchedule();
    return {
      alert,
      schedule: schedule ? schedule.name : null,
      lightsOff: Boolean(this.store.data.lightsSnapshot),
      muted: this.store.data.alerts.muteUntil > this.now().getTime(),
      error: this.lastError,
    };
  }
}

module.exports = { Engine, Store, scheduleActive, mediaType, findEntry, ALERT_TEMPLATES };
