'use strict';

// LCD template widgets. Each kind's default doubles as its schema: only these
// keys reach the daemon, and each value must match the type of its default.

const { check, isInt, isNumber, isText } = require('./check');

const WHITE = [255, 255, 255, 255];
const TRACK = [30, 30, 30, 255];
const FONT = { path: null };
const CPU = { type: 'cpu_usage' };

const WIDGET_DEFAULTS = {
  label: { type: 'label', text: 'Label', font: FONT, font_size: 28, color: WHITE, align: 'center', letter_spacing: 0 },
  value_text: { type: 'value_text', source: CPU, format: '{:.0}', unit: '%', font: FONT, font_size: 48, color: WHITE, align: 'center', value_min: 0, value_max: 100, ranges: [], letter_spacing: 0 },
  radial_gauge: { type: 'radial_gauge', source: CPU, value_min: 0, value_max: 100, start_angle: 90, sweep_angle: 330, inner_radius_pct: 0.78, background_color: TRACK, ranges: [], bg_corner_radius: 0, value_corner_radius: 0, gradient: false, gradient_stops: [] },
  vertical_bar: { type: 'vertical_bar', source: CPU, value_min: 0, value_max: 100, background_color: TRACK, corner_radius: 0, ranges: [] },
  horizontal_bar: { type: 'horizontal_bar', source: CPU, value_min: 0, value_max: 100, background_color: TRACK, corner_radius: 0, ranges: [] },
  speedometer: { type: 'speedometer', source: CPU, value_min: 0, value_max: 100, start_angle: 135, sweep_angle: 270, needle_color: WHITE, tick_color: [200, 200, 200, 255], tick_count: 10, background_color: TRACK, ranges: [], show_gauge: true, show_needle: true, needle_width: 14, needle_length_pct: 0.95, needle_border_color: [174, 10, 16, 255], needle_border_width: 1.5 },
  core_bars: { type: 'core_bars', orientation: 'horizontal', background_color: TRACK, show_labels: true, ranges: [] },
  image: { type: 'image', path: '', opacity: 1, fit: 'stretch' },
  video: { type: 'video', path: '', loop_playback: true, opacity: 1, fit: 'stretch' },
  clock_digital: { type: 'clock_digital', format: '%H:%M', font: FONT, font_size: 64, color: WHITE, align: 'center', letter_spacing: 0 },
  clock_analog: { type: 'clock_analog', face_color: TRACK, tick_color: [220, 220, 220, 255], minor_tick_color: [220, 220, 220, 255], hour_hand_color: [240, 240, 240, 255], minute_hand_color: [240, 240, 240, 255], second_hand_color: [220, 40, 40, 255], hub_color: [240, 240, 240, 255], numbers_color: [230, 230, 230, 255], numbers_font: FONT, numbers_font_size: 24, show_seconds: true, show_hour_ticks: true, show_minor_ticks: true, show_numbers: false, hour_hand_width: 6, minute_hand_width: 4, second_hand_width: 2, hour_hand_length_pct: 0.55, minute_hand_length_pct: 0.8, second_hand_length_pct: 0.9, hour_tick_length_pct: 0.12, minor_tick_length_pct: 0.05, hour_tick_width: 3, minor_tick_width: 1.5, hub_radius: 6 },
  sparkline: { type: 'sparkline', source: CPU, value_min: 0, value_max: 100, auto_range: false, history_length: 60, line_width: 2, line_color: [80, 180, 240, 255], fill_color: [80, 180, 240, 80], background_color: [0, 0, 0, 255], ranges: [], border_color: [80, 90, 110, 255], border_width: 0, corner_radius: 0, padding: 0, show_points: false, point_radius: 2.5, show_baseline: false, baseline_value: 0, baseline_color: [140, 140, 160, 160], baseline_width: 1, smooth: false, scroll_rtl: false, fill_from_ranges: false, range_blend: false, show_gridlines: false, gridlines_horizontal: 3, gridlines_vertical: 0, gridline_color: [120, 120, 140, 90], gridline_width: 1, show_axis_labels: false, axis_label_count: 3, axis_labels_on_right: false, axis_label_format: '{:.0}', axis_label_font: FONT, axis_label_size: 11, axis_label_color: [200, 200, 210, 220], axis_label_padding: 4 },
};

const ENUMS = { align: ['left', 'center', 'right'], fit: ['stretch', 'contain', 'cover'], orientation: ['horizontal', 'vertical'] };
const CATEGORIES = new Set(['cpu_temp', 'gpu_temp', 'cpu_usage', 'gpu_usage', 'mem_usage', 'mem_used', 'mem_free', 'network_rx', 'network_tx', 'disk_read', 'disk_write']);
const MAX_LIST = 64;
const MAX_WIDGETS = 256;
const MAX_SIZE = 8192;

const isByte = (value) => isInt(value, 0, 255);
const isRgb = (value) => Array.isArray(value) && value.length === 3 && value.every(isByte);
const isColorValue = (value) => Array.isArray(value) && (value.length === 3 || value.length === 4) && value.every(isByte);

