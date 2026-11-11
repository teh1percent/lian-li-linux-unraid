'use strict';

const ICONS = {
  overview: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  fans: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7s3 5-2 8M14 12c4 0 7 1 7 4s-5 3-8-2M12 14c0 4-1 7-4 7s-3-5 2-8M10 12c-4 0-7-1-7-4s5-3 8 2"/>',
  lights: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  screens: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  system: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  aio: '<path d="M12 3s7 7.5 7 12a7 7 0 0 1-14 0c0-4.5 7-12 7-12z"/>',
  temp: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  disk: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h.01M11 15h6"/>',
  storage: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  free: '<path d="M12 4v16M4 12h16"/>',
  parity: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M10 2v4M14 2v4M10 18v4M14 18v4M2 10h4M2 14h4M18 10h4M18 14h4"/>',
  memory: '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 17v3M11 17v3M15 17v3M7 10v4M11 10v4M15 10v4"/>',
};
const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// The AIO tab only appears once an AIO is connected.
const TABS = [['overview', 'Status'], ['fans', 'Fans'], ['aio', 'AIO'], ['lights', 'Lights'], ['screens', 'Screens'], ['auto', 'Auto'], ['system', 'System']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ALERT_TEXT = { disk: 'Disk problem', parity: 'Parity errors', temp: 'Drive too hot', storage: 'Storage nearly full', coolant: 'Coolant too hot' };
const COLOR_NAMES = { background: 'Background', text: 'Text', muted: 'Small text', track: 'Gauge track', good: 'Normal', warn: 'Warning', bad: 'Danger' };
const spaced = (name) => name.replace(/([a-z])([A-Z])/g, '$1 $2');
const COLOR_FREE = new Set(['Off', 'Rainbow', 'RainbowMorph']);
const MIN_FAN = 20;
const MIN_PUMP = 30;
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
let shownTabs = '';

// Extra reasons to hold off redrawing a page, added by the page scripts.
const holds = [];

// A session can end at any time, and every request should lead back to the sign-in page.
const plainFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await plainFetch(...args);
  if (response.status === 401) window.location.replace('/login');
  return response;
};

const aioDevices = () => (data ? data.devices.filter((device) => device.isAio && !device.unbound && !device.hidden) : []);

const view = document.getElementById('view');
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (rgb) => '#' + (rgb || [255, 255, 255]).map((part) => part.toString(16).padStart(2, '0')).join('');
const rgbOf = (value) => [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16));
const fileName = (file) => file.split('/').pop();
const option = (value, text, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(text)}</option>`;
const toggle = (attributes, text, checked) => `<label class="switch"><span>${text}</span><input type="checkbox" ${attributes} ${checked ? 'checked' : ''}></label>`;

function toast(message, isError = false) {
  const element = document.getElementById('toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
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
    toast(error.message, true);
  }
  await refresh(true);
}

async function actOnAll(items, send) {
  try {
    for (const item of items) await send(item);
    toast('Saved');
  } catch (error) {
    toast(error.message, true);
  }
  refresh(true);
}

// Drive limits by default; CPU tiles pass their own.
function tempClass(temp, warn, danger) {
  const tempWarn = warn ?? data.settings.limits.tempWarn;
  const tempDanger = danger ?? data.settings.limits.tempDanger;
  if (temp >= tempDanger) return 'bad';
  return temp >= tempWarn ? 'warn' : 'good';
}

function storageClass(percent) {
  const { storageWarn, storageDanger } = data.settings.limits;
  if (percent >= storageDanger) return 'bad';
  return percent >= storageWarn ? 'warn' : '';
}

function renderHealth() {
  const element = document.getElementById('health');
  const { daemon, status } = data;
  let tone = '';
  let text = 'All good';
  if (!daemon.connected) [tone, text] = ['bad', 'Daemon offline'];
  else if (status.alert) [tone, text] = ['bad', ALERT_TEXT[status.alert]];
  else if (status.error) [tone, text] = ['warn', 'Needs attention'];
  else if (status.muted) [tone, text] = ['warn', 'Alerts muted'];
  element.className = `health ${tone}`;
  element.textContent = text;
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
    historyChart('coolant', 'Coolant', '°C'),
    historyChart('used', 'Storage used', '%'),
    historyChart('rpm', 'Average fan speed', ' RPM'),
    historyChart('cpuTemp', 'CPU temperature', '°C'),
    historyChart('mem', 'Memory used', '%'),
  ].join('');
  return `<div class="card"><div class="card-head"><h2>Last 24 hours</h2></div>${charts ? `<div class="charts">${charts}</div>` : '<span class="empty">Collecting data. Charts appear after a couple of minutes.</span>'}</div>`;
}

// A small 24-hour trend line for a stat tile, from the Status page history.
function spark(key) {
  const values = history.map((point) => point[key]).filter((value) => Number.isFinite(value));
  if (values.length < 2) return '';
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low || 1;
  const points = values.map((value, index) => `${((index / (values.length - 1)) * 100).toFixed(1)},${(18 - ((value - low) / range) * 16).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"/></svg>`;
}

function tile(iconName, label, value, tone = '', { sub = '', extra = '' } = {}) {
  return `<div class="tile"><span><i class="tile-icon ${tone}">${icon(iconName)}</i>${esc(label)}</span><b class="${tone}">${esc(value)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}${extra}</div>`;
}

function meterBar(pct) {
  const tone = pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : '';
  return `<div class="meter slim"><i class="${tone}" style="width:${Math.min(100, Math.max(0, pct))}%"></i></div>`;
}

function systemTiles() {
  const system = data.system;
  if (!system) return '';
  const cpu = system.cpuTemp !== null || system.cpu !== null
    ? tile('cpu', 'CPU', system.cpuTemp !== null ? `${Math.round(system.cpuTemp)}°C` : `${system.cpu}%`, system.cpuTemp !== null ? tempClass(system.cpuTemp, 70, 85) : '', {
      sub: system.cpuTemp !== null && system.cpu !== null ? `${system.cpu}% load` : 'Load',
      extra: spark(system.cpuTemp !== null ? 'cpuTemp' : 'cpu'),
    })
    : '';
  const mem = system.mem !== null ? tile('memory', 'Memory', `${system.mem}%`, '', { sub: 'In use', extra: meterBar(system.mem) }) : '';
  return cpu + mem;
}

