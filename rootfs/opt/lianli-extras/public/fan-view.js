'use strict';

// Status page: a picture of each fan with its light bars and screen. Clicking a
// light bar or the screen opens a small editor for that part.

let fanEdit = null; // { device, lcd, part: 'Top' | 'Bottom' | 'screen', draft }
let fanArrange = false; // true while the fans are being put in order
let fanDragId = null;

holds.push(() => tab === 'overview' && fanEdit !== null);
holds.push(() => tab === 'overview' && fanDragId !== null);

// A point on a circle round the middle of the 120 x 120 drawing. 0 degrees is
// to the right and angles go clockwise, so 270 is straight up.
function onRing(radius, angle) {
  const rad = (angle * Math.PI) / 180;
  return [60 + radius * Math.cos(rad), 60 + radius * Math.sin(rad)];
}

// The light bars are arcs along the top and bottom of the ring, like the real fan.
const BAR_ARCS = { Top: [208, 332], Bottom: [28, 152] };
const FAN_PARTS = { Top: 'Top lights', Bottom: 'Bottom lights' };

// The USB hub a device hangs off, so a fan's receiver can be paired with its screen.
function usbParent(id) {
  const match = /:(\d+-[\d.]+)$/.exec(id || '');
  return match && match[1].includes('.') ? match[1].replace(/\.\d+$/, '') : null;
}

function regionalFan(device) {
  const scopes = (device.lighting?.regionOptions || []).map((region) => region.scope);
  return device.hasFan && device.hasRgb && !device.unbound && scopes.includes('Top') && scopes.includes('Bottom');
}

function fanScreens(fans) {
  const lcds = data.devices.filter((device) => device.hasLcd);
  const taken = new Set();
  return new Map(fans.map((fan) => {
    const parent = usbParent(fan.id);
    const lcd = parent && lcds.find((item) => !taken.has(item.id) && usbParent(item.id) === parent);
    if (lcd) taken.add(lcd.id);
    return [fan.id, lcd || null];
  }));
}

// The effect that lights one part of the fan right now. Quick Sync wins
// over the fan's own settings while the fan is in it.
function partEffect(device, part) {
  if (syncActive(device.id) && data.quickSync?.effect) return { ...data.quickSync.effect, sync: true };
  const regions = device.lighting?.regions || [];
  return regions.find((region) => region.effect.scope === part)?.effect
    || regions.find((region) => region.effect.scope === 'All')?.effect
    || device.effect
    || null;
}

function effectLook(effect) {
  if (!effect || effect.mode === 'Off' || effect.disabled || effect.brightness === 255) return { colors: ['#2a2f38'], cls: 'fx-off', label: 'Off' };
  const label = effect.sync ? `Quick Sync: ${spaced(effect.mode)}` : spaced(effect.mode);
  if (effect.mode === 'Rainbow' || effect.mode === 'RainbowMorph') return { colors: ['#ff3b3b', '#ffd23b', '#3bff6e', '#3bb8ff', '#b03bff'], cls: 'fx-rainbow', label };
  const colors = (effect.colors?.length ? effect.colors : [[255, 255, 255]]).map(hex);
  const cls = effect.mode === 'Static' || effect.mode === 'Direct' ? '' : effect.mode === 'Breathing' ? 'fx-breathe' : 'fx-move';
  const opacity = 0.45 + 0.55 * ((effect.brightness ?? 4) / 4);
  return { colors, cls, label, opacity };
}

function barPoints(part) {
  const [from, to] = BAR_ARCS[part];
  return Array.from({ length: 13 }, (_, step) => onRing(51.5, from + ((to - from) * step) / 12))
    .map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
}

// Nine swept blades between the hub and the ring.
function fanBlades() {
  const at = (radius, angle) => onRing(radius, angle).map((value) => value.toFixed(1)).join(' ');
  return Array.from({ length: 9 }, (_, blade) => {
    const a = blade * 40;
    return `<path class="fan-blade" d="M${at(27, a)} Q${at(41, a + 3)} ${at(47, a + 28)} L${at(47, a + 36)} Q${at(39, a + 20)} ${at(27, a + 17)} Z"/>`;
  }).join('');
}

