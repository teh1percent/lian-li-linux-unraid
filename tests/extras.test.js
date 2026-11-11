'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const extras = path.join(__dirname, '..', 'rootfs', 'opt', 'lianli-extras');
const { Auth } = require(path.join(extras, 'lib', 'auth'));
const { DaemonClient } = require(path.join(extras, 'lib', 'daemon'));
const { Engine, Store, scheduleActive } = require(path.join(extras, 'lib', 'engine'));
const { History } = require(path.join(extras, 'lib', 'history'));
const { toScreenSource } = require(path.join(extras, 'lib', 'sources'));
const { buildTemplates, tempSensors, sensorKey, sensorKeysInUse, screenGroups } = require(path.join(extras, 'lib', 'templates'));
const { computeStats, readStats, writeStats, EMPTY_VALUES } = require(path.join(extras, 'lib', 'unraid'));
const { createApp } = require(path.join(extras, 'server'));
const { createMockDaemon } = require('./mock-daemon');

const fixtures = path.join(__dirname, 'fixtures');
const disksIni = fs.readFileSync(path.join(fixtures, 'disks.ini'), 'utf8');
const varIni = fs.readFileSync(path.join(fixtures, 'var.ini'), 'utf8');

let dir, mock, socketPath, stats, clock, store, engine, http, base, auth, session;

function listen(server, target) {
  return new Promise((resolve) => server.listen(target, resolve));
}

function call(url, body, extraHeaders = { 'X-Lianli-Dashboard': '1' }) {
  const headers = { Cookie: session, ...extraHeaders };
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
  auth = new Auth(path.join(dir, 'auth.json'));
  await auth.setup('test password');
  session = `lianli_session=${auth.session()}`;
  http = createApp({ daemon, engine, store, options: { statsDir: '/run/lianli-stats', mediaDir: media, uploadDir: path.join(dir, 'uploads') }, auth });
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
  // 9.25 of 13 used across the array and the cache pool.
  assert.strictEqual(values.storage_used_pct, 71.2);
  assert.strictEqual(values.sync_pct, 0);
  assert.strictEqual(values.array_started, 1);
  assert.ok(!disks.some((disk) => disk.name === 'flash' || disk.name === 'disk3'));
});

test('ZFS pools count once each, however their members report size', () => {
  const member = (name, sizes, temp = '30') => `["${name}"]\nname="${name}"\ndevice="sd${name}"\nstatus="DISK_OK"\ntemp="${temp}"\nnumErrors="0"\n${sizes}type="Cache"\ncolor="green-on"\n`;
  const whole = 'fsSize="1000"\nfsFree="400"\n';
  const disks = [
    // Only the first member reports the filesystem.
    member('tank', whole), member('tank2', ''), member('tank3', 'fsSize="0"\nfsFree="0"\n'),
    // Every member reports the same filesystem.
    member('fast', 'fsSize="3000"\nfsFree="3000"\n'), member('fast2', 'fsSize="3000"\nfsFree="3000"\n'),
    // A special vdev belongs to its pool.
    member('tank~special', ''),
  ].join('');
  const { values, volumes, hasArray } = computeStats(disks, 'mdState="STARTED"\n');
  assert.strictEqual(hasArray, false);
  assert.deepStrictEqual(volumes.map((volume) => [volume.name, volume.usedPct]), [['tank', 60], ['fast', 0]]);
  assert.strictEqual(values.storage_used_pct, 15);
  assert.strictEqual(values.array_used_pct, 0);
  assert.strictEqual(values.disks_total, 6);
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
  const hostile = computeStats('["a;rm -rf"]\nname="a;rm -rf"\ndevice="sdx"\nstatus="DISK_OK"\nfsSize="10"\nfsFree="5"\ntype="Cache"\n', '').volumes;
  for (const template of buildTemplates('/run/lianli-stats', [...stats.volumes, ...hostile])) {
    assert.ok(template.id && template.name.trim());
    for (const widget of template.widgets) {
      assert.ok(widget.width > 0 && widget.height > 0, widget.id);
      if (widget.update_interval_ms) assert.ok(widget.update_interval_ms >= 100 && widget.update_interval_ms <= 10000);
      const source = widget.kind.source;
      if (source?.type === 'command') assert.match(source.cmd, /^cat \/run\/lianli-stats\/[a-z0-9_-]+$/);
    }
  }
});

test('temperature colours change at real degrees, as the daemon reads ranges', () => {
  // Same calculation as range_color and unit_interval in lianli-media.
  const colourAt = (widget, reading) => {
    const { ranges, value_min: min, value_max: max } = widget.kind;
    const percent = Math.min(Math.max((reading - min) / (max - min), 0), 1) * 100;
    return ranges.find((range) => range.max === null || percent <= range.max).color.join();
  };
  const [drives, , , overview] = buildTemplates('/run/lianli-stats');
  const widgets = [drives.widgets.find((w) => w.id === 'gauge'), overview.widgets.find((w) => w.id === 'temp')];
  for (const widget of widgets) {
    assert.strictEqual(colourAt(widget, 33), '0,200,90', widget.id);
    assert.strictEqual(colourAt(widget, 45), '230,150,0', widget.id);
    assert.strictEqual(colourAt(widget, 55), '225,40,40', widget.id);
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
  engine.installed = null;
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

test('a screen can show all storage or one pool, and new pools get a screen', async () => {
  await engine.tick();
  const state = await (await call('/api/state')).json();
  const ids = state.templates.map((item) => item.id);
  assert.ok(ids.includes('unraid_array'));
  assert.ok(ids.includes('unraid_volume_cache'));
  assert.ok(stats.values.volume_cache_used_pct === 25);
  assert.strictEqual((await call('/api/screen', { device_id: LCD1, screen: { kind: 'template', templateId: 'unraid_volume_cache' } })).status, 200);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_volume_cache');
  assert.strictEqual((await call('/api/screen', { device_id: 'usb:1-3', screen: { kind: 'template', templateId: 'unraid_array' } })).status, 200);
  assert.strictEqual(entryFor('usb:1-3').template_id, 'unraid_array');

  stats.volumes = [...stats.volumes, { name: 'tank', key: 'tank', usedPct: 10, freeTb: 9, sizeTb: 10 }];
  await engine.tick();
  assert.strictEqual(engine.lastError, null);
  assert.ok(mock.state.templates.some((item) => item.id === 'unraid_volume_tank'));
});

test('the storage picker chooses one pool, remembers it and falls back to all', async () => {
  const before = await (await call('/api/state')).json();
  assert.strictEqual(before.stats.selectedVolume, 'all');
  assert.strictEqual(before.stats.values.storage_used_pct, 71.2);

  assert.strictEqual((await call('/api/storage', { volume: 'cache' })).status, 200);
  const picked = await (await call('/api/state')).json();
  assert.strictEqual(picked.stats.selectedVolume, 'cache');
  assert.strictEqual(picked.stats.values.storage_used_pct, 25);
  assert.strictEqual(new Store(store.file).data.storageVolume, 'cache');

  assert.strictEqual((await call('/api/storage', { volume: '../../etc' })).status, 400);
  assert.strictEqual(store.data.storageVolume, 'cache');

  stats.volumes = stats.volumes.filter((volume) => volume.key !== 'cache');
  const removed = await (await call('/api/state')).json();
  assert.strictEqual(removed.stats.selectedVolume, 'all');
  assert.strictEqual(removed.stats.values.storage_used_pct, 71.2);
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

const FAN = 'wireless:1c:17:07:f5:10';
const gaugeColors = (template) => template.widgets.find((widget) => widget.id === 'gauge').kind.ranges.map((range) => range.color.join());
const stored = (id) => mock.state.templates.find((item) => item.id === id);

test('a theme recolours the Unraid screens and limits move, but alerts stay red', async () => {
  await engine.tick();
  const red = JSON.stringify(stored('unraid_alert_temp').background);
  assert.strictEqual((await call('/api/theme', { theme: 'ocean', limits: { ...store.data.limits, storageWarn: 50, storageDanger: 60 } })).status, 200);
  assert.strictEqual(engine.lastError, null);
  assert.deepStrictEqual(stored('unraid_drives').background.rgb, [4, 18, 36, 255]);
  assert.strictEqual(gaugeColors(stored('unraid_array'))[0], '0,180,230');
  assert.strictEqual(stored('unraid_array').widgets.find((widget) => widget.id === 'gauge').kind.ranges[0].max, 50);
  assert.strictEqual(JSON.stringify(stored('unraid_alert_temp').background), red);
});

test('custom colours and limits are validated', async () => {
  const colors = { background: [1, 2, 3], text: [4, 5, 6], muted: [7, 8, 9], track: [1, 1, 1], good: [2, 2, 2], warn: [3, 3, 3], bad: [4, 4, 4] };
  assert.strictEqual((await call('/api/theme', { theme: 'custom' })).status, 400);
  assert.strictEqual((await call('/api/theme', { customColors: { ...colors, bad: [999, 0, 0] } })).status, 400);
  assert.strictEqual((await call('/api/theme', { limits: { ...store.data.limits, tempWarn: 60, tempDanger: 50 } })).status, 400);
  assert.strictEqual((await call('/api/theme', { theme: 'custom', customColors: colors })).status, 200);
  assert.deepStrictEqual(stored('unraid_drives').background.rgb, [1, 2, 3, 255]);
  const preview = await call(`/api/preview?id=unraid_drives&colors=${encodeURIComponent(JSON.stringify(colors))}`);
  assert.strictEqual(preview.status, 200);
  assert.strictEqual((await call('/api/preview?id=unraid_drives&colors=nope')).status, 400);
});

test('one LCD can use its own theme without changing the others', async () => {
  await call('/api/screen', { device_id: LCD1, screen: { kind: 'template', templateId: 'unraid_drives' } });
  await call('/api/screen', { device_id: 'usb:1-3', screen: { kind: 'template', templateId: 'unraid_drives' } });
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, theme: 'ember' })).status, 200);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_drives__ember');
  assert.strictEqual(entryFor('usb:1-3').template_id, 'unraid_drives');
  assert.deepStrictEqual(stored('unraid_drives__ember').background.rgb, [20, 8, 4, 255]);
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, theme: 'nope' })).status, 400);
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, theme: null })).status, 200);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_drives');
});

