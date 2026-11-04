'use strict';

// Decides what each LCD should show (alert > schedule > chosen screen) and
// applies the difference through the daemon. Only LCDs given a screen here, or
// taken over by an alert or schedule, are touched; anything else stays as set
// in the desktop app.

const fs = require('fs');
const path = require('path');
const { installTemplates } = require('./templates');

const TEMP_CLEAR_MARGIN = 2;
const MEDIA_TYPES = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.bmp': 'image',
  '.gif': 'gif',
  '.mp4': 'video', '.mkv': 'video', '.webm': 'video', '.mov': 'video', '.avi': 'video',
};
const ALERT_TEMPLATES = {
  disk: 'unraid_alert_disk',
  parity: 'unraid_alert_parity',
  temp: 'unraid_alert_temp',
};

const defaults = () => ({
  screens: {},
  storageVolume: 'all',
  schedules: [],
  alerts: { enabled: false, diskTempC: 50, diskProblem: true, parityErrors: true, muteUntil: 0 },
  snapshots: {},
  baseBrightness: {},
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
  return false;
}

function lcdConfig(entry, device, screen) {
  const base = { ...(entry || { serial: device.device_id, orientation: 0 }), path: null, fps: null, rgb: null, template_id: null };
  if (screen.kind === 'template') return { ...base, type: 'custom', template_id: screen.templateId };
  return { ...base, type: mediaType(screen.path), path: screen.path };
}

class Engine {
  constructor({ daemon, store, statsDir, getStats, now = () => new Date() }) {
    this.daemon = daemon;
    this.store = store;
    this.statsDir = statsDir;
    this.getStats = getStats;
    this.now = now;
    this.tempAlert = false;
    this.lastError = null;
    this.instance = null;
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
    const { values, available, hasTemps } = this.getStats();
    this.tempAlert = available && hasTemps && values.disk_temp_max >= alerts.diskTempC - (this.tempAlert ? TEMP_CLEAR_MARGIN : 0);
    if (!alerts.enabled || !available) return null;
    if (alerts.muteUntil > this.now().getTime()) return null;
    if (alerts.diskProblem && (values.disks_bad > 0 || values.disk_errors > 0)) return 'disk';
    if (alerts.parityErrors && values.parity_errors > 0) return 'parity';
    return this.tempAlert ? 'temp' : null;
  }

  activeSchedule() {
    return this.store.data.schedules.find((schedule) => scheduleActive(schedule, this.now())) || null;
  }

  // What should be on this LCD right now and why.
  plan(device, alert, schedule) {
    const base = this.store.data.screens[device.device_id] || { kind: 'keep' };
    if (alert) return { screen: { kind: 'template', templateId: ALERT_TEMPLATES[alert] }, brightness: 100, override: true, reason: `alert:${alert}` };
    if (schedule) {
      const screen = schedule.templateId ? { kind: 'template', templateId: schedule.templateId } : base;
      return { screen, brightness: schedule.brightness, override: Boolean(schedule.templateId), reason: `schedule:${schedule.name}` };
    }
    return { screen: base, brightness: null, override: false, reason: base.kind === 'keep' ? 'desktop app' : 'chosen screen' };
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
    // Pool screens are generated, so a new pool needs installing too.
    const { volumes = [] } = this.getStats();
    const installed = JSON.stringify([info.instance_id, volumes.map((volume) => volume.key)]);
    if (installed !== this.installed) {
      await installTemplates(this.daemon, this.statsDir, volumes);
      this.installed = installed;
    }
    this.instance = info.instance_id;
    const [devices, config] = await Promise.all([
      this.daemon.request('ListDevices'),
      this.daemon.request('GetConfig'),
    ]);
    const lcds = devices.filter((device) => device.has_lcd);
    const alert = this.alert();
    const schedule = this.activeSchedule();
    const errors = [];
    for (const device of lcds) {
      try {
        await this.applyTo(device, config, alert, schedule);
      } catch (error) {
        errors.push(`${device.name}: ${error.message}`);
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  async applyTo(device, config, alert, schedule) {
    const { snapshots, baseBrightness } = this.store.data;
    const key = device.device_id;
    const wanted = normalizeId(key);
    const entry = (config.lcds || []).find((lcd) => normalizeId(lcd.serial) === wanted) || null;
    const plan = this.plan(device, alert, schedule);
    let dirty = false;

    if (plan.override && !(key in snapshots)) {
      snapshots[key] = entry;
      dirty = true;
    }
    if (dirty) this.store.save();

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

  status() {
    const alert = this.alert();
    const schedule = this.activeSchedule();
    return {
      alert,
      schedule: schedule ? schedule.name : null,
      muted: this.store.data.alerts.muteUntil > this.now().getTime(),
      error: this.lastError,
    };
  }
}

module.exports = { Engine, Store, scheduleActive, mediaType, ALERT_TEMPLATES };
