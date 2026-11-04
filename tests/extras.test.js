'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, beforeEach, afterEach } = require('node:test');

const extras = path.join(__dirname, '..', 'rootfs', 'opt', 'lianli-extras');
const { DaemonClient } = require(path.join(extras, 'lib', 'daemon'));
const { Engine, Store, scheduleActive } = require(path.join(extras, 'lib', 'engine'));
const { History } = require(path.join(extras, 'lib', 'history'));
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
  http = createApp({ daemon, engine, store, options: { statsDir: '/run/lianli-stats', mediaDir: media, uploadDir: path.join(dir, 'uploads'), fullAppPort: 6081, password: '' } });
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
  const send = (name, content = 'data', headers = { 'X-Lianli-Dashboard': '1' }) => fetch(`${base}/api/upload?name=${encodeURIComponent(name)}`, { method: 'POST', headers, body: content });
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
