'use strict';

// Screen page additions: gauges, image position, video settings, startup
// images, the template catalog and storage cleanup.

const STARTUP_MAX_PIXELS = 16777216;
const GAUGE_DEFAULT = {
  label: 'CPU', unit: '%', source: { type: 'cpu_usage' }, text_color: [255, 255, 255], background_color: [0, 0, 0], gauge_background_color: [60, 60, 60],
  gauge_ranges: [{ max: 50, color: [0, 200, 0], alpha: 255 }, { max: 80, color: [220, 140, 0], alpha: 255 }, { max: null, color: [220, 0, 0], alpha: 255 }],
  gauge_start_angle: 90, gauge_sweep_angle: 330, gauge_outer_radius: 180, gauge_thickness: 40, bar_corner_radius: 0,
  value_font_size: 72, unit_font_size: 32, label_font_size: 28, font_path: null, decimal_places: 0, value_offset: 0, unit_offset: 60, label_offset: -60,
};

const startupEdits = new Map();
let catalogItems = null;
let catalogError = null;
let catalogBinding = null;
let catalogStatus = null;
let storageInfo = null;
let storageReview = null;
let previewTimer = null;

const newGauge = () => JSON.parse(JSON.stringify(GAUGE_DEFAULT));

// Screens -------------------------------------------------------------------

// Panels stay open across the page redrawing every few seconds.
const seenPanels = new Set();
function panelAttrs(id, startOpen = false) {
  if (startOpen && !seenPanels.has(id)) {
    seenPanels.add(id);
    openPanels.add(id);
  }
  return `data-panel="${esc(id)}" ${openPanels.has(id) ? 'open' : ''}`;
}

function gaugeEditor(device, screen) {
  const gauge = screen.sensor;
  const current = JSON.stringify(gauge.source);
  const known = data.sources.some((source) => source.id === current);
  const number = (key, text, min, max) => `<label>${text}<input type="number" min="${min}" max="${max}" data-g="${key}" value="${gauge[key]}"></label>`;
  const color = (key, text) => `<label>${text}<input type="color" data-g-color="${key}" value="${hex(gauge[key])}"></label>`;
  return `<details class="panel" ${panelAttrs(`${device.id}:gauge`, true)}><summary>Gauge</summary>
    <img class="thumb gauge-preview" alt="Gauge preview" data-gauge-preview>
    <label>Sensor<select data-g-source>
      ${data.sources.map((source) => option(source.id, source.name, source.id === current)).join('')}
      ${known ? '' : `<option value="${esc(current)}" selected>Current sensor</option>`}
    </select></label>
    <div class="two"><label>Label<input type="text" maxlength="32" data-g="label" value="${esc(gauge.label)}"></label><label>Unit<input type="text" maxlength="8" data-g="unit" value="${esc(gauge.unit)}"></label></div>
    <div class="colors">${color('text_color', 'Text')}${color('background_color', 'Background')}${color('gauge_background_color', 'Track')}</div>
    <h3>Colour steps</h3>
    ${gauge.gauge_ranges.map((range, index) => `<div class="points" data-g-range="${index}">
      <label>${range.max === null ? 'Above that' : 'Up to %'}${range.max === null ? '<input type="text" disabled value="100">' : `<input type="number" min="0" max="100" data-g-max value="${range.max}">`}</label>
      <label>Colour<input type="color" data-g-range-color value="${hex(range.color)}"></label>
      <button class="btn" data-g-remove="${index}" aria-label="Remove step" ${range.max === null ? 'disabled' : ''}>×</button>
    </div>`).join('')}
    <div class="actions"><button class="btn" data-g-add>Add step</button></div>
    <div class="two">${number('gauge_start_angle', 'Start angle', -360, 720)}${number('gauge_sweep_angle', 'Sweep', 1, 360)}</div>
    <div class="two">${number('gauge_outer_radius', 'Size', 10, 1024)}${number('gauge_thickness', 'Thickness', 1, 512)}</div>
    <div class="two">${number('value_font_size', 'Value text size', 1, 400)}${number('decimal_places', 'Decimals', 0, 10)}</div>
    <div class="two">${number('unit_font_size', 'Unit text size', 1, 400)}${number('label_font_size', 'Label text size', 1, 400)}</div>
    <div class="two">${number('unit_offset', 'Unit position', -500, 500)}${number('label_offset', 'Label position', -500, 500)}</div>
    <label>Update every (ms)<input type="number" min="100" max="10000" step="100" data-lcd-option="interval" value="${data.screenOptions[device.id]?.interval ?? 1000}"></label>
  </details>`;
}

