'use strict';

// Reads Unraid's array state from the files emhttp keeps in /var/local/emhttp.
// Temperatures come from disks.ini rather than smartctl, so sleeping drives are
// never woken. The results are written as one small file per value because LCD
// and fan sensor commands have a 1 second limit: they only `cat` these files.

const fs = require('fs');
const path = require('path');

const ARRAY_TYPES = new Set(['Data', 'Parity', 'Cache']);
const BAD_STATUS = new Set(['DISK_DSBL', 'DISK_DSBL_NEW', 'DISK_INVALID', 'DISK_WRONG', 'DISK_NP_MISSING']);
const KB_PER_TB = 1024 ** 3;

const EMPTY_VALUES = {
  disk_temp_max: 0,
  disk_temp_avg: 0,
  disks_active: 0,
  disks_total: 0,
  disk_errors: 0,
  disks_bad: 0,
  storage_used_pct: 0,
  storage_free_tb: 0,
  volume_max_used_pct: 0,
  array_used_pct: 0,
  array_free_tb: 0,
  cache_used_pct: 0,
  parity_errors: 0,
  sync_pct: 0,
  array_started: 0,
};

function parseIni(text) {
  const sections = {};
  const root = {};
  let current = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const header = line.match(/^\[\s*"?([^"\]]*)"?\s*\]$/);
    if (header) {
      current = {};
      sections[header[1]] = current;
      continue;
    }
    const pair = line.match(/^([^=]+)=(.*)$/);
    if (pair) current[pair[1].trim()] = pair[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return { root, sections };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value, places = 1) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

const usedPct = ({ size, free }) => (size > 0 ? ((size - free) / size) * 100 : 0);

// Names become file names in sensor commands, which the daemon runs as shell.
const volumeKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9_-]/g, '_');

const hottest = (list) => {
  const temps = list.map((disk) => Number(disk.temp)).filter((temp) => Number.isFinite(temp) && temp > 0);
  return temps.length ? Math.max(...temps) : 0;
};

// Members of a pool are named after it (tank, tank2, tank3). They describe one
// filesystem, so a pool counts once, using the member that reports its size.
function poolsOf(disks) {
  const pools = new Map();
  for (const disk of disks) {
    if (disk.type !== 'Cache') continue;
    const name = (disk.name || disk.id).replace(/~.*$/, '').replace(/\d+$/, '');
    const pool = pools.get(name) || { name, size: 0, free: 0, members: [] };
    pool.members.push(disk);
    if (number(disk.fsSize) > pool.size) {
      pool.size = number(disk.fsSize);
      pool.free = number(disk.fsFree);
    }
    pools.set(name, pool);
  }
  return [...pools.values()].filter((pool) => pool.size > 0);
}

