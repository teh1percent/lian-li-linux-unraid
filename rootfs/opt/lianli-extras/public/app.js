'use strict';

const TABS = [['overview', 'Status'], ['fans', 'Fans'], ['lights', 'Lights'], ['screens', 'Screens'], ['auto', 'Auto'], ['system', 'System']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALERT_TEXT = { disk: 'Disk problem', parity: 'Parity errors', temp: 'Drive too hot', storage: 'Storage nearly full' };
const COLOR_NAMES = { background: 'Background', text: 'Text', muted: 'Small text', track: 'Gauge track', good: 'Normal', warn: 'Warning', bad: 'Danger' };
const spaced = (name) => name.replace(/([a-z])([A-Z])/g, '$1 $2');
const COLOR_FREE = new Set(['Off', 'Rainbow', 'RainbowMorph']);
const MIN_FAN = 20;
const MAX_POINTS = 8;
const MAX_UPLOAD = 512 * 1024 * 1024;
const HISTORY_REFRESH_MS = 60000;

let tab = 'overview';
let data = null;
let drafts = null;
let scheduleDirty = false;
let curveDraft = null;
let themeDraft = null;
let history = [];
let historyAt = 0;
let health = null;
let chartHover = false;

const view = document.getElementById('view');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (rgb) => '#' + (rgb || [255, 255, 255]).map((part) => part.toString(16).padStart(2, '0')).join('');
const rgbOf = (value) => [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16));
const fileName = (file) => file.split('/').pop();
const option = (value, text, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(text)}</option>`;

function toast(message) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 3500);
}

async function failure(response) {
  const body = await response.json().catch(() => ({}));
  return new Error(body.error || `Request failed (${response.status})`);
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
}

async function act(url, body, done = 'Saved') {
  try {
    await post(url, body);
    toast(done);
  } catch (error) {
    toast(error.message);
  }
  await refresh(true);
}

async function actOnAll(items, send) {
  try {
    for (const item of items) await send(item);
    toast('Saved');
  } catch (error) {
    toast(error.message);
  }
  refresh(true);
}

function tempClass(temp) {
  const { tempWarn, tempDanger } = data.settings.limits;
  if (temp >= tempDanger) return 'bad';
  return temp >= tempWarn ? 'warn' : 'good';
}

// Status ------------------------------------------------------------------

const oneDecimal = (value) => Math.round(value * 10) / 10;

function clock(time) {
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// One measure per chart: they have different units, so they never share an axis.
function historyChart(key, title, unit) {
  const points = history.filter((point) => point[key] !== null && point[key] !== undefined);
  if (points.length < 2) return '';
  const values = points.map((point) => point[key]);
  const low = oneDecimal(Math.min(...values));
  const high = oneDecimal(Math.max(...values));
  const pad = high === low ? 1 : (high - low) * 0.1;
  const min = Math.max(0, low - pad);
  const max = high + pad;
  const start = history[0].t;
  const span = Math.max(history[history.length - 1].t - start, 1);
  const x = (point) => ((point.t - start) / span) * 100;
  const y = (value) => 100 - ((value - min) / (max - min)) * 100;
  const line = history.reduce((parts, point) => {
    if (point[key] === null || point[key] === undefined) parts.push([]);
    else parts[parts.length - 1].push(`${x(point).toFixed(2)},${y(point[key]).toFixed(2)}`);
    return parts;
  }, [[]]).filter((part) => part.length).map((part) => `<polyline class="data-line" points="${part.join(' ')}"/>`).join('');
  const latest = `${oneDecimal(values[values.length - 1])}${unit}`;
  return `<div class="chart" data-chart="${key}" data-unit="${esc(unit)}" data-latest="${esc(latest)}">
    <div class="chart-head"><span>${esc(title)}</span><b data-readout>${esc(latest)}</b></div>
    <div class="chart-body">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="${esc(title)}, from ${low}${esc(unit)} to ${high}${esc(unit)}, now ${esc(latest)}">
        <line class="grid-line" x1="0" x2="100" y1="${y(high)}" y2="${y(high)}"/>
        <line class="grid-line" x1="0" x2="100" y1="${y(low)}" y2="${y(low)}"/>
        ${line}
        <line class="cross" data-cross x1="0" x2="0" y1="0" y2="100" visibility="hidden"/>
      </svg>
      <div class="y"><span>${high}</span><span>${low}</span></div>
      <div class="x"><span>${clock(start)}</span><span>${clock(history[history.length - 1].t)}</span></div>
    </div>
  </div>`;
}

function renderHistory() {
  const charts = [
    data.stats.hasTemps || history.some((point) => point.temp) ? historyChart('temp', 'Hottest drive', '°C') : '',
    historyChart('used', 'Storage used', '%'),
    historyChart('rpm', 'Average fan speed', ' RPM'),
  ].join('');
  return `<div class="card"><h2>Last 24 hours</h2>${charts || '<span class="muted">Collecting data. Charts appear after a couple of minutes.</span>'}</div>`;
}

function renderOverview() {
  const { stats, status, daemon, devices } = data;
  const values = stats.values;
  let html = '';
  if (!daemon.connected) html += `<div class="banner">Daemon not reachable. ${esc(daemon.error)}</div>`;
  if (status.alert) {
    html += `<div class="banner"><span>${esc(ALERT_TEXT[status.alert])}</span><button class="btn" data-mute="24">Mute 24 hours</button></div>`;
  } else if (status.muted) {
    html += `<div class="card notice row"><span>Alerts are muted.</span><button class="btn" data-mute="0">Unmute</button></div>`;
  }
  if (status.error) html += `<div class="card notice">Automation problem: ${esc(status.error)}</div>`;
  if (!stats.available) {
    html += `<div class="card notice">Unraid data isn't available. Add the <b>Unraid state</b> path to the container (host <code>/var/local/emhttp</code>).<br><span class="muted">${esc(stats.error)}</span></div>`;
  } else {
    const hottest = stats.hasTemps ? `<b class="${tempClass(values.disk_temp_max)}">${values.disk_temp_max}°C</b>` : '<b>Asleep</b>';
    const sync = values.sync_pct > 0 ? `${values.sync_pct}%` : 'Idle';
    const storageName = stats.volumes.find((volume) => volume.key === stats.selectedVolume)?.name || 'Storage';
    html += `<div class="grid">
      <div class="stat">${hottest}<span>Hottest drive</span></div>
      <div class="stat"><b>${values.disks_active}/${values.disks_total}</b><span>Drives awake</span></div>
      <div class="stat"><b>${values.storage_used_pct}%</b><span>${esc(storageName)} used</span></div>
      <div class="stat"><b>${values.storage_free_tb}</b><span>TB free</span></div>
      ${stats.hasArray ? `<div class="stat"><b class="${values.parity_errors ? 'bad' : ''}">${values.parity_errors}</b><span>Parity errors</span></div>
      <div class="stat"><b>${sync}</b><span>Parity check</span></div>` : ''}
    </div>`;
    if (stats.volumes.length) {
      const picker = stats.volumes.length > 1 ? `<label>Show on this page and the LCD screens
        <select data-storage>
          ${option('all', 'All storage', stats.selectedVolume === 'all')}
          ${stats.volumes.map((volume) => option(volume.key, volume.name, stats.selectedVolume === volume.key)).join('')}
        </select></label>` : '';
      html += `<div class="card"><h2>Storage</h2>${picker}${stats.volumes.map((volume) => `<div class="row"><span>${esc(volume.name)}</span><span class="num">${volume.usedPct}% used, ${volume.freeTb} of ${volume.sizeTb} TB free</span></div>`).join('')}</div>`;
    }
  }
  html += renderHistory();
  const fans = devices.filter((device) => device.hasFan);
  const silent = fans.length > 0 && fans.every((device) => !device.unbound && !device.rpms.some((value) => value > 0));
  html += `<div class="card"><h2>Fans</h2>${fans.length ? fans.map((device) => {
    const rpm = device.rpms.filter((value) => value > 0);
    return `<div class="row"><span>${esc(device.name)}</span><span class="num">${device.unbound ? 'Not paired' : rpm.length ? rpm.join(' / ') + ' RPM' : '0 RPM'}</span></div>`;
  }).join('') : '<span class="muted">No fan groups found.</span>'}
  ${silent ? '<p class="muted">Every group reports 0 RPM. This is what the fans send over the radio, so check that they have power and are plugged into their controller.</p>' : ''}</div>`;
  if (stats.disks.length) {
    html += `<div class="card"><h2>Drives</h2>${stats.disks.map((disk) => `<div class="row"><span>${esc(disk.name)}${disk.bad ? ' <span class="bad">problem</span>' : ''}${disk.errors ? ` <span class="bad">${disk.errors} errors</span>` : ''}</span><span class="num ${disk.temp ? tempClass(disk.temp) : 'muted'}">${disk.temp ? disk.temp + '°C' : 'Asleep'}</span></div>`).join('')}</div>`;
  }
  html += `<p class="muted">Server time ${esc(data.localTime)} (${esc(data.timezone)}). Daemon ${esc(daemon.version || 'offline')}.</p>`;
  view.innerHTML = html;
}