test('fan curves follow listed sensors only and never take a command from the API', async () => {
  const state = await (await call('/api/state')).json();
  assert.ok(!state.sensors.some((sensor) => sensor.name.includes('command')));
  assert.ok(state.sensors.some((sensor) => sensor.id === 'unraid:disk_temp_max'));
  const points = [[30, 25], [50, 100]];
  assert.strictEqual((await call('/api/curve', { name: 'Drives', sensor: 'unraid:disk_temp_max', points })).status, 200);
  const curve = mock.state.config.fan_curves.find((item) => item.name === 'Drives');
  assert.strictEqual(curve.temp_command, 'cat /run/lianli-stats/disk_temp_max');
  assert.deepStrictEqual(curve.temp_source, { type: 'command', cmd: curve.temp_command });

  const attacks = [
    { name: 'Bad', sensor: JSON.stringify({ type: 'command', cmd: 'rm -rf /' }), points },
    { name: 'Bad', sensor: 'unraid:disk_temp_max;reboot', points },
    { name: 'Bad', sensor: 'unraid:disk_temp_max', points, temp_command: 'rm -rf /', temp_source: { type: 'command', cmd: 'rm -rf /' } },
  ];
  assert.strictEqual((await call('/api/curve', attacks[0])).status, 400);
  assert.strictEqual((await call('/api/curve', attacks[1])).status, 400);
  await call('/api/curve', attacks[2]);
  for (const item of mock.state.config.fan_curves) assert.ok(!String(item.temp_command).includes('rm -rf'));
});

test('curve points are checked: rising, in range, and fans cannot stop', async () => {
  const send = (points, name = 'New') => call('/api/curve', { name, sensor: 'unraid:disk_temp_max', points });
  assert.strictEqual((await send([[50, 50], [30, 60]])).status, 400);
  assert.strictEqual((await send([[30, 0], [50, 60]])).status, 400);
  assert.strictEqual((await send([[30, 50]])).status, 400);
  assert.strictEqual((await send([[30, 50], [50, 60]], 'off')).status, 400);
  assert.strictEqual((await send([[30, 50], [50, 60]], 'Quiet')).status, 200, 'editing overwrites by name');
  assert.strictEqual(mock.state.config.fan_curves.length, 1);
});

test('renaming a curve moves the fans using it, and a curve in use cannot be deleted', async () => {
  await call('/api/fan', { device_id: FAN, mode: 'curve', curve: 'Quiet' });
  assert.strictEqual((await call('/api/curve/delete', { name: 'Quiet' })).status, 400);
  const body = { original: 'Quiet', name: 'Silent', sensor: 'unraid:disk_temp_max', points: [[30, 30], [50, 60]] };
  assert.strictEqual((await call('/api/curve', body)).status, 200);
  assert.strictEqual(mock.state.config.fans.speeds[0].speeds[0], 'Silent');
  await call('/api/fan', { device_id: FAN, mode: 'constant', percent: 50 });
  assert.strictEqual((await call('/api/curve/delete', { name: 'Silent' })).status, 200);
  assert.strictEqual(mock.state.config.fan_curves.length, 0);
});

test('lighting takes several colours, speed and direction', async () => {
  const body = { device_id: FAN, mode: 'Meteor', colors: [[1, 1, 1], [2, 2, 2]], brightness: 3, speed: 4, direction: 'CounterClockwise' };
  assert.strictEqual((await call('/api/rgb', body)).status, 200);
  const effect = mock.state.config.rgb.devices[0].zones[0].effect;
  assert.deepStrictEqual(effect.colors, body.colors);
  assert.strictEqual(effect.speed, 4);
  assert.strictEqual(effect.direction, 'CounterClockwise');
  assert.strictEqual((await call('/api/rgb', { ...body, speed: 9 })).status, 400);
  assert.strictEqual((await call('/api/rgb', { ...body, direction: 'Sideways' })).status, 400);
  assert.strictEqual((await call('/api/rgb', { ...body, colors: Array(5).fill([1, 1, 1]) })).status, 400);
});

test('a lights-off schedule restores the lighting afterwards', async () => {
  await call('/api/rgb', { device_id: FAN, mode: 'Static', color: [9, 9, 9], brightness: 4 });
  const schedule = { name: 'Night', start: '11:00', end: '13:00', days: [], brightness: 50, templateId: null, lightsOff: true, enabled: true };
  assert.strictEqual((await call('/api/schedules', { schedules: [schedule] })).status, 200);
  assert.strictEqual(engine.lastError, null);
  const zones = () => mock.state.config.rgb.devices.find((item) => item.device_id === FAN).zones;
  assert.strictEqual(zones()[0].effect.mode, 'Off');
  assert.deepStrictEqual(zones()[0].effect.colors, [[9, 9, 9]]);
  assert.ok(mock.state.config.rgb.devices.length === 3, 'every paired group goes dark');
  assert.strictEqual((await call('/api/rgb', { device_id: FAN, mode: 'Static', color: [1, 1, 1], brightness: 4 })).status, 400);
  clock = new Date(2026, 10, 3, 14, 0);
  await engine.tick();
  assert.strictEqual(zones()[0].effect.mode, 'Static');
  assert.strictEqual(mock.state.config.rgb.devices.length, 1);
  assert.strictEqual(store.data.lightsSnapshot, null);
});

