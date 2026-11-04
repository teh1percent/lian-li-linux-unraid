'use strict';

// Fan page additions: a speed per fan, motherboard sync and curve smoothing.

const MB_SYNC = '__mb_sync__';
const slotsOpen = new Set();
const isMbSpeed = (speed) => typeof speed === 'string' && speed.startsWith(MB_SYNC);

function fanMode(device) {
  const speeds = device.speeds || [];
  if (speeds.some(isMbSpeed)) return 'mb';
  if (slotsOpen.has(device.id) || speeds.some((speed) => speed !== speeds[0])) return 'slots';
  return 'single';
}

function canFollowBoard(device) {
  return device.mbHardware || data.pwmHeaders.length > 0;
}

function fanModeOptions(device, mode) {
  return [
    device.speeds.length > 1 || device.fanCount > 1 ? option('slots', 'Set each fan separately', mode === 'slots') : '',
    canFollowBoard(device) || mode === 'mb' ? option('mb', 'Follow the motherboard', mode === 'mb') : '',
  ];
}

function slotRow(device, speed, index) {
  const fixed = typeof speed === 'number';
  const percent = fixed ? Math.max(MIN_FAN, Math.round(speed / 2.55)) : 60;
  return `<div class="slot" data-slot="${index}">
    <label>${device.perFan ? 'Fan' : 'Port'} ${index + 1}<select data-slot-mode>
      ${option('constant', 'Fixed speed', fixed)}
      ${data.curves.map((curve) => option(`curve:${curve}`, `Curve: ${curve}`, speed === curve)).join('')}
    </select></label>
    ${fixed ? `<label><span class="slider-label"><span>Speed</span><span data-out>${percent}%</span></span><input type="range" min="${MIN_FAN}" max="100" step="5" value="${percent}" data-slot-speed data-show="%"></label>` : ''}
  </div>`;
}

function fanModeDetail(device, mode) {
  if (mode === 'slots') {
    const count = Math.max(Math.min(device.fanCount || 4, 4), 1);
    return Array.from({ length: count }, (_, index) => slotRow(device, device.speeds[index] ?? 153, index)).join('');
  }
  if (mode !== 'mb' || device.mbHardware) return mode === 'mb' ? '<p class="muted">The motherboard sets this group\'s speed directly.</p>' : '';
  const current = (device.speeds[0] || '').split(':')[1] || '';
  return `<label>Motherboard fan header<select data-fan-header>
    ${data.pwmHeaders.map((header) => option(header.id, header.label, header.id === current)).join('')}
    ${data.pwmHeaders.some((header) => header.id === current) ? '' : `<option value="${esc(current)}" selected disabled>${current ? `${esc(current)} (not found)` : 'Choose a header'}</option>`}
  </select></label>
  <p class="muted">These can be renumbered when the server restarts, so check this after a reboot.</p>`;
}

function leaveSlots(deviceId) {
  slotsOpen.delete(deviceId);
}

function slotBody(card) {
  return {
    device_id: card.dataset.device,
    slots: [...card.querySelectorAll('[data-slot]')].map((row) => {
      const mode = row.querySelector('[data-slot-mode]').value;
      return mode === 'constant'
        ? { mode, percent: Number(row.querySelector('[data-slot-speed]')?.value ?? 60) }
        : { mode: 'curve', curve: mode.slice(6) };
    }),
  };
}

// Returns true when the mode was one of the ones handled here.
function fanModeChange(select) {
  const deviceId = deviceOf(select);
  const device = data.devices.find((item) => item.id === deviceId);
  select.blur();
  if (select.value === 'slots') {
    slotsOpen.add(deviceId);
    renderFans();
    return true;
  }
  if (select.value !== 'mb') return false;
  leaveSlots(deviceId);
  if (device.mbHardware) act('/api/fan', { device_id: deviceId, mode: 'mb' });
  else act('/api/fan', { device_id: deviceId, mode: 'mb', header: data.pwmHeaders[0]?.id });
  return true;
}

function fanTuningCard() {
  const tuning = data.fanTuning;
  if (!tuning) return '';
  return `<div class="card"><div class="card-head"><h2>Curve smoothing</h2></div>
    <p class="muted" style="margin:0">Fans hold their speed until the change is bigger than both of these, which stops them hunting up and down around a curve point.</p>
    <div class="two">
      <label>Ignore temperature changes under (°C)<input type="number" min="0" max="10" step="0.1" data-tuning="hysteresisTemp" value="${tuning.hysteresisTemp}"></label>
      <label>Ignore speed changes under (%)<input type="number" min="0" max="19.6" step="0.1" data-tuning="hysteresisPercent" value="${tuning.hysteresisPercent}"></label>
    </div>
    <label>Update every (ms)<input type="number" min="100" max="10000" step="100" data-tuning="updateIntervalMs" value="${tuning.updateIntervalMs}"></label>
  </div>`;
}

view.addEventListener('change', (event) => {
  const { target } = event;
  if (target.matches('[data-slot-mode], [data-slot-speed]')) {
    target.blur();
    act('/api/fan', slotBody(target.closest('[data-device]')));
  } else if (target.matches('[data-fan-header]')) {
    target.blur();
    act('/api/fan', { device_id: deviceOf(target), mode: 'mb', header: target.value });
  } else if (target.dataset.tuning) {
    target.blur();
    act('/api/fan/tuning', { [target.dataset.tuning]: Number(target.value) });
  } else if (target.matches('[data-fan-quantity]')) {
    target.blur();
    act('/api/fan/quantity', { device_id: deviceOf(target), quantity: Number(target.value) });
  }
});
