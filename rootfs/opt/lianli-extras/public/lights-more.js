'use strict';

// Lighting page additions: zones, regions, single LEDs, presets, Quick Sync,
// motherboard sync and the OpenRGB server.

const openPanels = new Set();
const ledState = new Map();
const BRIGHTNESS = ['20%', '40%', '60%', '80%', '100%'];
const SPEEDS = ['Slowest', 'Slow', 'Medium', 'Fast', 'Fastest'];
let syncDraft = null;

holds.push(() => tab === 'lights' && syncDraft !== null);

function syncActive(deviceId) {
  const sync = data.quickSync;
  return Boolean(sync?.enabled && sync.device_order?.includes(deviceId) && !sync.disabled_devices?.includes(deviceId));
}

function syncNotice() {
  return data.devices.some((device) => syncActive(device.id)) ? '<div class="card notice">Quick Sync is on. Devices in it follow the Quick Sync effect instead of their own.</div>' : '';
}

function motherboardCard(device) {
  return `<div class="card" data-device="${esc(device.id)}"><div class="card-head"><h2>${esc(device.name)}</h2><span class="pill accent">Motherboard</span></div>
    <p class="muted" style="margin:0">The motherboard controls this device's lighting.</p>
    ${toggle('data-rgb-motherboard', 'Motherboard ARGB sync', true)}
  </div>`;
}

function panel(id, title, body) {
  return `<details class="panel" data-panel="${esc(id)}" ${openPanels.has(id) ? 'open' : ''}><summary>${esc(title)}</summary>${body}</details>`;
}

function effectEditor(attribute, effect, modes, { showScope = [], maxColors = 4 } = {}) {
  const current = effect || { mode: modes[0] || 'Static', colors: [[255, 255, 255]], brightness: 4, speed: 2 };
  const list = modes.includes(current.mode) ? modes : [current.mode, ...modes];
  const hideColors = current.mode === 'Direct' || COLOR_FREE.has(current.mode);
  const colors = hideColors ? [] : Array.from({ length: Math.max(Math.min(current.colors?.length || 1, maxColors), 1) }, (_, index) => current.colors?.[index] || [255, 255, 255]);
  return `<div class="effect" ${attribute}>
    <label>Effect<select data-e="mode">${list.map((mode) => option(mode, spaced(mode), mode === current.mode)).join('')}</select></label>
    ${colors.length ? `<div class="colors">${colors.map((color, index) => `<label>Colour ${index + 1}<input type="color" data-e="color" value="${hex(color)}"></label>`).join('')}</div>
    ${maxColors > 1 ? `<div class="row-actions" style="margin-top:6px">
      <button class="btn" data-color-count="1" ${colors.length >= maxColors ? 'disabled' : ''}>Add colour</button>
      <button class="btn" data-color-count="-1" ${colors.length <= 1 ? 'disabled' : ''}>Remove colour</button>
    </div>` : ''}` : ''}
    <div class="two">
      <label>Brightness<select data-e="brightness">${BRIGHTNESS.map((name, level) => option(level, name, level === (current.brightness ?? 4))).join('')}${option(255, 'Off', current.brightness === 255)}</select></label>
      <label>Speed<select data-e="speed">${SPEEDS.map((name, level) => option(level, name, level === (current.speed ?? 2))).join('')}</select></label>
    </div>
    ${showScope.length ? `<label>Part of the fan<select data-e="scope">${showScope.map((scope) => option(scope, spaced(scope), scope === current.scope)).join('')}</select></label>` : ''}
  </div>`;
}

function readEffect(element) {
  const value = (key) => element.querySelector(`[data-e="${key}"]`)?.value;
  const colors = [...element.querySelectorAll('[data-e="color"]')].map((input) => rgbOf(input.value));
  const effect = { mode: value('mode'), brightness: Number(value('brightness')), speed: Number(value('speed')) };
  if (colors.length) effect.colors = colors;
  if (value('scope')) effect.scope = value('scope');
  return effect;
}

