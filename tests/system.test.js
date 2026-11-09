'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { SystemStats, cpuTemp, memoryPercent } = require(path.join(__dirname, '..', 'rootfs', 'opt', 'lianli-extras', 'lib', 'system'));

function fakeHost() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lianli-system-'));
  const proc = path.join(dir, 'proc');
  const sys = path.join(dir, 'sys');
  fs.mkdirSync(proc);
  fs.writeFileSync(path.join(proc, 'stat'), 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n');
  fs.writeFileSync(path.join(proc, 'meminfo'), 'MemTotal:       1000 kB\nMemFree:         100 kB\nMemAvailable:    400 kB\n');
  const nvme = path.join(sys, 'class', 'hwmon', 'hwmon0');
  const cpu = path.join(sys, 'class', 'hwmon', 'hwmon1');
  fs.mkdirSync(nvme, { recursive: true });
  fs.mkdirSync(cpu, { recursive: true });
  fs.writeFileSync(path.join(nvme, 'name'), 'nvme\n');
  fs.writeFileSync(path.join(nvme, 'temp1_input'), '35000\n');
  fs.writeFileSync(path.join(cpu, 'name'), 'k10temp\n');
  fs.writeFileSync(path.join(cpu, 'temp1_input'), '60000\n');
  fs.writeFileSync(path.join(cpu, 'temp1_label'), 'Tccd1\n');
  fs.writeFileSync(path.join(cpu, 'temp2_input'), '41250\n');
  fs.writeFileSync(path.join(cpu, 'temp2_label'), 'Tctl\n');
  return { dir, proc, sys };
}

test('memory use comes from MemAvailable', () => {
  const host = fakeHost();
  assert.strictEqual(memoryPercent(host.proc), 60);
  fs.rmSync(host.dir, { recursive: true, force: true });
});

test('CPU temperature prefers Tctl on the CPU chip', () => {
  const host = fakeHost();
  assert.strictEqual(cpuTemp(host.sys), 41.3);
  fs.rmSync(host.dir, { recursive: true, force: true });
});

test('CPU load is measured between two samples', () => {
  const host = fakeHost();
  const system = new SystemStats(host);
  assert.strictEqual(system.values.cpu, null);
  // 100 more busy and 300 more idle: 25% load.
  fs.writeFileSync(path.join(host.proc, 'stat'), 'cpu  150 0 150 1000 100 0 0 0 0 0\n');
  assert.strictEqual(system.sample().cpu, 25);
  fs.rmSync(host.dir, { recursive: true, force: true });
});

test('a host without these files gives empty readings', () => {
  const system = new SystemStats({ proc: path.join(os.tmpdir(), 'no-such-proc'), sys: path.join(os.tmpdir(), 'no-such-sys') });
  assert.deepStrictEqual(system.sample(), { cpu: null, mem: null, cpuTemp: null });
});