function storageCard(stats) {
  const picker = stats.volumes.length > 1 ? `<label>Show on this page and on screens set to follow it
    <select data-storage>
      ${option('all', 'All storage', stats.selectedVolume === 'all')}
      ${stats.volumes.map((volume) => option(volume.key, volume.name, stats.selectedVolume === volume.key)).join('')}
    </select></label><div style="height:6px"></div>` : '';
  const rows = stats.volumes.map((volume) => {
    const shown = volume.key === stats.selectedVolume;
    return `<div class="volume">
      <div class="volume-top">
        <span class="volume-name">${esc(volume.name)}${shown ? '<span class="pill accent">On screens</span>' : ''}</span>
        <span class="muted num">${volume.freeTb} of ${volume.sizeTb} TB free</span>
      </div>
      <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${volume.usedPct}" aria-label="${esc(volume.name)}: ${volume.usedPct}% used"><i class="${storageClass(volume.usedPct)}" style="width:${Math.min(volume.usedPct, 100)}%"></i></div>
      <div class="muted num" style="margin:-4px 0 8px">${volume.usedPct}% used</div>
    </div>`;
  }).join('');
  return `<div class="card"><div class="card-head"><h2>Storage</h2></div>${picker}${rows}</div>`;
}

// Pool members are named after their pool, so the long drive list can be grouped.
function drivesCard(stats) {
  const groups = new Map();
  for (const disk of stats.disks) {
    const group = disk.type === 'Cache' ? disk.name.replace(/~.*$/, '').replace(/\d+$/, '') : 'Array';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(disk);
  }
  const body = [...groups].map(([name, disks]) => {
    const temps = disks.map((disk) => disk.temp).filter((temp) => temp > 0);
    const summary = temps.length ? `hottest ${Math.max(...temps)}°C` : 'asleep';
    return `<div class="pool-head"><b>${esc(name)}</b><span class="muted num">${disks.length} ${disks.length === 1 ? 'drive' : 'drives'}, ${summary}</span></div>
    <div class="drives ${name === 'Array' ? 'named' : ''}">${disks.map((disk) => {
      const problem = disk.bad || disk.errors;
      const note = disk.bad ? 'problem' : disk.errors ? `${disk.errors} errors` : '';
      // The heading already names the pool, and full names don't fit on a phone.
      const member = disk.name.slice(name.length).replace(/^~/, '');
      const shown = name === 'Array' ? disk.name : /^\d*$/.test(member) ? `#${member || 1}` : member;
      return `<div class="drive ${problem ? 'problem' : ''}"><span title="${esc(disk.name)}">${esc(shown)}</span><b class="${note ? 'bad' : disk.temp ? tempClass(disk.temp) : 'muted'}">${note ? esc(note) : disk.temp ? `${disk.temp}°` : 'Zzz'}</b></div>`;
    }).join('')}</div>`;
  }).join('');
  return `<div class="card"><div class="card-head"><h2>Drives</h2></div>${body}</div>`;
}

function aioPills(device) {
  const { coolant, pumpRpm } = device.aio;
  return `${coolant !== null ? `<span class="pill live">${oneDecimal(coolant)}°C</span>` : ''}${pumpRpm !== null ? `<span class="pill ${pumpRpm > 0 ? 'live' : ''}">Pump ${pumpRpm} RPM</span>` : ''}`;
}

function aioStatusCard() {
  const aios = aioDevices();
  if (!aios.length) return '';
  return `<div class="card"><div class="card-head"><h2>AIO</h2></div>${aios.map((device) => `<div class="row"><span>${esc(device.name)}</span><span class="row-actions">${aioPills(device)}</span></div>`).join('')}</div>`;
}

function fansCard(devices) {
  const fans = devices.filter((device) => device.hasFan && !device.isAio);
  const silent = fans.length > 0 && fans.every((device) => !device.unbound && !device.rpms.some((value) => value > 0));
  return `<div class="card"><div class="card-head"><h2>Fans</h2></div>${fans.length ? fans.map((device) => {
    const rpm = device.rpms.filter((value) => value > 0);
    const reading = device.unbound ? 'Not paired' : rpm.length ? `${rpm.join(' / ')} RPM` : '0 RPM';
    return `<div class="row"><span>${esc(device.name)}</span><span class="pill ${rpm.length ? 'live' : ''}">${reading}</span></div>`;
  }).join('') : '<span class="empty">No fan groups found.</span>'}
  ${silent ? '<p class="muted">Every group reports 0 RPM. This is what the fans send over the radio, so check that they have power and are plugged into their controller.</p>' : ''}</div>`;
}

function renderOverview() {
  const { stats, status, daemon, devices } = data;
  const values = stats.values;
  const fanParts = fanCards(devices);
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
    html += fanParts.pictures + aioStatusCard() + fanParts.list;
  } else {
    const storageName = stats.volumes.find((volume) => volume.key === stats.selectedVolume)?.name || 'Storage';
    html += `<div class="tiles">
      ${tile('temp', 'Hottest drive', stats.hasTemps ? `${values.disk_temp_max}°C` : 'Asleep', stats.hasTemps ? tempClass(values.disk_temp_max) : '', { sub: `${values.disks_active} of ${values.disks_total} drives awake`, extra: spark('temp') })}
      ${systemTiles()}
      ${tile('storage', `${storageName} used`, `${values.storage_used_pct}%`, '', { sub: `${values.storage_free_tb} TB free`, extra: meterBar(values.storage_used_pct) })}
      ${stats.hasArray ? `${tile('parity', 'Parity errors', values.parity_errors, values.parity_errors ? 'bad' : '')}
      ${tile('parity', 'Parity check', values.sync_pct > 0 ? `${values.sync_pct}%` : 'Idle')}` : ''}
    </div>`;
    html += renderHistory() + fanParts.pictures;
    html += `<div class="split"><div>${stats.volumes.length ? storageCard(stats) : ''}${aioStatusCard()}${fanParts.list}</div><div>${stats.disks.length ? drivesCard(stats) : ''}</div></div>`;
  }
  html += `<p class="footnote">Server time ${esc(data.localTime)} (${esc(data.timezone)}). Daemon ${esc(daemon.version || 'offline')}.</p>`;
  view.innerHTML = html;
  fanViewAfterRender();
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
  return `<div class="card" id="curveEditor"><div class="card-head"><h2>${draft.original ? `Edit ${esc(draft.original)}` : 'New curve'}</h2></div>
    <div class="two">
      <label style="margin-top:0">Name<input type="text" maxlength="40" data-curve="name" value="${esc(draft.name)}"></label>
      <label style="margin-top:0">Follow this temperature
        <select data-curve="sensor">
          ${draft.sensor === 'custom' ? '<option value="custom" selected disabled>Set outside this page (pick one to save)</option>' : ''}
          ${sensors}
        </select></label>
    </div>
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
  const fans = data.devices.filter((device) => device.hasFan && !device.unbound && !device.isAio && !device.hidden);
  let html = fans.length ? `<div class="cards">${fans.map((device) => {
    const mode = fanMode(device);
    const isCurve = typeof device.speed === 'string';
    const known = !isCurve || data.curves.includes(device.speed) || mode !== 'single';
    const percent = typeof device.speed === 'number' ? Math.max(MIN_FAN, Math.round(device.speed / 2.55)) : 60;
    const options = [option('constant', 'Fixed speed', mode === 'single' && !isCurve)]
      .concat(data.curves.map((curve) => option(`curve:${curve}`, `Curve: ${curve}`, mode === 'single' && device.speed === curve)))
      .concat(fanModeOptions(device, mode));
    if (!known) options.push('<option selected disabled>Custom setting</option>');
    const rpm = device.rpms.filter((value) => value > 0);
    return `<div class="card" data-device="${esc(device.id)}">
      <div class="card-head"><h2>${esc(device.name)}</h2><span class="pill ${rpm.length ? 'live' : ''}">${rpm.length ? `${rpm.join(' / ')} RPM` : '0 RPM'}</span></div>
      <label style="margin-top:0">Mode<select data-fan-mode>${options.join('')}</select></label>
      ${isCurve || mode !== 'single' ? '' : `<label><span class="slider-label"><span>Speed</span><span data-out>${percent}%</span></span><input type="range" min="${MIN_FAN}" max="100" step="5" value="${percent}" data-fan-speed></label>`}
      ${fanModeDetail(device, mode)}
      ${fans.length > 1 && mode !== 'slots' ? '<div class="actions"><button class="btn" data-fan-all>Use on all fans</button></div>' : ''}
    </div>`;
  }).join('')}</div><p class="footnote" style="margin-bottom:14px">Speeds stop at ${MIN_FAN}% here so fans can't be stopped by accident.</p>`
    : '<div class="card empty">No paired fan groups found.</div>';
  html += `<div class="card"><div class="card-head"><h2>Fan curves</h2></div>${data.curveDetails.length ? data.curveDetails.map((curve) => `<div class="row">
      <span>${esc(curve.name)}<br><span class="muted">${esc(data.sensors.find((sensor) => sensor.id === curve.sensor)?.name || 'Custom sensor')}, ${curve.points.map(([temp, pct]) => `${temp}°→${pct}%`).join(' ')}</span></span>
      <span class="row-actions"><button class="btn" data-curve-edit="${esc(curve.name)}">Edit</button><button class="btn danger" data-curve-delete="${esc(curve.name)}">Delete</button></span>
    </div>`).join('') : '<span class="empty">No curves yet.</span>'}
    ${curveDraft ? '' : '<div class="actions"><button class="btn primary" id="curveNew">New curve</button><button class="btn" id="curveDrives">New curve for drive temperature</button></div>'}
  </div>`;
  if (curveDraft) html += curveEditor();
  html += fanTuningCard();
  view.innerHTML = html;
}