function ledKey(deviceId, zone) {
  return `${deviceId}|${zone}`;
}

function ledEditor(device, index, zone) {
  const state = ledState.get(ledKey(device.id, index));
  if (!state) return `<div class="actions"><button class="btn" data-led-load="${index}">Edit single LEDs</button></div>`;
  return `<div class="led-grid" data-leds="${index}" role="group" aria-label="${esc(zone.name)} LEDs">${state.colors.map((color, led) => `<button class="led ${state.selected.has(led) ? 'on' : ''}" data-led="${led}" style="background:${hex(color)}" title="LED ${led + 1}" aria-pressed="${state.selected.has(led)}"></button>`).join('')}</div>
    <p class="muted">Tap LEDs to choose them. ${state.selected.size} chosen of ${state.colors.length}.</p>
    <label>Colour<input type="color" data-led-color="${index}" value="${esc(state.color)}"></label>
    <div class="actions">
      <button class="btn primary" data-led-apply="${index}" ${state.selected.size ? '' : 'disabled'}>Colour chosen LEDs</button>
      <button class="btn" data-led-fill="${index}">Fill all</button>
      <button class="btn" data-led-clear="${index}">Clear</button>
    </div>`;
}

function zonesPanel(device) {
  const info = device.lighting;
  const modes = device.rgbModes.concat(info.leds ? ['Direct'] : []);
  return panel(`${device.id}:zones`, 'Zones', info.zones.map((zone, index) => `<div class="zone" data-zone="${index}">
    <h3>${esc(zone.name || `Zone ${index + 1}`)} <span class="muted">${zone.leds} LEDs</span></h3>
    ${effectEditor(`data-zone-effect="${index}"`, zone.effect, modes, { showScope: info.scopes })}
    ${info.swap ? `<div class="two">${toggle(`data-swap="lr" data-swap-zone="${index}"`, 'Swap left and right', zone.swapLr)}${toggle(`data-swap="tb" data-swap-zone="${index}"`, 'Swap top and bottom', zone.swapTb)}</div>` : ''}
    ${index === 0 && info.zones.length > 1 ? '<div class="actions"><button class="btn" data-zone-all>Use this on all zones</button></div>' : ''}
    ${info.leds && zone.leds > 0 ? ledEditor(device, index, zone) : ''}
  </div>`).join(''));
}

function regionsPanel(device) {
  const info = device.lighting;
  const used = new Map((info.regions || []).map((region) => [region.effect.scope, region]));
  const flip = (info.regions || []).some((region) => region.flip);
  return panel(`${device.id}:regions`, 'Regions', `${info.regionOptions.map((region) => `<div class="zone">
    <h3>${esc(spaced(region.scope))}</h3>
    ${toggle(`data-region-on="${esc(region.scope)}"`, 'Set this region', used.has(region.scope))}
    ${used.has(region.scope) ? effectEditor(`data-region-effect="${esc(region.scope)}"`, used.get(region.scope).effect, (region.effects || []).map((item) => item.mode), { maxColors: Math.max(...(region.effects || []).map((item) => item.max_colors || 1), 1) }) : ''}
  </div>`).join('')}
    ${toggle('data-region-flip', 'Swap top and bottom', flip)}
    ${info.regions ? '<div class="actions"><button class="btn" data-regions-clear>Stop using regions</button></div>' : ''}`);
}

function presetsPanel(device) {
  const presets = data.rgbPresets.filter((preset) => preset.deviceId === device.id);
  const active = device.lighting.activePreset;
  return panel(`${device.id}:presets`, 'Presets', `${presets.map((preset) => `<div class="row"><span>${esc(preset.name)}${preset.name === active ? ' <span class="pill accent">In use</span>' : ''}</span>
      <span class="row-actions"><button class="btn" data-preset-apply="${esc(preset.name)}">Apply</button><button class="btn danger" data-preset-delete="${esc(preset.name)}">Delete</button></span></div>`).join('') || '<p class="muted">No presets yet.</p>'}
    <label>Preset name<input type="text" maxlength="40" data-preset-name></label>
    <div class="actions"><button class="btn" data-preset-save>Save current lighting</button></div>`);
}