test('saved setups can be made, used and removed, with safe names', async () => {
  assert.strictEqual((await call('/api/profile', { action: 'save', name: 'Desk', device_id: FAN })).status, 200);
  const state = await (await call('/api/state')).json();
  assert.deepStrictEqual(state.profiles, [{ name: 'Desk', deviceId: FAN }]);
  assert.strictEqual((await call('/api/profile', { action: 'apply', name: 'Desk', device_id: FAN })).status, 200);
  assert.strictEqual(mock.state.applied.name, 'Desk');
  for (const name of ['../../etc/passwd', '..', 'a/b', '']) {
    assert.strictEqual((await call('/api/profile', { action: 'save', name, device_id: FAN })).status, 400, name);
  }
  assert.strictEqual((await call('/api/profile', { action: 'delete', name: 'Desk' })).status, 200);
  assert.strictEqual(mock.state.profiles.length, 0);
});

test('devices can be paired, identified and renamed', async () => {
  const fan = mock.state.fans[1];
  fan.is_unbound_wireless = true;
  assert.strictEqual((await call('/api/device', { device_id: fan.device_id, action: 'bind' })).status, 200);
  assert.deepStrictEqual(mock.state.binds, [['BindWirelessDevice', 'f6:0b:07:f5:11']]);

  mock.state.bindResult = { status: 'failed', message: 'No answer' };
  const failed = await call('/api/device', { device_id: fan.device_id, action: 'bind' });
  assert.strictEqual(failed.status, 502);
  assert.strictEqual((await failed.json()).error, 'No answer');

  fan.foreign_master_online = true;
  assert.strictEqual((await call('/api/device', { device_id: fan.device_id, action: 'bind' })).status, 400);
  assert.strictEqual((await call('/api/device', { device_id: LCD1, action: 'bind' })).status, 400);

  assert.strictEqual((await call('/api/device', { device_id: FAN, action: 'identify' })).status, 200);
  assert.deepStrictEqual(mock.state.pings, [{ device_id: FAN, zone: 0 }]);

  assert.strictEqual((await call('/api/device', { device_id: FAN, action: 'rename', name: 'Top' })).status, 200);
  let state = await (await call('/api/state')).json();
  assert.strictEqual(state.devices.find((item) => item.id === FAN).name, 'Top');
  await call('/api/device', { device_id: FAN, action: 'rename', name: '' });
  state = await (await call('/api/state')).json();
  assert.notStrictEqual(state.devices.find((item) => item.id === FAN).name, 'Top');
});

test('a screen can be a solid colour, dimmed and rotated', async () => {
  assert.strictEqual((await call('/api/screen', { device_id: LCD1, screen: { kind: 'color', rgb: [5, 6, 7] } })).status, 200);
  assert.strictEqual(entryFor(LCD1).type, 'color');
  assert.deepStrictEqual(entryFor(LCD1).rgb, [5, 6, 7]);
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, brightness: 40 })).status, 200);
  assert.strictEqual(mock.state.brightness[LCD1], 40);
  assert.strictEqual(entryFor(LCD1).brightness, 40);
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, orientation: 180 })).status, 200);
  assert.strictEqual(entryFor(LCD1).orientation, 180);
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, orientation: 45 })).status, 400);
  assert.strictEqual((await call('/api/lcd', { device_id: LCD1, brightness: 500 })).status, 400);
  assert.strictEqual((await call('/api/lcd', { device_id: FAN, brightness: 40 })).status, 400);
});

test('brightness changed during a schedule is what comes back after it', async () => {
  mock.state.config.lcds.push({ serial: LCD1, type: 'color', rgb: [1, 2, 3], path: null, fps: null, orientation: 0, brightness: 80 });
  await call('/api/schedules', { schedules: [{ name: 'Night', start: '11:00', end: '13:00', days: [], brightness: 10, templateId: null, enabled: true }] });
  assert.strictEqual(mock.state.brightness[LCD1], 10);
  await call('/api/lcd', { device_id: LCD1, brightness: 70 });
  assert.strictEqual(mock.state.brightness[LCD1], 10);
  clock = new Date(2026, 10, 3, 14, 0);
  await engine.tick();
  assert.strictEqual(mock.state.brightness[LCD1], 70);
});

test('pixel cleaning waits for the daemon to prepare, and can stop', async () => {
  mock.state.pixel.needsPreparation = true;
  assert.strictEqual((await call('/api/pixel', { action: 'start', minutes: 45 })).status, 400);
  assert.strictEqual((await call('/api/pixel', { action: 'start', minutes: 30 })).status, 200);
  assert.strictEqual(mock.state.pixel.active, true);
  assert.strictEqual((await call('/api/pixel', { action: 'stop' })).status, 200);
  assert.strictEqual(mock.state.pixel.active, false);
});

test('uploads stay in their folder, need a media type and can be deleted', async () => {
  const send = (name, content = 'data', headers = { 'X-Lianli-Dashboard': '1' }) => fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { Cookie: session, ...headers }, body: content });
  assert.strictEqual((await send('run.sh')).status, 400);
  assert.strictEqual((await send('.png')).status, 400);
  assert.strictEqual((await send('cat.png', 'x', {})).status, 403);

  const response = await send('../../evil name.png');
  assert.strictEqual(response.status, 200);
  const { path: saved } = await response.json();
  const uploads = path.join(dir, 'uploads').split(path.sep).join('/');
  assert.strictEqual(saved, `${uploads}/evil_name.png`);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'uploads')), ['evil_name.png']);

  const big = await send('big.mp4', Buffer.alloc(200 * 1024));
  assert.strictEqual(big.status, 200, 'uploads are not held to the JSON size limit');

  assert.strictEqual((await call('/api/screen', { device_id: LCD1, screen: { kind: 'media', path: saved } })).status, 200);
  assert.strictEqual(entryFor(LCD1).path, saved);
  assert.strictEqual((await call('/api/media/delete', { path: saved })).status, 400, 'in use');
  await call('/api/screen', { device_id: LCD1, screen: { kind: 'keep' } });
  assert.strictEqual((await call('/api/media/delete', { path: saved })).status, 200);
  assert.ok(!fs.existsSync(saved));

  const outside = path.join(dir, 'media', 'logo.png').split(path.sep).join('/');
  assert.strictEqual((await call('/api/media/delete', { path: outside })).status, 400);
  assert.ok(fs.existsSync(outside));
  assert.strictEqual((await call('/api/media/delete', { path: `${uploads}/../media/logo.png` })).status, 400);
});

test('settings change only what was asked and keep the rest of the config', async () => {
  mock.state.config.default_fps = 24;
  assert.strictEqual((await call('/api/settings', { turnOffLcds: false, defaultFps: 30 })).status, 200);
  assert.strictEqual(mock.state.config.turn_off_lcds_on_shutdown, false);
  assert.strictEqual(mock.state.config.default_fps, 30);
  assert.strictEqual(mock.state.config.fan_curves.length, 1);
  assert.strictEqual((await call('/api/settings', { defaultFps: 500 })).status, 400);
  assert.strictEqual(mock.state.config.default_fps, 30);
  assert.strictEqual((await call('/api/settings', { defaultFps: 120 })).status, 200);
});

test('the storage alert watches the fullest pool, whichever one the screens show', async () => {
  store.data.alerts.enabled = true;
  store.data.alerts.diskTempC = 70;
  store.data.storageVolume = 'cache';
  assert.strictEqual(engine.alert(), null);
  store.data.alerts.storagePct = 75;
  assert.strictEqual(engine.alert(), 'storage');
  store.data.alerts.storageFull = false;
  assert.strictEqual(engine.alert(), null);
  const alert = buildTemplates('/run/lianli-stats').find((item) => item.id === 'unraid_alert_storage');
  assert.ok(alert);
});