function lightBar(device, part, key) {
  const look = effectLook(partEffect(device, part));
  const gradient = `grad-${key}-${part}`;
  const stroke = look.colors.length > 1 ? `url(#${gradient})` : look.colors[0];
  const stops = look.colors.map((color, index) => `<stop offset="${look.colors.length > 1 ? (index / (look.colors.length - 1)) * 100 : 0}%" stop-color="${color}"/>`).join('');
  return `<linearGradient id="${gradient}" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient>
    <g class="fan-part ${look.cls}" role="button" tabindex="0" data-fan-part="${part}" data-fan-device="${esc(device.id)}" aria-label="${esc(FAN_PARTS[part])}: ${esc(look.label)}" style="opacity:${look.opacity ?? 1}">
      <polyline class="fan-glow" points="${barPoints(part)}" stroke="${stroke}"/>
      <polyline class="fan-bar" points="${barPoints(part)}" stroke="${stroke}"/>
      <title>${esc(FAN_PARTS[part])}: ${esc(look.label)}. Click to change.</title>
    </g>`;
}

// How far the picture on a screen looks turned in the case. A TL Flex panel
// sits a quarter turn round in the fan, so its 90 degree setting reads upright.
function shownTurn(lcd) {
  const base = /Flex/i.test(lcd.model || '') ? 90 : 0;
  return ((((lcd.orientation || 0) - base) % 360) + 360) % 360;
}

function screenFace(lcd, key) {
  const clip = `clip-${key}`;
  const screen = lcd ? data.settings.screens[lcd.id] : null;
  let face = '<circle cx="60" cy="60" r="24" fill="#05070a"/>';
  const label = screenLabel(lcd);
  if (screen?.kind === 'template') {
    const own = data.settings.lcdThemes[lcd.id];
    const theme = own ? `&theme=${encodeURIComponent(own)}` : '';
    const turn = shownTurn(lcd);
    const rotate = turn ? ` transform="rotate(${turn} 60 60)"` : '';
    face = `<image href="/api/preview?id=${encodeURIComponent(screen.templateId)}${theme}" x="36" y="36" width="48" height="48" clip-path="url(#${clip})"${rotate}/>`;
  } else if (screen?.kind === 'color') {
    face = `<circle cx="60" cy="60" r="24" fill="${hex(screen.rgb)}"/>`;
  } else if (screen?.kind === 'media') {
    face += '<text x="60" y="63" text-anchor="middle" class="fan-screen-text">Your file</text>';
  } else if (screen?.kind === 'sensor') {
    face += '<text x="60" y="63" text-anchor="middle" class="fan-screen-text">Gauge</text>';
  }
  return `<clipPath id="${clip}"><circle cx="60" cy="60" r="24"/></clipPath>
    <g class="fan-part fan-screen" role="button" tabindex="0" ${lcd ? `data-fan-screen="${esc(lcd.id)}"` : ''} aria-label="Screen: ${esc(label)}">
      ${face}<circle cx="60" cy="60" r="24.5" class="fan-screen-ring"/>
      <title>Screen: ${esc(label)}.${lcd ? ' Click to change.' : ''}</title>
    </g>`;
}

function screenLabel(lcd) {
  if (!lcd) return 'No screen found';
  const screen = data.settings.screens[lcd.id];
  if (screen?.kind === 'template') return familyOf(screen.templateId)?.name || data.designs.find((item) => item.id === screen.templateId)?.name || 'Screen';
  if (screen?.kind === 'color') return 'Solid colour';
  if (screen?.kind === 'media') return 'Your file';
  if (screen?.kind === 'sensor') return 'Sensor gauge';
  return 'Not managed';
}

// "Static", or "Static / Breathing" when the two light bars differ.
function lightsLabel(device) {
  const top = effectLook(partEffect(device, 'Top')).label;
  const bottom = effectLook(partEffect(device, 'Bottom')).label;
  return top === bottom ? top : `${top} / ${bottom}`;
}

function fanPicture(device, lcd, index, last) {
  const key = `${index}`;
  const rpm = (device.rpms || []).filter((value) => value > 0);
  const selected = fanEdit?.device === device.id ? fanEdit.part : null;
  const moves = fanArrange ? `<div class="fan-move">
      <button class="btn icon" data-fan-move="-1" data-fan-id="${esc(device.id)}" aria-label="Move ${esc(device.name)} earlier" ${index === 0 ? 'disabled' : ''}>&#8592;</button>
      <button class="btn icon" data-fan-move="1" data-fan-id="${esc(device.id)}" aria-label="Move ${esc(device.name)} later" ${last ? 'disabled' : ''}>&#8594;</button>
    </div>` : '';
  return `<figure class="fan-figure${selected ? ' editing' : ''}${fanArrange ? ' arranging' : ''}" data-fan-card="${esc(device.id)}"${fanArrange ? ' draggable="true"' : ''}>
    <svg viewBox="0 0 120 120" class="fan-svg" role="group" aria-label="${esc(device.name)}">
      <rect x="2" y="2" width="116" height="116" rx="40" class="fan-frame"/>
      <circle cx="60" cy="60" r="55" class="fan-ring"/>
      <circle cx="60" cy="60" r="48" class="fan-throat"/>
      ${fanBlades()}
      ${lightBar(device, 'Top', key)}
      ${lightBar(device, 'Bottom', key)}
      ${screenFace(lcd, key)}
    </svg>
    <figcaption>
      <b>${esc(device.name)}</b>
      <span class="muted">${esc(lightsLabel(device))}</span>
      <span class="muted">${esc(lcd ? screenLabel(lcd) : 'No screen')}</span>
      <span class="pill ${rpm.length ? 'live' : ''}">${rpm.length ? `${rpm.join(' / ')} RPM` : '0 RPM'}</span>
      ${moves}
    </figcaption>
  </figure>`;
}