// Fans --------------------------------------------------------------------

function curveChart(points) {
  const width = 600;
  const height = 220;
  const left = 36;
  const bottom = 24;
  const x = (temp) => left + (temp / 100) * (width - left - 8);
  const y = (pct) => 8 + (1 - pct / 100) * (height - bottom - 8);
  const valid = points.filter(([temp, pct]) => Number.isFinite(temp) && Number.isFinite(pct));
  const path = valid.map(([temp, pct]) => `${x(temp).toFixed(1)},${y(pct).toFixed(1)}`).join(' ');
  const yTicks = [0, 50, 100].map((pct) => `<line class="grid-line" x1="${left}" x2="${width - 8}" y1="${y(pct)}" y2="${y(pct)}"/><text x="${left - 6}" y="${y(pct) + 4}" text-anchor="end">${pct}%</text>`).join('');
  const xTicks = [0, 25, 50, 75, 100].map((temp) => `<text x="${x(temp)}" y="${height - 6}" text-anchor="middle">${temp}°</text>`).join('');
  return `<svg class="curve-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Fan speed against temperature">
    ${yTicks}${xTicks}
    <polyline class="data-line" points="${path}"/>
    ${valid.map(([temp, pct]) => `<circle cx="${x(temp).toFixed(1)}" cy="${y(pct).toFixed(1)}" r="5"><title>${temp}°C: ${pct}%</title></circle>`).join('')}
  </svg>`;
}

function curveEditor() {
  const draft = curveDraft;
  const sensors = data.sensors.map((sensor) => option(sensor.id, sensor.name, sensor.id === draft.sensor)).join('');
  return `<div class="card" id="curveEditor"><h2>${draft.original ? `Edit ${esc(draft.original)}` : 'New curve'}</h2>
    <label>Name<input type="text" maxlength="40" data-curve="name" value="${esc(draft.name)}"></label>
    <label>Follow this temperature
      <select data-curve="sensor">
        ${draft.sensor === 'custom' ? '<option value="custom" selected disabled>Set in the full app (pick one to save)</option>' : ''}
        ${sensors}
      </select></label>
    <div id="curvePreview">${curveChart(draft.points)}</div>
    ${draft.points.map(([temp, pct], index) => `<div class="points">
      <label>Temperature °C<input type="number" min="0" max="110" data-point="${index}" data-part="0" value="${temp}"></label>
      <label>Speed %<input type="number" min="${MIN_FAN}" max="100" data-point="${index}" data-part="1" value="${pct}"></label>
      <button class="btn" data-point-remove="${index}" aria-label="Remove point" ${draft.points.length <= 2 ? 'disabled' : ''}>×</button>
    </div>`).join('')}
    <div class="actions">
      <button class="btn" id="pointAdd" ${draft.points.length >= MAX_POINTS ? 'disabled' : ''}>Add point</button>
      <button class="btn primary" id="curveSave">Save curve</button>
      <button class="btn" id="curveCancel">Cancel</button>
    </div>
  </div>`;
}