function lightingMore(device) {
  const info = device.lighting;
  if (!info) return '';
  const locked = syncActive(device.id);
  return `<div class="more">
    ${info.waiting ? `<p class="muted">${esc(info.waiting)}</p>` : ''}
    ${locked ? '<p class="muted">In Quick Sync, so its own effects are paused.</p>' : ''}
    ${info.motherboardCapable ? toggle('data-rgb-motherboard', 'Motherboard ARGB sync', false) : ''}
    ${!locked && info.perZone && info.zones.length ? zonesPanel(device) : ''}
    ${!locked && info.regionOptions.length ? regionsPanel(device) : ''}
    ${presetsPanel(device)}
    ${info.ledCount ? `<label>LEDs per fan<input type="number" min="${info.ledCount.min}" max="${info.ledCount.max}" data-led-count value="${info.ledCount.value ?? info.ledCount.default}"></label>` : ''}
  </div>`;
}

// Quick Sync ----------------------------------------------------------------

function syncCandidates(kind, mode) {
  return data.syncDevices.filter((device) => (kind === 'Continuous' ? device.continuous : device.modes.includes(mode)));
}

function syncModes(kind, ids) {
  const chosen = data.syncDevices.filter((device) => ids.includes(device.id));
  if (kind === 'Matched') return data.matchedModes.filter((mode) => chosen.every((device) => device.modes.includes(mode)));
  const first = chosen[0]?.continuousModes || data.syncDevices.flatMap((device) => device.continuousModes);
  return [...new Set(first)].filter((mode) => chosen.every((device) => device.continuousModes.includes(mode)));
}

// Keeps the effect on one that every chosen device can actually run.
function fixSyncMode(draft) {
  const modes = syncModes(draft.kind, draft.devices);
  if (modes.length && !modes.includes(draft.mode)) draft.mode = modes[0];
  return draft;
}

function draftFromSaved() {
  const saved = data.quickSync;
  const disabled = new Set(saved?.disabled_devices || []);
  const ids = (saved?.device_order || data.syncDevices.filter((device) => device.continuous).map((device) => device.id)).filter((id) => !disabled.has(id));
  return fixSyncMode({
    enabled: saved?.enabled === true,
    kind: saved?.kind || 'Continuous',
    devices: ids,
    reversed: (saved?.device_order || []).filter((id, index) => saved.directions?.[index] === 'CounterClockwise'),
    mode: saved?.effect?.mode || 'Rainbow',
    colors: saved?.effect?.colors?.length ? saved.effect.colors : [[255, 255, 255]],
    speed: saved?.effect?.speed ?? 2,
    brightness: saved?.effect?.brightness === 255 ? 4 : saved?.effect?.brightness ?? 4,
  });
}

