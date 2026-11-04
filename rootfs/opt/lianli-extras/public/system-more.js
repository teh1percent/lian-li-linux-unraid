'use strict';

// System page additions: more settings, backups, diagnostics and update checks.

const BACKUP_LABELS = { configuration: 'Fan, lighting and screen settings', templates: 'Screen designs', rgb_presets: 'Lighting presets', profile: 'Saved setup' };
let backups = null;
let backupPreview = null;
let updateInfo = null;

function settingsMore(settings) {
  return `<label>USB backend<select data-hid-backend>
      ${option('hidraw', 'HIDRAW (recommended)', settings.hidBackend === 'hidraw')}
      ${option('rusb', 'LibUSB (direct)', settings.hidBackend === 'rusb')}
    </select></label>
    <label>Check lights every (ms)<input type="number" min="100" max="10000" step="100" data-drift-interval value="${settings.driftInterval}"></label>`;
}

function thermalCard(settings) {
  const part = (key, label) => {
    const item = settings.thermal[key];
    return `<div data-thermal="${key}">
      ${toggle('data-t="enabled"', `Flash lights when the ${label} is too hot`, item.enabled)}
      <div class="two">
        <label>${label} limit (°C)<input type="number" min="20" max="120" data-t="threshold" value="${item.threshold}"></label>
        <label>Alert colour<input type="color" data-t="color" value="${hex(item.alert_color)}"></label>
      </div></div>`;
  };
  return `<div class="card"><div class="card-head"><h2>Temperature alert on the lights</h2></div>${part('cpu', 'CPU')}${part('gpu', 'GPU')}</div>`;
}

function deviceReadings(device) {
  return device.rpms?.some((rpm) => rpm > 0) ? `<p class="muted num">${device.rpms.join(' / ')} RPM</p>` : '';
}

function backupName(entry) {
  const label = BACKUP_LABELS[entry.target.kind] || entry.target.kind;
  return entry.target.name ? `${label}: ${entry.target.name}` : label;
}

function backupPreviewForm() {
  const { entry, preview } = backupPreview;
  const blocked = preview.parse_error || preview.validation_error;
  return `<div class="zone"><h3>${esc(backupName(entry))}</h3>
    ${blocked ? `<p class="bad">${esc(blocked)}</p>` : ''}
    ${(preview.warnings || []).map((warning) => `<p class="warn">${esc(warning)}</p>`).join('')}
    <pre class="json">${esc(preview.json)}${preview.truncated ? '\n…' : ''}</pre>
    ${!entry.preserved && !blocked ? '<label class="check"><input type="checkbox" id="backupConfirm"> I reviewed this and want to replace my current settings</label>' : ''}
    <label class="check"><input type="checkbox" id="backupDeleteConfirm"> Delete this backup permanently</label>
    <div class="actions">
      ${!entry.preserved && !blocked ? '<button class="btn primary" id="backupRestore">Restore</button>' : ''}
      <button class="btn danger" id="backupDelete">Delete</button>
      <button class="btn" id="backupClose">Close</button>
    </div></div>`;
}

function backupsCard() {
  const head = '<div class="card-head"><h2>Restore a backup</h2></div>';
  if (!backups) return `<div class="card" id="backups">${head}<p class="muted" style="margin:0">The daemon keeps the previous version of its settings each time they change.</p><div class="actions"><button class="btn" id="backupFind">Find backups</button></div></div>`;
  return `<div class="card" id="backups">${head}
    ${backupPreview ? backupPreviewForm() : ''}
    ${backups.map((entry, index) => `<div class="row"><span>${esc(backupName(entry))}<br><span class="muted">${entry.preserved ? 'Before last restore' : 'Previous save'}, ${new Date(entry.modified_unix_seconds * 1000).toLocaleString()}</span>${entry.error ? `<br><span class="bad">${esc(entry.error)}</span>` : ''}</span>
      <button class="btn" data-backup="${index}" ${entry.error ? 'disabled' : ''}>Preview</button></div>`).join('') || '<p class="muted">No backups yet.</p>'}
  </div>`;
}