function fanEditor() {
  if (!fanEdit) return '';
  const device = data.devices.find((item) => item.id === fanEdit.device);
  if (!device) return '';
  if (fanEdit.part === 'screen') {
    const lcd = data.devices.find((item) => item.id === fanEdit.lcd);
    if (!lcd) return '';
    const screen = data.settings.screens[lcd.id];
    return `<div class="fan-editor" data-device="${esc(lcd.id)}">
      <div class="card-head"><h3>${esc(device.name)}: screen</h3><button class="btn" data-fan-close>Done</button></div>
      <label>Shows<select data-screen="${esc(lcd.id)}">
        <option value="keep">Leave as it is</option>
        ${screenOptions(lcd, screen)}
        ${data.designs.length ? `<optgroup label="Your designs">${data.designs.map((item) => option(`template:${item.id}`, item.name)).join('')}</optgroup>` : ''}
        <option value="color">Solid colour</option>
      </select></label>
      ${screen?.kind === 'color' ? `<label>Colour<input type="color" data-solid value="${hex(screen.rgb)}"></label>` : ''}
      <p class="muted">Brightness, rotation and the other screen settings are on the Screens page.</p>
    </div>`;
  }
  const options = device.lighting.regionOptions.find((region) => region.scope === fanEdit.part)?.effects || [];
  const modes = options.map((item) => item.mode);
  const draft = fanEdit.draft;
  const max = options.find((item) => item.mode === draft.mode)?.max_colors || 1;
  const colorFree = COLOR_FREE.has(draft.mode) || draft.mode === 'Direct';
  const colors = colorFree ? [] : draft.colors.slice(0, max);
  return `<div class="fan-editor">
    <div class="card-head"><h3>${esc(device.name)}: ${esc(FAN_PARTS[fanEdit.part].toLowerCase())}</h3></div>
    ${syncActive(device.id) ? '<p class="fan-sync-warning">Quick Sync is on for this fan, so it shows the Quick Sync effect and ignores these settings. Turn Quick Sync off on the Lights page to use them.</p>' : ''}
    <label>Effect<select data-fan-e="mode">${modes.map((mode) => option(mode, spaced(mode), mode === draft.mode)).join('')}</select></label>
    ${colors.length ? `<div class="colors">${colors.map((color, index) => `<label>Colour ${index + 1}<input type="color" data-fan-color="${index}" value="${hex(color)}"></label>`).join('')}</div>
    ${max > 1 ? `<div class="row-actions" style="margin-top:6px">
      <button class="btn" data-fan-colors="1" ${colors.length >= max ? 'disabled' : ''}>Add colour</button>
      <button class="btn" data-fan-colors="-1" ${colors.length <= 1 ? 'disabled' : ''}>Remove colour</button></div>` : ''}` : ''}
    <div class="two">
      <label>Brightness<select data-fan-e="brightness">${BRIGHTNESS.map((name, level) => option(level, name, level === draft.brightness)).join('')}</select></label>
      <label>Speed<select data-fan-e="speed">${SPEEDS.map((name, level) => option(level, name, level === draft.speed)).join('')}</select></label>
    </div>
    ${toggle('data-fan-both', 'Use on both light bars', draft.both)}
    <div class="actions"><button class="btn primary" data-fan-save>Apply</button><button class="btn" data-fan-close>Cancel</button></div>
  </div>`;
}

function fanLayout() {
  return data.settings.fanLayout || { order: [], perRow: 0 };
}