test('history keeps a day of samples and survives a restart', () => {
  const file = path.join(dir, 'history.json');
  const history = new History(file);
  for (let index = 0; index < 1500; index += 1) history.add({ t: index, temp: 30 });
  assert.strictEqual(history.points.length, 1440);
  assert.strictEqual(history.points[0].t, 60);
  history.save();
  assert.strictEqual(new History(file).points.length, 1440);
  fs.writeFileSync(file, 'not json');
  assert.deepStrictEqual(new History(file).points, []);
});

test('the page assets, health report and backup are served, nothing else from disk', async () => {
  assert.match(await (await call('/')).text(), /app\.js/);
  assert.match((await call('/app.js')).headers.get('content-type'), /javascript/);
  assert.match((await call('/style.css')).headers.get('content-type'), /css/);
  assert.strictEqual((await call('/server.js')).status, 404);
  assert.strictEqual((await call('/../server.js')).status, 404);
  assert.strictEqual((await (await call('/api/health')).json()).findings[0].title, 'Example');
  const backup = await call('/api/export');
  assert.match(backup.headers.get('content-disposition'), /attachment/);
  const parsed = await backup.json();
  assert.ok(parsed.daemonConfig.fan_curves && parsed.dashboard.schedules);
});

test('settings saved by the previous version still load with new defaults', () => {
  const file = path.join(dir, 'old.json');
  fs.writeFileSync(file, JSON.stringify({ storageVolume: 'hulk', alerts: { enabled: true, diskTempC: 45, diskProblem: true, parityErrors: true, muteUntil: 0 } }));
  const old = new Store(file);
  assert.strictEqual(old.data.storageVolume, 'hulk');
  assert.strictEqual(old.data.alerts.diskTempC, 45);
  assert.strictEqual(old.data.alerts.storagePct, 90);
  assert.strictEqual(old.data.theme, 'default');
  assert.deepStrictEqual(old.data.names, {});
});

const AIO = 'wireless:aa:bb:cc:dd:ee:ff';

function addAio(overrides = {}) {
  mock.state.extra.push({
    device_id: AIO, family: 'WirelessAio', name: 'Galahad II', serial: 'aa:bb', has_lcd: false, has_fan: true,
    has_pump: true, has_pump_control: true, has_rgb: false, fan_count: 3, rgb_zone_count: 0,
    mb_sync_support: false, pump_mb_sync_support: false, is_unbound_wireless: false, ...overrides,
  });
  mock.state.telemetry.fan_rpms[AIO] = [900, 910, 905, 2100];
  mock.state.telemetry.coolant_temps[AIO] = 34.5;
  mock.state.sensors.push({ source: { type: 'wireless_coolant', device_id: AIO }, display_name: 'Galahad II (Coolant)', unit: 'C', current_value: 34.5 });
}

const aioSaved = () => mock.state.config.aio[AIO];
const aioState = async () => (await (await call('/api/state')).json()).devices.find((device) => device.id === AIO);

test('an AIO reports pump speed and coolant apart from its fans', async () => {
  addAio();
  const device = await aioState();
  assert.strictEqual(device.isAio, true);
  assert.deepStrictEqual(device.rpms, [900, 910, 905]);
  assert.strictEqual(device.aio.pumpRpm, 2100);
  assert.strictEqual(device.aio.coolant, 34.5);
  assert.strictEqual(device.aio.pump, 'off');
  const fan = (await (await call('/api/state')).json()).devices.find((item) => item.id === FAN);
  assert.strictEqual(fan.isAio, false);
  assert.strictEqual(fan.aio, null);
});

test('AIO speeds go to its own config section and keep the other settings', async () => {
  addAio();
  mock.state.config.aio = { [AIO]: { pump_target_rpm: 'off', fan_speeds: ['off', 'off', 'off', 'off'], brightness: 55, theme_index: 4 }, other: { brightness: 1 } };
  assert.strictEqual((await call('/api/aio', { device_id: AIO, pump: { mode: 'constant', percent: 100 } })).status, 200);
  assert.strictEqual(aioSaved().pump_target_rpm, 255);
  assert.strictEqual((await call('/api/aio', { device_id: AIO, fans: { mode: 'curve', curve: 'Quiet' } })).status, 200);
  assert.deepStrictEqual(aioSaved().fan_speeds, ['Quiet', 'Quiet', 'Quiet', 'off'], 'only slots the AIO has');
  assert.strictEqual(aioSaved().brightness, 55);
  assert.strictEqual(aioSaved().theme_index, 4);
  assert.strictEqual(mock.state.config.aio.other.brightness, 1);
  assert.deepStrictEqual(mock.state.config.fans.speeds, [], 'never written as a fan group');
  assert.strictEqual((await call('/api/aio', { device_id: AIO, pump: { mode: 'auto' } })).status, 200);
  assert.strictEqual(aioSaved().pump_target_rpm, 'off');
});

test('the pump and AIO fans cannot be stopped or misdirected', async () => {
  addAio();
  const send = (body) => call('/api/aio', { device_id: AIO, ...body });
  assert.strictEqual((await send({ pump: { mode: 'constant', percent: 0 } })).status, 400);
  assert.strictEqual((await send({ pump: { mode: 'constant', percent: 29 } })).status, 400);
  assert.strictEqual((await send({ fans: { mode: 'constant', percent: 10 } })).status, 400);
  assert.strictEqual((await send({ pump: { mode: 'curve', curve: 'off' } })).status, 400);
  assert.strictEqual((await send({ pump: { mode: 'curve', curve: 'Nope' } })).status, 400);
  assert.strictEqual((await send({ pump: 0 })).status, 400);
  assert.strictEqual((await send({ pump: { mode: 'mb' } })).status, 400, 'not supported by this one');
  assert.strictEqual((await call('/api/aio', { device_id: FAN, pump: { mode: 'auto' } })).status, 400, 'not an AIO');
  assert.strictEqual((await call('/api/fan', { device_id: AIO, mode: 'constant', percent: 50 })).status, 400, 'belongs on the AIO page');
  assert.strictEqual(mock.state.config.aio, undefined);
});

test('an AIO that is not paired cannot be set', async () => {
  addAio({ is_unbound_wireless: true });
  assert.strictEqual((await call('/api/aio', { device_id: AIO, pump: { mode: 'auto' } })).status, 400);
});

test('motherboard sync is offered only where the AIO supports it', async () => {
  addAio({ pump_mb_sync_support: true });
  assert.strictEqual((await call('/api/aio', { device_id: AIO, pump: { mode: 'mb' } })).status, 200);
  assert.strictEqual(aioSaved().pump_target_rpm, '__mb_sync__');
  assert.strictEqual((await call('/api/aio', { device_id: AIO, fans: { mode: 'mb' } })).status, 400);
});

test('the pump screen settings are checked and saved', async () => {
  addAio();
  const send = (body) => call('/api/aio', { device_id: AIO, ...body });
  assert.strictEqual((await send({ brightness: 40, rotation: 2, theme: 12, loopInterval: 5, colors: { value: [1, 2, 3] } })).status, 200);
  assert.strictEqual(aioSaved().brightness, 40);
  assert.strictEqual(aioSaved().rotation, 2);
  assert.strictEqual(aioSaved().theme_index, 12);
  assert.strictEqual(aioSaved().loop_interval, 5);
  assert.deepStrictEqual(aioSaved().val_color, [1, 2, 3, 255]);
  assert.deepStrictEqual((await aioState()).aio.colors.value, [1, 2, 3]);
  for (const bad of [{ brightness: 101 }, { rotation: 4 }, { theme: 13 }, { loopInterval: 0 }, { colors: { value: [999, 0, 0] } }]) {
    assert.strictEqual((await send(bad)).status, 400, JSON.stringify(bad));
  }
});