function mediaOptions(device, screen) {
  const options = data.screenOptions[device.id] || {};
  const framing = options.framing || { fit: 'stretch', zoom: 1, offset_x: 0, offset_y: 0 };
  const moving = /\.(gif|mp4|webm|mkv|mov|avi|m4v)$/i.test(screen.path);
  return `<details class="panel" ${panelAttrs(`${device.id}:media`)}><summary>Position and playback</summary>
    <label>Fit<select data-frame="fit">${[['stretch', 'Stretch'], ['contain', 'Fit inside'], ['cover', 'Fill']].map(([value, text]) => option(value, text, value === framing.fit)).join('')}</select></label>
    <label><span class="slider-label"><span>Zoom</span><span data-out>${framing.zoom}×</span></span><input type="range" min="1" max="8" step="0.1" data-frame="zoom" data-show="×" value="${framing.zoom}"></label>
    <div class="two">
      <label>Move sideways<input type="range" min="-1" max="1" step="0.05" data-frame="offset_x" value="${framing.offset_x}"></label>
      <label>Move up or down<input type="range" min="-1" max="1" step="0.05" data-frame="offset_y" value="${framing.offset_y}"></label>
    </div>
    ${moving ? `<label>Frame rate (1 to 120)<input type="number" min="1" max="120" data-lcd-option="fps" value="${options.fps ?? ''}" placeholder="Default"></label>` : ''}
  </details>`;
}

function templateOptions(device) {
  const options = data.screenOptions[device.id] || {};
  return `<details class="panel" ${panelAttrs(`${device.id}:render`)}><summary>Rendering</summary>
    ${toggle('data-lcd-flag="smoothEdges"', 'Smooth edges', options.smooth_edges === true)}
    ${device.h264 ? toggle('data-lcd-flag="customH264"', 'Use H.264', options.custom_h264 !== false) : ''}
    ${device.cCommand ? toggle('data-lcd-flag="aio512Frame"', 'Use larger frames', options.aio_512_frame ?? device.family !== 'HydroShiftLcd') : ''}
  </details>`;
}

function startupPanel(device) {
  if (!device.startupImage) return '';
  const { width, height } = device.startupImage;
  const edit = startupEdits.get(device.id);
  const recovery = data.startupRecovery.includes(device.id);
  return `<details class="panel" ${edit ? 'open' : panelAttrs(`${device.id}:startup`)}><summary>Startup image</summary>
    <p class="muted">Shown when this screen powers on. It's stored on the device as ${width}×${height}.${device.family === 'WirelessAio' ? ' This model is experimental upstream.' : ''}</p>
    ${recovery ? '<p class="warn">An earlier startup image transfer needs clearing.</p><div class="actions"><button class="btn" data-startup-clear>Clear it</button></div>' : ''}
    <label>Choose an image<input type="file" accept="image/png,image/jpeg,image/bmp" data-startup-file></label>
    ${edit ? `<canvas class="startup-canvas" width="${width}" height="${height}" data-startup-canvas></canvas>
      <label><span class="slider-label"><span>Zoom</span><span data-out>${edit.zoom}%</span></span><input type="range" min="100" max="300" data-startup="zoom" data-show="%" value="${edit.zoom}"></label>
      <div class="two">
        <label>Move sideways<input type="range" min="-100" max="100" data-startup="panX" value="${edit.panX}"></label>
        <label>Move up or down<input type="range" min="-100" max="100" data-startup="panY" value="${edit.panY}"></label>
      </div>
      <label>Rotation<select data-startup="rotation">${[0, 90, 180, 270].map((angle) => option(angle, `${angle}°`, angle === edit.rotation)).join('')}</select></label>
      <div class="actions"><button class="btn primary" data-startup-send>Send to screen</button><button class="btn" data-startup-cancel>Cancel</button></div>
      <p class="muted" data-startup-note></p>` : ''}
  </details>`;
}

function lcdMore(device, screen) {
  return `<div class="more">
    ${screen?.kind === 'sensor' ? gaugeEditor(device, screen) : ''}
    ${screen?.kind === 'media' ? mediaOptions(device, screen) : ''}
    ${screen?.kind === 'template' ? templateOptions(device) : ''}
    ${startupPanel(device)}
  </div>`;
}

