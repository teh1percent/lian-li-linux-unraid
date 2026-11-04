'use strict';

// LCD templates installed into the daemon. Layouts are 400x400 and keep their
// content inside the round area of the fan screens.

const WHITE = [255, 255, 255, 255];
const MUTED = [170, 178, 190, 255];
const GREEN = [0, 200, 90];
const AMBER = [230, 150, 0];
const RED = [225, 40, 40];
const BLACK = { type: 'color', rgb: [0, 0, 0, 255] };
const ALERT_RED = { type: 'color', rgb: [120, 0, 0, 255] };
const UPDATE_MS = 2000;

const thresholds = (warn, danger) => [
  { max: warn, color: GREEN, alpha: 255 },
  { max: danger, color: AMBER, alpha: 255 },
  { max: null, color: RED, alpha: 255 },
];

function label(id, text, y, fontSize, { x = 200, width = 320, color = WHITE, align = 'center' } = {}) {
  return {
    id, x, y, width, height: Math.ceil(fontSize * 1.3),
    kind: { type: 'label', text, font: { path: null }, font_size: fontSize, color, align },
  };
}

function value(id, source, y, fontSize, options = {}) {
  const { x = 200, width = 300, color = WHITE, align = 'center', unit = '', format = '{:.0}', ranges = [], max = 100 } = options;
  return {
    id, x, y, width, height: Math.ceil(fontSize * 1.25), update_interval_ms: UPDATE_MS,
    kind: {
      type: 'value_text', source, format, unit, font: { path: null }, font_size: fontSize,
      color, align, value_min: 0, value_max: max, ranges,
    },
  };
}

function gauge(source, min, max, ranges) {
  return {
    id: 'gauge', x: 200, y: 200, width: 360, height: 360, update_interval_ms: UPDATE_MS,
    kind: {
      type: 'radial_gauge', source, value_min: min, value_max: max, start_angle: 300, sweep_angle: 300,
      inner_radius_pct: 0.778, background_color: [40, 44, 52, 255], bg_corner_radius: 20,
      value_corner_radius: 20, ranges,
    },
  };
}

function template(id, name, background, widgets) {
  return { id, name, base_width: 400, base_height: 400, rotated: false, target_device: null, background, widgets };
}

function buildTemplates(statsDir, volumes = []) {
  const stat = (key) => ({ type: 'command', cmd: `cat ${statsDir}/${key}` });
  const tempRanges = thresholds(40, 50);
  const storage = (id, name, title, usedKey, freeKey) => template(id, name, BLACK, [
    gauge(stat(usedKey), 0, 100, thresholds(75, 90)),
    label('title', title, 84, 36),
    value('used', stat(usedKey), 186, 120),
    label('unit', '% used', 266, 26, { color: MUTED }),
    value('free', stat(freeKey), 312, 26, { width: 200, unit: ' TB free', format: '{:.1}', color: MUTED }),
  ]);

  return [
    template('unraid_drives', 'Unraid: Drives', BLACK, [
      gauge(stat('disk_temp_max'), 20, 65, tempRanges),
      label('title', 'DRIVES', 84, 36),
      value('temp', stat('disk_temp_max'), 186, 120, { max: 65 }),
      label('unit', 'hottest °C', 266, 26, { color: MUTED }),
      value('active', stat('disks_active'), 312, 26, { width: 160, unit: ' awake', color: MUTED }),
    ]),
    storage('unraid_array', 'Unraid: All storage', 'STORAGE', 'storage_used_pct', 'storage_free_tb'),
    ...volumes.map(({ name, key }) => storage(
      `unraid_volume_${key}`, `Unraid: ${name}`, name.toUpperCase(), `volume_${key}_used_pct`, `volume_${key}_free_tb`,
    )),
    template('unraid_system', 'Unraid: System', BLACK, [
      gauge({ type: 'cpu_usage' }, 0, 100, thresholds(50, 80)),
      label('title', 'CPU', 84, 36),
      value('cpu', { type: 'cpu_usage' }, 186, 120),
      label('unit', '% load', 266, 26, { color: MUTED }),
      value('mem', { type: 'mem_usage' }, 312, 26, { width: 180, unit: '% RAM', color: MUTED }),
    ]),
    template('unraid_overview', 'Unraid: Overview', BLACK, [
      label('title', 'UNRAID', 64, 36),
      label('temp_l', 'Hottest', 126, 30, { x: 125, width: 150, color: MUTED, align: 'left' }),
      value('temp', stat('disk_temp_max'), 126, 42, { x: 280, width: 130, unit: '°', align: 'right', ranges: tempRanges, max: 65 }),
      label('used_l', 'Used', 190, 30, { x: 125, width: 150, color: MUTED, align: 'left' }),
      value('used', stat('storage_used_pct'), 190, 42, { x: 280, width: 130, unit: '%', align: 'right', ranges: thresholds(75, 90) }),
      label('free_l', 'Free TB', 254, 30, { x: 125, width: 150, color: MUTED, align: 'left' }),
      value('free', stat('storage_free_tb'), 254, 42, { x: 280, width: 130, format: '{:.1}', align: 'right', max: 100000 }),
      label('awake_l', 'Awake', 318, 30, { x: 140, width: 110, color: MUTED, align: 'left' }),
      value('awake', stat('disks_active'), 318, 42, { x: 260, width: 120, align: 'right', max: 1000 }),
    ]),
    template('unraid_alert_temp', 'Unraid alert: Drive hot', ALERT_RED, [
      label('title', 'DRIVE HOT', 112, 50),
      value('temp', stat('disk_temp_max'), 210, 130, { max: 65 }),
      label('unit', '°C', 308, 36),
    ]),
    template('unraid_alert_disk', 'Unraid alert: Disk problem', ALERT_RED, [
      label('title', 'DISK', 120, 62),
      label('title2', 'PROBLEM', 190, 62),
      label('hint', 'Check Unraid', 270, 32),
    ]),
    template('unraid_alert_parity', 'Unraid alert: Parity errors', ALERT_RED, [
      label('title', 'PARITY', 112, 54),
      value('errors', stat('parity_errors'), 210, 110, { max: 100000 }),
      label('unit', 'errors', 300, 36),
    ]),
  ];
}

// Whether every field we define is already present in what the daemon stores.
// The daemon adds default fields of its own when it saves a template.
function contains(stored, wanted) {
  if (wanted === null || wanted === undefined) return stored === null || stored === undefined;
  if (Array.isArray(wanted)) {
    return Array.isArray(stored) && stored.length === wanted.length
      && wanted.every((item, index) => contains(stored[index], item));
  }
  if (typeof wanted === 'object') {
    return stored !== null && typeof stored === 'object'
      && Object.keys(wanted).every((key) => contains(stored[key], wanted[key]));
  }
  return stored === wanted;
}

async function installTemplates(daemon, statsDir, volumes) {
  const wanted = buildTemplates(statsDir, volumes);
  const current = await daemon.request('GetLcdTemplates');
  const originals = current.filter((item) => wanted.some((mine) => mine.id === item.id));
  const upToDate = wanted.every((mine) => contains(originals.find((item) => item.id === mine.id), mine));
  if (upToDate) return false;
  await daemon.write('MergeLcdTemplates', { originals, copies: wanted });
  return true;
}

module.exports = { buildTemplates, installTemplates, contains };
