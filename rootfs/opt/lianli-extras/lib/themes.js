'use strict';

// Colours and warning limits for the Unraid LCD screens. Alert screens stay red
// on purpose, so they always stand out.

const COLOR_KEYS = ['background', 'text', 'muted', 'track', 'good', 'warn', 'bad'];

const PRESETS = {
  default: { label: 'Default', background: [0, 0, 0], text: [255, 255, 255], muted: [170, 178, 190], track: [40, 44, 52], good: [0, 200, 90], warn: [230, 150, 0], bad: [225, 40, 40] },
  ocean: { label: 'Ocean', background: [4, 18, 36], text: [225, 243, 255], muted: [130, 170, 200], track: [22, 52, 82], good: [0, 180, 230], warn: [250, 190, 60], bad: [255, 80, 90] },
  ember: { label: 'Ember', background: [20, 8, 4], text: [255, 236, 220], muted: [200, 150, 120], track: [62, 32, 20], good: [255, 150, 40], warn: [255, 95, 30], bad: [240, 30, 40] },
  forest: { label: 'Forest', background: [6, 20, 12], text: [230, 250, 235], muted: [140, 185, 155], track: [24, 58, 38], good: [90, 220, 120], warn: [225, 200, 70], bad: [240, 80, 60] },
  violet: { label: 'Violet', background: [16, 8, 32], text: [242, 234, 255], muted: [170, 150, 215], track: [48, 32, 84], good: [170, 100, 255], warn: [255, 110, 200], bad: [255, 60, 90] },
  mono: { label: 'Mono', background: [0, 0, 0], text: [255, 255, 255], muted: [160, 160, 160], track: [50, 50, 50], good: [255, 255, 255], warn: [190, 190, 190], bad: [120, 120, 120] },
};

const DEFAULT_LIMITS = { tempWarn: 40, tempDanger: 50, storageWarn: 75, storageDanger: 90, cpuWarn: 50, cpuDanger: 80 };

function isColor(value) {
  return Array.isArray(value) && value.length === 3
    && value.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
}

function validColors(colors) {
  return Boolean(colors) && COLOR_KEYS.every((key) => isColor(colors[key]));
}

function pickColors(colors) {
  return Object.fromEntries(COLOR_KEYS.map((key) => [key, colors[key]]));
}

function validLimits(limits) {
  const pairs = [['tempWarn', 'tempDanger', 20, 65], ['storageWarn', 'storageDanger', 0, 100], ['cpuWarn', 'cpuDanger', 0, 100]];
  return Boolean(limits) && pairs.every(([warn, danger, min, max]) => (
    Number.isInteger(limits[warn]) && Number.isInteger(limits[danger])
    && limits[warn] >= min && limits[danger] <= max && limits[warn] < limits[danger]
  ));
}

function themeExists(settings, name) {
  return Object.hasOwn(PRESETS, name) || (name === 'custom' && validColors(settings.customColors));
}

function themeColors(settings, name) {
  if (name === 'custom' && validColors(settings.customColors)) return settings.customColors;
  return PRESETS[Object.hasOwn(PRESETS, name) ? name : 'default'];
}

module.exports = { COLOR_KEYS, PRESETS, DEFAULT_LIMITS, isColor, validColors, pickColors, validLimits, themeExists, themeColors };
