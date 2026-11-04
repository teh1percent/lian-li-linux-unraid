'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const extras = path.join(__dirname, '..', 'rootfs', 'opt', 'lianli-extras');
const { DaemonClient } = require(path.join(extras, 'lib', 'daemon'));
const { Engine, Store, scheduleActive } = require(path.join(extras, 'lib', 'engine'));
const { buildTemplates } = require(path.join(extras, 'lib', 'templates'));
const { computeStats, readStats, writeStats, EMPTY_VALUES } = require(path.join(extras, 'lib', 'unraid'));
const { createApp } = require(path.join(extras, 'server'));
const { createMockDaemon } = require('./mock-daemon');

const fixtures = path.join(__dirname, 'fixtures');
const disksIni = fs.readFileSync(path.join(fixtures, 'disks.ini'), 'utf8');
const varIni = fs.readFileSync(path.join(fixtures, 'var.ini'), 'utf8');

let dir, mock, socketPath, stats, clock, store, engine, http, base;

function listen(server, target) {
  return new Promise((resolve) => server.listen(target, resolve));
}

function call(url, body, headers = { 'X-Lianli-Dashboard': '1' }) {
  return fetch(`${base}${url}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lianli-extras-'));
  socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\lianli-test-${process.pid}-${Date.now()}` : path.join(dir, 'daemon.sock');
  mock = createMockDaemon();
  await listen(mock.server, socketPath);
  stats = { available: true, error: null, ...computeStats(disksIni, varIni) };
  clock = new Date(2026, 10, 3, 12, 0, 0);
  store = new Store(path.join(dir, 'settings.json'));
  const daemon = new DaemonClient(socketPath);
  engine = new Engine({ daemon, store, statsDir: '/run/lianli-stats', getStats: () => stats, now: () => clock });
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  fs.writeFileSync(path.join(media, 'logo.png'), 'x');
  fs.writeFileSync(path.join(media, 'notes.txt'), 'x');
  http = createApp({ daemon, engine, store, options: { statsDir: '/run/lianli-stats', mediaDir: media, fullAppPort: 6081, password: '' } });
  await listen(http, 0);
  base = `http://127.0.0.1:${http.address().port}`;
});

