'use strict';

// Sensor sources for LCD widgets and gauges. The daemon runs a `command` source
// as shell, so the only command accepted here reads one of our own stat files.

const { check, isInt, isNumber, isText } = require('./check');

const NAME = /^[\w.:@-]{1,64}$/;
const PLAIN = new Set(['cpu_usage', 'mem_usage', 'mem_used', 'mem_free']);

function cleanSource(source, statsDir) {
  check(source && typeof source === 'object', 'Choose a sensor');
  const { type } = source;
  if (PLAIN.has(type)) return { type };
  switch (type) {
    case 'constant':
      check(isNumber(source.value), 'Invalid fixed value');
      return { type, value: source.value };
    case 'command': {
      const prefix = `cat ${statsDir}/`;
      const key = isText(source.cmd, 256) && source.cmd.startsWith(prefix) ? source.cmd.slice(prefix.length) : '';
      check(/^[a-z0-9_]+$/.test(key), 'Custom commands can only be set up by editing the daemon files');
      return { type, cmd: source.cmd };
    }
    case 'hwmon':
      check(isText(source.name, 128) && isText(source.label ?? '', 128) && isText(source.device_path ?? '', 512), 'Invalid sensor');
      return { type, name: source.name, label: source.label ?? '', device_path: source.device_path ?? '' };
    case 'nvidia_gpu':
      check(isInt(source.gpu_index ?? 0, 0, 64) && (source.metric === 'temp' || source.metric === 'usage'), 'Invalid sensor');
      return { type, gpu_index: source.gpu_index ?? 0, metric: source.metric };
    case 'amd_gpu_usage':
      check(isInt(source.card_index ?? 0, 0, 64), 'Invalid sensor');
      return { type, card_index: source.card_index ?? 0 };
    case 'wireless_coolant':
      check(isText(source.device_id, 256) && source.device_id, 'Invalid sensor');
      return { type, device_id: source.device_id };
    case 'network_rx':
    case 'network_tx':
      check(NAME.test(source.iface || ''), 'Invalid network interface');
      return { type, iface: source.iface };
    case 'disk_read':
    case 'disk_write':
      check(NAME.test(source.device || ''), 'Invalid disk');
      return { type, device: source.device };
    default:
      return check(false, 'Unknown sensor');
  }
}

// The daemon lists rates in a different shape from the one screens store.
function toScreenSource(source) {
  if (source?.type === 'network_rate') return { type: source.direction === 'tx' ? 'network_tx' : 'network_rx', iface: source.iface };
  if (source?.type === 'disk_rate') return { type: source.direction === 'write' ? 'disk_write' : 'disk_read', device: source.device };
  return source;
}

function statSources(statsDir, volumes = []) {
  const stat = (key, name, unit) => ({ id: JSON.stringify({ type: 'command', cmd: `cat ${statsDir}/${key}` }), name, unit });
  return [
    stat('disk_temp_max', 'Hottest drive', '°C'),
    stat('disk_temp_avg', 'Average drive temperature', '°C'),
    stat('storage_used_pct', 'Storage used', '%'),
    ...volumes.flatMap((volume) => [
      stat(`volume_${volume.key}_temp_max`, `Hottest drive in ${volume.name}`, '°C'),
      stat(`volume_${volume.key}_used_pct`, `${volume.name} used`, '%'),
    ]),
  ];
}

const SENSOR_UNITS = { C: '°C', '%': '%' };

function sourceOptions(listed, statsDir, volumes) {
  const hardware = (listed || [])
    .filter((sensor) => sensor.source && sensor.source.type !== 'command')
    .map((sensor) => ({
      id: JSON.stringify(toScreenSource(sensor.source)),
      name: sensor.display_name || `${sensor.sensor_name?.device_name || 'Sensor'}: ${sensor.sensor_name?.sensor_name || ''}`,
      unit: SENSOR_UNITS[sensor.unit] ?? sensor.unit ?? '',
    }));
  return [...statSources(statsDir, volumes), ...hardware];
}

module.exports = { cleanSource, toScreenSource, sourceOptions };