function desktopModeCard() {
  const stuck = data.devices.filter((device) => device.desktopMode);
  if (!stuck.length) return '';
  return `<div class="card notice"><b>Screens in monitor mode</b><p class="muted">Monitor mode needs a desktop session that this container doesn't have, so these screens stay blank until they're back in LCD mode.</p>
    ${stuck.map((device) => `<div class="row" data-device="${esc(device.id)}"><span>${esc(device.name)}</span><button class="btn primary" data-leave-desktop>Return to LCD mode</button></div>`).join('')}</div>`;
}

function designsCard() {
  return `<div class="card"><div class="card-head"><h2>Screen designs</h2></div>
    ${data.designs.map((item) => `<div class="row"><span>${esc(item.name)}</span><span class="row-actions"><button class="btn" data-design-edit="${esc(item.id)}">Edit</button><button class="btn danger" data-design-delete="${esc(item.id)}">Delete</button></span></div>`).join('') || '<p class="muted" style="margin:0">Build your own screens from text, gauges, clocks, images and video.</p>'}
    <div class="actions"><button class="btn primary" data-design-new>New design</button></div>
  </div>`;
}

// Catalog -------------------------------------------------------------------

function catalogBindingForm() {
  const { id, categories } = catalogBinding;
  const item = catalogItems.find((entry) => entry.id === id);
  return `<div class="zone"><h3>Choose sensors for ${esc(item.name)}</h3>
    ${categories.map(({ category, suggested }) => `<label>${esc(category.replace(/_/g, ' '))}<select data-catalog-bind="${esc(category)}">
      ${option('', 'Unavailable', !suggested)}
      ${data.sources.filter((source) => !source.id.includes('"command"')).map((source) => option(source.id, source.name, source.id === suggested)).join('')}
    </select></label>`).join('')}
    <div class="actions"><button class="btn primary" id="catalogInstall">Install</button><button class="btn" id="catalogCancel">Cancel</button></div>
  </div>`;
}

function catalogCard() {
  const head = '<div class="card-head"><h2>Template catalog</h2></div>';
  if (catalogError) return `<div class="card" id="catalog">${head}<p class="bad">${esc(catalogError)}</p><div class="actions"><button class="btn" id="catalogLoad">Try again</button></div></div>`;
  if (!catalogItems) return `<div class="card" id="catalog">${head}<p class="muted" style="margin:0">Ready-made screens from the Lian Li Linux project. Opening this downloads the list from GitHub.</p><div class="actions"><button class="btn" id="catalogLoad">Browse templates</button></div></div>`;
  return `<div class="card" id="catalog">${head}
    ${catalogStatus ? `<p class="muted">${esc(catalogStatus)}</p>` : ''}
    ${catalogBinding ? catalogBindingForm() : ''}
    <div class="gallery catalog">${catalogItems.map((item) => `<figure><img loading="lazy" alt="${esc(item.name)} preview" src="/api/catalog/preview?id=${encodeURIComponent(item.id)}">
      <figcaption>${esc(item.name)}${item.author ? `<br><span class="muted">by ${esc(item.author)}</span>` : ''}</figcaption>
      <button class="btn" data-catalog-get="${esc(item.id)}">${item.installed ? 'Reinstall' : 'Install'}</button></figure>`).join('') || '<p class="muted">No templates available for this version.</p>'}</div>
  </div>`;
}

async function installCatalog(id, bindings) {
  catalogBinding = null;
  catalogStatus = 'Installing…';
  renderScreens();
  try {
    const response = await fetch('/api/catalog/install', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ id, bindings }) });
    if (!response.ok) throw await failure(response);
    const started = await response.json();
    let status = started;
    while (!status?.finished) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = await (await fetch('/api/catalog/status')).json();
      if (status && status.operation_id !== started.operation_id) break;
    }
    if (status?.error) throw new Error(status.error);
    toast('Installed. It is in the Shows list under Your designs.');
    catalogItems = null;
    catalogStatus = null;
    await refresh(true);
    await loadCatalog();
  } catch (error) {
    catalogStatus = null;
    toast(error.message, true);
    renderScreens();
  }
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/catalog');
    if (!response.ok) throw await failure(response);
    catalogItems = await response.json();
    catalogError = null;
  } catch (error) {
    catalogError = error.message;
  }
  if (tab === 'screens') renderScreens();
}

// Storage cleanup -----------------------------------------------------------