function renderFans() {
  const fans = data.devices.filter((device) => device.hasFan && !device.unbound);
  let html = fans.length ? fans.map((device) => {
    const isCurve = typeof device.speed === 'string';
    const known = !isCurve || data.curves.includes(device.speed);
    const percent = typeof device.speed === 'number' ? Math.max(MIN_FAN, Math.round(device.speed / 2.55)) : 60;
    const options = [option('constant', 'Fixed speed', !isCurve)]
      .concat(data.curves.map((curve) => option(`curve:${curve}`, `Curve: ${curve}`, device.speed === curve)));
    if (!known) options.push('<option selected disabled>Set in the full app</option>');
    const rpm = device.rpms.filter((value) => value > 0);
    return `<div class="card" data-device="${esc(device.id)}">
      <div class="row"><b>${esc(device.name)}</b><span class="num">${rpm.length ? rpm.join(' / ') + ' RPM' : '0 RPM'}</span></div>
      <label>Mode<select data-fan-mode>${options.join('')}</select></label>
      ${isCurve ? '' : `<label>Speed: <span data-out>${percent}%</span><input type="range" min="${MIN_FAN}" max="100" step="5" value="${percent}" data-fan-speed></label>`}
      ${fans.length > 1 ? '<div class="actions"><button class="btn" data-fan-all>Use on all fans</button></div>' : ''}
    </div>`;
  }).join('') + `<p class="muted">Speeds stop at ${MIN_FAN}% here so fans can't be stopped by accident.</p>`
    : '<div class="card muted">No paired fan groups found.</div>';
  html += `<div class="card"><h2>Fan curves</h2>${data.curveDetails.length ? data.curveDetails.map((curve) => `<div class="row">
      <span>${esc(curve.name)}<br><span class="muted">${esc(data.sensors.find((sensor) => sensor.id === curve.sensor)?.name || 'Set in the full app')}, ${curve.points.map(([temp, pct]) => `${temp}°→${pct}%`).join(' ')}</span></span>
      <span class="actions" style="margin:0;flex:none"><button class="btn" data-curve-edit="${esc(curve.name)}">Edit</button><button class="btn danger" data-curve-delete="${esc(curve.name)}">Delete</button></span>
    </div>`).join('') : '<span class="muted">No curves yet.</span>'}
    ${curveDraft ? '' : '<div class="actions"><button class="btn primary" id="curveNew">New curve</button><button class="btn" id="curveDrives">New curve for drive temperature</button></div>'}
  </div>`;
  if (curveDraft) html += curveEditor();
  view.innerHTML = html;
}

// Lights ------------------------------------------------------------------

function effectParams(device, mode) {
  return device.rgbParams.find((item) => item.mode === mode) || null;
}

function renderLights() {
  const lights = data.devices.filter((device) => device.hasRgb && !device.unbound);
  let html = '';
  if (data.status.lightsOff) html += '<div class="card notice">A schedule has the lights off right now. They come back when it ends.</div>';
  if (lights.length > 1 && !data.status.lightsOff) html += '<div class="actions" style="margin:0 0 12px"><button class="btn" id="lightsOff">Turn all lights off</button></div>';
  html += lights.length ? lights.map((device) => {
    const effect = device.effect || { mode: device.rgbModes[0] || 'Off', colors: [[255, 255, 255]], brightness: 4, speed: 2 };
    const modes = device.rgbModes.includes(effect.mode) ? device.rgbModes : [effect.mode, ...device.rgbModes];
    const params = effectParams(device, effect.mode);
    const colorCount = COLOR_FREE.has(effect.mode) ? 0 : Math.min(params ? params.max_colors : 1, 4);
    const colors = Array.from({ length: colorCount }, (_, index) => effect.colors?.[index] || effect.colors?.[0] || [255, 255, 255]);
    const directions = params?.directions || [];
    const canSpeed = params ? params.supports_speed : !COLOR_FREE.has(effect.mode) && effect.mode !== 'Static';
    return `<div class="card" data-device="${esc(device.id)}">
      <b>${esc(device.name)}</b>
      <label>Effect<select data-rgb-mode>${modes.map((mode) => option(mode, spaced(mode), mode === effect.mode)).join('')}</select></label>
      ${colors.length ? `<div class="colors">${colors.map((color, index) => `<label>${colors.length > 1 ? `Colour ${index + 1}` : 'Colour'}<input type="color" data-rgb-color value="${hex(color)}"></label>`).join('')}</div>` : ''}
      <div class="two">
        <label>Brightness<select data-rgb-brightness>${[0, 1, 2, 3, 4].map((level) => option(level, `${(level + 1) * 20}%`, level === (effect.brightness ?? 4))).join('')}</select></label>
        ${canSpeed ? `<label>Speed<select data-rgb-speed>${['Slowest', 'Slow', 'Medium', 'Fast', 'Fastest'].map((name, level) => option(level, name, level === (effect.speed ?? 2))).join('')}</select></label>` : ''}
      </div>
      ${directions.length > 1 ? `<label>Direction<select data-rgb-direction>${directions.map((item) => option(item, spaced(item), item === effect.direction)).join('')}</select></label>` : ''}
      <div class="actions"><button class="btn" data-rgb-all>Use on all fans</button></div>
    </div>`;
  }).join('') : '<div class="card muted">No paired lighting found.</div>';
  if (lights.length) {
    html += `<div class="card"><h2>Saved setups</h2>
      ${data.profiles.length ? data.profiles.map((profile) => `<div class="row"><span>${esc(profile.name)}<br><span class="muted">${esc(data.devices.find((device) => device.id === profile.deviceId)?.name || 'Device not connected')}</span></span>
        <span class="actions" style="margin:0;flex:none"><button class="btn" data-profile-apply="${esc(profile.name)}" data-for="${esc(profile.deviceId)}">Apply</button><button class="btn danger" data-profile-delete="${esc(profile.name)}">Delete</button></span></div>`).join('') : '<span class="muted">Save a fan group\'s lights, fan speed and screen under a name, and bring them back later.</span>'}
      <div class="two"><label>Group<select id="profileDevice">${lights.map((device) => option(device.id, device.name)).join('')}</select></label>
      <label>Name<input type="text" maxlength="40" id="profileName"></label></div>
      <div class="actions"><button class="btn primary" id="profileSave">Save setup</button></div>
    </div>`;
  }
  view.innerHTML = html;
}