// AIO ---------------------------------------------------------------------

function speedControl(kind, label, speed, min, fallback, mbSync) {
  const isFixed = typeof speed === 'number';
  const known = isFixed || speed === 'off' || speed === '__mb_sync__' || data.curves.includes(speed);
  const percent = isFixed ? Math.max(min, Math.round(speed / 2.55)) : fallback;
  return `<label>${esc(label)}<select data-aio-mode="${kind}">
      ${option('auto', 'Automatic (the AIO decides)', speed === 'off')}
      ${option('constant', 'Fixed speed', isFixed)}
      ${data.curves.map((curve) => option(`curve:${curve}`, `Curve: ${curve}`, speed === curve)).join('')}
      ${mbSync || speed === '__mb_sync__' ? option('mb', 'Follow the motherboard', speed === '__mb_sync__') : ''}
      ${known ? '' : '<option selected disabled>Mixed or custom</option>'}
    </select></label>
    ${isFixed ? `<label><span class="slider-label"><span>${esc(label)} speed</span><span data-out>${percent}%</span></span><input type="range" min="${min}" max="100" step="5" value="${percent}" data-aio-speed="${kind}"></label>` : ''}`;
}

function aioCard(device) {
  const { aio } = device;
  const sensorSelect = (key, label) => {
    const value = aio.sensors[key];
    const known = !value || data.aioSensors.some((sensor) => sensor.id === value);
    return `<label>${label}<select data-aio-sensor="${key}">
      ${option('', 'None', !value)}
      ${data.aioSensors.map((sensor) => option(sensor.id, sensor.name, sensor.id === value)).join('')}
      ${known ? '' : '<option selected disabled>Custom sensor</option>'}
    </select></label>`;
  };
  const fanRpm = device.rpms.filter((rpm) => rpm > 0);
  const fans = device.hasFan && device.fanCount > 0;
  // Slots can only be shown as one control when they agree.
  const fanSpeed = aio.fans.every((speed) => speed === aio.fans[0]) ? aio.fans[0] ?? 'off' : '__mixed__';
  return `<div class="card" data-device="${esc(device.id)}">
    <div class="card-head"><h2>${esc(device.name)}</h2><span class="row-actions">${aioPills(device)}</span></div>
    ${speedControl('pump', 'Pump', aio.pump, MIN_PUMP, 70, aio.pumpMbSync)}
    ${fans ? speedControl('fans', 'Radiator fans', fanSpeed, MIN_FAN, 60, aio.fanMbSync) : ''}
    ${fanRpm.length ? `<p class="muted num">Fans: ${fanRpm.join(' / ')} RPM</p>` : ''}
    <div class="actions"><button class="btn" data-coolant-curve>New curve for coolant</button></div>
    <h3>Pump screen</h3>
    <label><span class="slider-label"><span>Brightness</span><span data-out>${aio.brightness}%</span></span><input type="range" min="0" max="100" step="5" value="${aio.brightness}" data-aio-brightness></label>
    <div class="two">
      <label style="margin-top:6px">Theme<select data-aio-theme>${Array.from({ length: 13 }, (_, index) => option(index, `Theme ${index + 1}`, index === aio.theme)).join('')}</select></label>
      <label style="margin-top:6px">Rotation<select data-aio-rotation>${[0, 1, 2, 3].map((step) => option(step, `${step * 90}°`, step === aio.rotation)).join('')}</select></label>
    </div>
    <label>Seconds per page<input type="number" min="1" max="30" value="${aio.loopInterval}" data-aio-loop></label>
    <div class="colors">${[['label', 'Labels'], ['value', 'Values'], ['unit', 'Units']].map(([key, text]) => `<label>${text}<input type="color" data-aio-color="${key}" value="${hex(aio.colors[key])}"></label>`).join('')}</div>
    <h3>What the pump screen shows</h3>
    <div class="two">${sensorSelect('cpuTemp', 'CPU temperature')}${sensorSelect('cpuLoad', 'CPU load')}</div>
    <div class="two">${sensorSelect('gpuTemp', 'GPU temperature')}${sensorSelect('gpuLoad', 'GPU load')}</div>
  </div>`;
}