test('pump screen sensors come from the list and never take a command', async () => {
  addAio();
  const send = (sensors) => call('/api/aio', { device_id: AIO, sensors });
  const hwmon = JSON.stringify({ type: 'hwmon', name: 'k10temp', label: 'Tctl', device_path: '/x' });
  const state = await (await call('/api/state')).json();
  assert.ok(state.aioSensors.some((sensor) => sensor.id === hwmon));
  assert.ok(!state.aioSensors.some((sensor) => sensor.id.includes('command')));
  assert.strictEqual((await send({ cpuTemp: hwmon })).status, 200);
  assert.strictEqual(aioSaved().cpu_temp_source.type, 'hwmon');
  assert.strictEqual((await send({ cpuTemp: null })).status, 200);
  assert.strictEqual(aioSaved().cpu_temp_source, null);
  assert.strictEqual((await send({ cpuTemp: JSON.stringify({ type: 'command', cmd: 'rm -rf /' }) })).status, 400);
  assert.strictEqual((await send({ cpuTemp: { type: 'command', cmd: 'rm -rf /' } })).status, 400);
  assert.strictEqual((await send({ temp_command: hwmon })).status, 400);
});

test('fan curves can follow coolant, and an AIO keeps its curve safe', async () => {
  addAio();
  const coolant = JSON.stringify({ type: 'wireless_coolant', device_id: AIO });
  const state = await (await call('/api/state')).json();
  assert.ok(state.sensors.some((sensor) => sensor.id === coolant));
  const points = [[30, 40], [45, 100]];
  assert.strictEqual((await call('/api/curve', { name: 'Loop', sensor: coolant, points })).status, 200);
  assert.deepStrictEqual(mock.state.config.fan_curves.find((curve) => curve.name === 'Loop').temp_source, { type: 'wireless_coolant', device_id: AIO });
  await call('/api/aio', { device_id: AIO, pump: { mode: 'curve', curve: 'Loop' }, fans: { mode: 'curve', curve: 'Loop' } });

  assert.strictEqual((await call('/api/curve/delete', { name: 'Loop' })).status, 400);
  assert.strictEqual((await call('/api/curve', { original: 'Loop', name: 'Coolant', sensor: coolant, points })).status, 200);
  assert.strictEqual(aioSaved().pump_target_rpm, 'Coolant');
  assert.deepStrictEqual(aioSaved().fan_speeds, ['Coolant', 'Coolant', 'Coolant', 'off']);
});

test('the coolant alert has a margin, stays quiet with no AIO and works without Unraid', () => {
  store.data.alerts.enabled = true;
  store.data.alerts.diskTempC = 70;
  assert.strictEqual(engine.alert(), null, 'no AIO');
  stats.coolantMax = 50;
  assert.strictEqual(engine.alert(), 'coolant');
  stats.coolantMax = 49;
  assert.strictEqual(engine.alert(), 'coolant', 'inside the margin');
  stats.coolantMax = 47;
  assert.strictEqual(engine.alert(), null);
  stats.coolantMax = 55;
  stats.available = false;
  assert.strictEqual(engine.alert(), 'coolant');
  store.data.alerts.coolantHot = false;
  assert.strictEqual(engine.alert(), null);
  store.data.alerts.coolantHot = true;
  stats.available = true;
  stats.values.disks_bad = 1;
  assert.strictEqual(engine.alert(), 'disk', 'a disk problem still ranks first');
});

test('the coolant alert takes over the screens, and its limit can be saved', async () => {
  store.data.alerts.enabled = true;
  stats.coolantMax = 60;
  await engine.tick();
  assert.strictEqual(engine.lastError, null);
  assert.strictEqual(entryFor(LCD1).template_id, 'unraid_alert_coolant');
  const body = { enabled: true, diskTempC: 50, diskProblem: true, parityErrors: true, storageFull: true, coolantHot: true };
  assert.strictEqual((await call('/api/alerts', { ...body, coolantC: 25 })).status, 400);
  assert.strictEqual((await call('/api/alerts', { ...body, coolantC: 65 })).status, 200);
  assert.strictEqual(store.data.alerts.coolantC, 65);
  assert.strictEqual(engine.alert(), null);
  assert.strictEqual((await call('/api/alerts', { ...body, coolantHot: undefined })).status, 200);
  assert.strictEqual(store.data.alerts.coolantHot, true, 'pages without the switch leave it alone');
});