// Screens -----------------------------------------------------------------

function screenValue(device) {
  const screen = data.settings.screens[device.id];
  if (!screen) return 'keep';
  if (screen.kind === 'color') return 'color';
  return screen.kind === 'template' ? `template:${screen.templateId}` : `media:${screen.path}`;
}

function draftColors() {
  const { keys, presets } = data.themes;
  const source = themeDraft.theme === 'custom' ? themeDraft.customColors : presets[themeDraft.theme];
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function themePreview(id) {
  return `/api/preview?id=${encodeURIComponent(id)}&colors=${encodeURIComponent(JSON.stringify(draftColors()))}`;
}

function themeCard() {
  const { presets, keys } = data.themes;
  themeDraft ||= {
    theme: data.settings.theme,
    customColors: data.settings.customColors || Object.fromEntries(keys.map((key) => [key, presets.default[key]])),
    limits: { ...data.settings.limits },
  };
  const { limits } = themeDraft;
  const limit = (key, text, min, max) => `<label>${text}<input type="number" min="${min}" max="${max}" data-limit="${key}" value="${limits[key]}"></label>`;
  return `<div class="card" id="themeCard"><h2>Screen colours</h2>
    <label>Theme<select id="themePick">
      ${Object.entries(presets).map(([key, preset]) => option(key, preset.label, themeDraft.theme === key)).join('')}
      ${option('custom', 'Custom', themeDraft.theme === 'custom')}
    </select></label>
    ${themeDraft.theme === 'custom' ? `<div class="colors">${keys.map((key) => `<label>${esc(COLOR_NAMES[key])}<input type="color" data-theme-color="${key}" value="${hex(themeDraft.customColors[key])}"></label>`).join('')}</div>` : ''}
    <div class="gallery" style="margin-top:12px">
      <figure><img id="themeA" alt="Drives screen in this theme" src="${esc(themePreview('unraid_drives'))}"><figcaption>Drives</figcaption></figure>
      <figure><img id="themeB" alt="Overview screen in this theme" src="${esc(themePreview('unraid_overview'))}"><figcaption>Overview</figcaption></figure>
    </div>
    <h3>When colours change</h3>
    <div class="two">${limit('tempWarn', 'Drive warning °C', 20, 65)}${limit('tempDanger', 'Drive danger °C', 20, 65)}</div>
    <div class="two">${limit('storageWarn', 'Storage warning %', 0, 100)}${limit('storageDanger', 'Storage danger %', 0, 100)}</div>
    <div class="two">${limit('cpuWarn', 'CPU warning %', 0, 100)}${limit('cpuDanger', 'CPU danger %', 0, 100)}</div>
    <div class="actions"><button class="btn primary" id="themeSave">Save colours</button></div>
    <p class="muted">Applies to the Unraid screens. Alert screens stay red so they always stand out.</p>
  </div>`;
}

function lcdCard(device) {
  const screen = data.settings.screens[device.id];
  const { presets } = data.themes;
  const own = data.settings.lcdThemes[device.id] || '';
  return `<div class="card" data-device="${esc(device.id)}"><b>${esc(device.name)}</b>
    <label>Shows
      <select data-screen="${esc(device.id)}">
        <option value="keep">Set in the full app</option>
        <optgroup label="Unraid">${data.templates.map((item) => option(`template:${item.id}`, item.name)).join('')}</optgroup>
        ${data.media.length ? `<optgroup label="Your media">${data.media.map((file) => option(`media:${file}`, fileName(file))).join('')}</optgroup>` : ''}
        <option value="color">Solid colour</option>
      </select></label>
    ${screen?.kind === 'color' ? `<label>Colour<input type="color" data-solid value="${hex(screen.rgb)}"></label>` : ''}
    <label>Brightness: <span data-out>${device.brightness}%</span><input type="range" min="0" max="100" step="5" value="${device.brightness}" data-lcd-brightness></label>
    <div class="two">
      <label>Rotation<select data-lcd-rotation>${[0, 90, 180, 270].map((angle) => option(angle, `${angle}°`, angle === device.orientation)).join('')}</select></label>
      <label>Colours<select data-lcd-theme>
        ${option('', 'Same as all screens', !own)}
        ${Object.entries(presets).map(([key, preset]) => option(key, preset.label, own === key)).join('')}
        ${data.settings.customColors ? option('custom', 'Custom', own === 'custom') : ''}
      </select></label>
    </div>
  </div>`;
}

function renderScreens() {
  const lcds = data.devices.filter((device) => device.hasLcd);
  let html = '';
  if (!lcds.length) {
    html += `<div class="card notice"><b>No screens connected.</b><br>Each LCD fan needs its USB cable connected to the server. Screens appear here automatically afterwards. You can set everything below in the meantime.</div>`;
  } else {
    html += lcds.map(lcdCard).join('');
    if (lcds.length > 1) html += '<div class="actions" style="margin:0 0 12px"><button class="btn" id="spread">Different stat on each fan</button></div>';
  }
  html += themeCard();
  const uploaded = data.media.filter((file) => file.startsWith(`${data.uploadDir}/`));
  html += `<div class="card"><h2>Your images and videos</h2>
    ${uploaded.map((file) => `<div class="row"><span>${esc(fileName(file))}</span><button class="btn danger" data-media-delete="${esc(file)}">Delete</button></div>`).join('')}
    <label>Add a file (images, GIFs and videos, up to 512 MB)<input type="file" id="upload" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,.mkv,.avi"></label>
    <p class="muted" id="uploadNote">Files in the LCD media folder show up in the Shows list too.</p>
  </div>`;
  if (lcds.length) {
    const running = data.pixelClean[0];
    html += `<div class="card"><h2>Pixel cleaning</h2>
      <p class="muted" style="margin-top:0">Shows a moving pattern on the screens to reduce image retention.</p>
      ${running ? `<div class="row"><span>Running, ${Math.ceil(running.remaining_seconds / 60)} minutes left</span><button class="btn" id="pixelStop">Stop</button></div>`
    : `<div class="two"><label>Run for<select id="pixelMinutes">${[15, 30, 60, 120].map((minutes) => option(minutes, `${minutes} minutes`, minutes === 30)).join('')}</select></label>
         <div class="actions" style="align-self:end"><button class="btn" id="pixelStart">Start</button></div></div>`}
    </div>`;
  }
  html += `<div class="card"><h2>Unraid screens</h2><div class="gallery">${data.templates.map((item) => `<figure><img loading="lazy" alt="${esc(item.name)} preview" src="/api/preview?id=${encodeURIComponent(item.id)}"><figcaption>${esc(item.name.replace('Unraid: ', ''))}</figcaption></figure>`).join('')}</div>
    <p class="muted">Previews come from the daemon, so live values can show as blank here.</p></div>`;
  view.innerHTML = html;
  lcds.forEach((device) => { view.querySelector(`[data-screen="${CSS.escape(device.id)}"]`).value = screenValue(device); });
}

// Automation --------------------------------------------------------------

function scheduleCard(item, index) {
  const screens = [option('', "Don't change screen", !item.templateId)]
    .concat(data.templates.map((template) => option(template.id, template.name, item.templateId === template.id)));
  return `<div class="card" data-index="${index}">
    <div class="row"><label class="check"><input type="checkbox" data-k="enabled" ${item.enabled ? 'checked' : ''}>On</label><button class="btn" data-remove>Remove</button></div>
    <label>Name<input type="text" maxlength="40" data-k="name" value="${esc(item.name)}"></label>
    <div class="two">
      <label>From<input type="time" data-k="start" value="${esc(item.start)}"></label>
      <label>Until<input type="time" data-k="end" value="${esc(item.end)}"></label>
    </div>
    <label>Screen brightness: <span data-out>${item.brightness}%</span><input type="range" min="0" max="100" step="5" data-k="brightness" value="${item.brightness}"></label>
    <label>Show<select data-k="templateId">${screens.join('')}</select></label>
    <label class="check"><input type="checkbox" data-k="lightsOff" ${item.lightsOff ? 'checked' : ''}>Turn fan lights off too</label>
    <label>Days (none ticked means every day)</label>
    <div class="days">${DAYS.map((day, number) => `<label class="check"><input type="checkbox" data-day="${number}" ${item.days.includes(number) ? 'checked' : ''}>${day}</label>`).join('')}</div>
  </div>`;
}

function renderAuto() {
  const alerts = data.settings.alerts;
  if (!scheduleDirty) drafts = JSON.parse(JSON.stringify(data.settings.schedules));
  view.innerHTML = `<div class="card" id="alerts"><h2>Alerts on the screens</h2>
      <label class="check"><input type="checkbox" id="aOn" ${alerts.enabled ? 'checked' : ''}>Take over all screens when something is wrong</label>
      <label>Drive too hot at (°C)<input type="number" id="aTemp" min="30" max="70" value="${alerts.diskTempC}"></label>
      <label class="check"><input type="checkbox" id="aDisk" ${alerts.diskProblem ? 'checked' : ''}>Disabled disks or read errors</label>
      ${data.stats.hasArray ? `<label class="check"><input type="checkbox" id="aParity" ${alerts.parityErrors ? 'checked' : ''}>Parity errors</label>` : `<input type="checkbox" id="aParity" hidden ${alerts.parityErrors ? 'checked' : ''}>`}
      <label class="check"><input type="checkbox" id="aStorage" ${alerts.storageFull ? 'checked' : ''}>Any pool nearly full</label>
      <label>Nearly full at (%)<input type="number" id="aStoragePct" min="50" max="100" value="${alerts.storagePct}"></label>
      <div class="actions"><button class="btn primary" id="aSave">Save alerts</button></div>
    </div>
    <h2>Schedules</h2>
    <div id="schedules">${drafts.map(scheduleCard).join('')}</div>
    ${drafts.length ? '' : '<div class="card muted">No schedules yet.</div>'}
    <div class="actions"><button class="btn" id="addNight">Add night mode</button><button class="btn primary" id="sSave">Save schedules</button></div>
    <p class="muted">Times use the server clock (${esc(data.timezone)}). Fan speeds aren't affected. An alert overrides any schedule's screen.</p>`;
}

// System ------------------------------------------------------------------

function deviceCard(device) {
  const wireless = device.id.startsWith('wireless:');
  const parts = [device.model];
  if (device.serial) parts.push(device.serial);
  if (device.firmware) parts.push(`firmware ${device.firmware}`);
  const pairing = !wireless ? ''
    : device.unbound
      ? `<button class="btn primary" data-pair="bind" ${device.foreignOnline ? 'disabled' : ''}>Pair</button>`
      : '<button class="btn danger" data-pair="unbind">Unpair</button>';
  return `<div class="card" data-device="${esc(device.id)}">
    <label>Name<input type="text" maxlength="40" data-rename value="${esc(data.settings.names[device.id] || '')}" placeholder="${esc(device.model)}"></label>
    <p class="muted" style="margin:6px 0 0;overflow-wrap:anywhere">${esc(parts.join(', '))}</p>
    ${device.foreignOnline ? '<p class="warn" style="margin:6px 0 0">Paired to another controller that is switched on. Turn that controller off to pair it here.</p>' : ''}
    ${wireless ? `<div class="actions">${pairing}<button class="btn" data-identify>Identify</button></div>` : ''}
  </div>`;
}

function healthCard() {
  if (!health) return '<div class="card"><h2>Installation health</h2><span class="muted">Checking…</span></div>';
  if (health.error) return `<div class="card"><h2>Installation health</h2><span class="muted">${esc(health.error)}</span></div>`;
  const failed = (health.findings || []).filter((item) => item.state === 'failed');
  return `<div class="card"><h2>Installation health</h2>
    ${failed.length ? failed.map((item) => `<div class="row" style="display:block"><b class="${item.severity === 'error' ? 'bad' : item.severity === 'warning' ? 'warn' : ''}">${esc(item.title)}</b><br><span class="muted">${esc(item.remediation)}</span></div>`).join('') : '<span class="good">All checks passed.</span>'}
    <div class="actions"><button class="btn" id="healthRefresh">Check again</button></div></div>`;
}

function renderSystem() {
  const settings = data.daemonSettings;
  const unbound = data.devices.filter((device) => device.unbound && !device.foreignOnline);
  let html = '<h2>Devices</h2>';
  if (unbound.length > 1) html += '<div class="actions" style="margin:0 0 12px"><button class="btn" id="pairAll">Pair all unpaired fans</button></div>';
  html += data.devices.length ? data.devices.map(deviceCard).join('') : '<div class="card muted">No devices found.</div>';
  if (settings) {
    html += `<div class="card"><h2>Settings</h2>
      <label class="check"><input type="checkbox" data-setting="turnOffLcds" ${settings.turnOffLcds ? 'checked' : ''}>Turn screens off when the container stops</label>
      <label class="check"><input type="checkbox" data-setting="hardwareVideo" ${settings.hardwareVideo ? 'checked' : ''}>Use hardware video decoding</label>
      <label class="check"><input type="checkbox" data-setting="rgbDrift" ${settings.rgbDrift ? 'checked' : ''}>Keep fan lights in sync with their saved colours</label>
      <label>Video frame rate (1 to 60)<input type="number" min="1" max="60" data-setting-fps value="${settings.defaultFps ?? ''}" placeholder="Default"></label>
    </div>`;
  }
  html += healthCard();
  html += `<div class="card"><h2>Backup</h2><p class="muted" style="margin-top:0">Downloads the fan, lighting and screen settings plus this dashboard's settings as a JSON file.</p>
    <a href="/api/export" download>Download settings</a></div>`;
  view.innerHTML = html;
}

const RENDER = { overview: renderOverview, fans: renderFans, lights: renderLights, screens: renderScreens, auto: renderAuto, system: renderSystem };

function renderTabs() {
  document.getElementById('tabs').innerHTML = TABS.map(([id, name]) => `<button role="tab" data-tab="${id}" aria-selected="${tab === id}">${name}</button>`).join('');
}

function interacting() {
  const active = document.activeElement;
  return (active && view.contains(active) && /^(INPUT|SELECT)$/.test(active.tagName))
    || chartHover
    || (tab === 'auto' && scheduleDirty)
    || (tab === 'fans' && curveDraft);
}

async function loadHistory() {
  if (Date.now() - historyAt < HISTORY_REFRESH_MS) return;
  historyAt = Date.now();
  const response = await fetch('/api/history').catch(() => null);
  if (response?.ok) history = await response.json();
}

async function loadHealth() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw await failure(response);
    health = await response.json();
  } catch (error) {
    health = { error: error.message };
  }
  if (tab === 'system' && !interacting()) renderSystem();
}