function renderAio() {
  const aios = aioDevices();
  view.innerHTML = aios.length
    ? `<div class="cards">${aios.map(aioCard).join('')}</div><p class="footnote">Automatic leaves the AIO to manage itself and doesn't stop the pump. Fixed pump speeds stop at ${MIN_PUMP}% here, and the AIO may run its pump faster than that to stay safe.</p>`
    : '<div class="card empty">No AIO connected.</div>';
}

function aioSpeedBody(kind, value, fallback) {
  if (value === 'auto') return { [kind]: { mode: 'auto' } };
  if (value === 'mb') return { [kind]: { mode: 'mb' } };
  if (value === 'constant') return { [kind]: { mode: 'constant', percent: fallback } };
  return { [kind]: { mode: 'curve', curve: value.slice(6) } };
}

// Lights ------------------------------------------------------------------

function effectParams(device, mode) {
  return device.rgbParams.find((item) => item.mode === mode) || null;
}

// Effects as buttons when there are only a few, else a list.
const EFFECT_BUTTONS_MAX = 12;
function effectPicker(modes, current) {
  if (modes.length > EFFECT_BUTTONS_MAX) {
    return `<label style="margin-top:0">Effect<select data-rgb-mode>${modes.map((mode) => option(mode, spaced(mode), mode === current)).join('')}</select></label>`;
  }
  return `<div class="label-text">Effect</div><input type="hidden" data-rgb-mode value="${esc(current)}">
    <div class="chips" role="group" aria-label="Effect">${modes.map((mode) => `<button type="button" class="chip" data-rgb-pick="${esc(mode)}" aria-pressed="${mode === current}">${esc(spaced(mode))}</button>`).join('')}</div>`;
}

// A five-step slider (0 to 4) that names its level, for brightness and speed.
function levelSlider(title, attr, names, level) {
  return `<label><span class="slider-label"><span>${esc(title)}</span><span data-out>${esc(names[level] ?? '')}</span></span><input type="range" min="0" max="4" step="1" value="${level}" ${attr} data-names="${esc(names.join('|'))}"></label>`;
}

// Colours picked recently on this browser, to reuse with one click.
const RECENT_KEY = 'lianli.recentColors';
function loadRecent() {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(saved) ? saved.filter((value) => /^#[0-9a-f]{6}$/i.test(value)).slice(0, 8) : [];
  } catch {
    return [];
  }
}
function rememberColor(value) {
  const list = [value.toLowerCase(), ...loadRecent().filter((item) => item !== value.toLowerCase())].slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private windows can block storage; recent colours just won't show.
  }
}
function recentColors() {
  const list = loadRecent();
  if (!list.length) return '';
  return `<div class="recent"><span class="muted">Recent</span>${list.map((value) => `<button type="button" class="recent-dot" data-recent="${value}" style="background:${value}" aria-label="Use ${value}" title="Use ${value}"></button>`).join('')}</div>`;
}
let lastColorInput = null;

function renderLights() {
  const lights = data.devices.filter((device) => device.hasRgb && !device.unbound);
  let html = syncNotice();
  if (data.status.lightsOff) html += '<div class="card notice">A schedule has the lights off right now. They come back when it ends.</div>';
  if (lights.length > 1 && !data.status.lightsOff) html += '<div class="toolbar"><button class="btn" id="lightsOff">Turn all lights off</button></div>';
  html += lights.length ? `<div class="cards">${lights.map((device) => {
    const effect = device.effect || { mode: device.rgbModes[0] || 'Off', colors: [[255, 255, 255]], brightness: 4, speed: 2 };
    const modes = device.rgbModes.includes(effect.mode) ? device.rgbModes : [effect.mode, ...device.rgbModes];
    const params = effectParams(device, effect.mode);
    const colorCount = COLOR_FREE.has(effect.mode) ? 0 : Math.min(params ? params.max_colors : 1, 4);
    const colors = Array.from({ length: colorCount }, (_, index) => effect.colors?.[index] || effect.colors?.[0] || [255, 255, 255]);
    const directions = params?.directions || [];
    const canSpeed = params ? params.supports_speed : !COLOR_FREE.has(effect.mode) && effect.mode !== 'Static';
    if (device.lighting?.motherboard) return motherboardCard(device);
    return `<div class="card" data-device="${esc(device.id)}">
      <div class="card-head"><h2>${esc(device.name)}</h2>${colors.length ? `<span class="dots" aria-hidden="true">${colors.map((color) => `<i style="background:${hex(color)}"></i>`).join('')}</span>` : ''}</div>
      ${effectPicker(modes, effect.mode)}
      ${colors.length ? `<div class="colors">${colors.map((color, index) => `<label>${colors.length > 1 ? `Colour ${index + 1}` : 'Colour'}<input type="color" data-rgb-color value="${hex(color)}"></label>`).join('')}</div>${recentColors()}` : ''}
      <div class="two">
        ${levelSlider('Brightness', 'data-rgb-brightness', ['20%', '40%', '60%', '80%', '100%'], effect.brightness ?? 4)}
        ${canSpeed ? levelSlider('Speed', 'data-rgb-speed', ['Slowest', 'Slow', 'Medium', 'Fast', 'Fastest'], effect.speed ?? 2) : ''}
      </div>
      ${directions.length > 1 ? `<label>Direction<select data-rgb-direction>${directions.map((item) => option(item, spaced(item), item === effect.direction)).join('')}</select></label>` : ''}
      <div class="actions"><button class="btn" data-rgb-all>Use on all fans</button></div>
      ${lightingMore(device)}
    </div>`;
  }).join('')}</div>` : '<div class="card empty">No paired lighting found.</div>';
  if (lights.length) {
    html += `<div class="card"><div class="card-head"><h2>Saved setups</h2></div>
      ${data.profiles.length ? data.profiles.map((profile) => `<div class="row"><span>${esc(profile.name)}<br><span class="muted">${esc(data.devices.find((device) => device.id === profile.deviceId)?.name || 'Device not connected')}</span></span>
        <span class="row-actions"><button class="btn" data-profile-apply="${esc(profile.name)}" data-for="${esc(profile.deviceId)}">Apply</button><button class="btn danger" data-profile-delete="${esc(profile.name)}">Delete</button></span></div>`).join('') : '<span class="empty">Save a fan group\'s lights, fan speed and screen under a name, and bring them back later.</span>'}
      <div class="two"><label>Group<select id="profileDevice">${lights.map((device) => option(device.id, device.name)).join('')}</select></label>
      <label>Name<input type="text" maxlength="40" id="profileName"></label></div>
      <div class="actions"><button class="btn primary" id="profileSave">Save setup</button></div>
    </div>`;
    html += quickSyncCard() + openRgbCard();
  }
  view.innerHTML = html;
}

// Screens -----------------------------------------------------------------