function diagnosticsCard() {
  return `<div class="card"><div class="card-head"><h2>Diagnostics</h2></div>
    <p class="muted" style="margin:0 0 12px">Downloads a report for troubleshooting: daemon details, health checks and recent log lines with paths and secrets removed. Check it before sharing it.</p>
    <a class="btn" href="/api/diagnostics" download>Download report</a></div>`;
}

function updateCard() {
  const result = !updateInfo ? ''
    : updateInfo.error ? `<p class="bad">${esc(updateInfo.error)}</p>`
      : updateInfo.updateAvailable ? `<p class="warn">Version ${esc(updateInfo.latest)} is out. You're on ${esc(updateInfo.current)}. It arrives once this container's image is rebuilt with it.</p>`
        : `<p class="good">You're on the latest version (${esc(updateInfo.current)}).</p>`;
  return `<div class="card"><div class="card-head"><h2>Updates</h2></div>${result}
    <p class="muted" style="margin:0 0 12px">Checks GitHub for a newer Lian Li Linux release.</p>
    <button class="btn" id="updateCheck">Check for updates</button></div>`;
}

async function loadBackups() {
  const response = await fetch('/api/backups');
  if (!response.ok) throw await failure(response);
  backups = await response.json();
}

holds.push(() => tab === 'system' && backupPreview !== null);

view.addEventListener('change', (event) => {
  const { target } = event;
  if (target.matches('[data-hid-backend]')) {
    target.blur();
    if (window.confirm('Changing this restarts the daemon, so fans and screens may pause for a moment. Continue?')) act('/api/settings', { hidBackend: target.value });
    else renderSystem();
  } else if (target.matches('[data-drift-interval]')) {
    target.blur();
    act('/api/settings', { driftInterval: Number(target.value) });
  } else if (target.dataset.t) {
    const element = target.closest('[data-thermal]');
    const read = (key) => element.querySelector(`[data-t="${key}"]`);
    target.blur();
    act('/api/settings', { thermal: { [element.dataset.thermal]: { enabled: read('enabled').checked, threshold: Number(read('threshold').value), color: rgbOf(read('color').value) } } });
  }
});

view.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  const set = target.dataset;
  try {
    if (target.id === 'backupFind') {
      await loadBackups();
      renderSystem();
    } else if (set.backup !== undefined) {
      const entry = backups[Number(set.backup)];
      const response = await fetch('/api/backups/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lianli-Dashboard': '1' }, body: JSON.stringify({ target: entry.target, preserved: entry.preserved }) });
      if (!response.ok) throw await failure(response);
      backupPreview = { entry, preview: await response.json() };
      renderSystem();
    } else if (target.id === 'backupClose') {
      backupPreview = null;
      renderSystem();
    } else if (target.id === 'backupRestore') {
      if (!document.getElementById('backupConfirm').checked) {
        toast('Tick the box to confirm', true);
        return;
      }
      await post('/api/backups/restore', { target: backupPreview.entry.target, sha256: backupPreview.preview.sha256 });
      backupPreview = null;
      await loadBackups();
      toast('Restored');
      await refresh(true);
    } else if (target.id === 'backupDelete') {
      if (!document.getElementById('backupDeleteConfirm').checked) {
        toast('Tick the delete box to confirm', true);
        return;
      }
      const { entry, preview } = backupPreview;
      await post('/api/backups/delete', { target: entry.target, preserved: entry.preserved, sha256: preview.sha256 });
      backupPreview = null;
      await loadBackups();
      toast('Deleted');
      renderSystem();
    } else if (target.id === 'updateCheck') {
      target.disabled = true;
      const response = await fetch('/api/update');
      if (!response.ok) throw await failure(response);
      updateInfo = await response.json();
      renderSystem();
    } else if (set.reboot !== undefined) {
      if (window.confirm('Restart this screen?')) act('/api/device', { device_id: deviceOf(target), action: 'reboot' }, 'Restarting');
    }
  } catch (error) {
    toast(error.message, true);
  }
});