async function refresh(force = false) {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`Status ${response.status}`);
    data = await response.json();
    if (tab === 'overview') await loadHistory();
    document.getElementById('fullApp').href = `http://${location.hostname}:${data.fullAppPort}/vnc.html?autoconnect=1&resize=remote`;
    // Screens reloads preview images, so it only redraws when asked to.
    if (force === true || (!interacting() && tab !== 'screens' && tab !== 'auto')) RENDER[tab]();
  } catch (error) {
    if (!data) view.innerHTML = `<div class="banner">Can't reach the dashboard server. ${esc(error.message)}</div>`;
  }
}

function deviceOf(element) {
  return element.closest('[data-device]').dataset.device;
}

function rgbBody(card) {
  const device = data.devices.find((item) => item.id === card.dataset.device);
  const colors = [...card.querySelectorAll('[data-rgb-color]')].map((input) => rgbOf(input.value));
  const body = {
    device_id: card.dataset.device,
    mode: card.querySelector('[data-rgb-mode]').value,
    colors: colors.length ? colors : (device.effect?.colors?.length ? device.effect.colors.slice(0, 4) : [[255, 255, 255]]),
    brightness: Number(card.querySelector('[data-rgb-brightness]').value),
  };
  const speed = card.querySelector('[data-rgb-speed]');
  const direction = card.querySelector('[data-rgb-direction]');
  if (speed) body.speed = Number(speed.value);
  if (direction) body.direction = direction.value;
  return body;
}