function screenValue(device) {
  const screen = data.settings.screens[device.id];
  if (!screen) return 'keep';
  if (screen.kind === 'color') return 'color';
  if (screen.kind === 'sensor') return 'sensor';
  return screen.kind === 'template' ? `template:${screen.templateId}` : `media:${screen.path}`;
}

// The family a generated screen belongs to, so an LCD can pick the screen and
// its pool or sensor separately.
function familyOf(templateId) {
  return data.screenFamilies.find((family) => family.choices.some((choice) => choice.id === templateId)) || null;
}

function shownScreenValue(device) {
  const value = screenValue(device);
  if (!value.startsWith('template:')) return value;
  const family = familyOf(value.slice(9));
  return family ? `template:${family.choices[0].id}` : value;
}

function screenVariant(device, screen) {
  if (screen?.kind !== 'template') return '';
  const family = familyOf(screen.templateId);
  if (!family || family.choices.length < 2) return '';
  return `<label>${esc(family.choiceLabel)}<select data-screen-variant="${esc(device.id)}">
    ${family.choices.map((choice) => option(choice.id, choice.name, choice.id === screen.templateId)).join('')}
  </select></label>`;
}

function screenOptions(device, screen) {
  const groups = ['Unraid', 'System'].map((group) => `<optgroup label="${group}">${data.screenFamilies.filter((family) => family.group === group)
    .map((family) => option(`template:${family.choices[0].id}`, family.name)).join('')}</optgroup>`);
  // A screen for a sensor or pool that's gone stays visible until it's changed.
  const known = screen?.kind !== 'template' || familyOf(screen.templateId) || data.designs.some((item) => item.id === screen.templateId);
  return `${groups.join('')}${known ? '' : option(`template:${screen.templateId}`, 'Earlier screen')}`;
}

function draftColors() {
  const { keys, presets } = data.themes;
  const source = themeDraft.theme === 'custom' ? themeDraft.customColors : presets[themeDraft.theme];
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}

function themePreview(id) {
  return `/api/preview?id=${encodeURIComponent(id)}&colors=${encodeURIComponent(JSON.stringify(draftColors()))}`;
}

function swatch(key, label, colors) {
  return `<button class="swatch" data-theme-pick="${esc(key)}" aria-pressed="${themeDraft.theme === key}">
    <i style="background:${hex(colors.background)};border-color:${hex(colors.good)}"></i>${esc(label)}</button>`;
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
  return `<div class="card" id="themeCard"><div class="card-head"><h2>Screen colours</h2></div>
    <div class="swatches" role="group" aria-label="Theme">
      ${Object.entries(presets).map(([key, preset]) => swatch(key, preset.label, preset)).join('')}
      ${swatch('custom', 'Custom', themeDraft.customColors)}
    </div>
    ${themeDraft.theme === 'custom' ? `<div class="colors">${keys.map((key) => `<label>${esc(COLOR_NAMES[key])}<input type="color" data-theme-color="${key}" value="${hex(themeDraft.customColors[key])}"></label>`).join('')}</div>` : ''}
    <div class="gallery pair">
      <figure><img id="themeA" alt="Drives screen in this theme" src="${esc(themePreview('unraid_drives'))}"><figcaption>Drives</figcaption></figure>
      <figure><img id="themeB" alt="Overview screen in this theme" src="${esc(themePreview('unraid_overview'))}"><figcaption>Overview</figcaption></figure>
    </div>
    <h3>When colours change</h3>
    <div class="two">${limit('tempWarn', 'Drive warning °C', 20, 65)}${limit('tempDanger', 'Drive danger °C', 20, 65)}</div>
    <div class="two">${limit('storageWarn', 'Storage warning %', 0, 100)}${limit('storageDanger', 'Storage danger %', 0, 100)}</div>
    <div class="two">${limit('cpuWarn', 'CPU and memory warning %', 0, 100)}${limit('cpuDanger', 'CPU and memory danger %', 0, 100)}</div>
    <div class="actions"><button class="btn primary" id="themeSave">Save colours</button></div>
    <p class="muted">Applies to the Unraid screens. Alert screens stay red so they always stand out.</p>
  </div>`;
}

function lcdThumb(device) {
  const screen = data.settings.screens[device.id];
  if (screen?.kind === 'template') {
    const own = data.settings.lcdThemes[device.id];
    const theme = own ? `&theme=${encodeURIComponent(own)}` : '';
    return `<img class="thumb" alt="" src="/api/preview?id=${encodeURIComponent(screen.templateId)}${theme}">`;
  }
  if (screen?.kind === 'color') return `<div class="thumb" style="background:${hex(screen.rgb)}"></div>`;
  if (screen?.kind === 'media') return '<div class="thumb">Your file</div>';
  if (screen?.kind === 'sensor') return '<div class="thumb">Gauge</div>';
  return '<div class="thumb">Not managed</div>';
}

