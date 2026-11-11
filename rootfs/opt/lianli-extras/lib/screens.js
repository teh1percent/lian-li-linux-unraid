'use strict';

// Sensor gauge screens, the screen designer, the template catalog, storage
// cleanup and startup images. Anything from the browser that names a file or a
// sensor is checked here, because the daemon follows paths and runs commands.

const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const { check, isInt, isNumber, isText } = require('./check');
const { cleanSource, sourceOptions } = require('./sources');
const { WIDGET_DEFAULTS, cleanTemplate } = require('./widgets');
const { isColor } = require('./themes');

const CATALOG_BASE = 'https://raw.githubusercontent.com/sgtaziz/lian-li-linux/main/templates';
const CATALOG_TTL_MS = 3600000;
const CATALOG_MAX_BYTES = 1024 * 1024;
const CATALOG_MAX_TEMPLATES = 128;
const CATEGORY_LIMIT = 32;
const FETCH_TIMEOUT_MS = 15000;
const POLL_MS = 500;
const REVIEW_TIMEOUT_MS = 30000;
const MAX_PREVIEW_EDGE = 1024;
const FILE_NAME = /^[\w. -]{1,128}$/;
const FOLDER_NAME = /^[\w.-]{1,128}$/;
const FIT = new Set(['stretch', 'contain', 'cover']);
const STORAGE = {
  catalog: { list: 'GetCatalogStorage', start: 'StartCatalogReview', get: 'GetCatalogReview', remove: 'StartCatalogRemoval' },
  media: { list: 'GetManagedMediaStorage', start: 'StartManagedMediaReview', get: 'GetManagedMediaReview', remove: 'StartManagedMediaRemoval' },
};
const SENSOR_DEFAULTS = {
  label: 'CPU', unit: '%', source: { type: 'cpu_usage' }, text_color: [255, 255, 255], background_color: [0, 0, 0], gauge_background_color: [60, 60, 60],
  gauge_ranges: [{ max: 50, color: [0, 200, 0], alpha: 255 }, { max: 80, color: [220, 140, 0], alpha: 255 }, { max: null, color: [220, 0, 0], alpha: 255 }],
  gauge_start_angle: 90, gauge_sweep_angle: 330, gauge_outer_radius: 180, gauge_thickness: 40, bar_corner_radius: 0,
  value_font_size: 72, unit_font_size: 32, label_font_size: 28, font_path: null, decimal_places: 0, value_offset: 0, unit_offset: 60, label_offset: -60,
};
// Devices left in monitor firmware. They can only be sent back to LCD mode here,
// because monitor mode needs a desktop session that a container doesn't have.
const DESKTOP_FAMILIES = new Set(['HydroShift2LcdDesktop', 'Lancool207Desktop', 'UniversalScreenDesktop', 'Vision9p2Desktop']);
// Uploading a startup image to a TL Flex screen left it unable to boot (it
// dropped off USB until the startup selection was reset), so it isn't offered.
const NO_STARTUP_IMAGE_FAMILIES = new Set(['TlFlexLcd']);
const H264_FAMILIES = new Set(['HydroShiftLcd', 'Galahad2Lcd', 'HydroShift2Lcd', 'HydroShift2OledCurveLcd', 'UniversalScreen', 'TlFlexLcd', 'SlInfFlexLcd']);

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

function versionAtLeast(have, wanted) {
  const parts = (text) => String(text).split(/[.+-]/).slice(0, 3).map((part) => Number(part) || 0);
  const [one, two] = [parts(have), parts(wanted)];
  for (let index = 0; index < 3; index += 1) {
    if ((one[index] || 0) !== (two[index] || 0)) return (one[index] || 0) > (two[index] || 0);
  }
  return true;
}

async function defaultDownload(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'lianli-dashboard' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > CATALOG_MAX_BYTES) throw new Error('Download too large');
  return body;
}

function defaultListFonts() {
  return new Promise((resolve) => {
    execFile('fc-list', ['--format=%{family[0]}\t%{file}\n'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      const seen = new Map();
      for (const line of stdout.split('\n')) {
        const [family, file] = line.split('\t');
        if (family && file && /\.(ttf|otf)$/i.test(file) && !seen.has(family)) seen.set(family, file);
      }
      return resolve([...seen].map(([name, file]) => ({ name, path: file })).sort((one, two) => one.name.localeCompare(two.name)));
    });
  });
}