function readDrafts() {
  document.querySelectorAll('#schedules [data-index]').forEach((card) => {
    const item = drafts[Number(card.dataset.index)];
    card.querySelectorAll('[data-k]').forEach((input) => {
      const key = input.dataset.k;
      if (key === 'enabled' || key === 'lightsOff') item[key] = input.checked;
      else if (key === 'brightness') item.brightness = Number(input.value);
      else if (key === 'templateId') item.templateId = input.value || null;
      else item[key] = input.value;
    });
    item.days = [...card.querySelectorAll('[data-day]:checked')].map((input) => Number(input.dataset.day));
  });
}

async function uploadFile(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > MAX_UPLOAD) {
    toast('Files can be up to 512 MB');
    return;
  }
  document.getElementById('uploadNote').textContent = `Uploading ${file.name}…`;
  input.disabled = true;
  try {
    const response = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'X-Lianli-Dashboard': '1' },
      body: file,
    });
    if (!response.ok) throw await failure(response);
    toast('Uploaded');
  } catch (error) {
    toast(error.message);
  }
  refresh(true);
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const id = event.target.dataset.tab;
  if (!id) return;
  tab = id;
  chartHover = false;
  renderTabs();
  if (tab === 'system' && !health) loadHealth();
  if (tab === 'overview') loadHistory();
  if (data) RENDER[tab]();
});