function lcdCard(device) {
  const screen = data.settings.screens[device.id];
  const { presets } = data.themes;
  const own = data.settings.lcdThemes[device.id] || '';
  return `<div class="card" data-device="${esc(device.id)}">
    <div class="lcd-name">${esc(device.name)}</div>
    <div class="lcd-top">${lcdThumb(device)}
      <label>Shows
        <select data-screen="${esc(device.id)}">
          <option value="keep">Leave as it is</option>
          ${screenOptions(device, screen)}
          ${data.designs.length ? `<optgroup label="Your designs">${data.designs.map((item) => option(`template:${item.id}`, item.name)).join('')}</optgroup>` : ''}
          ${data.media.length ? `<optgroup label="Your media">${data.media.map((file) => option(`media:${file}`, fileName(file))).join('')}</optgroup>` : ''}
          <option value="sensor">Sensor gauge</option>
          <option value="color">Solid colour</option>
        </select></label>
    </div>
    ${screenVariant(device, screen)}
    ${screen?.kind === 'color' ? `<label>Colour<input type="color" data-solid value="${hex(screen.rgb)}"></label>` : ''}
    ${lcdMore(device, screen)}
    <label><span class="slider-label"><span>Brightness</span><span data-out>${device.brightness}%</span></span><input type="range" min="0" max="100" step="5" value="${device.brightness}" data-lcd-brightness></label>
    <div class="two">
      <label style="margin-top:6px">Rotation<select data-lcd-rotation>${[0, 90, 180, 270].map((angle) => option(angle, `${angle}°`, angle === device.orientation)).join('')}</select></label>
      <label style="margin-top:6px">Colours<select data-lcd-theme>
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
    html += `<div class="card notice"><b>No screens connected.</b><br><span class="muted">Each LCD fan needs its USB cable connected to the server. Screens appear here automatically afterwards. You can set everything below in the meantime.</span></div>`;
  } else {
    if (lcds.length > 1) html += '<div class="toolbar"><button class="btn" id="spread">Different stat on each fan</button></div>';
    html += `<div class="cards">${lcds.map(lcdCard).join('')}</div>`;
  }
  html += desktopModeCard() + designsCard() + themeCard();
  const uploaded = data.media.filter((file) => file.startsWith(`${data.uploadDir}/`));
  html += `<div class="card"><div class="card-head"><h2>Your images and videos</h2></div>
    ${uploaded.map((file) => `<div class="row"><span>${esc(fileName(file))}</span><button class="btn danger" data-media-delete="${esc(file)}">Delete</button></div>`).join('')}
    <label>Add a file (images, GIFs and videos, up to 512 MB)<input type="file" id="upload" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif,video/mp4,video/webm,video/quicktime,video/x-matroska,video/x-msvideo,.mkv,.avi"></label>
    <p class="muted" id="uploadNote">Files in the LCD media folder show up in the Shows list too.</p>
  </div>`;
  if (lcds.length) {
    const running = data.pixelClean[0];
    html += `<div class="card"><div class="card-head"><h2>Pixel cleaning</h2></div>
      <p class="muted" style="margin:0">Shows a moving pattern on the screens to reduce image retention.</p>
      ${running ? `<div class="row"><span>Running, ${Math.ceil(running.remaining_seconds / 60)} minutes left</span><button class="btn" id="pixelStop">Stop</button></div>`
    : `<div class="two"><label>Run for<select id="pixelMinutes">${[15, 30, 60, 120].map((minutes) => option(minutes, `${minutes} minutes`, minutes === 30)).join('')}</select></label>
         <div class="actions" style="align-self:end"><button class="btn" id="pixelStart">Start</button></div></div>`}
    </div>`;
  }
  const preview = (item) => `<figure><img loading="lazy" alt="${esc(item.name)} preview" src="/api/preview?id=${encodeURIComponent(item.id)}"><figcaption>${esc(item.name)}</figcaption></figure>`;
  html += `<div class="card"><div class="card-head"><h2>Unraid screens</h2></div>
    ${data.screenGroups.map((group) => `<details class="panel" ${panelAttrs(`gallery:${group.id}`, group.open)}><summary>${esc(group.name)}</summary><div class="gallery">${group.screens.map(preview).join('')}</div></details>`).join('')}
    <p class="muted">Previews may not show live values. Choose a screen in each LCD's Shows list. The Storage and Overview screens under All storage follow the Storage choice on the Status page.</p></div>`;
  html += catalogCard() + storageCleanupCard();
  view.innerHTML = html;
  lcds.forEach((device) => { view.querySelector(`[data-screen="${CSS.escape(device.id)}"]`).value = shownScreenValue(device); });
}

// Automation --------------------------------------------------------------

function scheduleCard(item, index) {
  const screens = [option('', "Don't change screen", !item.templateId)]
    .concat([...data.templates, ...data.designs].map((template) => option(template.id, template.name, item.templateId === template.id)));
  return `<div class="card" data-index="${index}">
    <div class="card-head"><h2>${esc(item.name)}</h2><button class="btn" data-remove>Remove</button></div>
    ${toggle('data-k="enabled"', 'On', item.enabled)}
    <label style="margin-top:6px">Name<input type="text" maxlength="40" data-k="name" value="${esc(item.name)}"></label>
    <div class="two">
      <label>From<input type="time" data-k="start" value="${esc(item.start)}"></label>
      <label>Until<input type="time" data-k="end" value="${esc(item.end)}"></label>
    </div>
    <label><span class="slider-label"><span>Screen brightness</span><span data-out>${item.brightness}%</span></span><input type="range" min="0" max="100" step="5" data-k="brightness" value="${item.brightness}"></label>
    <label style="margin-top:6px">Show<select data-k="templateId">${screens.join('')}</select></label>
    <div style="height:6px"></div>
    ${toggle('data-k="lightsOff"', 'Turn fan lights off too', item.lightsOff)}
    <label>Days (none picked means every day)</label>
    <div class="days">${DAYS.map((day, number) => `<label class="day"><input type="checkbox" data-day="${number}" ${item.days.includes(number) ? 'checked' : ''}><span>${day}</span></label>`).join('')}</div>
  </div>`;
}

function renderAuto() {
  const alerts = data.settings.alerts;
  if (!scheduleDirty) drafts = JSON.parse(JSON.stringify(data.settings.schedules));
  view.innerHTML = `<div class="card" id="alerts"><div class="card-head"><h2>Alerts on the screens</h2></div>
      ${toggle('id="aOn"', 'Take over all screens when something is wrong', alerts.enabled)}
      ${toggle('id="aDisk"', 'Disabled disks or read errors', alerts.diskProblem)}
      ${data.stats.hasArray ? toggle('id="aParity"', 'Parity errors', alerts.parityErrors) : `<input type="checkbox" id="aParity" hidden ${alerts.parityErrors ? 'checked' : ''}>`}
      ${toggle('id="aStorage"', 'Any pool nearly full', alerts.storageFull)}
      ${aioDevices().length ? toggle('id="aCoolant"', 'AIO coolant too hot', alerts.coolantHot) : ''}
      <div class="two">
        <label>Drive too hot at (°C)<input type="number" id="aTemp" min="30" max="70" value="${alerts.diskTempC}"></label>
        <label>Nearly full at (%)<input type="number" id="aStoragePct" min="50" max="100" value="${alerts.storagePct}"></label>
      </div>
      ${aioDevices().length ? `<label>Coolant too hot at (°C)<input type="number" id="aCoolantC" min="30" max="70" value="${alerts.coolantC}"></label>` : ''}
      <div class="actions"><button class="btn primary" id="aSave">Save alerts</button></div>
    </div>
    <div class="page-title"><h2>Schedules</h2></div>
    <div id="schedules" class="${drafts.length ? 'cards' : ''}">${drafts.map(scheduleCard).join('')}</div>
    ${drafts.length ? '' : '<div class="card empty">No schedules yet. Night mode dims the screens overnight.</div>'}
    <div class="actions"><button class="btn" id="addNight">Add night mode</button><button class="btn primary" id="sSave">Save schedules</button></div>
    <p class="footnote" style="margin-top:12px">Times use the server clock (${esc(data.timezone)}). Fan speeds aren't affected. An alert overrides any schedule's screen.</p>`;
}

// System ------------------------------------------------------------------