function cleanList(value, max, cleanItem) {
  check(Array.isArray(value) && value.length <= max, 'Too many colour steps');
  return value.map(cleanItem);
}

function cleanRange(item) {
  check(item && (item.max === null || isNumber(item.max)) && isRgb(item.color), 'Invalid colour step');
  const alpha = item.alpha ?? 255;
  check(isByte(alpha), 'Invalid colour step');
  return { max: item.max, color: item.color, alpha };
}

function cleanStop(item) {
  check(item && isNumber(item.position, 0, 100) && isRgb(item.color), 'Invalid gradient');
  const alpha = item.alpha ?? 255;
  check(isByte(alpha), 'Invalid gradient');
  return { position: item.position, color: item.color, alpha };
}

function cleanValue(key, value, fallback, rules) {
  if (key === 'source') return rules.source(value);
  if (key === 'path') return rules.path(value);
  if (key === 'ranges') return cleanList(value, MAX_LIST, cleanRange);
  if (key === 'gradient_stops') return cleanList(value, MAX_LIST, cleanStop);
  if (fallback && typeof fallback === 'object' && 'path' in fallback) return { path: rules.font(value?.path ?? null) };
  if (Array.isArray(fallback)) {
    check(isColorValue(value), `Invalid colour for ${key}`);
    return value;
  }
  if (typeof fallback === 'boolean') {
    check(typeof value === 'boolean', `Invalid value for ${key}`);
    return value;
  }
  if (typeof fallback === 'number') {
    check(isNumber(value), `Invalid value for ${key}`);
    return value;
  }
  check(isText(value), `Invalid value for ${key}`);
  if (ENUMS[key]) check(ENUMS[key].includes(value), `Invalid value for ${key}`);
  return value;
}

function cleanKind(kind, rules) {
  const defaults = WIDGET_DEFAULTS[kind?.type];
  check(defaults, 'Unknown widget type');
  const clean = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    clean[key] = key === 'type' ? kind.type : cleanValue(key, kind[key] === undefined ? fallback : kind[key], fallback, rules);
  }
  return clean;
}

function cleanWidget(widget, rules) {
  check(widget && isText(widget.id, 128) && widget.id, 'A widget has no id');
  check(isNumber(widget.x) && isNumber(widget.y), 'A widget has an invalid position');
  check(isNumber(widget.width, 0.01) && isNumber(widget.height, 0.01), 'Widgets need a width and height above 0');
  const rotation = widget.rotation ?? 0;
  check(isNumber(rotation, -3600, 3600), 'Invalid rotation');
  const clean = { id: widget.id, kind: cleanKind(widget.kind, rules), x: widget.x, y: widget.y, width: widget.width, height: widget.height, rotation, visible: widget.visible !== false };
  if (widget.update_interval_ms !== undefined && widget.update_interval_ms !== null) {
    check(isInt(widget.update_interval_ms, 100, 10000), 'Update interval must be 100 to 10000 ms');
    clean.update_interval_ms = widget.update_interval_ms;
  }
  if (widget.fps !== undefined && widget.fps !== null) {
    check(isNumber(widget.fps, 1, 120), 'Frame rate must be 1 to 120');
    clean.fps = widget.fps;
  }
  if (widget.sensor_category !== undefined && widget.sensor_category !== null) {
    check(CATEGORIES.has(widget.sensor_category), 'Unknown sensor category');
    clean.sensor_category = widget.sensor_category;
  }
  return clean;
}

function cleanTemplate(template, rules) {
  check(template && typeof template === 'object', 'Invalid screen design');
  check(/^[\w.-]{1,128}$/.test(template.id || '') && !template.id.startsWith('unraid_'), 'Invalid screen id');
  check(isText(template.name, 80) && template.name.trim(), 'A screen design needs a name');
  check(isInt(template.base_width, 1, MAX_SIZE) && isInt(template.base_height, 1, MAX_SIZE), `Screen size must be 1 to ${MAX_SIZE} pixels`);
  check(Array.isArray(template.widgets) && template.widgets.length <= MAX_WIDGETS, 'Too many widgets');
  const { background } = template;
  let cleanBackground;
  if (background?.type === 'image') cleanBackground = { type: 'image', path: rules.path(background.path) };
  else {
    check(background?.type === 'color' && isColorValue(background.rgb), 'Invalid background');
    cleanBackground = { type: 'color', rgb: background.rgb };
  }
  const widgets = template.widgets.map((widget) => cleanWidget(widget, rules));
  check(new Set(widgets.map((widget) => widget.id)).size === widgets.length, 'Widget ids must be unique');
  const target = template.target_device ?? null;
  check(target === null || isText(target, 128), 'Invalid screen size label');
  return {
    id: template.id, name: template.name.trim(), base_width: template.base_width, base_height: template.base_height,
    background: cleanBackground, widgets, rotated: template.rotated === true, target_device: target,
  };
}

module.exports = { WIDGET_DEFAULTS, cleanTemplate };