view.addEventListener('input', (event) => {
  const target = event.target;
  if (target.matches('[data-fan-speed], [data-k="brightness"], [data-lcd-brightness]')) {
    target.closest('label').querySelector('[data-out]').textContent = `${target.value}%`;
  }
  if (target.closest('#schedules')) scheduleDirty = true;
  if (target.dataset.curve) curveDraft[target.dataset.curve] = target.value;
  if (target.dataset.point !== undefined) {
    curveDraft.points[Number(target.dataset.point)][Number(target.dataset.part)] = target.value === '' ? NaN : Number(target.value);
    document.getElementById('curvePreview').innerHTML = curveChart(curveDraft.points);
  }
  if (target.dataset.limit) themeDraft.limits[target.dataset.limit] = Number(target.value);
  if (target.dataset.themeColor) themeDraft.customColors[target.dataset.themeColor] = rgbOf(target.value);
});

view.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[data-fan-mode]')) {
    const body = { device_id: deviceOf(target) };
    if (target.value === 'constant') Object.assign(body, { mode: 'constant', percent: 60 });
    else Object.assign(body, { mode: 'curve', curve: target.value.slice(6) });
    target.blur();
    act('/api/fan', body);
  } else if (target.matches('[data-fan-speed]')) {
    target.blur();
    act('/api/fan', { device_id: deviceOf(target), mode: 'constant', percent: Number(target.value) });
  } else if (target.matches('[data-rgb-mode], [data-rgb-color], [data-rgb-brightness], [data-rgb-speed], [data-rgb-direction]')) {
    target.blur();
    act('/api/rgb', rgbBody(target.closest('[data-device]')));
  } else if (target.matches('[data-storage]')) {
    target.blur();
    act('/api/storage', { volume: target.value });
  } else if (target.matches('[data-screen]')) {
    const [kind, ...rest] = target.value.split(':');
    const value = rest.join(':');
    let screen = { kind };
    if (kind === 'template') screen = { kind, templateId: value };
    else if (kind === 'media') screen = { kind, path: value };
    else if (kind === 'color') screen = { kind, rgb: [0, 0, 0] };
    target.blur();
    act('/api/screen', { device_id: target.dataset.screen, screen });
  } else if (target.matches('[data-solid]')) {
    target.blur();
    act('/api/screen', { device_id: deviceOf(target), screen: { kind: 'color', rgb: rgbOf(target.value) } });
  } else if (target.matches('[data-lcd-brightness]')) {
    target.blur();
    act('/api/lcd', { device_id: deviceOf(target), brightness: Number(target.value) });
  } else if (target.matches('[data-lcd-rotation]')) {
    target.blur();
    act('/api/lcd', { device_id: deviceOf(target), orientation: Number(target.value) });
  } else if (target.matches('[data-lcd-theme]')) {
    target.blur();
    act('/api/lcd', { device_id: deviceOf(target), theme: target.value || null });
  } else if (target.id === 'themePick') {
    themeDraft.theme = target.value;
    target.blur();
    renderScreens();
  } else if (target.dataset.themeColor) {
    document.getElementById('themeA').src = themePreview('unraid_drives');
    document.getElementById('themeB').src = themePreview('unraid_overview');
  } else if (target.id === 'upload') {
    uploadFile(target);
  } else if (target.dataset.setting) {
    act('/api/settings', { [target.dataset.setting]: target.checked });
  } else if (target.matches('[data-setting-fps]')) {
    target.blur();
    act('/api/settings', { defaultFps: Number(target.value) });
  } else if (target.matches('[data-rename]')) {
    target.blur();
    act('/api/device', { device_id: deviceOf(target), action: 'rename', name: target.value });
  } else if (target.dataset.curve === 'sensor') {
    target.blur();
  }
});

function newCurve(sensor) {
  const taken = new Set(data.curves);
  let name = 'My curve';
  for (let number = 2; taken.has(name); number += 1) name = `My curve ${number}`;
  curveDraft = { original: null, name, sensor: sensor || data.sensors[0]?.id || 'custom', points: [[30, 25], [40, 40], [50, 70], [55, 100]] };
  renderFans();
  document.getElementById('curveEditor').scrollIntoView({ block: 'nearest' });
}