function quickSyncCard() {
  // Still shown while it is on, so it can be turned off after devices go away.
  if (data.syncDevices.length < 2 && !data.quickSync?.enabled) return '';
  const draft = syncDraft || draftFromSaved();
  const candidates = syncCandidates(draft.kind, draft.mode);
  const names = (id) => data.devices.find((device) => device.id === id)?.name || id;
  const modes = syncModes(draft.kind, draft.devices);
  const list = modes.includes(draft.mode) ? modes : [draft.mode, ...modes];
  return `<div class="card" id="quickSync"><div class="card-head"><h2>Quick Sync</h2>${draft.enabled ? '<span class="pill accent">On</span>' : ''}</div>
    <p class="muted" style="margin:0">One effect across several devices at once.</p>
    ${toggle('data-sync="enabled"', 'Use Quick Sync', draft.enabled)}
    <div class="two">
      <label>Sync style<select data-sync="kind">${option('Continuous', 'Continuous strip', draft.kind === 'Continuous')}${option('Matched', 'Matched effect', draft.kind === 'Matched')}</select></label>
      <label>Effect<select data-sync="mode">${list.map((mode) => option(mode, spaced(mode), mode === draft.mode)).join('')}</select></label>
    </div>
    ${COLOR_FREE.has(draft.mode) ? '' : `<label>Colour<input type="color" data-sync="color" value="${hex(draft.colors[0])}"></label>`}
    <div class="two">
      <label>Brightness<select data-sync="brightness">${BRIGHTNESS.map((name, level) => option(level, name, level === draft.brightness)).join('')}</select></label>
      <label>Speed<select data-sync="speed">${SPEEDS.map((name, level) => option(level, name, level === draft.speed)).join('')}</select></label>
    </div>
    <h3>Devices</h3>
    ${candidates.map((device) => {
    const position = draft.devices.indexOf(device.id);
    return `<div class="row"><label class="check"><input type="checkbox" data-sync-device="${esc(device.id)}" ${position !== -1 ? 'checked' : ''}> ${esc(names(device.id))}</label>
      ${position !== -1 ? `<span class="row-actions">
        <button class="btn" data-sync-up="${esc(device.id)}" aria-label="Move up" ${position === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn" data-sync-reverse="${esc(device.id)}" aria-pressed="${draft.reversed.includes(device.id)}">${draft.reversed.includes(device.id) ? 'Reverse' : 'Forward'}</button>
      </span>` : ''}</div>`;
  }).join('') || '<p class="muted">No devices can use this style.</p>'}
    ${draft.devices.length < 2 ? '<p class="muted">Choose at least two compatible devices to enable Quick Sync.</p>' : ''}
    <div class="actions"><button class="btn primary" id="syncSave" ${draft.enabled && draft.devices.length < 2 ? 'disabled' : ''}>Save Quick Sync</button>${syncDraft ? '<button class="btn" id="syncCancel">Cancel</button>' : ''}</div>
  </div>`;
}

function openRgbCard() {
  const settings = data.daemonSettings?.openrgb;
  if (!settings) return '';
  const { status } = settings;
  const pill = status?.running ? `<span class="pill live">Port ${status.port}</span>` : status?.error ? '<span class="pill">Failed</span>' : '';
  return `<div class="card" id="openRgb"><div class="card-head"><h2>OpenRGB server</h2>${pill}</div>
    <p class="muted" style="margin:0">Lets OpenRGB control the lights. It has no password, and the lighting set here pauses while it's on. To reach it from other computers, add port ${settings.port} to the container in Unraid.</p>
    ${toggle('data-openrgb="enabled"', 'Run the server', settings.enabled)}
    <label>Port<input type="number" min="1" max="65535" data-openrgb="port" value="${settings.port}"></label>
    ${toggle('data-openrgb="regions"', 'AL V2 inner and outer regions', settings.regions)}
    ${toggle('data-openrgb="perFan"', 'One zone per wireless fan', settings.perFan)}
    ${status?.error ? `<p class="bad">${esc(status.error)}</p><div class="actions"><button class="btn" id="openRgbRetry">Try again</button></div>` : ''}
  </div>`;
}

function postOpenRgb() {
  const card = document.getElementById('openRgb');
  const read = (key) => card.querySelector(`[data-openrgb="${key}"]`);
  act('/api/settings', { openrgb: { enabled: read('enabled').checked, port: Number(read('port').value), regions: read('regions').checked, perFan: read('perFan').checked } });
}

// Events --------------------------------------------------------------------

async function sendLeds(deviceId, zone, colors) {
  await post('/api/rgb/leds', { device_id: deviceId, zone, colors });
  toast('Saved');
  await refresh(true);
}

async function loadLeds(deviceId, zone, leds) {
  const response = await fetch(`/api/rgb/leds?device_id=${encodeURIComponent(deviceId)}&zone=${zone}`);
  if (!response.ok) throw await failure(response);
  const saved = await response.json();
  const colors = Array.from({ length: leds }, (_, index) => saved[index] || [0, 0, 0]);
  ledState.set(ledKey(deviceId, zone), { colors, selected: new Set(), color: '#ffffff' });
  renderLights();
}

