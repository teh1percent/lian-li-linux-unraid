'use strict';

// LCD templates installed into the daemon. Layouts are 400x400 and keep their
// content inside the round area of the fan screens.

const { PRESETS, DEFAULT_LIMITS, themeColors } = require('./themes');

const ALERT_WHITE = [255, 255, 255, 255];
const ALERT_RED = { type: 'color', rgb: [120, 0, 0, 255] };
const UPDATE_MS = 2000;

const rgba = (color) => [...color, 255];

function label(id, text, y, fontSize, { x = 200, width = 320, color = ALERT_WHITE, align = 'center' } = {}) {
  return {
    id, x, y, width, height: Math.ceil(fontSize * 1.3),
    kind: { type: 'label', text, font: { path: null }, font_size: fontSize, color, align },
  };
}

function value(id, source, y, fontSize, options = {}) {
  const { x = 200, width = 300, color = ALERT_WHITE, align = 'center', unit = '', format = '{:.0}', ranges = [], max = 100 } = options;
  return {
    id, x, y, width, height: Math.ceil(fontSize * 1.25), update_interval_ms: UPDATE_MS,
    kind: {
      type: 'value_text', source, format, unit, font: { path: null }, font_size: fontSize,
      color, align, value_min: 0, value_max: max, ranges,
    },
  };
}

function template(id, name, background, widgets) {
  return { id, name, base_width: 400, base_height: 400, rotated: false, target_device: null, background, widgets };
}

function buildScreens(statsDir, volumes, colors, limits) {
  const stat = (key) => ({ type: 'command', cmd: `cat ${statsDir}/${key}` });
  const background = { type: 'color', rgb: rgba(colors.background) };
  const text = rgba(colors.text);
  const muted = rgba(colors.muted);
  // The daemon compares range limits with the percentage of the widget's value
  // range, not with the value itself, so real limits are converted here.
  const thresholds = (warn, danger, min = 0, max = 100) => {
    const percent = (limit) => Math.round(((limit - min) / (max - min)) * 100);
    return [
      { max: percent(warn), color: colors.good, alpha: 255 },
      { max: percent(danger), color: colors.warn, alpha: 255 },
      { max: null, color: colors.bad, alpha: 255 },
    ];
  };
  const gauge = (source, min, max, ranges) => ({
    id: 'gauge', x: 200, y: 200, width: 360, height: 360, update_interval_ms: UPDATE_MS,
    kind: {
      type: 'radial_gauge', source, value_min: min, value_max: max, start_angle: 300, sweep_angle: 300,
      inner_radius_pct: 0.778, background_color: rgba(colors.track), bg_corner_radius: 20,
      value_corner_radius: 20, ranges,
    },
  });
  const storageRanges = thresholds(limits.storageWarn, limits.storageDanger);
  const storage = (id, name, title, usedKey, freeKey) => template(id, name, background, [
    gauge(stat(usedKey), 0, 100, storageRanges),
    label('title', title, 84, 36, { color: text }),
    value('used', stat(usedKey), 186, 120, { color: text }),
    label('unit', '% used', 266, 26, { color: muted }),
    value('free', stat(freeKey), 312, 26, { width: 200, unit: ' TB free', format: '{:.1}', color: muted }),
  ]);

  return [
    template('unraid_drives', 'Unraid: Drives', background, [
      gauge(stat('disk_temp_max'), 20, 65, thresholds(limits.tempWarn, limits.tempDanger, 20, 65)),
      label('title', 'DRIVES', 84, 36, { color: text }),
      value('temp', stat('disk_temp_max'), 186, 120, { max: 65, color: text }),
      label('unit', 'hottest °C', 266, 26, { color: muted }),
      value('active', stat('disks_active'), 312, 26, { width: 160, unit: ' awake', color: muted }),
    ]),
    storage('unraid_array', 'Unraid: Storage (picked on Status)', 'STORAGE', 'storage_used_pct', 'storage_free_tb'),
    template('unraid_system', 'Unraid: System', background, [
      gauge({ type: 'cpu_usage' }, 0, 100, thresholds(limits.cpuWarn, limits.cpuDanger)),
      label('title', 'CPU', 84, 36, { color: text }),
      value('cpu', { type: 'cpu_usage' }, 186, 120, { color: text }),
      label('unit', '% load', 266, 26, { color: muted }),
      value('mem', { type: 'mem_usage' }, 312, 26, { width: 180, unit: '% RAM', color: muted }),
    ]),
    template('unraid_overview', 'Unraid: Overview', background, [
      label('title', 'UNRAID', 64, 36, { color: text }),
      label('temp_l', 'Hottest', 126, 30, { x: 125, width: 150, color: muted, align: 'left' }),
      value('temp', stat('disk_temp_max'), 126, 42, { x: 280, width: 130, unit: '°', align: 'right', ranges: thresholds(limits.tempWarn, limits.tempDanger, 0, 65), max: 65, color: text }),
      label('used_l', 'Used', 190, 30, { x: 125, width: 150, color: muted, align: 'left' }),
      value('used', stat('storage_used_pct'), 190, 42, { x: 280, width: 130, unit: '%', align: 'right', ranges: storageRanges, color: text }),
      label('free_l', 'Free TB', 254, 30, { x: 125, width: 150, color: muted, align: 'left' }),
      value('free', stat('storage_free_tb'), 254, 42, { x: 280, width: 130, format: '{:.1}', align: 'right', max: 100000, color: text }),
      label('awake_l', 'Awake', 318, 30, { x: 140, width: 110, color: muted, align: 'left' }),
      value('awake', stat('disks_active'), 318, 42, { x: 260, width: 120, align: 'right', max: 1000, color: text }),
    ]),
    ...volumes.map(({ name, key }) => storage(
      `unraid_volume_${key}`, `Unraid: ${name}`, name.toUpperCase(), `volume_${key}_used_pct`, `volume_${key}_free_tb`,
    )),
  ];
}