function deviceCard(device, screen) {
  const wireless = device.id.startsWith('wireless:');
  const parts = [device.model];
  if (device.serial) parts.push(device.serial);
  if (device.firmware) parts.push(`firmware ${device.firmware}`);
  // A fan's own screen shares its card and takes its name.
  if (screen) parts.push(`screen: ${[screen.model, screen.serial].filter(Boolean).join(', ')}`);
  const takeover = device.bindStatus === 'bind_other';
  const pairing = !wireless && !device.unbound ? ''
    : device.unbound || takeover
      ? `<button class="btn primary" data-pair="bind" ${takeover ? 'data-takeover' : ''} ${device.foreignOnline ? 'disabled' : ''}>${takeover ? 'Take over' : 'Pair'}</button>`
      : `${device.needsRebind ? '<button class="btn primary" data-pair="bind">Pair again</button>' : ''}<button class="btn danger" data-pair="unbind">Unpair</button>`;
  return `<div class="card" data-device="${esc(device.id)}">
    <label style="margin-top:0">Name<input type="text" maxlength="40" data-rename value="${esc(data.settings.names[device.id] || '')}" placeholder="${esc(device.model)}"></label>
    <p class="muted" style="margin-top:8px;overflow-wrap:anywhere">${esc(parts.join(', '))}</p>
    ${device.foreignOnline ? '<p class="warn">Paired to another controller that is switched on. Turn that controller off to pair it here.</p>' : ''}
    ${deviceReadings(device)}
    ${device.maxFanQuantity ? `<label>Fans on this port<select data-fan-quantity>${Array.from({ length: device.maxFanQuantity }, (_, index) => option(index + 1, index + 1, index + 1 === device.fanCount)).join('')}</select></label>` : ''}
    <div class="actions">${device.hasRgb || wireless ? '<button class="btn" data-identify>Identify</button>' : ''}${pairing}${wireless && device.hasLcd ? '<button class="btn" data-reboot>Restart screen</button>' : ''}</div>
  </div>`;
}

function healthCard() {
  const head = '<div class="card-head"><h2>Installation health</h2></div>';
  if (!health) return `<div class="card">${head}<span class="empty">Checking…</span></div>`;
  if (health.error) return `<div class="card">${head}<span class="empty">${esc(health.error)}</span></div>`;
  const failed = (health.findings || []).filter((item) => item.state === 'failed');
  return `<div class="card">${head}
    ${failed.length ? failed.map((item) => `<div class="row" style="display:block"><b class="${item.severity === 'error' ? 'bad' : item.severity === 'warning' ? 'warn' : ''}">${esc(item.title)}</b><br><span class="muted">${esc(item.remediation)}</span></div>`).join('') : '<span class="good">All checks passed.</span>'}
    <div class="actions"><button class="btn" id="healthRefresh">Check again</button></div></div>`;
}

// Fans first, in the order set on the Status page, each with its own screen
// folded in; then everything else.
function systemDeviceCards() {
  const shown = data.devices.filter((device) => !device.hidden);
  const fans = shown.filter((device) => device.hasFan);
  const screens = typeof fanScreens === 'function' ? fanScreens(fans) : new Map();
  const paired = new Set([...screens.values()].filter(Boolean).map((screen) => screen.id));
  const order = (typeof fanLayout === 'function' && fanLayout().order) || [];
  const rank = (device) => {
    const at = order.indexOf(device.id);
    return device.hasFan ? (at < 0 ? order.length : at) : order.length + 1;
  };
  return shown.filter((device) => !paired.has(device.id))
    .map((device, index) => ({ device, index }))
    .sort((a, b) => rank(a.device) - rank(b.device) || a.index - b.index)
    .map(({ device }) => deviceCard(device, screens.get(device.id)))
    .join('');
}

function renderSystem() {
  const settings = data.daemonSettings;
  const unbound = data.devices.filter((device) => device.unbound && !device.foreignOnline);
  let html = '<div class="page-title"><h2>Devices</h2></div>';
  if (unbound.length > 1) html += '<div class="toolbar"><button class="btn" id="pairAll">Pair all unpaired fans</button></div>';
  html += data.devices.length ? `<div class="cards">${systemDeviceCards()}</div>` : '<div class="card empty">No devices found.</div>';
  html += '<div class="split"><div>';
  if (settings) {
    html += `<div class="card"><div class="card-head"><h2>Settings</h2></div>
      ${toggle('data-setting="turnOffLcds"', 'Turn screens off when the container stops', settings.turnOffLcds)}
      ${toggle('data-setting="hardwareVideo"', 'Use hardware video decoding', settings.hardwareVideo)}
      ${toggle('data-setting="rgbDrift"', 'Keep fan lights in sync with their saved colours', settings.rgbDrift)}
      <label>Video frame rate (1 to 120)<input type="number" min="1" max="120" data-setting-fps value="${settings.defaultFps ?? ''}" placeholder="Default"></label>
      ${settingsMore(settings)}
    </div>`;
    html += thermalCard(settings);
  }
  html += `<div class="card"><div class="card-head"><h2>Backup</h2></div><p class="muted" style="margin:0 0 12px">Downloads the fan, lighting and screen settings plus this dashboard's settings as a JSON file.</p>
    <a class="btn" href="/api/export" download>Download settings</a></div>`;
  html += backupsCard();
  html += `</div><div>${healthCard()}${passwordCard()}${diagnosticsCard()}${updateCard()}${aboutCard()}</div></div>`;
  view.innerHTML = html;
}

const RENDER = { overview: renderOverview, fans: renderFans, aio: renderAio, lights: renderLights, screens: renderScreens, auto: renderAuto, system: renderSystem, designer: () => renderDesigner() };

function renderTabs() {
  const hasAio = aioDevices().length > 0 || tab === 'aio';
  shownTabs = String(hasAio);
  document.getElementById('tabs').innerHTML = TABS.filter(([id]) => id !== 'aio' || hasAio).map(([id, name]) => `<button role="tab" data-tab="${id}" aria-selected="${tab === id || (tab === 'designer' && id === 'screens')}">${icon(id)}<span>${name}</span></button>`).join('');
}

function interacting() {
  const active = document.activeElement;
  return (active && view.contains(active) && /^(INPUT|SELECT)$/.test(active.tagName))
    || chartHover
    || (tab === 'auto' && scheduleDirty)
    || (tab === 'fans' && curveDraft)
    || holds.some((hold) => hold());
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
    renderHealth();
    if (shownTabs !== String(aioDevices().length > 0 || tab === 'aio')) renderTabs();
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
    toast('Files can be up to 512 MB', true);
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
    toast(error.message, true);
  }
  refresh(true);
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const id = event.target.closest('[data-tab]')?.dataset.tab;
  if (!id) return;
  tab = id;
  chartHover = false;
  renderTabs();
  window.scrollTo(0, 0);
  if (tab === 'system' && !health) loadHealth();
  if (tab === 'overview') loadHistory();
  if (data) RENDER[tab]();
});

