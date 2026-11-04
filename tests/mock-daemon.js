'use strict';

// Stand-in for lianli-daemon that follows the rules of its IPC server: JSON
// lines, and writes rejected unless wrapped in a matching Guarded request.

const net = require('net');

const READ_ONLY = new Set([
  'GetDaemonInfo', 'ListDevices', 'GetConfig', 'GetTelemetry', 'GetRgbCapabilities',
  'GetLcdTemplates', 'RenderTemplatePreview', 'ListSensors', 'ListDeviceProfiles',
  'GetInstallationHealth', 'GetWirelessOperation', 'GetPixelCleanPreparation',
]);
// A one pixel JPEG, enough for an <img> to load.
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z';

function createMockDaemon({ lcds = 3 } = {}) {
  const state = {
    info: { version: '1.2.3', protocol_version: 1, instance_id: 'instance-1', pid: 1, mode: 'system', capabilities: ['guarded_writes'] },
    templates: [{ id: 'user_made', name: 'Mine', base_width: 400, base_height: 400, background: { type: 'color', rgb: [0, 0, 0, 255] }, widgets: [], rotated: false }],
    config: {
      lcds: [],
      fan_curves: [{ name: 'Quiet', curve: [[30, 25], [70, 100]] }],
      fans: { speeds: [], update_interval_ms: 1000 },
      rgb: { enabled: true, devices: [] },
    },
    brightness: {},
    effects: [],
    writes: [],
    profiles: [],
    pings: [],
    binds: [],
    bindResult: { status: 'succeeded', message: 'done' },
    pixel: { needsPreparation: false, active: false, prepared: false },
    sensors: [
      { source: { type: 'cpu_usage' }, sensor_name: { device_name: 'CPU', sensor_name: 'Usage' }, display_name: 'CPU usage', unit: '%', current_value: 5 },
      { source: { type: 'hwmon', name: 'k10temp', label: 'Tctl', device_path: '/x' }, sensor_name: { device_name: 'k10temp', sensor_name: 'Tctl' }, display_name: 'CPU temperature', unit: 'C', current_value: 40 },
      { source: { type: 'command', cmd: 'rm -rf /' }, sensor_name: { device_name: 'x', sensor_name: 'y' }, display_name: 'Someone else\'s command', unit: 'C', current_value: 1 },
    ],
  };
  const fans = ['1c:17:07:f5:10', 'f6:0b:07:f5:11', 'fc:24:07:f5:12'].map((mac) => ({
    device_id: `wireless:${mac}`, family: 'Tlv2Led', name: 'UNI FAN TL V3 Wireless LCD', serial: mac,
    has_lcd: false, has_fan: true, has_pump: false, has_rgb: true, fan_count: 3, rgb_zone_count: 3,
    is_unbound_wireless: false,
  }));
  const screens = Array.from({ length: lcds }, (_, index) => ({
    device_id: `usb:1-${index + 2}`, family: 'TlFlexLcd', name: `TL V3 LCD ${index + 1}`, serial: null,
    has_lcd: true, has_fan: false, has_pump: false, has_rgb: false, screen_width: 400, screen_height: 400,
  }));

  state.fans = fans;
  // Tests add AIOs here, with their readings in state.telemetry.
  state.extra = [];
  state.telemetry = { fan_rpms: {}, coolant_temps: {} };

  function handle(request) {
    const { method, params } = request;
    if (method === 'Guarded') {
      const expected = state.info;
      if (params.guard.instance_id !== expected.instance_id || params.guard.client_version !== expected.version
        || params.guard.protocol_version !== expected.protocol_version) {
        return { status: 'error', message: 'The daemon changed' };
      }
      state.writes.push(params.request);
      return apply(params.request);
    }
    if (!READ_ONLY.has(method)) return { status: 'error', message: 'Changes require a compatible client.' };
    return apply(request);
  }

  function apply({ method, params }) {
    const ok = (data = null) => ({ status: 'ok', data });
    switch (method) {
      case 'GetDaemonInfo': return ok(state.info);
      case 'ListDevices': return ok([...fans, ...screens, ...state.extra]);
      case 'GetConfig': return ok(state.config);
      case 'GetTelemetry': return ok({ fan_rpms: { [fans[0].device_id]: [1200, 1210, 1190], ...state.telemetry.fan_rpms }, coolant_temps: state.telemetry.coolant_temps });
      case 'GetRgbCapabilities': return ok(fans.map((fan) => ({
        device_id: fan.device_id,
        supported_modes: ['Off', 'Direct', 'Static', 'Rainbow', 'Breathing', 'Meteor'],
        sync_effect_parameters: [
          { mode: 'Static', min_colors: 1, max_colors: 1, per_fan_colors: false, directions: [], supports_speed: false },
          { mode: 'Meteor', min_colors: 1, max_colors: 4, per_fan_colors: false, directions: ['Clockwise', 'CounterClockwise'], supports_speed: true },
        ],
      })));
      case 'ListSensors': return ok(state.sensors);
      case 'ListDeviceProfiles': return ok(state.profiles);
      case 'SaveDeviceProfile': state.profiles.push({ name: params.name, device_id: params.device_id, device_family: 'Tlv2Led' }); return ok();
      case 'ApplyDeviceProfile': state.applied = params; return ok();
      case 'DeleteDeviceProfile': state.profiles = state.profiles.filter((item) => item.name !== params.name); return ok();
      case 'GetInstallationHealth': return ok({ findings: [{ code: 'x', state: 'failed', severity: 'warning', title: 'Example', remediation: 'Fix it' }] });
      case 'SetConfig': state.config = params.config; return ok();
      case 'PingDevice': state.pings.push(params); return ok();
      case 'BindWirelessDevice':
      case 'UnbindWirelessDevice':
        state.binds.push([method, params.mac]);
        return ok({ operation_id: 7, message: 'queued' });
      case 'GetWirelessOperation': return ok(state.bindResult);
      case 'StartPixelClean':
        if (state.pixel.needsPreparation && params.preparation_id === null) return ok({ started: false, session_id: 9 });
        if (state.pixel.needsPreparation && params.preparation_id !== 9) return { status: 'error', message: 'Wrong session' };
        state.pixel.active = true;
        return ok({ started: true, session_id: 9 });
      case 'GetPixelCleanPreparation': return ok({ ready: true, error: null });
      case 'StopPixelClean': state.pixel.active = false; return ok();
      case 'GetLcdTemplates': return ok(state.templates);
      case 'RenderTemplatePreview': return ok({ jpeg_base64: JPEG });
      case 'MergeLcdTemplates': {
        for (const copy of params.copies) {
          const index = state.templates.findIndex((item) => item.id === copy.id);
          const current = index === -1 ? undefined : state.templates[index];
          const original = params.originals.find((item) => item.id === copy.id);
          if (JSON.stringify(current) !== JSON.stringify(original)) return { status: 'error', message: 'Template changed' };
          if (index === -1) state.templates.push(copy);
          else state.templates[index] = copy;
        }
        return ok();
      }
      case 'SetLcdMedia': {
        const key = (lcd) => (lcd.serial ? `serial:${lcd.serial}` : `index:${lcd.index}`);
        if (params.config.type === 'custom' && !state.templates.some((item) => item.id === params.config.template_id)) {
          return { status: 'error', message: 'Unknown template' };
        }
        const index = state.config.lcds.findIndex((lcd) => key(lcd) === params.device_id);
        if (index === -1) state.config.lcds.push(params.config);
        else state.config.lcds[index] = params.config;
        return ok();
      }
      case 'SetLcdBrightness': state.brightness[params.device_id] = params.brightness; return ok({ accepted: true, applied: true });
      case 'SetFanConfig': state.config.fans = params.config; return ok();
      case 'SetRgbEffect': state.effects.push(params); return ok();
      case 'SetRgbConfig': state.config.rgb = params.config; return ok();
      default: return { status: 'error', message: `Unhandled ${method}` };
    }
  }

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        socket.write(`${JSON.stringify(handle(JSON.parse(line)))}\n`);
      }
    });
  });
  return { server, state };
}

module.exports = { createMockDaemon };
