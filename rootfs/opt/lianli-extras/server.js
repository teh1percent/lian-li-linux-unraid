'use strict';

// Web dashboard and Unraid integration, running next to lianli-daemon. The HTTP
// API only exposes fixed operations with validated values: sensor commands
// cannot be set through it, because the daemon would run them as shell.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const { DaemonClient } = require('./lib/daemon');
const { Engine, Store, mediaType, ALERT_TEMPLATES } = require('./lib/engine');
const { buildTemplates } = require('./lib/templates');
const { readStats, selectStorage, writeStats } = require('./lib/unraid');

const STATS_INTERVAL_MS = 5000;
const ENGINE_INTERVAL_MS = 15000;
const MAX_BODY = 64 * 1024;
const MIN_FAN_PERCENT = 20;
const MAX_MUTE_HOURS = 168;
const HIDDEN_RGB_MODES = new Set(['Direct', 'Render', 'Paint', 'Voice']);

class BadRequest extends Error {}

function check(condition, message) {
  if (!condition) throw new BadRequest(message);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
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

function createApp({ daemon, engine, store, options }) {
  const page = path.join(__dirname, 'public', 'index.html');
  const alertIds = new Set(Object.values(ALERT_TEMPLATES));
  const screenTemplates = () => buildTemplates(options.statsDir, engine.getStats().volumes)
    .filter((item) => !alertIds.has(item.id));
  const passwordHash = options.password
    ? crypto.createHash('sha256').update(options.password).digest()
    : null;

  const findDevice = async (deviceId) => {
    const devices = await daemon.request('ListDevices');
    const device = devices.find((item) => item.device_id === deviceId);
    check(device, 'Unknown device');
    return device;
  };

  const knownTemplate = async (id) => {
    if (screenTemplates().some((item) => item.id === id)) return true;
    const stored = await daemon.request('GetLcdTemplates');
    return stored.some((item) => item.id === id && !alertIds.has(id));
  };

  async function state() {
    const stats = selectStorage(engine.getStats(), store.data.storageVolume);
    const base = {
      time: engine.now().toISOString(),
      localTime: engine.now().toLocaleString(),
      timezone: process.env.TZ || 'UTC',
      fullAppPort: options.fullAppPort,
      stats,
      settings: { schedules: store.data.schedules, alerts: store.data.alerts, screens: store.data.screens },
      status: engine.status(),
      media: listMedia(options.mediaDir),
      templates: screenTemplates().map(({ id, name }) => ({ id, name })),
    };
    try {
      const [info, devices, config, telemetry, capabilities] = await Promise.all([
        daemon.request('GetDaemonInfo'),
        daemon.request('ListDevices'),
        daemon.request('GetConfig'),
        daemon.request('GetTelemetry'),
        daemon.request('GetRgbCapabilities').catch(() => []),
      ]);
      const fans = config.fans?.speeds || [];
      const rgbDevices = config.rgb?.devices || [];
      return {
        ...base,
        daemon: { connected: true, version: info.version, mode: info.mode },
        curves: (config.fan_curves || []).map((curve) => curve.name),
        devices: devices.map((device) => {
          const caps = capabilities.find((item) => item.device_id === device.device_id);
          const zone = rgbDevices.find((item) => item.device_id === device.device_id)?.zones?.[0];
          return {
            id: device.device_id,
            name: device.name,
            hasFan: device.has_fan,
            hasRgb: device.has_rgb,
            hasLcd: device.has_lcd,
            unbound: device.is_unbound_wireless,
            fanCount: device.fan_count,
            rpms: telemetry.fan_rpms?.[device.device_id] || [],
            speed: fans.find((group) => group.device_id === device.device_id)?.speeds?.[0] ?? null,
            effect: zone?.effect || null,
            rgbModes: (caps?.supported_modes || []).filter((mode) => !HIDDEN_RGB_MODES.has(mode)),
          };
        }),
      };
    } catch (error) {
      return { ...base, daemon: { connected: false, error: error.message }, curves: [], devices: [] };
    }
  }

  async function setFan(body) {
    const device = await findDevice(body.device_id);
    check(device.has_fan && !device.is_unbound_wireless, 'This device has no controllable fans');
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

  async function setRgb(body) {
    const device = await findDevice(body.device_id);
    check(device.has_rgb && !device.is_unbound_wireless, 'This device has no controllable lighting');
    const capabilities = await daemon.request('GetRgbCapabilities');
    const caps = capabilities.find((item) => item.device_id === device.device_id);
    check(caps?.supported_modes?.includes(body.mode) && !HIDDEN_RGB_MODES.has(body.mode), 'Unsupported effect');
    check(Array.isArray(body.color) && body.color.length === 3 && body.color.every((part) => isInt(part, 0, 255)), 'Invalid colour');
    check(isInt(body.brightness, 0, 4), 'Brightness must be 0 to 4');

    const config = await daemon.request('GetConfig');
    const rgb = config.rgb || { enabled: true, devices: [] };
    const devices = rgb.devices || [];
    let entry = devices.find((item) => item.device_id === device.device_id);
    if (!entry) {
      entry = { device_id: device.device_id, zones: [] };
      devices.push(entry);
    }
    const zoneCount = Math.max(device.rgb_zone_count || 1, 1);
    for (let zone = 0; zone < zoneCount; zone += 1) {
      const existing = entry.zones.find((item) => item.zone_index === zone);
      const effect = { ...(existing?.effect || {}), mode: body.mode, colors: [body.color], brightness: body.brightness, disabled: false };
      if (existing) existing.effect = effect;
      else entry.zones.push({ zone_index: zone, effect });
      await daemon.write('SetRgbEffect', { device_id: device.device_id, zone, effect });
    }
    await daemon.write('SetRgbConfig', { config: { ...rgb, devices } });
  }

  async function setScreen(body) {
    const device = await findDevice(body.device_id);
    check(device.has_lcd, 'This device has no screen');
    const screen = body.screen || {};
    if (screen.kind === 'keep') {
      delete store.data.screens[device.device_id];
    } else {
      if (screen.kind === 'template') {
        check(await knownTemplate(screen.templateId), 'Unknown screen');
        store.data.screens[device.device_id] = { kind: 'template', templateId: screen.templateId };
      } else {
        check(screen.kind === 'media' && listMedia(options.mediaDir).includes(screen.path), 'Unknown media file');
        store.data.screens[device.device_id] = { kind: 'media', path: screen.path };
      }
    }
    store.save();
    await engine.tick();
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
        brightness: item.brightness, templateId, enabled: item.enabled === true,
      });
    }
    store.data.schedules = clean;
    store.save();
    await engine.tick();
  }

  async function setAlerts(body) {
    check(isInt(body.diskTempC, 30, 70), 'Temperature must be 30 to 70 °C');
    Object.assign(store.data.alerts, {
      enabled: body.enabled === true,
      diskTempC: body.diskTempC,
      diskProblem: body.diskProblem === true,
      parityErrors: body.parityErrors === true,
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

  const routes = {
    '/api/fan': setFan,
    '/api/rgb': setRgb,
    '/api/screen': setScreen,
    '/api/storage': setStorage,
    '/api/schedules': setSchedules,
    '/api/alerts': setAlerts,
    '/api/alerts/mute': muteAlerts,
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
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(page));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        return sendJson(res, 200, await state());
      }
      if (req.method === 'GET' && url.pathname === '/api/preview') {
        const id = url.searchParams.get('id');
        const stored = await daemon.request('GetLcdTemplates');
        const template = stored.find((item) => item.id === id);
        if (!template) return sendJson(res, 404, { error: 'Unknown screen' });
        const preview = await daemon.request('RenderTemplatePreview', { template, width: 400, height: 400 });
        return send(res, 200, 'image/jpeg', Buffer.from(preview.jpeg_base64, 'base64'));
      }
      const route = routes[url.pathname];
      if (req.method === 'POST' && route) {
        // A custom header cannot be sent cross-site without a CORS approval,
        // which this server never gives, so other web pages cannot post here.
        if (req.headers['x-lianli-dashboard'] !== '1') return sendJson(res, 403, { error: 'Forbidden' });
        await route(await readBody(req));
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
    mediaDir: env.MEDIA_DIR || '/media/lianli',
    port: Number(env.WEB_PORT) || 6090,
    fullAppPort: Number(env.FULL_APP_PORT) || 6080,
    password: env.WEB_PASSWORD || '',
  };

  const store = new Store(options.settingsFile);
  let stats = readStats(options.emhttpDir);
  const collect = () => {
    stats = readStats(options.emhttpDir);
    try {
      writeStats(options.statsDir, selectStorage(stats, store.data.storageVolume).values);
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

  createApp({ daemon, engine, store, options }).listen(options.port, () => {
    console.log(`lianli-extras: dashboard listening on port ${options.port}`);
  });
}

if (require.main === module) main();

module.exports = { createApp };