view.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const set = target.dataset;
  if (set.mute !== undefined) {
    act('/api/alerts/mute', { hours: Number(set.mute) });
  } else if (target.matches('[data-fan-all]')) {
    const card = target.closest('[data-device]');
    const mode = card.querySelector('[data-fan-mode]').value;
    const speed = card.querySelector('[data-fan-speed]');
    const body = mode === 'constant' ? { mode, percent: Number(speed?.value ?? 60) } : { mode: 'curve', curve: mode.slice(6) };
    actOnAll(data.devices.filter((device) => device.hasFan && !device.unbound), (device) => post('/api/fan', { ...body, device_id: device.id }));
  } else if (target.id === 'curveNew') {
    newCurve();
  } else if (target.id === 'curveDrives') {
    newCurve(data.sensors.find((sensor) => sensor.id === 'unraid:disk_temp_max')?.id);
  } else if (set.curveEdit) {
    const curve = data.curveDetails.find((item) => item.name === set.curveEdit);
    curveDraft = { original: curve.name, name: curve.name, sensor: curve.sensor, points: curve.points.map((point) => [...point]) };
    renderFans();
    document.getElementById('curveEditor').scrollIntoView({ block: 'nearest' });
  } else if (set.curveDelete) {
    if (window.confirm(`Delete the curve "${set.curveDelete}"?`)) act('/api/curve/delete', { name: set.curveDelete }, 'Deleted');
  } else if (target.id === 'pointAdd') {
    const last = curveDraft.points[curveDraft.points.length - 1];
    curveDraft.points.push([Math.min((last[0] || 0) + 5, 110), last[1] || 100]);
    renderFans();
  } else if (set.pointRemove !== undefined) {
    curveDraft.points.splice(Number(set.pointRemove), 1);
    renderFans();
  } else if (target.id === 'curveCancel') {
    curveDraft = null;
    renderFans();
  } else if (target.id === 'curveSave') {
    try {
      await post('/api/curve', curveDraft);
      curveDraft = null;
      toast('Saved');
    } catch (error) {
      toast(error.message);
    }
    refresh(true);
  } else if (target.matches('[data-rgb-all]')) {
    const body = rgbBody(target.closest('[data-device]'));
    actOnAll(data.devices.filter((device) => device.hasRgb && !device.unbound), (device) => post('/api/rgb', { ...body, device_id: device.id }));
  } else if (target.id === 'lightsOff') {
    actOnAll(data.devices.filter((device) => device.hasRgb && !device.unbound && device.rgbModes.includes('Off')), (device) => post('/api/rgb', { device_id: device.id, mode: 'Off', colors: device.effect?.colors?.slice(0, 4) || [[0, 0, 0]], brightness: device.effect?.brightness ?? 4 }));
  } else if (target.id === 'profileSave') {
    act('/api/profile', { action: 'save', name: document.getElementById('profileName').value.trim(), device_id: document.getElementById('profileDevice').value });
  } else if (set.profileApply) {
    act('/api/profile', { action: 'apply', name: set.profileApply, device_id: set.for }, 'Applied');
  } else if (set.profileDelete) {
    if (window.confirm(`Delete "${set.profileDelete}"?`)) act('/api/profile', { action: 'delete', name: set.profileDelete }, 'Deleted');
  } else if (target.id === 'spread') {
    const order = ['unraid_drives', 'unraid_array', 'unraid_system', 'unraid_overview'];
    const lcds = data.devices.filter((device) => device.hasLcd);
    actOnAll(lcds, (device) => post('/api/screen', { device_id: device.id, screen: { kind: 'template', templateId: order[lcds.indexOf(device) % order.length] } }));
  } else if (target.id === 'themeSave') {
    const body = { theme: themeDraft.theme, limits: themeDraft.limits };
    if (themeDraft.theme === 'custom') body.customColors = themeDraft.customColors;
    try {
      await post('/api/theme', body);
      themeDraft = null;
      toast('Saved');
    } catch (error) {
      toast(error.message);
    }
    refresh(true);
  } else if (set.mediaDelete) {
    if (window.confirm(`Delete ${fileName(set.mediaDelete)}?`)) act('/api/media/delete', { path: set.mediaDelete }, 'Deleted');
  } else if (target.id === 'pixelStart') {
    target.disabled = true;
    toast('Starting…');
    act('/api/pixel', { action: 'start', minutes: Number(document.getElementById('pixelMinutes').value) }, 'Pixel cleaning started');
  } else if (target.id === 'pixelStop') {
    act('/api/pixel', { action: 'stop' }, 'Stopped');
  } else if (target.id === 'aSave') {
    act('/api/alerts', {
      enabled: document.getElementById('aOn').checked,
      diskTempC: Number(document.getElementById('aTemp').value),
      diskProblem: document.getElementById('aDisk').checked,
      parityErrors: document.getElementById('aParity').checked,
      storageFull: document.getElementById('aStorage').checked,
      storagePct: Number(document.getElementById('aStoragePct').value),
    });
  } else if (target.id === 'addNight') {
    readDrafts();
    drafts.push({ name: 'Night mode', start: '23:00', end: '07:00', days: [], brightness: 0, templateId: null, lightsOff: false, enabled: true });
    scheduleDirty = true;
    renderAuto();
  } else if (target.matches('[data-remove]')) {
    readDrafts();
    drafts.splice(Number(target.closest('[data-index]').dataset.index), 1);
    scheduleDirty = true;
    renderAuto();
  } else if (target.id === 'sSave') {
    readDrafts();
    try {
      await post('/api/schedules', { schedules: drafts });
      scheduleDirty = false;
      toast('Saved');
    } catch (error) {
      toast(error.message);
    }
    refresh(true);
  } else if (set.pair) {
    if (set.pair === 'unbind' && !window.confirm('Unpair this fan group? It stops responding here until you pair it again.')) return;
    target.disabled = true;
    toast(set.pair === 'bind' ? 'Pairing…' : 'Unpairing…');
    act('/api/device', { device_id: deviceOf(target), action: set.pair }, 'Done');
  } else if (target.id === 'pairAll') {
    target.disabled = true;
    toast('Pairing…');
    actOnAll(data.devices.filter((device) => device.unbound && !device.foreignOnline), (device) => post('/api/device', { device_id: device.id, action: 'bind' }));
  } else if (set.identify !== undefined) {
    act('/api/device', { device_id: deviceOf(target), action: 'identify' }, 'Look for the flashing fan');
  } else if (target.id === 'healthRefresh') {
    health = null;
    renderSystem();
    loadHealth();
  }
});

// Moving over a chart reads off the value at that time.
view.addEventListener('pointermove', (event) => {
  const svg = event.target.closest?.('.chart svg');
  if (!svg) return;
  chartHover = true;
  const chart = svg.closest('.chart');
  const key = chart.dataset.chart;
  const box = svg.getBoundingClientRect();
  const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
  const start = history[0].t;
  const time = start + fraction * (history[history.length - 1].t - start);
  const nearest = history.reduce((best, point) => (Math.abs(point.t - time) < Math.abs(best.t - time) ? point : best));
  const cross = svg.querySelector('[data-cross]');
  const x = ((nearest.t - start) / Math.max(history[history.length - 1].t - start, 1)) * 100;
  cross.setAttribute('x1', x);
  cross.setAttribute('x2', x);
  cross.setAttribute('visibility', 'visible');
  const reading = nearest[key] === null || nearest[key] === undefined ? 'no reading' : `${oneDecimal(nearest[key])}${chart.dataset.unit}`;
  chart.querySelector('[data-readout]').textContent = `${reading} at ${clock(nearest.t)}`;
});

view.addEventListener('pointerout', (event) => {
  const svg = event.target.closest?.('.chart svg');
  if (!svg || svg.contains(event.relatedTarget)) return;
  chartHover = false;
  const chart = svg.closest('.chart');
  svg.querySelector('[data-cross]').setAttribute('visibility', 'hidden');
  chart.querySelector('[data-readout]').textContent = chart.dataset.latest;
});

renderTabs();
refresh(true);
setInterval(refresh, 4000);