function computeStats(disksText, varText) {
  const disks = Object.entries(parseIni(disksText).sections)
    .map(([id, disk]) => ({ id, ...disk }))
    .filter((disk) => ARRAY_TYPES.has(disk.type) && disk.device && !disk.status?.startsWith('DISK_NP'));
  const vars = parseIni(varText).root;

  const temps = disks.map((disk) => Number(disk.temp)).filter((temp) => Number.isFinite(temp) && temp > 0);
  const bad = disks.filter((disk) => BAD_STATUS.has(disk.status) || (disk.color || '').startsWith('red'));
  const errors = disks.reduce((sum, disk) => sum + number(disk.numErrors), 0);
  const total = (list) => ({
    size: list.reduce((sum, item) => sum + number(item.fsSize ?? item.size), 0),
    free: list.reduce((sum, item) => sum + number(item.fsFree ?? item.free), 0),
  });
  const data = total(disks.filter((disk) => disk.type === 'Data' && number(disk.fsSize) > 0));
  const pools = poolsOf(disks);
  const cache = total(pools);
  const arrayMembers = disks.filter((disk) => disk.type === 'Data' || disk.type === 'Parity');
  const volumes = data.size > 0 ? [{ name: 'Array', ...data, members: arrayMembers }, ...pools] : pools;
  const storage = total(volumes);
  const syncSize = number(vars.mdResyncSize) || number(vars.mdResync);
  const syncPos = number(vars.mdResyncPos);

  return {
    values: {
      disk_temp_max: temps.length ? Math.max(...temps) : 0,
      disk_temp_avg: temps.length ? round(temps.reduce((a, b) => a + b, 0) / temps.length) : 0,
      disks_active: temps.length,
      disks_total: disks.length,
      disk_errors: errors,
      disks_bad: bad.length,
      storage_used_pct: round(usedPct(storage)),
      storage_free_tb: round(storage.free / KB_PER_TB),
      volume_max_used_pct: round(Math.max(0, ...volumes.map(usedPct))),
      array_used_pct: round(usedPct(data)),
      array_free_tb: round(data.free / KB_PER_TB),
      cache_used_pct: round(usedPct(cache)),
      parity_errors: number(vars.sbSyncErrs),
      sync_pct: syncPos > 0 && syncSize > 0 ? round((syncPos / syncSize) * 100) : 0,
      array_started: vars.mdState === 'STARTED' ? 1 : 0,
      ...Object.fromEntries(volumes.flatMap((volume) => [
        [`volume_${volumeKey(volume.name)}_used_pct`, round(usedPct(volume))],
        [`volume_${volumeKey(volume.name)}_free_tb`, round(volume.free / KB_PER_TB)],
        [`volume_${volumeKey(volume.name)}_temp_max`, hottest(volume.members)],
      ])),
    },
    hasTemps: temps.length > 0,
    hasArray: disks.some((disk) => disk.type === 'Data' || disk.type === 'Parity'),
    volumes: volumes.map((volume) => ({
      name: volume.name,
      key: volumeKey(volume.name),
      usedPct: round(usedPct(volume)),
      freeTb: round(volume.free / KB_PER_TB),
      sizeTb: round(volume.size / KB_PER_TB),
    })),
    disks: disks.map((disk) => ({
      name: disk.name || disk.id,
      type: disk.type,
      temp: Number.isFinite(Number(disk.temp)) ? Number(disk.temp) : null,
      errors: number(disk.numErrors),
      bad: bad.includes(disk),
    })),
    arrayState: vars.mdState || 'UNKNOWN',
  };
}

function readStats(emhttpDir) {
  try {
    const disks = fs.readFileSync(path.join(emhttpDir, 'disks.ini'), 'utf8');
    const vars = fs.readFileSync(path.join(emhttpDir, 'var.ini'), 'utf8');
    return { available: true, error: null, ...computeStats(disks, vars) };
  } catch (error) {
    return {
      available: false,
      error: `Cannot read Unraid state in ${emhttpDir}: ${error.code || error.message}`,
      values: { ...EMPTY_VALUES },
      hasTemps: false,
      hasArray: false,
      volumes: [],
      disks: [],
      arrayState: 'UNKNOWN',
    };
  }
}

// Points the storage values at one pool. A pool that no longer exists falls
// back to all storage.
function selectStorage(stats, key) {
  const volume = stats.volumes.find((item) => item.key === key);
  if (!volume) return { ...stats, selectedVolume: 'all' };
  return {
    ...stats,
    selectedVolume: volume.key,
    values: { ...stats.values, storage_used_pct: volume.usedPct, storage_free_tb: volume.freeTb },
  };
}

function writeStats(statsDir, values) {
  fs.mkdirSync(statsDir, { recursive: true });
  for (const [key, value] of Object.entries(values)) {
    const target = path.join(statsDir, key);
    fs.writeFileSync(`${target}.tmp`, `${value}\n`);
    fs.renameSync(`${target}.tmp`, target);
  }
}

module.exports = { parseIni, computeStats, readStats, selectStorage, writeStats, EMPTY_VALUES };