afterEach(async () => {
  await new Promise((resolve) => http.close(resolve));
  await new Promise((resolve) => mock.server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

const entryFor = (id) => mock.state.config.lcds.find((lcd) => lcd.serial === id);
const LCD1 = 'usb:1-2';

test('stats use only present array drives and skip sleeping ones', () => {
  const { values, disks } = computeStats(disksIni, varIni);
  assert.strictEqual(values.disk_temp_max, 44);
  assert.strictEqual(values.disks_active, 3);
  assert.strictEqual(values.disks_total, 4);
  assert.strictEqual(values.array_used_pct, 75);
  assert.strictEqual(values.cache_used_pct, 25);
  assert.strictEqual(values.sync_pct, 0);
  assert.strictEqual(values.array_started, 1);
  assert.ok(!disks.some((disk) => disk.name === 'flash' || disk.name === 'disk3'));
});

test('stats detect a parity check, parity errors and failed disks', () => {
  const failing = disksIni.replace('status="DISK_OK"\ntemp="44"\nnumErrors="0"', 'status="DISK_DSBL"\ntemp="44"\nnumErrors="7"');
  const running = varIni.replace('mdResyncPos="0"', 'mdResyncPos="3907013266"').replace('sbSyncErrs="0"', 'sbSyncErrs="12"');
  const { values } = computeStats(failing, running);
  assert.strictEqual(values.disks_bad, 1);
  assert.strictEqual(values.disk_errors, 7);
  assert.strictEqual(values.parity_errors, 12);
  assert.strictEqual(values.sync_pct, 50);
});

test('missing Unraid files report unavailable with zero values', () => {
  const result = readStats(path.join(dir, 'nope'));
  assert.strictEqual(result.available, false);
  assert.deepStrictEqual(result.values, EMPTY_VALUES);
});

test('stat files hold a single number that a sensor command can parse', () => {
  const target = path.join(dir, 'stats');
  writeStats(target, stats.values);
  const text = fs.readFileSync(path.join(target, 'array_used_pct'), 'utf8');
  assert.strictEqual(Number(text.split(/\s+/)[0]), 75);
});

test('templates respect limits the daemon validates and read only stat files', () => {
  for (const template of buildTemplates('/run/lianli-stats')) {
    assert.ok(template.id && template.name.trim());
    for (const widget of template.widgets) {
      assert.ok(widget.width > 0 && widget.height > 0, widget.id);
      if (widget.update_interval_ms) assert.ok(widget.update_interval_ms >= 100 && widget.update_interval_ms <= 10000);
      const source = widget.kind.source;
      if (source?.type === 'command') assert.match(source.cmd, /^cat \/run\/lianli-stats\/[a-z_]+$/);
    }
  }
});

test('schedules handle overnight ranges and days', () => {
  const night = { enabled: true, start: '23:00', end: '07:00', days: [] };
  assert.ok(scheduleActive(night, new Date(2026, 10, 3, 23, 30)));
  assert.ok(scheduleActive(night, new Date(2026, 10, 3, 6, 59)));
  assert.ok(!scheduleActive(night, new Date(2026, 10, 3, 7, 0)));
  assert.ok(!scheduleActive({ ...night, enabled: false }, new Date(2026, 10, 3, 23, 30)));
  // Tuesday's night still runs into early Wednesday, but not into Thursday.
  const tuesday = { ...night, days: [2] };
  assert.ok(scheduleActive(tuesday, new Date(2026, 10, 3, 23, 30)));
  assert.ok(scheduleActive(tuesday, new Date(2026, 10, 4, 1, 0)));
  assert.ok(!scheduleActive(tuesday, new Date(2026, 10, 5, 1, 0)));
});

test('templates install alongside user templates, once', async () => {
  await engine.tick();
  assert.strictEqual(engine.lastError, null);
  assert.ok(mock.state.templates.some((item) => item.id === 'user_made'));
  assert.ok(mock.state.templates.some((item) => item.id === 'unraid_drives'));
  const writes = mock.state.writes.length;
  engine.instance = null;
  await engine.tick();
  assert.strictEqual(mock.state.writes.length, writes);
});

test('each fan can show a different screen and unmanaged LCDs stay untouched', async () => {
  await engine.tick();
  let response = await call('/api/screen', { device_id: LCD1, screen: { kind: 'template', templateId: 'unraid_drives' } });
  assert.strictEqual(response.status, 200);
  response = await call('/api/screen', { device_id: 'usb:1-3', screen: { kind: 'template', templateId: 'unraid_array' } });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_drives');
  assert.strictEqual(entryFor('usb:1-3').template_id, 'unraid_array');
  assert.strictEqual(entryFor('usb:1-4'), undefined);
  const writes = mock.state.writes.length;
  await engine.tick();
  assert.strictEqual(mock.state.writes.length, writes, 'no writes when nothing changed');
});

test('media must come from the media folder', async () => {
  const good = path.join(dir, 'media', 'logo.png').split(path.sep).join('/');
  assert.strictEqual((await call('/api/screen', { device_id: LCD1, screen: { kind: 'media', path: good } })).status, 200);
  assert.strictEqual(entryFor(LCD1).type, 'image');
  const outside = await call('/api/screen', { device_id: LCD1, screen: { kind: 'media', path: '/etc/passwd' } });
  assert.strictEqual(outside.status, 400);
  const notMedia = await call('/api/screen', { device_id: LCD1, screen: { kind: 'media', path: path.join(dir, 'media', 'notes.txt') } });
  assert.strictEqual(notMedia.status, 400);
});

test('a temperature alert takes over and then restores what was there', async () => {
  mock.state.config.lcds.push({ serial: LCD1, type: 'color', rgb: [1, 2, 3], path: null, fps: null, orientation: 90, brightness: 60 });
  store.data.alerts.enabled = true;
  store.data.alerts.diskTempC = 40;
  await engine.tick();
  assert.strictEqual(engine.lastError, null);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_alert_temp');
  assert.strictEqual(entryFor(LCD1).orientation, 90);
  assert.strictEqual(mock.state.brightness[LCD1], 100);

  // Inside the 2 degree margin the alert holds, so screens don't flicker.
  stats.values.disk_temp_max = 39;
  await engine.tick();
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_alert_temp');

  stats.values.disk_temp_max = 37;
  await engine.tick();
  assert.deepStrictEqual(entryFor(LCD1).rgb, [1, 2, 3]);
  assert.strictEqual(entryFor(LCD1).type, 'color');
  assert.strictEqual(mock.state.brightness[LCD1], 60);
  assert.deepStrictEqual(store.data.snapshots, {});
  assert.deepStrictEqual(store.data.baseBrightness, {});
});

test('an alert survives a restart and still restores afterwards', async () => {
  mock.state.config.lcds.push({ serial: LCD1, type: 'color', rgb: [1, 2, 3], path: null, fps: null, orientation: 0 });
  store.data.alerts.enabled = true;
  store.data.alerts.diskTempC = 40;
  await engine.tick();
  const reloaded = new Store(store.file);
  const again = new Engine({ daemon: engine.daemon, store: reloaded, statsDir: '/run/lianli-stats', getStats: () => stats, now: () => clock });
  stats.values.disk_temp_max = 30;
  await again.tick();
  assert.deepStrictEqual(entryFor(LCD1).rgb, [1, 2, 3]);
});

test('muting stops an alert until it expires', async () => {
  store.data.alerts.enabled = true;
  store.data.alerts.diskTempC = 40;
  store.data.screens[LCD1] = { kind: 'template', templateId: 'unraid_array' };
  await engine.tick();
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_alert_temp');
  assert.strictEqual((await call('/api/alerts/mute', { hours: 24 })).status, 200);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_array');
  clock = new Date(clock.getTime() + 25 * 3600000);
  await engine.tick();
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_alert_temp');
});

test('alerts rank disk problems first and ignore sleeping drives', async () => {
  store.data.alerts.enabled = true;
  store.data.alerts.diskTempC = 40;
  stats.values.disks_bad = 1;
  stats.values.parity_errors = 3;
  assert.strictEqual(engine.alert(), 'disk');
  stats.values.disks_bad = 0;
  assert.strictEqual(engine.alert(), 'parity');
  stats.values.parity_errors = 0;
  assert.strictEqual(engine.alert(), 'temp');
  stats.hasTemps = false;
  assert.strictEqual(engine.alert(), null);
});

test('a schedule dims and optionally swaps the screen, then restores', async () => {
  mock.state.config.lcds.push({ serial: LCD1, type: 'custom', template_id: 'user_made', path: null, fps: null, orientation: 0, rgb: null, brightness: 80 });
  const response = await call('/api/schedules', {
    schedules: [{ name: 'Night', start: '11:00', end: '13:00', days: [], brightness: 10, templateId: 'unraid_overview', enabled: true }],
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(mock.state.brightness[LCD1], 10);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_overview');
  clock = new Date(2026, 10, 3, 14, 0);
  await engine.tick();
  assert.strictEqual(mock.state.brightness[LCD1], 80);
  assert.strictEqual(entryFor(LCD1).template_id, 'user_made');
});

test('fan speed is converted to PWM and kept apart from other groups', async () => {
  const id = 'wireless:1c:17:07:f5:10';
  mock.state.config.fans.speeds.push({ device_id: 'wireless:other', speeds: [128, 128, 128, 0] });
  assert.strictEqual((await call('/api/fan', { device_id: id, mode: 'constant', percent: 100 })).status, 200);
  const group = mock.state.config.fans.speeds.find((item) => item.device_id === id);
  assert.deepStrictEqual(group.speeds, [255, 255, 255, 0]);
  assert.strictEqual(mock.state.config.fans.speeds.length, 2);
  assert.strictEqual(mock.state.config.fans.update_interval_ms, 1000);
  assert.strictEqual((await call('/api/fan', { device_id: id, mode: 'curve', curve: 'Quiet' })).status, 200);
  assert.deepStrictEqual(mock.state.config.fans.speeds.find((item) => item.device_id === id).speeds, ['Quiet', 'Quiet', 'Quiet', 0]);
});

test('fans cannot be stopped or given unknown curves through the API', async () => {
  const id = 'wireless:1c:17:07:f5:10';
  assert.strictEqual((await call('/api/fan', { device_id: id, mode: 'constant', percent: 0 })).status, 400);
  assert.strictEqual((await call('/api/fan', { device_id: id, mode: 'curve', curve: 'Nope' })).status, 400);
  assert.strictEqual((await call('/api/fan', { device_id: 'nope', mode: 'constant', percent: 50 })).status, 400);
});

test('lighting applies live to every zone and persists', async () => {
  const id = 'wireless:1c:17:07:f5:10';
  const body = { device_id: id, mode: 'Static', color: [10, 20, 30], brightness: 2 };
  assert.strictEqual((await call('/api/rgb', body)).status, 200);
  assert.strictEqual(mock.state.effects.length, 3);
  const saved = mock.state.config.rgb.devices.find((item) => item.device_id === id);
  assert.strictEqual(saved.zones.length, 3);
  assert.deepStrictEqual(saved.zones[0].effect.colors, [[10, 20, 30]]);
  assert.strictEqual((await call('/api/rgb', { ...body, mode: 'Direct' })).status, 400);
});

test('the API refuses cross-site posts and never accepts sensor commands', async () => {
  const blocked = await call('/api/alerts/mute', { hours: 1 }, {});
  assert.strictEqual(blocked.status, 403);
  const injected = await call('/api/screen', { device_id: LCD1, screen: { kind: 'template', templateId: 'x; rm -rf /' } });
  assert.strictEqual(injected.status, 400);
  const alertTemplate = await call('/api/screen', { device_id: LCD1, screen: { kind: 'template', templateId: 'unraid_alert_temp' } });
  assert.strictEqual(alertTemplate.status, 400);
});

test('state reports devices, stats and media, and survives a stopped daemon', async () => {
  let state = await (await call('/api/state')).json();
  assert.strictEqual(state.daemon.connected, true);
  assert.strictEqual(state.devices.length, 6);
  assert.strictEqual(state.devices[0].rgbModes.includes('Direct'), false);
  assert.strictEqual(state.media.length, 1);
  assert.strictEqual(state.stats.values.disk_temp_max, 44);
  await new Promise((resolve) => { mock.server.close(resolve); mock.server = { close: (done) => done() }; });
  state = await (await call('/api/state')).json();
  assert.strictEqual(state.daemon.connected, false);
});

test('password protection applies to everything when set', async () => {
  const locked = createApp({ daemon: engine.daemon, engine, store, options: { statsDir: '/run/lianli-stats', mediaDir: dir, fullAppPort: 6081, password: 'secret' } });
  await listen(locked, 0);
  const url = `http://127.0.0.1:${locked.address().port}`;
  try {
    assert.strictEqual((await fetch(`${url}/`)).status, 401);
    assert.strictEqual((await fetch(`${url}/api/state`)).status, 401);
    const wrong = `Basic ${Buffer.from('x:nope').toString('base64')}`;
    assert.strictEqual((await fetch(`${url}/`, { headers: { Authorization: wrong } })).status, 401);
    const right = `Basic ${Buffer.from('x:secret').toString('base64')}`;
    assert.strictEqual((await fetch(`${url}/`, { headers: { Authorization: right } })).status, 200);
  } finally {
    await new Promise((resolve) => locked.close(resolve));
  }
});