// Fans in the saved order. Fans that aren't in it yet go at the end.
function orderedFans(devices) {
  const order = fanLayout().order;
  const rank = (device) => {
    const at = order.indexOf(device.id);
    return at < 0 ? order.length : at;
  };
  return devices.filter(regionalFan).map((device, index) => ({ device, index }))
    .sort((a, b) => rank(a.device) - rank(b.device) || a.index - b.index)
    .map((item) => item.device);
}

function fanViewCard(devices) {
  const fans = orderedFans(devices);
  if (!fans.length) return '';
  const screens = fanScreens(fans);
  const perRow = fanLayout().perRow;
  const grid = perRow ? ` fixed${perRow >= 4 ? ' compact' : ''}" style="--per-row:${perRow}` : '';
  const button = fans.length > 1 || fanArrange
    ? `<button class="btn${fanArrange ? ' primary' : ''}" data-fan-arrange>${fanArrange ? 'Done' : 'Arrange'}</button>` : '';
  const footer = fanArrange && !fanEdit
    ? `<div class="fan-arrange-bar"><label>Fans per row<select data-fan-per-row>${[0, 1, 2, 3, 4, 5, 6].map((count) => option(count, count || 'Fit to width', count === perRow)).join('')}</select></label>
      <p class="muted">Drag the fans, or use the arrows, to match the order in your case.</p></div>`
    : fanEditor() || '<p class="muted" style="margin-bottom:0">Click a light bar or a screen to change it.</p>';
  return `<div class="card" id="fanView"><div class="card-head"><h2>Your fans</h2>${button}</div>
    <div class="fan-row${grid}">${fans.map((device, index) => fanPicture(device, screens.get(device.id), index, index === fans.length - 1)).join('')}</div>
    ${footer}
  </div>`;
}

async function saveFanLayout(change) {
  const before = fanLayout();
  data.settings.fanLayout = { ...before, ...change };
  renderOverview();
  try {
    await post('/api/fan-layout', change);
  } catch (error) {
    data.settings.fanLayout = before;
    renderOverview();
    toast(error.message, true);
  }
}

// Move one fan to a new place in the order and save it.
function moveFan(id, to) {
  const ids = orderedFans(data.devices).map((device) => device.id);
  const from = ids.indexOf(id);
  if (from < 0 || to < 0 || to >= ids.length || to === from) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  saveFanLayout({ order: ids });
}

// Called after the Status page is drawn: show the screen's current choice in the editor.
function fanViewAfterRender() {
  const select = fanEdit?.part === 'screen' && view.querySelector('#fanView [data-screen]');
  const lcd = select && data.devices.find((item) => item.id === fanEdit.lcd);
  if (lcd) select.value = shownScreenValue(lcd);
}

// The fan pictures, plus the plain list for fans that can't be drawn.
function fanCards(devices) {
  const pictures = fanViewCard(devices);
  const others = devices.filter((device) => !regionalFan(device));
  return { pictures, list: !pictures || others.some((device) => device.hasFan && !device.isAio) ? fansCard(others) : '' };
}

function openFanPart(deviceId, part, lcdId) {
  const device = data.devices.find((item) => item.id === deviceId);
  if (part === 'screen') {
    fanEdit = { device: deviceId, lcd: lcdId, part };
  } else {
    const current = partEffect(device, part) || {};
    const modes = (device.lighting.regionOptions.find((region) => region.scope === part)?.effects || []).map((item) => item.mode);
    const mode = modes.includes(current.mode) ? current.mode : modes.includes('Static') ? 'Static' : modes[0];
    const regions = device.lighting.regions || [];
    fanEdit = {
      device: deviceId,
      part,
      draft: {
        mode,
        colors: current.colors?.length ? current.colors.map((color) => [...color]) : [[255, 255, 255]],
        brightness: current.brightness === 255 ? 4 : current.brightness ?? 4,
        speed: current.speed ?? 2,
        both: !regions.length || regions.some((region) => region.effect.scope === 'All'),
      },
    };
  }
  renderOverview();
}