// A second app with its own password file, for the sign-in tests.
async function withFreshAuth(run) {
  const file = path.join(dir, 'fresh-auth.json');
  const fresh = new Auth(file, () => clock.getTime());
  const app = createApp({ daemon: engine.daemon, engine, store, options: { statsDir: '/run/lianli-stats', mediaDir: dir, uploadDir: path.join(dir, 'uploads') }, auth: fresh });
  await listen(app, 0);
  const url = `http://127.0.0.1:${app.address().port}`;
  const post = (route, body, cookie = '') => fetch(`${url}${route}`, { method: 'POST', headers: { 'X-Lianli-Dashboard': '1', Cookie: cookie }, body: JSON.stringify(body) });
  const cookieOf = (response) => response.headers.get('set-cookie').split(';')[0];
  try {
    await run({ url, post, cookieOf, fresh, file });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test('everything but the sign-in page is locked, even before a password exists', async () => {
  await withFreshAuth(async ({ url, post, cookieOf }) => {
    const home = await fetch(`${url}/`, { redirect: 'manual' });
    assert.strictEqual(home.status, 302);
    assert.strictEqual(home.headers.get('location'), '/login');
    assert.strictEqual((await fetch(`${url}/login`)).status, 200);
    assert.strictEqual((await fetch(`${url}/app.js`)).status, 401);
    assert.strictEqual((await fetch(`${url}/api/state`)).status, 401);
    assert.strictEqual((await post('/api/storage', { volume: 'all' })).status, 401);
    assert.deepStrictEqual(await (await fetch(`${url}/api/auth`)).json(), { setup: true, resetOn: false });

    const noHeader = await fetch(`${url}/api/auth/setup`, { method: 'POST', body: JSON.stringify({ password: 'long enough' }) });
    assert.strictEqual(noHeader.status, 403, 'another website cannot claim the password');
    assert.strictEqual((await post('/api/auth/setup', { password: 'short' })).status, 400);

    const created = await post('/api/auth/setup', { password: 'long enough' });
    assert.strictEqual(created.status, 200);
    assert.match(created.headers.get('set-cookie'), /HttpOnly/);
    assert.strictEqual((await fetch(`${url}/api/state`, { headers: { Cookie: cookieOf(created) } })).status, 200);
    assert.strictEqual((await post('/api/auth/setup', { password: 'someone else' })).status, 400, 'setup only works once');
  });
});

test('only the stored hash is written and sessions expire', async () => {
  await withFreshAuth(async ({ url, post, cookieOf, file }) => {
    const created = await post('/api/auth/setup', { password: 'long enough' });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('long enough'));
    const cookie = cookieOf(created);
    assert.strictEqual((await fetch(`${url}/api/export`, { headers: { Cookie: cookie } })).status, 200);
    assert.ok(!(await (await fetch(`${url}/api/export`, { headers: { Cookie: cookie } })).text()).includes(JSON.parse(fs.readFileSync(file, 'utf8')).password.hash), 'the settings download has no hash');
    const forged = `${cookie.split('.')[0]}.${'0'.repeat(64)}`;
    assert.strictEqual((await fetch(`${url}/api/state`, { headers: { Cookie: forged } })).status, 401);
    clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
    assert.strictEqual((await fetch(`${url}/api/state`, { headers: { Cookie: cookie } })).status, 401);
  });
});

test('signing in checks the password and limits guessing', async () => {
  await withFreshAuth(async ({ url, post, cookieOf }) => {
    await post('/api/auth/setup', { password: 'long enough' });
    assert.strictEqual((await post('/api/auth/login', { password: 'wrong' })).status, 401);
    const right = await post('/api/auth/login', { password: 'long enough' });
    assert.strictEqual(right.status, 200);
    assert.strictEqual((await fetch(`${url}/api/state`, { headers: { Cookie: cookieOf(right) } })).status, 200);

    for (let i = 0; i < 5; i += 1) assert.strictEqual((await post('/api/auth/login', { password: 'wrong' })).status, 401);
    assert.strictEqual((await post('/api/auth/login', { password: 'long enough' })).status, 429, 'even the right password waits');
    clock = new Date(clock.getTime() + 61000);
    assert.strictEqual((await post('/api/auth/login', { password: 'long enough' })).status, 200);
  });
});

test('changing the password needs the current one and signs out other browsers', async () => {
  await withFreshAuth(async ({ url, post, cookieOf }) => {
    const old = cookieOf(await post('/api/auth/setup', { password: 'long enough' }));
    assert.strictEqual((await post('/api/auth/change', { current: 'nope', password: 'brand new one' })).status, 401, 'needs a session');
    assert.strictEqual((await post('/api/auth/change', { current: 'nope', password: 'brand new one' }, old)).status, 400);
    const changed = await post('/api/auth/change', { current: 'long enough', password: 'brand new one' }, old);
    assert.strictEqual(changed.status, 200);
    assert.strictEqual((await fetch(`${url}/api/state`, { headers: { Cookie: old } })).status, 401);
    assert.strictEqual((await fetch(`${url}/api/state`, { headers: { Cookie: cookieOf(changed) } })).status, 200);
    assert.strictEqual((await post('/api/auth/login', { password: 'long enough' })).status, 401);
  });
});

test('the reset setting clears the password once per time it is turned on', async () => {
  const file = path.join(dir, 'reset-auth.json');
  const boot = (requested) => {
    const auth = new Auth(file);
    auth.applyReset(requested);
    return auth;
  };
  const first = boot(false);
  await first.setup('long enough');
  assert.strictEqual(boot(false).needsSetup, false);

  const reset = boot(true);
  assert.strictEqual(reset.needsSetup, true);
  assert.strictEqual(reset.resetOn, true);
  await reset.setup('second one here');
  const restarted = boot(true);
  assert.strictEqual(restarted.needsSetup, false, 'left on, a restart must not wipe the new password');
  assert.ok(await restarted.verify('second one here'));

  assert.strictEqual(boot(false).needsSetup, false);
  assert.strictEqual(boot(true).needsSetup, true, 'turned off and on again, it resets again');
});

test('a damaged password file stays locked until reset', () => {
  const file = path.join(dir, 'broken-auth.json');
  fs.writeFileSync(file, '{not json');
  const auth = new Auth(file);
  assert.strictEqual(auth.needsSetup, false);
  auth.applyReset(true);
  assert.strictEqual(auth.needsSetup, true);
});

// Everything the desktop app used to do ----------------------------------------

const SCREEN = 'usb:1-2';
const stateOf = async () => (await call('/api/state')).json();

test('every page script is served and nothing links to the old desktop app', async () => {
  const page = await (await call('/')).text();
  for (const name of ['app', 'fans-more', 'lights-more', 'screens-more', 'designer', 'system-more', 'boot']) {
    assert.ok(page.includes(`/${name}.js`), name);
    const served = await call(`/${name}.js`);
    assert.strictEqual(served.status, 200, name);
    assert.ok(!/full app|fullApp|vnc/i.test(await served.text()), name);
  }
  assert.ok(!/full app|fullApp|vnc/i.test(page));
});

test('each fan can run its own speed, and groups can follow the motherboard', async () => {
  const slots = [{ mode: 'constant', percent: 50 }, { mode: 'curve', curve: 'Quiet' }, { mode: 'constant', percent: 100 }];
  assert.strictEqual((await call('/api/fan', { device_id: FAN, slots })).status, 200);
  const saved = mock.state.config.fans.speeds.find((item) => item.device_id === FAN);
  assert.strictEqual(saved.speeds[1], 'Quiet');
  assert.notStrictEqual(saved.speeds[0], saved.speeds[2]);
  mock.state.pwmHeaders = [{ id: 'hwmon3/pwm1', label: 'CHA1' }];
  assert.strictEqual((await call('/api/fan', { device_id: FAN, mode: 'mb', header: 'hwmon3/pwm1' })).status, 200);
  assert.ok(mock.state.config.fans.speeds.find((item) => item.device_id === FAN).speeds[0].startsWith('__mb_sync__:hwmon3/pwm1'));
  assert.strictEqual((await call('/api/fan', { device_id: FAN, mode: 'mb', header: '../../etc/passwd' })).status, 400);
  assert.strictEqual((await call('/api/fan/tuning', { hysteresisTemp: 2 })).status, 200);
  assert.strictEqual((await call('/api/fan/tuning', { hysteresisTemp: 50 })).status, 400);
});

test('zones, presets and single LEDs reach the daemon', async () => {
  mock.state.caps[FAN] = { zones: [{ name: 'A', led_count: 2 }, { name: 'B', led_count: 2 }], supports_direct: true, software_modes: ['Direct'] };
  const effect = { mode: 'Meteor', colors: [[1, 2, 3]], speed: 1, brightness: 2 };
  assert.strictEqual((await call('/api/rgb/zone', { device_id: FAN, zone: 1, effect })).status, 200);
  const entry = mock.state.config.rgb.devices.find((item) => item.device_id === FAN);
  assert.strictEqual(entry.zones[1].effect.mode, 'Meteor');
  assert.strictEqual(entry.zones[0].effect.mode, 'Static');
  assert.strictEqual((await call('/api/rgb/zone', { device_id: FAN, zone: 9, effect })).status, 400);
  assert.strictEqual((await call('/api/rgb/zone', { device_id: FAN, zone: 0, effect: { ...effect, mode: 'Nope' } })).status, 400);
  assert.strictEqual((await call('/api/rgb/leds', { device_id: FAN, zone: 0, colors: [[9, 9, 9], [8, 8, 8]] })).status, 200);
  assert.deepStrictEqual(await (await call(`/api/rgb/leds?device_id=${FAN}&zone=0`)).json(), [[9, 9, 9], [8, 8, 8]]);
  assert.ok(mock.state.presets.some((item) => item.name === 'Custom LEDs'), 'colours survive a restart');
  assert.strictEqual((await call('/api/rgb/preset', { action: 'save', device_id: FAN, name: 'Mine' })).status, 200);
  assert.ok((await stateOf()).rgbPresets.some((item) => item.name === 'Mine' && item.deviceId === FAN));
  assert.strictEqual((await call('/api/rgb/preset', { action: 'delete', device_id: FAN, name: 'Mine' })).status, 200);
  assert.ok(!mock.state.presets.some((item) => item.name === 'Mine'));
});

test('Quick Sync needs two compatible devices', async () => {
  const [one, two] = mock.state.fans.map((fan) => fan.device_id);
  mock.state.caps[one] = { sync_led_count: 10 };
  mock.state.caps[two] = { sync_led_count: 10 };
  const body = { enabled: true, kind: 'Continuous', mode: 'Meteor', colors: [[1, 1, 1]], speed: 2, brightness: 4, reversed: [two] };
  assert.strictEqual((await call('/api/rgb/sync', { ...body, devices: [one] })).status, 400);
  assert.strictEqual((await call('/api/rgb/sync', { ...body, devices: [one, two] })).status, 200);
  const saved = mock.state.config.rgb.merge_lighting;
  assert.deepStrictEqual(saved.device_order, [one, two]);
  assert.deepStrictEqual(saved.directions, ['Clockwise', 'CounterClockwise']);
  assert.strictEqual((await call('/api/rgb/sync', { ...body, devices: [one, 'wireless:nope'] })).status, 400);
});

test('screens can never be given a command or a file outside the media folders', async () => {
  const sensor = { source: { type: 'command', cmd: 'rm -rf /' } };
  assert.strictEqual((await call('/api/screen', { device_id: SCREEN, screen: { kind: 'sensor', sensor } })).status, 400);
  const template = (widget) => ({ id: 'user-1', name: 'X', base_width: 400, base_height: 400, background: { type: 'color', rgb: [0, 0, 0, 255] }, widgets: [widget], rotated: false, target_device: null });
  const box = { id: 'w', x: 10, y: 10, width: 10, height: 10, rotation: 0, visible: true };
  const command = { ...box, kind: { type: 'value_text', source: { type: 'command', cmd: 'id' } } };
  const traversal = { ...box, kind: { type: 'image', path: '/etc/passwd', opacity: 1, fit: 'stretch' } };
  assert.strictEqual((await call('/api/design/save', { template: template(command) })).status, 400);
  assert.strictEqual((await call('/api/design/save', { template: template(traversal) })).status, 400);
  assert.strictEqual((await call('/api/design/preview', { template: template(traversal) })).status, 400);
  assert.strictEqual(mock.state.writes.filter((item) => item.method === 'MergeLcdTemplates').length, 0);
});

test('designs save, show up as a screen choice and delete', async () => {
  const schema = (await (await call('/api/design/schema')).json()).widgets;
  const box = (kind) => ({ id: `w-${kind}`, kind: schema[kind], x: 200, y: 200, width: 100, height: 100, rotation: 0, visible: true });
  const kinds = Object.keys(schema).filter((kind) => kind !== 'image' && kind !== 'video');
  const template = { id: 'user-2', name: 'Everything', base_width: 400, base_height: 400, background: { type: 'color', rgb: [0, 0, 0, 255] }, widgets: kinds.map(box), rotated: false, target_device: null };
  const saved = await call('/api/design/save', { template });
  assert.strictEqual(saved.status, 200, await saved.clone().text());
  assert.ok((await stateOf()).designs.some((item) => item.id === 'user-2'));
  assert.strictEqual((await call('/api/design/delete', { id: 'user-2' })).status, 200);
  assert.ok(!(await stateOf()).designs.some((item) => item.id === 'user-2'));
});

test('a sensor gauge saves and previews', async () => {
  const sensor = { source: { type: 'cpu_usage' }, label: 'CPU', unit: '%' };
  const preview = await call('/api/lcd/sensor-preview', { sensor, width: 400, height: 400 });
  assert.strictEqual(preview.status, 200, await preview.clone().text());
  assert.ok((await preview.json()).jpeg_base64);
  assert.strictEqual((await call('/api/screen', { device_id: SCREEN, screen: { kind: 'sensor', sensor } })).status, 200);
  await engine.tick();
  assert.ok(mock.state.config.lcds.some((lcd) => lcd.type === 'sensor'));
});

test('startup images must be a JPEG of exactly the right size', async () => {
  const device = mock.state.screens[0];
  device.startup_image = { width: 400, height: 400, max_jpeg_bytes: 200000, jpeg_target_bytes: 150000 };
  const onePixel = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';
  assert.strictEqual((await call('/api/startup-image', { device_id: SCREEN, jpeg_base64: onePixel })).status, 400);
  assert.strictEqual((await call('/api/startup-image', { device_id: SCREEN, jpeg_base64: 'bm90IGEganBlZw==' })).status, 400);
});

test('backups only restore with the checksum that was previewed', async () => {
  const target = { kind: 'configuration' };
  const preview = await (await call('/api/backups/preview', { target, preserved: false })).json();
  assert.strictEqual((await call('/api/backups/restore', { target, sha256: preview.sha256 })).status, 200);
  assert.strictEqual(mock.state.calls.at(-1).method, 'RestoreStateBackup');
  assert.strictEqual((await call('/api/backups/restore', { target: { kind: 'other' }, sha256: 'abc' })).status, 400);
  assert.strictEqual((await call('/api/backups/restore', { target })).status, 400);
});

test('settings cover alerts, the USB backend and the OpenRGB server', async () => {
  assert.strictEqual((await call('/api/settings', { hidBackend: 'rusb', openrgb: { enabled: true, port: 7000, regions: false, perFan: false }, thermal: { cpu: { enabled: true, threshold: 90, color: [255, 0, 0] } } })).status, 200);
  assert.strictEqual(mock.state.config.rgb.openrgb_port, 7000);
  assert.strictEqual((await call('/api/settings', { hidBackend: 'nope' })).status, 400);
  assert.strictEqual((await call('/api/settings', { openrgb: { enabled: true, port: 99999, regions: false, perFan: false } })).status, 400);
});

test('the diagnostics report downloads', async () => {
  const report = await call('/api/diagnostics');
  assert.strictEqual(report.status, 200);
  assert.ok((await report.text()).includes('1.2.3'));
});

test('catalog templates install only when their checksum matches', async () => {
  const sha = (text) => require('node:crypto').createHash('sha256').update(text).digest('hex');
  let body = JSON.stringify({ widgets: [{ sensor_category: 'cpu_temp', kind: { source: { type: 'cpu_usage' } } }] });
  const templateSha = sha(body);
  const manifest = () => JSON.stringify({ schema_version: 1, templates: [{ id: 'cat', name: 'Cat', folder: 'cat', template_file: 't.json', template_sha256: templateSha, preview: 'p.png', preview_sha256: sha('png'), base_width: 400, base_height: 400 }] });
  const download = async (url) => Buffer.from(url.endsWith('default_templates.json') ? manifest() : url.endsWith('t.json') ? body : 'png');
  const options = { statsDir: '/run/lianli-stats', mediaDir: dir, uploadDir: path.join(dir, 'uploads'), download };
  const server = createApp({ daemon: engine.daemon, engine, store, options, auth });
  await listen(server, 0);
  const local = async (url, payload) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { method: payload ? 'POST' : 'GET', headers: { 'X-Lianli-Dashboard': '1', Cookie: session }, body: payload && JSON.stringify(payload) });
  try {
    assert.strictEqual((await (await local('/api/catalog')).json())[0].id, 'cat');
    assert.strictEqual((await local('/api/catalog/preview?id=cat')).headers.get('content-type'), 'image/png');
    const prepared = await (await local('/api/catalog/prepare', { id: 'cat' })).json();
    assert.strictEqual(prepared.categories[0].category, 'cpu_temp');
    assert.strictEqual((await local('/api/catalog/install', { id: 'cat', bindings: { cpu_temp: '{"type":"command","cmd":"id"}' } })).status, 400);
    assert.strictEqual((await local('/api/catalog/install', { id: 'cat', bindings: { cpu_temp: prepared.categories[0].suggested } })).status, 200);
    assert.strictEqual(mock.state.lastInstall.template.id, 'cat');
    body = 'tampered';
    assert.notStrictEqual((await local('/api/catalog/prepare', { id: 'cat' })).status, 200);
  } finally {
    server.close();
  }
});

