'use strict';

// Daemon settings, restoring backups, the diagnostic report and update checks.

const fs = require('fs');

const { check, isInt, isText } = require('./check');
const { isColor } = require('./themes');

const LOG_TAIL_BYTES = 1024 * 1024;
const LOG_LINES = 100;
const LOG_LINE_MAX = 2048;
const UPDATE_URL = 'https://api.github.com/repos/sgtaziz/lian-li-linux/releases/latest';
const UPDATE_TTL_MS = 24 * 3600000;
const UPDATE_RETRY_MS = 3600000;
const FETCH_TIMEOUT_MS = 10000;
const BACKUP_KINDS = new Set(['configuration', 'templates', 'rgb_presets', 'profile']);
const SECRET = /token|secret|password|authorization|cookie|credential/i;
const FILE_EXT = /\.(json|png|jpe?g|gif|webp|mp4|mkv|webm|ttf|otf|conf|log)\b/i;
const PUBLIC_SLASH = /^(\/dev\/dri\/(renderD|card)\d*|SL\/AL|USB\/HID|\d+\/\d+|retry\/retries|active\/running|inactive\/dead|failed\/failed)[,.:;)]*$/;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g; // eslint-disable-line no-control-regex

// The report is meant for sharing, so paths, secrets and long ids stay out of it.
function redactLine(raw) {
  const line = raw.replace(ANSI, '').trim().slice(0, LOG_LINE_MAX);
  const words = [];
  for (const word of line.split(/\s+/)) {
    if (SECRET.test(word)) {
      words.push('[redacted]');
      break;
    }
    if (word.includes('/') && !PUBLIC_SLASH.test(word)) {
      words.push('[path redacted]');
      break;
    }
    if (FILE_EXT.test(word)) words.push('[file redacted]');
    else if (/[A-Za-z0-9]{24,}/.test(word)) words.push('[identifier redacted]');
    else words.push(word);
  }
  return words.join(' ');
}

function readLogTail(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(handle);
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').filter((line) => line.trim()).slice(-LOG_LINES).map(redactLine);
  } finally {
    fs.closeSync(handle);
  }
}

function newerThan(latest, current) {
  const parts = (text) => String(text).replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const [one, two] = [parts(latest), parts(current)];
  for (let index = 0; index < 3; index += 1) {
    if ((one[index] || 0) !== (two[index] || 0)) return (one[index] || 0) > (two[index] || 0);
  }
  return false;
}

function cleanTarget(target) {
  check(target && BACKUP_KINDS.has(target.kind), 'Unknown backup');
  if (target.kind !== 'profile') return { kind: target.kind };
  check(isText(target.name, 128) && target.name, 'Unknown backup');
  return { kind: 'profile', name: target.name };
}

