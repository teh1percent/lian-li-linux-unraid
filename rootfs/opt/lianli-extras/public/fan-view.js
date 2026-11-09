'use strict';

// Status page: a picture of each fan with its light bars and screen. Clicking a
// light bar or the screen opens a small editor for that part.

let fanEdit = null; // { device, lcd, part: 'Top' | 'Bottom' | 'screen', draft }

holds.push(() => tab === 'overview' && fanEdit !== null);

// LED positions of one TL fan (13 top, 13 bottom), from the daemon's TL renderer.
const TL_TOP = [[0, 63], [13, 46], [27, 29], [44, 17], [61, 7], [77, 0], [94, 0], [111, 0], [127, 7], [144, 17], [161, 29], [173, 46], [187, 63]];
const TL_BOTTOM = TL_TOP.map(([x, y]) => [x, 166 - y]);
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

// The effect that lights one part of the fan right now.
function partEffect(device, part) {
  const regions = device.lighting?.regions || [];
  return regions.find((region) => region.effect.scope === part)?.effect
    || regions.find((region) => region.effect.scope === 'All')?.effect
    || device.effect
    || null;
}

function effectLook(effect) {
  if (!effect || effect.mode === 'Off' || effect.disabled || effect.brightness === 255) return { colors: ['#2a2f38'], cls: 'fx-off', label: 'Off' };
  const label = spaced(effect.mode);
  if (effect.mode === 'Rainbow' || effect.mode === 'RainbowMorph') return { colors: ['#ff3b3b', '#ffd23b', '#3bff6e', '#3bb8ff', '#b03bff'], cls: 'fx-rainbow', label };
  const colors = (effect.colors?.length ? effect.colors : [[255, 255, 255]]).map(hex);
  const cls = effect.mode === 'Static' || effect.mode === 'Direct' ? '' : effect.mode === 'Breathing' ? 'fx-breathe' : 'fx-move';
  const opacity = 0.45 + 0.55 * ((effect.brightness ?? 4) / 4);
  return { colors, cls, label, opacity };
}

function fanPoints(points) {
  // Fit the 187 x 166 LED grid into the 120 x 120 drawing, centred.
  return points.map(([x, y]) => `${(10 + x * 0.535).toFixed(1)},${(15.6 + y * 0.535).toFixed(1)}`).join(' ');
}

function lightBar(device, part, key) {
  const look = effectLook(partEffect(device, part));
  const gradient = `grad-${key}-${part}`;
  const stroke = look.colors.length > 1 ? `url(#${gradient})` : look.colors[0];
  const stops = look.colors.map((color, index) => `<stop offset="${look.colors.length > 1 ? (index / (look.colors.length - 1)) * 100 : 0}%" stop-color="${color}"/>`).join('');
  return `<linearGradient id="${gradient}" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient>
    <g class="fan-part ${look.cls}" role="button" tabindex="0" data-fan-part="${part}" data-fan-device="${esc(device.id)}" aria-label="${esc(FAN_PARTS[part])}: ${esc(look.label)}" style="opacity:${look.opacity ?? 1}">
      <polyline class="fan-glow" points="${fanPoints(part === 'Top' ? TL_TOP : TL_BOTTOM)}" stroke="${stroke}"/>
      <polyline class="fan-bar" points="${fanPoints(part === 'Top' ? TL_TOP : TL_BOTTOM)}" stroke="${stroke}"/>
      <title>${esc(FAN_PARTS[part])}: ${esc(look.label)}. Click to change.</title>
    </g>`;
}

function screenFace(lcd, key) {
  const clip = `clip-${key}`;
  const screen = lcd ? data.settings.screens[lcd.id] : null;
  let face = '<circle cx="60" cy="60" r="24" fill="#05070a"/>';
  const label = screenLabel(lcd);
  if (screen?.kind === 'template') {
    const own = data.settings.lcdThemes[lcd.id];
    const theme = own ? `&theme=${encodeURIComponent(own)}` : '';
    const rotate = lcd.orientation ? ` transform="rotate(${lcd.orientation} 60 60)"` : '';
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

function fanPicture(device, lcd, index) {
  const key = `${index}`;
  const blades = Array.from({ length: 9 }, (_, blade) => `<path class="fan-blade" d="M60 60 Q ${60 + 30 * Math.cos((blade * 40 + 20) * Math.PI / 180)} ${60 + 30 * Math.sin((blade * 40 + 20) * Math.PI / 180)} ${60 + 44 * Math.cos(blade * 40 * Math.PI / 180)} ${60 + 44 * Math.sin(blade * 40 * Math.PI / 180)}" />`).join('');
  const rpm = (device.rpms || []).filter((value) => value > 0);
  const selected = fanEdit?.device === device.id ? fanEdit.part : null;
  return `<figure class="fan-figure${selected ? ' editing' : ''}">
    <svg viewBox="0 0 120 120" class="fan-svg" role="group" aria-label="${esc(device.name)}">
      <rect x="2" y="2" width="116" height="116" rx="14" class="fan-frame"/>
      <circle cx="60" cy="60" r="48" class="fan-ring"/>
      ${blades}
      ${lightBar(device, 'Top', key)}
      ${lightBar(device, 'Bottom', key)}
      ${screenFace(lcd, key)}
    </svg>
    <figcaption>
      <b>${esc(device.name)}</b>
      <span class="muted">${esc(lightsLabel(device))}</span>
      <span class="muted">${esc(lcd ? screenLabel(lcd) : 'No screen')}</span>
      <span class="pill ${rpm.length ? 'live' : ''}">${rpm.length ? `${rpm.join(' / ')} RPM` : '0 RPM'}</span>
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

function fanViewCard(devices) {
  const fans = devices.filter(regionalFan);
  if (!fans.length) return '';
  const screens = fanScreens(fans);
  return `<div class="card" id="fanView"><div class="card-head"><h2>Your fans</h2></div>
    <div class="fan-row">${fans.map((device, index) => fanPicture(device, screens.get(device.id), index)).join('')}</div>
    ${fanEditor() || '<p class="muted" style="margin-bottom:0">Click a light bar or a screen to change it.</p>'}
  </div>`;
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