function regionsFrom(card) {
  return [...card.querySelectorAll('[data-region-effect]')].map((element) => ({
    effect: { ...readEffect(element), scope: element.dataset.regionEffect, direction: 'Clockwise' },
    flip: card.querySelector('[data-region-flip]').checked,
  }));
}

function updateSync(change) {
  syncDraft ||= draftFromSaved();
  change(syncDraft);
  fixSyncMode(syncDraft);
  renderLights();
}

view.addEventListener('toggle', (event) => {
  const id = event.target.dataset?.panel;
  if (!id) return;
  if (event.target.open) openPanels.add(id);
  else openPanels.delete(id);
}, true);

view.addEventListener('change', (event) => {
  const { target } = event;
  const card = target.closest('[data-device]');
  if (target.dataset.e && target.closest('[data-zone-effect]')) {
    const element = target.closest('[data-zone-effect]');
    target.blur();
    act('/api/rgb/zone', { device_id: card.dataset.device, zone: Number(element.dataset.zoneEffect), effect: readEffect(element) });
  } else if (target.dataset.e && target.closest('[data-region-effect]')) {
    target.blur();
    act('/api/rgb/regions', { device_id: card.dataset.device, regions: regionsFrom(card) });
  } else if (target.dataset.regionOn) {
    const device = data.devices.find((item) => item.id === card.dataset.device);
    const regions = regionsFrom(card).filter((region) => region.effect.scope !== target.dataset.regionOn);
    if (target.checked) {
      const option_ = device.lighting.regionOptions.find((item) => item.scope === target.dataset.regionOn);
      const first = option_.effects?.[0]?.mode || 'Static';
      if (target.dataset.regionOn === 'All') regions.length = 0;
      else regions.splice(0, regions.length, ...regions.filter((region) => region.effect.scope !== 'All'));
      regions.push({ effect: { mode: first, colors: [[255, 255, 255]], brightness: 4, speed: 2, direction: 'Clockwise', scope: target.dataset.regionOn }, flip: false });
    }
    act('/api/rgb/regions', { device_id: card.dataset.device, regions: regions.length ? regions : null });
  } else if (target.matches('[data-region-flip]')) {
    act('/api/rgb/regions', { device_id: card.dataset.device, regions: regionsFrom(card) });
  } else if (target.dataset.swap) {
    const zone = target.dataset.swapZone;
    const box = (kind) => card.querySelector(`[data-swap="${kind}"][data-swap-zone="${zone}"]`).checked;
    act('/api/rgb/swap', { device_id: card.dataset.device, zone: Number(zone), swapLr: box('lr'), swapTb: box('tb') });
  } else if (target.matches('[data-rgb-motherboard]')) {
    act('/api/rgb/motherboard', { device_id: card.dataset.device, enabled: target.checked });
  } else if (target.matches('[data-led-count]')) {
    target.blur();
    act('/api/rgb/led-count', { device_id: card.dataset.device, count: Number(target.value) });
  } else if (target.dataset.ledColor !== undefined) {
    ledState.get(ledKey(card.dataset.device, Number(target.dataset.ledColor))).color = target.value;
    target.blur();
  } else if (target.dataset.sync) {
    updateSync((draft) => {
      const key = target.dataset.sync;
      if (key === 'enabled') draft.enabled = target.checked;
      else if (key === 'color') draft.colors = [rgbOf(target.value)];
      else if (key === 'brightness' || key === 'speed') draft[key] = Number(target.value);
      else draft[key] = target.value;
      if (key === 'kind') draft.devices = syncCandidates(draft.kind, draft.mode).filter((device) => draft.devices.includes(device.id)).map((device) => device.id);
    });
  } else if (target.dataset.syncDevice) {
    updateSync((draft) => {
      const id = target.dataset.syncDevice;
      draft.devices = target.checked ? [...draft.devices, id] : draft.devices.filter((item) => item !== id);
    });
  } else if (target.dataset.openrgb) {
    target.blur();
    postOpenRgb();
  }
});