function createMaintenance({ daemon, engine, options, fetchJson = defaultFetch }) {
  let update = null;

  async function setSettings(body) {
    const config = await daemon.request('GetConfig');
    const next = { ...config };
    if (body.turnOffLcds !== undefined) next.turn_off_lcds_on_shutdown = body.turnOffLcds === true;
    if (body.hardwareVideo !== undefined) next.hardware_video = body.hardwareVideo === true;
    if (body.rgbDrift !== undefined) next.rgb_drift_detection_enabled = body.rgbDrift === true;
    if (body.driftInterval !== undefined) {
      check(isInt(body.driftInterval, 100, 10000), 'Check interval must be 100 to 10000 ms');
      next.rgb_drift_detection_interval_ms = body.driftInterval;
    }
    if (body.defaultFps !== undefined) {
      check(isInt(body.defaultFps, 1, 120), 'Frame rate must be 1 to 120');
      next.default_fps = body.defaultFps;
    }
    if (body.hidBackend !== undefined) {
      check(body.hidBackend === 'hidraw' || body.hidBackend === 'rusb', 'Unknown USB backend');
      next.hid_backend = body.hidBackend;
    }
    if (body.thermal !== undefined) {
      const thermal = { ...config.thermal_alert };
      for (const part of ['cpu', 'gpu']) {
        const value = body.thermal?.[part];
        if (value === undefined) continue;
        check(isInt(value.threshold, 20, 120), 'Temperature must be 20 to 120 °C');
        check(isColor(value.color), 'Invalid colour');
        thermal[part] = { enabled: value.enabled === true, threshold: value.threshold, alert_color: value.color };
      }
      next.thermal_alert = thermal;
    }
    if (body.openrgb !== undefined) {
      const { enabled, port, regions, perFan } = body.openrgb;
      check(isInt(port, 1, 65535), 'Port must be 1 to 65535');
      next.rgb = {
        enabled: true, devices: [], ...config.rgb, openrgb_server: enabled === true, openrgb_port: port,
        openrgb_regions: regions === true, openrgb_per_fan_zones: perFan === true,
      };
    }
    await daemon.write('SetConfig', { config: next });
  }

  async function previewBackup(body) {
    return daemon.request('PreviewStateBackup', { target: cleanTarget(body.target), preserved: body.preserved === true });
  }

  async function restoreBackup(body) {
    check(/^[0-9a-f]{64}$/i.test(body.sha256 || ''), 'Preview this backup first');
    await daemon.write('RestoreStateBackup', { target: cleanTarget(body.target), sha256: body.sha256 });
    await engine.tick();
  }

  async function deleteBackup(body) {
    check(/^[0-9a-f]{64}$/i.test(body.sha256 || ''), 'Preview this backup first');
    await daemon.write('DeleteStateBackup', { target: cleanTarget(body.target), preserved: body.preserved === true, sha256: body.sha256 });
  }

  async function diagnostics() {
    const [info, telemetry, report] = await Promise.all([
      daemon.request('GetDaemonInfo'),
      daemon.request('GetTelemetry').catch(() => ({})),
      daemon.request('GetInstallationHealth').catch(() => ({})),
    ]);
    let logs;
    try {
      logs = { source: 'daemon', messages: readLogTail(options.logFile) };
    } catch (error) {
      logs = { source: 'daemon', unavailable: `Log not readable: ${error.code || 'error'}` };
    }
    return {
      format_version: 1,
      checked_at_unix_ms: engine.now().getTime(),
      installation_context: 'unraid_docker',
      daemon_context: report.context ?? null,
      daemon: { version: info.version, protocol_version: info.protocol_version, mode: info.mode, pid: info.pid },
      services: null,
      findings: (report.findings || []).slice(0, 64).map(({ code, state, severity, feature, title, evidence }) => ({ code, state, severity, feature, title, evidence })),
      media_preparation: telemetry.media_preparation || [],
      desktop_streams: telemetry.desktop_streams || [],
      logs,
      privacy: 'Paths, secrets, file names and long identifiers are removed from log lines. Check the file before sharing it.',
    };
  }

  async function checkUpdate() {
    const current = (await daemon.request('GetDaemonInfo')).version;
    const now = Date.now();
    if (!update || now > update.expires) {
      try {
        const release = await fetchJson(UPDATE_URL);
        update = { latest: String(release.tag_name || '').replace(/^v/, ''), url: release.html_url, error: null, expires: now + UPDATE_TTL_MS };
      } catch (error) {
        update = { latest: null, url: null, error: error.message, expires: now + UPDATE_RETRY_MS };
      }
    }
    return { current, latest: update.latest, error: update.error, updateAvailable: update.latest ? newerThan(update.latest, current) : false };
  }

  return {
    routes: {
      '/api/settings': setSettings,
      '/api/openrgb/retry': () => daemon.write('RetryOpenRgb'),
      '/api/backups/restore': restoreBackup,
      '/api/backups/delete': deleteBackup,
    },
    unqueued: new Set(['/api/backups/restore']),
    dataRoutes: { '/api/backups/preview': previewBackup },
    gets: { '/api/backups': () => daemon.request('ListStateBackups'), '/api/update': checkUpdate },
    downloads: {
      '/api/diagnostics': async () => ({ name: 'lian-li-diagnostics.json', body: JSON.stringify(await diagnostics(), null, 2) }),
    },
    state: ({ config, telemetry, info }) => ({
      capabilities: info.capabilities || [],
      daemonSettings: {
        turnOffLcds: config.turn_off_lcds_on_shutdown !== false,
        hardwareVideo: config.hardware_video === true,
        rgbDrift: config.rgb_drift_detection_enabled !== false,
        driftInterval: config.rgb_drift_detection_interval_ms ?? 1000,
        defaultFps: config.default_fps ?? null,
        hidBackend: config.hid_backend || 'hidraw',
        thermal: {
          cpu: { enabled: false, threshold: 80, alert_color: [255, 0, 0], ...config.thermal_alert?.cpu },
          gpu: { enabled: false, threshold: 80, alert_color: [0, 0, 255], ...config.thermal_alert?.gpu },
        },
        openrgb: {
          enabled: config.rgb?.openrgb_server === true,
          port: config.rgb?.openrgb_port ?? 6743,
          regions: config.rgb?.openrgb_regions === true,
          perFan: config.rgb?.openrgb_per_fan_zones === true,
          status: telemetry.openrgb_status || null,
        },
      },
    }),
  };
}

async function defaultFetch(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'lianli-dashboard', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

module.exports = { createMaintenance, redactLine, newerThan };