view.addEventListener('input', (event) => {
  const target = event.target;
  if (target.matches('[data-fan-speed], [data-k="brightness"], [data-lcd-brightness], [data-aio-speed], [data-aio-brightness]')) {
    target.closest('label').querySelector('[data-out]').textContent = `${target.value}%`;
  }
  if (target.closest('#schedules')) scheduleDirty = true;
  if (target.dataset.curve) curveDraft[target.dataset.curve] = target.value;
  if (target.dataset.point !== undefined) {
    curveDraft.points[Number(target.dataset.point)][Number(target.dataset.part)] = target.value === '' ? NaN : Number(target.value);
    document.getElementById('curvePreview').innerHTML = curveChart(curveDraft.points);
  }
  if (target.dataset.show !== undefined) target.closest('label').querySelector('[data-out]').textContent = `${target.value}${target.dataset.show}`;
  if (target.dataset.names) target.closest('label').querySelector('[data-out]').textContent = target.dataset.names.split('|')[Number(target.value)] || '';
  if (target.matches('[data-rgb-color]')) lastColorInput = target;
  if (target.dataset.limit) themeDraft.limits[target.dataset.limit] = Number(target.value);
  if (target.dataset.themeColor) themeDraft.customColors[target.dataset.themeColor] = rgbOf(target.value);
});

view.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[data-fan-mode]')) {
    if (fanModeChange(target)) return;
    const body = { device_id: deviceOf(target) };
    leaveSlots(body.device_id);
    if (target.value === 'constant') Object.assign(body, { mode: 'constant', percent: 60 });
    else Object.assign(body, { mode: 'curve', curve: target.value.slice(6) });
    target.blur();
    act('/api/fan', body);
  } else if (target.matches('[data-fan-speed]')) {
    target.blur();
    act('/api/fan', { device_id: deviceOf(target), mode: 'constant', percent: Number(target.value) });
  } else if (target.matches('[data-rgb-mode], [data-rgb-color], [data-rgb-brightness], [data-rgb-speed], [data-rgb-direction]')) {
    if (target.matches('[data-rgb-color]')) rememberColor(target.value);
    target.blur();
    act('/api/rgb', rgbBody(target.closest('[data-device]')));
  } else if (target.dataset.aioMode) {
    const kind = target.dataset.aioMode;
    target.blur();
    act('/api/aio', { device_id: deviceOf(target), ...aioSpeedBody(kind, target.value, kind === 'pump' ? 70 : 60) });
  } else if (target.dataset.aioSpeed) {
    target.blur();
    act('/api/aio', { device_id: deviceOf(target), [target.dataset.aioSpeed]: { mode: 'constant', percent: Number(target.value) } });
  } else if (target.dataset.aioSensor) {
    target.blur();
    act('/api/aio', { device_id: deviceOf(target), sensors: { [target.dataset.aioSensor]: target.value || null } });
  } else if (target.dataset.aioColor) {
    target.blur();
    act('/api/aio', { device_id: deviceOf(target), colors: { [target.dataset.aioColor]: rgbOf(target.value) } });
  } else if (target.matches('[data-aio-brightness], [data-aio-theme], [data-aio-rotation], [data-aio-loop]')) {
    const field = target.matches('[data-aio-brightness]') ? 'brightness' : target.matches('[data-aio-theme]') ? 'theme' : target.matches('[data-aio-rotation]') ? 'rotation' : 'loopInterval';
    target.blur();
    act('/api/aio', { device_id: deviceOf(target), [field]: Number(target.value) });
  } else if (target.matches('[data-storage]')) {
    target.blur();
    act('/api/storage', { volume: target.value });
  } else if (target.dataset.screenVariant) {
    target.blur();
    act('/api/screen', { device_id: target.dataset.screenVariant, screen: { kind: 'template', templateId: target.value } });
  } else if (target.matches('[data-screen]')) {
    const [kind, ...rest] = target.value.split(':');
    const value = rest.join(':');
    let screen = { kind };
    if (kind === 'template') screen = { kind, templateId: value };
    else if (kind === 'media') screen = { kind, path: value };
    else if (kind === 'color') screen = { kind, rgb: [0, 0, 0] };
    else if (kind === 'sensor') screen = { kind, sensor: newGauge() };
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
  if (set.rgbPick !== undefined || set.recent !== undefined) {
    const card = target.closest('[data-device]');
    const input = set.recent !== undefined
      ? (lastColorInput && card.contains(lastColorInput) ? lastColorInput : card.querySelector('[data-rgb-color]'))
      : card.querySelector('[data-rgb-mode]');
    if (!input) return;
    input.value = set.recent ?? set.rgbPick;
    if (set.rgbPick !== undefined) card.querySelectorAll('[data-rgb-pick]').forEach((chip) => chip.setAttribute('aria-pressed', String(chip === target)));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  if (set.mute !== undefined) {
    act('/api/alerts/mute', { hours: Number(set.mute) });
  } else if (target.matches('[data-fan-all]')) {
    const card = target.closest('[data-device]');
    const mode = card.querySelector('[data-fan-mode]').value;
    const speed = card.querySelector('[data-fan-speed]');
    const header = card.querySelector('[data-fan-header]')?.value;
    const body = mode === 'mb' ? { mode, header } : mode === 'constant' ? { mode, percent: Number(speed?.value ?? 60) } : { mode: 'curve', curve: mode.slice(6) };
    actOnAll(data.devices.filter((device) => device.hasFan && !device.unbound && !device.isAio && !device.hidden), (device) => post('/api/fan', { ...body, device_id: device.id }));
  } else if (target.matches('[data-coolant-curve]')) {
    const wanted = JSON.stringify({ type: 'wireless_coolant', device_id: deviceOf(target) });
    const coolantSensor = data.sensors.find((sensor) => sensor.id === wanted);
    if (!coolantSensor) {
      toast("This AIO isn't reporting coolant temperature yet", true);
      return;
    }
    tab = 'fans';
    renderTabs();
    window.scrollTo(0, 0);
    newCurve(coolantSensor.id);
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
      toast(error.message, true);
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
  } else if (set.themePick) {
    themeDraft.theme = set.themePick;
    view.querySelectorAll('[data-theme-pick]').forEach((button) => button.setAttribute('aria-pressed', button === target));
    renderScreens();
  } else if (target.id === 'themeSave') {
    const body = { theme: themeDraft.theme, limits: themeDraft.limits };
    if (themeDraft.theme === 'custom') body.customColors = themeDraft.customColors;
    try {
      await post('/api/theme', body);
      themeDraft = null;
      toast('Saved');
    } catch (error) {
      toast(error.message, true);
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
      coolantHot: document.getElementById('aCoolant')?.checked,
      coolantC: document.getElementById('aCoolantC') ? Number(document.getElementById('aCoolantC').value) : undefined,
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
      toast(error.message, true);
    }
    refresh(true);
  } else if (set.pair) {
    if (set.pair === 'unbind' && !window.confirm('Unpair this fan group? It stops responding here until you pair it again.')) return;
    if (set.takeover !== undefined && !window.confirm('This device is paired to another controller. Take it over?')) return;
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