function storageList(kind, title, entries) {
  if (entries?.error) return `<h3>${title}</h3><p class="muted">${esc(entries.error)}</p>`;
  if (!entries?.length) return `<h3>${title}</h3><p class="muted">Nothing stored.</p>`;
  const size = (bytes) => (bytes > 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`);
  return `<h3>${title}</h3>${entries.map((entry) => {
    const inUse = entry.saved_reference_count > 0 || entry.runtime_referenced;
    return `<div class="row"><span style="overflow-wrap:anywhere">${esc(entry.directory)}<br><span class="muted">${size(entry.bytes)}${inUse ? ', in use' : ''}${entry.issue ? `, ${esc(entry.issue)}` : ''}</span></span>
      <button class="btn" data-store-review="${esc(entry.directory)}" data-store-kind="${kind}" ${entry.ownership_verified ? '' : 'disabled'}>Review</button></div>`;
  }).join('')}`;
}

function storageReviewForm() {
  const { kind, directory, result } = storageReview;
  const { review } = result;
  const refs = review.references;
  const free = refs.saved_references_checked && refs.runtime_references_checked && refs.saved_reference_count === 0 && !refs.runtime_referenced;
  return `<div class="zone"><h3>${esc(directory)}</h3>
    <p class="muted">${review.contents.files.length} files${review.contents.missing_files?.length ? `, ${review.contents.missing_files.length} missing` : ''}. ${free ? 'Nothing is using this folder.' : 'Something is still using this folder, so it cannot be removed.'}</p>
    ${free ? `<label class="check"><input type="checkbox" id="storeConfirm"> Yes, permanently remove this folder</label>` : ''}
    <div class="actions">${free ? `<button class="btn danger" id="storeRemove" data-kind="${esc(kind)}">Remove</button>` : ''}<button class="btn" id="storeClose">Close</button></div></div>`;
}

function storageCleanupCard() {
  const head = '<div class="card-head"><h2>Stored template files</h2></div>';
  if (!storageInfo) return `<div class="card" id="storage">${head}<p class="muted" style="margin:0">See and remove files left behind by templates you no longer use.</p><div class="actions"><button class="btn" id="storeLoad">Check storage</button></div></div>`;
  return `<div class="card" id="storage">${head}
    ${storageReview ? storageReviewForm() : ''}
    ${storageList('catalog', 'Catalog templates', storageInfo.catalog)}
    ${storageList('media', 'Imported media', storageInfo.media)}
  </div>`;
}

async function loadStorage() {
  const response = await fetch('/api/storage-cleanup');
  if (!response.ok) throw await failure(response);
  storageInfo = await response.json();
}

// Startup images ------------------------------------------------------------

function drawStartup(card, edit) {
  const canvas = card.querySelector('[data-startup-canvas]');
  if (!canvas || !edit.image) return;
  const context = canvas.getContext('2d');
  const { width, height } = canvas;
  const sideways = edit.rotation % 180 !== 0;
  const imageWidth = sideways ? edit.image.naturalHeight : edit.image.naturalWidth;
  const imageHeight = sideways ? edit.image.naturalWidth : edit.image.naturalHeight;
  const scale = Math.max(width / imageWidth, height / imageHeight) * (edit.zoom / 100);
  const spareX = Math.max((imageWidth * scale - width) / 2, 0);
  const spareY = Math.max((imageHeight * scale - height) / 2, 0);
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2 + (edit.panX / 100) * spareX, height / 2 + (edit.panY / 100) * spareY);
  context.rotate((edit.rotation * Math.PI) / 180);
  context.scale(scale, scale);
  context.drawImage(edit.image, -edit.image.naturalWidth / 2, -edit.image.naturalHeight / 2);
  context.restore();
}

function canvasJpeg(canvas, limit) {
  for (let quality = 0.95; quality >= 0.3; quality -= 0.05) {
    const encoded = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if ((encoded.length * 3) / 4 <= limit) return encoded;
  }
  return null;
}

async function sendStartup(card, device) {
  const canvas = card.querySelector('[data-startup-canvas]');
  const note = card.querySelector('[data-startup-note]');
  const { max_jpeg_bytes: max, jpeg_target_bytes: target } = device.startupImage;
  const encoded = canvasJpeg(canvas, target || max) || canvasJpeg(canvas, max);
  if (!encoded) throw new Error('That image is too detailed to fit on this screen');
  const send = await fetch('/api/startup-image', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ device_id: device.id, jpeg_base64: encoded }) });
  if (!send.ok) throw await failure(send);
  const { id } = await send.json();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const status = await (await fetch('/api/startup-image')).json();
    if (status && status.id !== id) throw new Error('Another upload has started');
    const state = status?.status?.state || 'transferred';
    note.textContent = `Status: ${state}`;
    if (state === 'failed') throw new Error(status.status.message || 'The upload failed');
    if (state === 'cancelled') throw new Error('The upload was cancelled');
    if (state === 'transferred') return;
  }
}

// Events --------------------------------------------------------------------

function saveGauge(deviceId, change) {
  const gauge = JSON.parse(JSON.stringify(data.settings.screens[deviceId].sensor));
  change(gauge);
  return post('/api/screen', { device_id: deviceId, screen: { kind: 'sensor', sensor: gauge } });
}

function gaugeChanged(deviceId, change) {
  saveGauge(deviceId, change).then(() => { toast('Saved'); return refresh(true); }).then(() => loadGaugePreviews()).catch((error) => toast(error.message, true));
}

async function loadGaugePreviews() {
  clearTimeout(previewTimer);
  for (const image of view.querySelectorAll('[data-gauge-preview]')) {
    const deviceId = deviceOf(image);
    const device = data.devices.find((item) => item.id === deviceId);
    const response = await fetch('/api/lcd/sensor-preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' },
      body: JSON.stringify({ sensor: data.settings.screens[deviceId].sensor, width: Math.min(device.screenWidth || 400, 400), height: Math.min(device.screenHeight || 400, 400) }),
    }).catch(() => null);
    if (response?.ok) image.src = `data:image/jpeg;base64,${(await response.json()).jpeg_base64}`;
  }
}

const baseRenderScreens = renderScreens;
// eslint-disable-next-line no-global-assign
renderScreens = function renderScreensWithExtras() {
  baseRenderScreens();
  previewTimer = setTimeout(loadGaugePreviews, 50);
  for (const [deviceId, edit] of startupEdits) {
    const card = view.querySelector(`[data-device="${CSS.escape(deviceId)}"]`);
    if (card) drawStartup(card, edit);
  }
};
RENDER.screens = () => renderScreens();

function postFraming(card) {
  const read = (key) => card.querySelector(`[data-frame="${key}"]`).value;
  const fps = card.querySelector('[data-lcd-option="fps"]');
  act('/api/lcd/options', {
    device_id: card.dataset.device,
    framing: { fit: read('fit'), zoom: Number(read('zoom')), offset_x: Number(read('offset_x')), offset_y: Number(read('offset_y')) },
    ...(fps?.value ? { fps: Number(fps.value) } : {}),
  });
}

view.addEventListener('input', (event) => {
  const { target } = event;
  if (!target.dataset.startup) return;
  const card = target.closest('[data-device]');
  const edit = startupEdits.get(card.dataset.device);
  edit[target.dataset.startup] = Number(target.value);
  drawStartup(card, edit);
});

view.addEventListener('change', (event) => {
  const { target } = event;
  const card = target.closest('[data-device]');
  const deviceId = card?.dataset.device;
  const set = target.dataset;
  if (set.g) {
    const text = set.g === 'label' || set.g === 'unit';
    target.blur();
    gaugeChanged(deviceId, (gauge) => { gauge[set.g] = text ? target.value : Number(target.value); });
  } else if (set.gColor) {
    target.blur();
    gaugeChanged(deviceId, (gauge) => { gauge[set.gColor] = rgbOf(target.value); });
  } else if (target.matches('[data-g-source]')) {
    const source = data.sources.find((item) => item.id === target.value);
    target.blur();
    gaugeChanged(deviceId, (gauge) => {
      gauge.source = JSON.parse(target.value);
      if (source) {
        gauge.label = source.name.slice(0, 32);
        gauge.unit = (source.unit || '').slice(0, 8);
      }
    });
  } else if (target.matches('[data-g-max]') || target.matches('[data-g-range-color]')) {
    const index = Number(target.closest('[data-g-range]').dataset.gRange);
    target.blur();
    gaugeChanged(deviceId, (gauge) => {
      if (target.matches('[data-g-max]')) gauge.gauge_ranges[index].max = Number(target.value);
      else gauge.gauge_ranges[index].color = rgbOf(target.value);
    });
  } else if (set.frame) {
    target.blur();
    postFraming(card);
  } else if (set.lcdOption === 'interval') {
    target.blur();
    act('/api/lcd/options', { device_id: deviceId, interval: Number(target.value) });
  } else if (set.lcdOption === 'fps') {
    target.blur();
    postFraming(card);
  } else if (set.lcdFlag) {
    const flags = { device_id: deviceId };
    card.querySelectorAll('[data-lcd-flag]').forEach((box) => { flags[box.dataset.lcdFlag] = box.checked; });
    act('/api/lcd/options', flags);
  } else if (target.matches('[data-startup-file]')) {
    const file = target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth * image.naturalHeight > STARTUP_MAX_PIXELS) {
        toast('That image is too large', true);
        return;
      }
      startupEdits.set(deviceId, { image, zoom: 100, panX: 0, panY: 0, rotation: 0 });
      renderScreens();
    };
    image.onerror = () => toast("That image can't be read", true);
    image.src = url;
  } else if (set.startup === 'rotation') {
    startupEdits.get(deviceId).rotation = Number(target.value);
    drawStartup(card, startupEdits.get(deviceId));
  }
});

view.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const set = target.dataset;
  const card = target.closest('[data-device]');
  const deviceId = card?.dataset.device;
  try {
    if (set.gAdd !== undefined) {
      gaugeChanged(deviceId, (gauge) => {
        const steps = gauge.gauge_ranges.filter((range) => range.max !== null);
        const last = steps[steps.length - 1]?.max ?? 0;
        gauge.gauge_ranges.splice(steps.length, 0, { max: Math.min(last + 10, 100), color: [255, 255, 255], alpha: 255 });
      });
    } else if (set.gRemove !== undefined) {
      gaugeChanged(deviceId, (gauge) => { gauge.gauge_ranges.splice(Number(set.gRemove), 1); });
    } else if (set.leaveDesktop !== undefined) {
      if (window.confirm('Return this screen to LCD mode? It restarts while switching.')) act('/api/lcd/leave-desktop', { device_id: deviceId }, 'Switching. It should reappear shortly.');
    } else if (set.startupCancel !== undefined) {
      startupEdits.delete(deviceId);
      renderScreens();
    } else if (set.startupClear !== undefined) {
      act('/api/startup-image/clear', { device_id: deviceId }, 'Cleared');
    } else if (set.startupSend !== undefined) {
      target.disabled = true;
      try {
        await sendStartup(card, data.devices.find((item) => item.id === deviceId));
        startupEdits.delete(deviceId);
        toast('Startup image sent');
        renderScreens();
      } finally {
        target.disabled = false;
      }
    } else if (target.id === 'catalogLoad') {
      catalogError = null;
      target.disabled = true;
      await loadCatalog();
    } else if (set.catalogGet) {
      target.disabled = true;
      const prepare = await fetch('/api/catalog/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ id: set.catalogGet }) });
      if (!prepare.ok) throw await failure(prepare);
      const { categories } = await prepare.json();
      if (categories.length) {
        catalogBinding = { id: set.catalogGet, categories };
        renderScreens();
        document.getElementById('catalog').scrollIntoView({ block: 'nearest' });
      } else {
        await installCatalog(set.catalogGet, {});
      }
    } else if (target.id === 'catalogCancel') {
      catalogBinding = null;
      renderScreens();
    } else if (target.id === 'catalogInstall') {
      const bindings = {};
      view.querySelectorAll('[data-catalog-bind]').forEach((select) => { bindings[select.dataset.catalogBind] = select.value || null; });
      await installCatalog(catalogBinding.id, bindings);
    } else if (target.id === 'storeLoad') {
      await loadStorage();
      renderScreens();
    } else if (set.storeReview) {
      target.disabled = true;
      toast('Reviewing…');
      const response = await fetch('/api/storage-cleanup/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ kind: set.storeKind, directory: set.storeReview }) });
      if (!response.ok) throw await failure(response);
      storageReview = { kind: set.storeKind, directory: set.storeReview, result: await response.json() };
      renderScreens();
    } else if (target.id === 'storeClose') {
      storageReview = null;
      renderScreens();
    } else if (target.id === 'storeRemove') {
      if (!document.getElementById('storeConfirm').checked) {
        toast('Tick the box to confirm', true);
        return;
      }
      await post('/api/storage-cleanup/remove', { kind: storageReview.kind, operationId: storageReview.result.operation_id });
      storageReview = null;
      await loadStorage();
      toast('Removed');
      renderScreens();
    }
  } catch (error) {
    toast(error.message, true);
  }
});