function buildAlerts(statsDir) {
  const stat = (key) => ({ type: 'command', cmd: `cat ${statsDir}/${key}` });
  return [
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
    template('unraid_alert_coolant', 'Unraid alert: Coolant hot', ALERT_RED, [
      label('title', 'COOLANT HOT', 112, 46),
      value('temp', stat('coolant_temp'), 210, 130, { max: 100 }),
      label('unit', '°C', 308, 36),
    ]),
    template('unraid_alert_storage', 'Unraid alert: Storage full', ALERT_RED, [
      label('title', 'STORAGE', 112, 54),
      value('used', stat('volume_max_used_pct'), 210, 110),
      label('unit', '% full', 300, 36),
    ]),
  ];
}

function buildTemplates(statsDir, volumes = [], colors = PRESETS.default, limits = DEFAULT_LIMITS) {
  return [...buildScreens(statsDir, volumes, colors, limits), ...buildAlerts(statsDir)];
}

const themedId = (id, theme) => `${id}__${theme}`;

// Everything the settings call for: each screen in the main theme, plus copies
// for any other theme that a single LCD uses.
function wantedTemplates(statsDir, volumes, settings) {
  const main = themeColors(settings, settings.theme);
  const wanted = buildTemplates(statsDir, volumes, main, settings.limits);
  const others = new Set(Object.values(settings.lcdThemes).filter((theme) => theme !== settings.theme));
  for (const theme of others) {
    for (const screen of buildScreens(statsDir, volumes, themeColors(settings, theme), settings.limits)) {
      wanted.push({ ...screen, id: themedId(screen.id, theme), name: `${screen.name} (${theme})` });
    }
  }
  return wanted;
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

async function installTemplates(daemon, wanted) {
  const current = await daemon.request('GetLcdTemplates');
  const originals = current.filter((item) => wanted.some((mine) => mine.id === item.id));
  const upToDate = wanted.every((mine) => contains(originals.find((item) => item.id === mine.id), mine));
  if (upToDate) return false;
  await daemon.write('MergeLcdTemplates', { originals, copies: wanted });
  return true;
}

module.exports = { buildTemplates, wantedTemplates, installTemplates, contains, themedId };