function createScreens({ daemon, engine, store, options, findDevice, download = defaultDownload, listFonts = defaultListFonts }) {
  const { statsDir } = options;
  const roots = () => [options.mediaDir, options.uploadDir, options.templatesDir].filter(Boolean).map((dir) => path.resolve(dir));
  let fonts = null;
  let catalog = null;

  const fontList = async () => {
    fonts ||= await listFonts();
    return fonts;
  };

  function cleanPath(file, { allowEmpty = false } = {}) {
    if (allowEmpty && file === '') return file;
    check(isText(file, 4096) && file && !file.split(/[\\/]/).includes('..'), 'Choose a file');
    const resolved = path.resolve(file);
    check(roots().some((root) => resolved === root || resolved.startsWith(root + path.sep)), 'Files must come from the LCD media or upload folders');
    return file;
  }

  async function templateRules({ allowEmpty }) {
    const known = new Set((await fontList()).map((font) => font.path));
    return {
      source: (source) => cleanSource(source, statsDir),
      path: (file) => cleanPath(file, { allowEmpty }),
      font: (file) => {
        if (file === null || file === '') return null;
        return known.has(file) ? file : cleanPath(file);
      },
    };
  }

  function cleanSensor(sensor) {
    check(sensor && typeof sensor === 'object', 'Invalid gauge');
    const merged = { ...SENSOR_DEFAULTS, ...sensor };
    const sweep = merged.gauge_sweep_angle;
    check(isText(merged.label, 64) && isText(merged.unit, 16), 'Label and unit are too long');
    check(isColor(merged.text_color) && isColor(merged.background_color) && isColor(merged.gauge_background_color), 'Invalid colour');
    check(isNumber(sweep) && sweep > 0 && sweep <= 360 && isNumber(merged.gauge_start_angle, -360, 720), 'Invalid gauge angle');
    check(isNumber(merged.gauge_thickness) && merged.gauge_thickness > 0 && isNumber(merged.gauge_outer_radius) && merged.gauge_outer_radius > merged.gauge_thickness + 5, 'The gauge must be larger than its thickness');
    for (const key of ['value_font_size', 'unit_font_size', 'label_font_size']) check(isNumber(merged[key]) && merged[key] > 0, 'Font sizes must be above 0');
    check(isNumber(merged.bar_corner_radius, 0), 'Invalid corner radius');
    check(isInt(merged.decimal_places, 0, 10), 'Decimal places must be 0 to 10');
    for (const key of ['value_offset', 'unit_offset', 'label_offset']) check(isNumber(merged[key]), 'Invalid text position');
    check(Array.isArray(merged.gauge_ranges) && merged.gauge_ranges.length >= 1 && merged.gauge_ranges.length <= 16, 'Invalid colour steps');
    let last = -Infinity;
    for (const range of merged.gauge_ranges) {
      check(range && isColor(range.color) && isInt(range.alpha ?? 255, 0, 255), 'Invalid colour step');
      if (range.max !== null) {
        check(isNumber(range.max, 0, 100) && range.max >= last, 'Colour steps must go up from 0 to 100');
        last = range.max;
      }
    }
    const font = merged.font_path;
    check(font === null || (fonts || []).some((item) => item.path === font), 'Unknown font');
    return {
      ...Object.fromEntries(Object.keys(SENSOR_DEFAULTS).map((key) => [key, merged[key]])),
      source: cleanSource(merged.source, statsDir),
    };
  }

  // Which entry fields an LCD screen can carry beyond what it shows.
  function cleanOptions(body) {
    const clean = {};
    if (body.fps !== undefined && body.fps !== null) {
      check(isInt(body.fps, 1, 120), 'Frame rate must be 1 to 120');
      clean.fps = body.fps;
    }
    if (body.interval !== undefined && body.interval !== null) {
      check(isInt(body.interval, 100, 10000), 'Update interval must be 100 to 10000 ms');
      clean.interval = body.interval;
    }
    if (body.framing) {
      const { fit, zoom, offset_x: offsetX, offset_y: offsetY } = body.framing;
      check(FIT.has(fit) && isNumber(zoom, 1, 8) && isNumber(offsetX, -1, 1) && isNumber(offsetY, -1, 1), 'Invalid image position');
      clean.framing = { fit, zoom, offset_x: offsetX, offset_y: offsetY };
    }
    for (const [from, to] of [['smoothEdges', 'smooth_edges'], ['customH264', 'custom_h264'], ['aio512Frame', 'aio_512_frame']]) {
      if (typeof body[from] === 'boolean') clean[to] = body[from];
    }
    return clean;
  }

  async function setOptions(body) {
    const device = await findDevice(body.device_id);
    check(device.has_lcd, 'This device has no screen');
    store.data.screenOptions[device.device_id] = cleanOptions(body);
    store.save();
    await engine.tick();
  }

  async function sensorPreview(body) {
    await fontList();
    const width = Math.min(isInt(body.width, 1, 8192) ? body.width : 400, MAX_PREVIEW_EDGE);
    const height = Math.min(isInt(body.height, 1, 8192) ? body.height : 400, MAX_PREVIEW_EDGE);
    const lcd = { serial: 'preview', type: 'sensor', path: null, fps: null, rgb: null, orientation: 0, template_id: null, sensor: cleanSensor(body.sensor), update_interval_ms: 1000 };
    return daemon.request('RenderSensorPreview', { lcd, width, height });
  }

  // Designer ---------------------------------------------------------------

  const isOurs = (template) => String(template.id).startsWith('unraid_');

  async function listDesigns() {
    return (await daemon.request('GetLcdTemplates')).filter((template) => !isOurs(template));
  }

  async function designPreview(body) {
    const template = cleanTemplate(body.template, await templateRules({ allowEmpty: true }));
    template.widgets = template.widgets.filter((widget) => widget.kind.path !== '');
    return daemon.request('RenderTemplatePreview', { template, width: Math.min(template.base_width, MAX_PREVIEW_EDGE), height: Math.min(template.base_height, MAX_PREVIEW_EDGE) });
  }

  async function saveDesign(body) {
    const template = cleanTemplate(body.template, await templateRules({ allowEmpty: false }));
    const stored = await daemon.request('GetLcdTemplates');
    check(!stored.some((item) => item.name === template.name && item.id !== template.id), 'A screen design with that name already exists');
    const original = stored.find((item) => item.id === template.id);
    await daemon.write('MergeLcdTemplates', { originals: original ? [original] : [], copies: [template] });
    await engine.tick();
    return { id: template.id };
  }

  async function deleteDesign(body) {
    const stored = await daemon.request('GetLcdTemplates');
    const template = stored.find((item) => item.id === body.id);
    check(template && !isOurs(template), 'Unknown screen design');
    const config = await daemon.request('GetConfig');
    const inUse = (config.lcds || []).some((lcd) => lcd.template_id === body.id)
      || Object.values(store.data.screens).some((screen) => screen.templateId === body.id)
      || store.data.schedules.some((schedule) => schedule.templateId === body.id);
    check(!inUse, 'A screen or schedule is using this design. Choose something else first.');
    await daemon.write('SetLcdTemplates', { templates: stored.filter((item) => item.id !== body.id) });
  }

  // Catalog ----------------------------------------------------------------

  async function loadCatalog() {
    if (catalog && Date.now() < catalog.expires) return catalog.templates;
    const manifest = JSON.parse((await download(`${CATALOG_BASE}/default_templates.json`)).toString('utf8'));
    if (manifest.schema_version !== 1 || !Array.isArray(manifest.templates)) throw new Error('The template catalog has an unknown format');
    const templates = manifest.templates.slice(0, CATALOG_MAX_TEMPLATES)
      .filter((item) => FOLDER_NAME.test(item.folder || '') && FILE_NAME.test(item.template_file || '') && FILE_NAME.test(item.preview || ''));
    catalog = { templates, expires: Date.now() + CATALOG_TTL_MS, previews: new Map() };
    return templates;
  }

  async function findCatalogTemplate(id) {
    const template = (await loadCatalog()).find((item) => item.id === id);
    check(template, 'Unknown template');
    return template;
  }

  const assetUrl = (template, file) => `${CATALOG_BASE}/assets/${encodeURIComponent(template.folder)}/${encodeURIComponent(file)}`;

  async function verifiedAsset(template, file, sha256) {
    const body = await download(assetUrl(template, file));
    if (crypto.createHash('sha256').update(body).digest('hex') !== String(sha256).toLowerCase()) throw new Error('The downloaded file failed its checksum');
    return body;
  }

  async function catalogList() {
    const { version } = await daemon.request('GetDaemonInfo');
    const installed = new Set((await daemon.request('GetLcdTemplates')).map((item) => item.id));
    return (await loadCatalog()).filter((item) => versionAtLeast(version, item.min_daemon_version || '0')).map((item) => ({
      id: item.id, name: item.name, description: item.description || '', author: item.author || '',
      width: item.base_width, height: item.base_height, installed: installed.has(item.id),
    }));
  }

  async function catalogPreview(url) {
    const template = await findCatalogTemplate(url.searchParams.get('id'));
    if (!catalog.previews.has(template.id)) catalog.previews.set(template.id, await verifiedAsset(template, template.preview, template.preview_sha256));
    const extension = path.extname(template.preview).toLowerCase();
    return { type: extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg', body: catalog.previews.get(template.id) };
  }

  // Lists the sensors a template wants, so they can be matched to this machine's.
  async function catalogPrepare(body) {
    const template = await findCatalogTemplate(body.id);
    const parsed = JSON.parse((await verifiedAsset(template, template.template_file, template.template_sha256)).toString('utf8'));
    const categories = [...new Set((parsed.widgets || []).filter((widget) => widget.sensor_category && widget.kind?.source).map((widget) => widget.sensor_category))].slice(0, CATEGORY_LIMIT);
    if (!categories.length) return { categories: [] };
    const suggested = await daemon.request('SuggestSensorSources', { categories }).catch(() => []);
    return {
      categories: categories.map((category, index) => {
        const source = suggested[index];
        return { category, suggested: source && source.type !== 'command' ? JSON.stringify(source) : '' };
      }),
    };
  }

  async function catalogInstall(body) {
    const template = await findCatalogTemplate(body.id);
    const bindings = {};
    for (const [category, value] of Object.entries(body.bindings || {})) {
      check(/^[a-z_]{1,32}$/.test(category), 'Unknown sensor category');
      if (value === null || value === '') bindings[category] = null;
      else {
        let source;
        try {
          source = JSON.parse(value);
        } catch {
          check(false, 'Unknown sensor');
        }
        bindings[category] = cleanSource(source, statsDir);
      }
    }
    return daemon.write('StartCatalogInstall', { template, sensor_bindings: bindings });
  }

  // Storage cleanup --------------------------------------------------------

  const storageKind = (kind) => {
    check(Object.hasOwn(STORAGE, kind), 'Unknown storage');
    return STORAGE[kind];
  };

  async function storageList() {
    const read = (kind) => daemon.request(STORAGE[kind].list).catch((error) => ({ error: error.message }));
    const [templates, media] = await Promise.all([read('catalog'), read('media')]);
    return { catalog: templates, media };
  }

  async function waitForOperation(method, operationId, done) {
    const deadline = Date.now() + REVIEW_TIMEOUT_MS;
    for (;;) {
      const status = await daemon.request(method, { operation_id: operationId });
      if (status.error) throw new Error(status.error);
      if (done(status)) return status;
      if (Date.now() > deadline) throw new Error('This is taking too long. Check the list again in a moment.');
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async function storageReview(body) {
    const kind = storageKind(body.kind);
    check(/^[^/\\]{1,160}$/.test(body.directory || ''), 'Unknown folder');
    const started = await daemon.request(kind.start, { directory: body.directory });
    return waitForOperation(kind.get, started.operation_id, (status) => status.finished);
  }

  function removable(references) {
    return references && references.saved_references_checked === true && references.runtime_references_checked === true
      && references.saved_reference_count === 0 && !(references.saved_references || []).length && references.runtime_referenced === false;
  }

  async function storageRemove(body) {
    const kind = storageKind(body.kind);
    check(isText(body.operationId, 128) && body.operationId, 'Review this folder first');
    const review = await daemon.request(kind.get, { operation_id: body.operationId });
    check(removable(review.review?.references), 'This folder is still in use, so it cannot be removed');
    const started = await daemon.write(kind.remove, { operation_id: body.operationId });
    const finished = await waitForOperation(kind.get, started?.operation_id ?? body.operationId, (status) => status.finished);
    check(finished.removed === true, 'The folder was not removed. Review it again.');
    return { removed: true };
  }

  // Startup image ----------------------------------------------------------

  async function uploadStartupImage(body) {
    const device = await findDevice(body.device_id);
    const limits = device.startup_image;
    check(!NO_STARTUP_IMAGE_FAMILIES.has(device.family), 'Startup images are turned off for TL Flex screens, because one stopped a screen booting');
    check(limits, 'This screen has no startup image');
    check(typeof body.jpeg_base64 === 'string' && body.jpeg_base64, 'Choose an image');
    const jpeg = Buffer.from(body.jpeg_base64, 'base64');
    check(jpeg.length <= limits.max_jpeg_bytes, 'That image is too large for this screen');
    const size = jpegSize(jpeg);
    check(size && size.width === limits.width && size.height === limits.height, `The image must be ${limits.width}×${limits.height}`);
    return daemon.write('UploadStartupImage', { device_id: device.device_id, jpeg_base64: body.jpeg_base64 });
  }

  async function cancelStartupImage(body) {
    check(isInt(body.id, 0, Number.MAX_SAFE_INTEGER), 'Unknown upload');
    return daemon.write('CancelStartupImage', { id: body.id });
  }

  async function clearRecovery(body) {
    const device = await findDevice(body.device_id);
    return daemon.write('ClearStartupImageRecovery', { device_id: device.device_id });
  }

  async function leaveDesktopMode(body) {
    const device = await findDevice(body.device_id);
    check(DESKTOP_FAMILIES.has(device.family), 'This screen is already in LCD mode');
    return daemon.write('SwitchDisplayMode', { device_id: device.device_id });
  }

  return {
    cleanSensor: async (sensor) => {
      await fontList();
      return cleanSensor(sensor);
    },
    routes: { '/api/lcd/options': setOptions, '/api/design/delete': deleteDesign, '/api/startup-image/clear': clearRecovery, '/api/lcd/leave-desktop': leaveDesktopMode },
    unqueued: new Set(['/api/lcd/options', '/api/design/save']),
    dataRoutes: {
      '/api/lcd/sensor-preview': sensorPreview,
      '/api/design/preview': designPreview,
      '/api/design/save': saveDesign,
      '/api/catalog/prepare': catalogPrepare,
      '/api/catalog/install': catalogInstall,
      '/api/storage-cleanup/review': storageReview,
      '/api/storage-cleanup/remove': storageRemove,
      '/api/startup-image': uploadStartupImage,
      '/api/startup-image/cancel': cancelStartupImage,
    },
    gets: {
      '/api/fonts': fontList,
      '/api/designs': listDesigns,
      '/api/design/schema': () => ({ widgets: WIDGET_DEFAULTS, media: null }),
      '/api/catalog': catalogList,
      '/api/catalog/status': () => daemon.request('GetCatalogInstallStatus'),
      '/api/storage-cleanup': storageList,
      '/api/startup-image': () => daemon.request('GetStartupImageStatus'),
    },
    binary: { '/api/catalog/preview': catalogPreview },
    state: async ({ listed, telemetry }) => {
      const stored = await daemon.request('GetLcdTemplates').catch(() => []);
      return {
        sources: sourceOptions(listed, statsDir, engine.getStats().volumes).map(({ id, name, unit }) => ({ id, name, unit })),
        designs: stored.filter((template) => !isOurs(template)).map(({ id, name }) => ({ id, name })),
        screenOptions: store.data.screenOptions,
        startupRecovery: Object.values(telemetry.media_preparation || {})
          .filter((item) => item?.startup_recovery_required)
          .map((item) => item.device_id),
      };
    },
    device: (device) => (device.has_lcd || DESKTOP_FAMILIES.has(device.family) ? {
      family: device.family,
      screenWidth: device.screen_width ?? null,
      screenHeight: device.screen_height ?? null,
      startupImage: NO_STARTUP_IMAGE_FAMILIES.has(device.family) ? null : device.startup_image || null,
      desktopMode: DESKTOP_FAMILIES.has(device.family),
      h264: H264_FAMILIES.has(device.family),
      cCommand: device.supports_c_command === true,
    } : {}),
  };
}

module.exports = { createScreens, jpegSize, SENSOR_DEFAULTS };