view.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const set = target.dataset;
  const card = target.closest('[data-device]');
  try {
    if (set.colorCount) {
      const element = target.closest('.effect');
      const effect = readEffect(element);
      effect.colors = set.colorCount === '1' ? [...effect.colors, [255, 255, 255]] : effect.colors.slice(0, -1);
      if (element.dataset.zoneEffect !== undefined) act('/api/rgb/zone', { device_id: card.dataset.device, zone: Number(element.dataset.zoneEffect), effect });
      else {
        const regions = regionsFrom(card).map((region) => (region.effect.scope === element.dataset.regionEffect ? { ...region, effect: { ...region.effect, colors: effect.colors } } : region));
        act('/api/rgb/regions', { device_id: card.dataset.device, regions });
      }
    } else if (set.zoneAll !== undefined) {
      act('/api/rgb/zone', { device_id: card.dataset.device, zone: 0, effect: readEffect(card.querySelector('[data-zone-effect="0"]')), applyToAll: true });
    } else if (set.regionsClear !== undefined) {
      act('/api/rgb/regions', { device_id: card.dataset.device, regions: null });
    } else if (set.ledLoad !== undefined) {
      const device = data.devices.find((item) => item.id === card.dataset.device);
      await loadLeds(device.id, Number(set.ledLoad), device.lighting.zones[Number(set.ledLoad)].leds);
    } else if (set.led !== undefined) {
      const zone = Number(target.closest('[data-leds]').dataset.leds);
      const state = ledState.get(ledKey(card.dataset.device, zone));
      const led = Number(set.led);
      if (state.selected.has(led)) state.selected.delete(led);
      else state.selected.add(led);
      renderLights();
    } else if (set.ledApply !== undefined || set.ledFill !== undefined || set.ledClear !== undefined) {
      const zone = Number(set.ledApply ?? set.ledFill ?? set.ledClear);
      const state = ledState.get(ledKey(card.dataset.device, zone));
      if (set.ledClear !== undefined && !window.confirm('Turn every LED in this zone off?')) return;
      const paint = set.ledClear !== undefined ? [0, 0, 0] : rgbOf(state.color);
      state.colors = state.colors.map((color, led) => (set.ledApply === undefined || state.selected.has(led) ? paint : color));
      state.selected.clear();
      await sendLeds(card.dataset.device, zone, state.colors);
    } else if (set.presetSave !== undefined) {
      const name = card.querySelector('[data-preset-name]').value;
      act('/api/rgb/preset', { action: 'save', device_id: card.dataset.device, name });
    } else if (set.presetApply) {
      act('/api/rgb/preset', { action: 'apply', device_id: card.dataset.device, name: set.presetApply }, 'Applied');
    } else if (set.presetDelete) {
      if (window.confirm(`Delete "${set.presetDelete}"?`)) act('/api/rgb/preset', { action: 'delete', device_id: card.dataset.device, name: set.presetDelete }, 'Deleted');
    } else if (set.syncUp) {
      updateSync((draft) => {
        const index = draft.devices.indexOf(set.syncUp);
        [draft.devices[index - 1], draft.devices[index]] = [draft.devices[index], draft.devices[index - 1]];
      });
    } else if (set.syncReverse) {
      updateSync((draft) => {
        draft.reversed = draft.reversed.includes(set.syncReverse) ? draft.reversed.filter((id) => id !== set.syncReverse) : [...draft.reversed, set.syncReverse];
      });
    } else if (target.id === 'syncCancel') {
      syncDraft = null;
      renderLights();
    } else if (target.id === 'syncSave') {
      const body = syncDraft || draftFromSaved();
      await post('/api/rgb/sync', { ...body, colors: COLOR_FREE.has(body.mode) ? [] : body.colors });
      syncDraft = null;
      toast('Saved');
      await refresh(true);
    } else if (target.id === 'openRgbRetry') {
      act('/api/openrgb/retry', {}, 'Trying again');
    }
  } catch (error) {
    toast(error.message, true);
  }
});