test('each screen can show its own pool', async () => {
  const volumes = stats.volumes;
  assert.ok(volumes.length > 0);
  const { key, name } = volumes[0];
  const state = await stateOf();
  const drives = state.screenFamilies.find((family) => family.name === 'Drives');
  assert.deepStrictEqual(drives.choices.map((choice) => choice.name), ['All drives', ...volumes.map((volume) => volume.name)]);
  await engine.tick();
  for (const [lcd, id] of [[LCD1, `unraid_drives_${key}`], ['usb:1-3', `unraid_overview_${key}`], ['usb:1-4', `unraid_volume_${key}`]]) {
    assert.strictEqual((await call('/api/screen', { device_id: lcd, screen: { kind: 'template', templateId: id } })).status, 200, id);
    assert.strictEqual(entryFor(lcd).template_id, id);
  }
  const stored = mock.state.templates.find((item) => item.id === `unraid_drives_${key}`);
  assert.ok(stored.widgets.some((widget) => widget.kind.source?.cmd?.endsWith(`volume_${key}_temp_max`)), name);
  assert.ok(stored.widgets.some((widget) => widget.kind.source?.cmd?.endsWith(`volume_${key}_active`)));
  assert.ok('volume_' + key + '_active' in stats.values);
});

test('system screens show CPU, memory and temperature sensors', async () => {
  await engine.tick();
  const ids = mock.state.templates.map((item) => item.id);
  for (const id of ['unraid_system', 'unraid_memory', 'unraid_sysinfo']) assert.ok(ids.includes(id), id);
  const state = await stateOf();
  const temps = state.screenFamilies.find((family) => family.name === 'Temperature');
  assert.deepStrictEqual(temps.choices.map((choice) => choice.name), ['CPU temperature']);
  const id = temps.choices[0].id;
  assert.ok(ids.includes(id));
  assert.strictEqual((await call('/api/screen', { device_id: LCD1, screen: { kind: 'template', templateId: id } })).status, 200);
  assert.strictEqual(entryFor(LCD1).template_id, id);
  const sysinfo = mock.state.templates.find((item) => item.id === 'unraid_sysinfo');
  assert.strictEqual(sysinfo.widgets.find((widget) => widget.id === 'ctemp').kind.source.name, 'k10temp');
  const all = JSON.stringify(mock.state.templates);
  assert.ok(!all.includes('rm -rf'), "other sensors' commands never reach a screen");
});

