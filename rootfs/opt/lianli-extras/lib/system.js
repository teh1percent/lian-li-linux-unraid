'use strict';

// CPU load, memory and CPU temperature for the Status page. /proc/stat,
// /proc/meminfo and hwmon show the whole host even inside the container.

const fs = require('fs');
const path = require('path');

const CPU_CHIP = /^(k10temp|coretemp|zenpower|cpu_thermal)$/i;
const CPU_MAIN = /^(tctl|tdie|package id \d+|cpu)$/i;

const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

function cpuTimes(proc) {
  const line = read(path.join(proc, 'stat')).split('\n').find((text) => text.startsWith('cpu '));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  return { idle, total: parts.reduce((sum, value) => sum + (value || 0), 0) };
}

function memoryPercent(proc) {
  const info = Object.fromEntries(read(path.join(proc, 'meminfo')).split('\n')
    .map((line) => line.match(/^(\w+):\s+(\d+)/)).filter(Boolean).map((match) => [match[1], Number(match[2])]));
  if (!info.MemTotal || info.MemAvailable === undefined) return null;
  return Math.round((1 - info.MemAvailable / info.MemTotal) * 100);
}

// The main CPU temperature: Tctl/Tdie on AMD, Package on Intel, else the chip's first reading.
function cpuTemp(sys) {
  const root = path.join(sys, 'class', 'hwmon');
  let chips = [];
  try {
    chips = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const chip of chips) {
    const dir = path.join(root, chip);
    if (!CPU_CHIP.test(read(path.join(dir, 'name')).trim())) continue;
    let inputs = [];
    try {
      inputs = fs.readdirSync(dir).filter((file) => /^temp\d+_input$/.test(file)).sort();
    } catch {
      continue;
    }
    const main = inputs.find((file) => CPU_MAIN.test(read(path.join(dir, file.replace('_input', '_label'))).trim())) || inputs[0];
    const value = Number(read(path.join(dir, main || 'missing')).trim());
    if (main && Number.isFinite(value) && value > 0) return Math.round(value / 100) / 10;
  }
  return null;
}

class SystemStats {
  constructor({ proc = '/proc', sys = '/sys' } = {}) {
    this.proc = proc;
    this.sys = sys;
    this.last = cpuTimes(proc);
    this.values = { cpu: null, mem: memoryPercent(proc), cpuTemp: cpuTemp(sys) };
  }

  sample() {
    const now = cpuTimes(this.proc);
    let cpu = null;
    if (now && this.last && now.total > this.last.total) {
      cpu = Math.round((1 - (now.idle - this.last.idle) / (now.total - this.last.total)) * 100);
    }
    this.last = now;
    this.values = { cpu, mem: memoryPercent(this.proc), cpuTemp: cpuTemp(this.sys) };
    return this.values;
  }
}

module.exports = { SystemStats, cpuTimes, memoryPercent, cpuTemp };