async function saveFanPart() {
  const device = data.devices.find((item) => item.id === fanEdit.device);
  const { draft, part } = fanEdit;
  const effect = { mode: draft.mode, colors: draft.colors, brightness: draft.brightness, speed: draft.speed, direction: 'Clockwise' };
  const flip = (device.lighting.regions || []).some((region) => region.flip);
  const scopes = device.lighting.regionOptions.map((region) => region.scope);
  let regions;
  if (draft.both && scopes.includes('All')) {
    regions = [{ effect: { ...effect, scope: 'All' }, flip }];
  } else {
    // Keep the other bar as it looks now, then change this one.
    const other = part === 'Top' ? 'Bottom' : 'Top';
    const otherModes = (device.lighting.regionOptions.find((region) => region.scope === other)?.effects || []).map((item) => item.mode);
    const kept = partEffect(device, other);
    const otherEffect = draft.both ? effect : kept && otherModes.includes(kept.mode) ? kept : { ...effect, mode: otherModes.includes('Static') ? 'Static' : otherModes[0] };
    regions = [
      { effect: { ...effect, scope: part }, flip },
      { effect: { ...otherEffect, scope: other }, flip },
    ];
  }
  fanEdit = null;
  await act('/api/rgb/regions', { device_id: device.id, regions });
}

view.addEventListener('click', (event) => {
  if (tab !== 'overview') return;
  if (event.target.closest('[data-fan-arrange]')) {
    fanArrange = !fanArrange;
    fanEdit = null;
    renderOverview();
    return;
  }
  const move = event.target.closest('[data-fan-move]');
  if (move) {
    const { fanId, fanMove } = move.dataset;
    const ids = orderedFans(data.devices).map((device) => device.id);
    moveFan(fanId, ids.indexOf(fanId) + Number(fanMove));
    // Keep keyboard focus on the fan that moved.
    view.querySelector(`[data-fan-move="${fanMove}"][data-fan-id="${CSS.escape(fanId)}"]:not([disabled])`)?.focus();
    return;
  }
  const part = event.target.closest('[data-fan-part], [data-fan-screen]');
  if (part) {
    if (part.dataset.fanPart) openFanPart(part.dataset.fanDevice, part.dataset.fanPart);
    else {
      const owner = data.devices.filter(regionalFan).find((fan) => fanScreens([fan]).get(fan.id)?.id === part.dataset.fanScreen);
      if (owner) openFanPart(owner.id, 'screen', part.dataset.fanScreen);
    }
    return;
  }
  const set = event.target.dataset;
  if (set.fanClose !== undefined) {
    fanEdit = null;
    renderOverview();
  } else if (set.fanSave !== undefined) {
    saveFanPart();
  } else if (set.fanColors) {
    const colors = fanEdit.draft.colors;
    if (set.fanColors === '1') colors.push([255, 255, 255]);
    else if (colors.length > 1) colors.pop();
    renderOverview();
  }
});

view.addEventListener('keydown', (event) => {
  if (tab !== 'overview' || (event.key !== 'Enter' && event.key !== ' ')) return;
  if (!event.target.closest('[data-fan-part], [data-fan-screen]')) return;
  event.preventDefault();
  event.target.closest('[data-fan-part], [data-fan-screen]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

view.addEventListener('change', (event) => {
  if (tab === 'overview' && event.target.matches('[data-fan-per-row]')) {
    saveFanLayout({ perRow: Number(event.target.value) });
    return;
  }
  if (tab !== 'overview' || !fanEdit?.draft) return;
  const { target } = event;
  if (target.dataset.fanE) {
    fanEdit.draft[target.dataset.fanE] = target.dataset.fanE === 'mode' ? target.value : Number(target.value);
    renderOverview();
  } else if (target.dataset.fanColor !== undefined) {
    fanEdit.draft.colors[Number(target.dataset.fanColor)] = rgbOf(target.value);
  } else if (target.matches('[data-fan-both]')) {
    fanEdit.draft.both = target.checked;
  }
});

// Drag a fan card onto another to put it in that place.
view.addEventListener('dragstart', (event) => {
  const card = fanArrange && event.target.closest?.('[data-fan-card]');
  if (!card) return;
  fanDragId = card.dataset.fanCard;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', fanDragId);
  card.classList.add('dragging');
});

view.addEventListener('dragover', (event) => {
  const card = fanDragId && event.target.closest('[data-fan-card]');
  if (!card) return;
  event.preventDefault();
  view.querySelectorAll('.drop-target').forEach((item) => item !== card && item.classList.remove('drop-target'));
  if (card.dataset.fanCard !== fanDragId) card.classList.add('drop-target');
});

view.addEventListener('drop', (event) => {
  const card = fanDragId && event.target.closest('[data-fan-card]');
  if (!card) return;
  event.preventDefault();
  const id = fanDragId;
  fanDragId = null;
  moveFan(id, orderedFans(data.devices).map((device) => device.id).indexOf(card.dataset.fanCard));
});

view.addEventListener('dragend', () => {
  fanDragId = null;
  view.querySelectorAll('.dragging, .drop-target').forEach((item) => item.classList.remove('dragging', 'drop-target'));
});