test('temperature sensors skip commands and per-core readings, with the CPU first', () => {
  const hwmon = (name, label) => ({ source: { type: 'hwmon', name, label, device_path: '/x' }, display_name: `${name}: ${label}`, unit: 'C' });
  const sensors = tempSensors([
    hwmon('nvme', 'Composite'),
    hwmon('coretemp', 'Core 3'),
    hwmon('coretemp', 'Package id 0'),
    { source: { type: 'command', cmd: 'id' }, display_name: 'x', unit: 'C' },
    { source: { type: 'cpu_usage' }, display_name: 'CPU', unit: '%' },
  ]);
  assert.deepStrictEqual(sensors.map((sensor) => sensor.name), ['coretemp: Package id 0', 'nvme: Composite']);
  assert.strictEqual(new Set(sensors.map((sensor) => sensor.key)).size, 2);
  assert.strictEqual(sensors[0].cpu, true);
  assert.strictEqual(sensors[1].cpu, false);
});

// Named the way a real server reports them: the raw label says nothing about the reading.
const named = (source, display, label = 'temp1') => ({ source: { type: 'hwmon', name: source, label, device_path: `/${display}` }, display_name: display, unit: 'C' });
const REAL_SENSORS = [
  named('coretemp', 'CPU: Control Temp'),
  named('coretemp', 'CPU: Temp Core 0', 'temp2'),
  named('coretemp', 'CPU: Temp Core 12', 'temp14'),
  named('nvme', 'TEAM TM8FPW004T: Composite'),
  named('nvme', 'Samsung SSD 980 PRO 1TB: Composite'),
  named('nvme', 'Samsung SSD 980 PRO 1TB: Sensor 1', 'temp2'),
  named('nvme', 'Samsung SSD 980 PRO 1TB: Sensor 2', 'temp3'),
  named('r8169', 'eth0: MAC Temperature', 'temp2'),
  named('r8169', 'eth0: PHY Temperature'),
  named('iwlwifi_1', 'iwlwifi_1: temp1'),
];

test('sensor screens skip redundant readings even when the raw label is meaningless', () => {
  const sensors = tempSensors(REAL_SENSORS);
  assert.deepStrictEqual(sensors.map((sensor) => [sensor.name, sensor.title]), [
    ['CPU: Control Temp', 'CPU'],
    ['TEAM TM8FPW004T: Composite', 'TEAM TM8FPW004T'],
    ['Samsung SSD 980 PRO 1TB: Composite', 'SAMSUNG 980 PRO'],
    ['eth0: MAC Temperature', 'ETH0'],
  ]);
});

test('an extra reading stays when its device has no main reading', () => {
  const sensors = tempSensors([named('r8169', 'eth1: PHY Temperature'), named('x', 'Board: Sensor 1')]);
  assert.deepStrictEqual(sensors.map((sensor) => sensor.title), ['ETH1', 'BOARD']);
});

test('a hidden sensor stays while an LCD or schedule uses its screen', () => {
  const key = (name) => {
    const { source } = REAL_SENSORS.find((sensor) => sensor.display_name === name);
    const hash = sensorKey(toScreenSource(source));
    return tempSensors(REAL_SENSORS, new Set([hash])).find((sensor) => sensor.key === hash);
  };
  const core = key('CPU: Temp Core 12');
  assert.strictEqual(core.title, 'CORE 12');
  const onLcd = sensorKeysInUse({ screens: { a: { kind: 'template', templateId: `unraid_temp_${core.key}` }, b: { kind: 'keep' } }, schedules: [] });
  assert.ok(tempSensors(REAL_SENSORS, onLcd).some((sensor) => sensor.key === core.key));
  const wifi = key('iwlwifi_1: temp1');
  const onSchedule = sensorKeysInUse({ screens: {}, schedules: [{ templateId: `unraid_temp_${wifi.key}` }, { templateId: null }] });
  assert.ok(tempSensors(REAL_SENSORS, onSchedule).some((sensor) => sensor.key === wifi.key));
  assert.strictEqual(sensorKeysInUse({ screens: {}, schedules: [] }).size, 0);
});

test('the gallery groups every screen it lists, with pools and sensors collapsed', async () => {
  const volumes = [{ name: 'cache', key: 'cache' }];
  const sensors = tempSensors(REAL_SENSORS);
  const groups = screenGroups(volumes, sensors);
  assert.deepStrictEqual(groups.map((group) => [group.name, group.open]), [['All storage', true], ['System', true], ['cache', false], ['Temperature sensors', false]]);
  const built = new Set(buildTemplates('/run/lianli-stats', volumes, undefined, undefined, sensors).map((item) => item.id));
  const shown = groups.flatMap((group) => group.screens.map((item) => item.id));
  assert.ok(shown.every((id) => built.has(id)), 'each preview is a real screen');
  assert.deepStrictEqual(shown.filter((_, index) => index < 6), ['unraid_drives', 'unraid_array', 'unraid_overview', 'unraid_system', 'unraid_memory', 'unraid_sysinfo']);
  assert.deepStrictEqual([...built].filter((id) => !id.startsWith('unraid_alert_') && !shown.includes(id)), [], 'no screen is missing from the gallery');
  assert.ok((await stateOf()).screenGroups.length >= 2);
});

test('the system page script carries the version and credits', async () => {
  const script = await (await call('/system-more.js')).text();
  assert.ok(script.includes('https://github.com/sgtaziz/lian-li-linux'));
  assert.ok(script.includes('data.daemon?.version'));
  assert.strictEqual((await stateOf()).daemon.version, '1.2.3');
});

test('the fan order and fans per row are saved and checked', async () => {
  const before = await (await call('/api/state')).json();
  assert.deepStrictEqual(before.settings.fanLayout, { order: [], perRow: 0 });

  assert.strictEqual((await call('/api/fan-layout', { order: ['b', 'a', 'b'] })).status, 200);
  assert.strictEqual((await call('/api/fan-layout', { perRow: 3 })).status, 200);
  assert.deepStrictEqual(new Store(store.file).data.fanLayout, { order: ['b', 'a'], perRow: 3 });

  assert.strictEqual((await call('/api/fan-layout', { perRow: 9 })).status, 400);
  assert.strictEqual((await call('/api/fan-layout', { order: 'a' })).status, 400);
  assert.strictEqual((await call('/api/fan-layout', { order: [1] })).status, 400);
  const after = await (await call('/api/state')).json();
  assert.deepStrictEqual(after.settings.fanLayout, { order: ['b', 'a'], perRow: 3 });
  await call('/api/fan-layout', { order: [], perRow: 0 });
});
