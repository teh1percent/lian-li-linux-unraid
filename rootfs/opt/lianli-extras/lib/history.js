'use strict';

// A day of one-minute samples for the charts on the Status page.

const fs = require('fs');
const path = require('path');

const MAX_POINTS = 1440;

class History {
  constructor(file) {
    this.file = file;
    this.points = [];
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(saved)) this.points = saved.slice(-MAX_POINTS);
    } catch {
      // No history yet, or an unreadable file: start again.
    }
  }

  add(point) {
    this.points.push(point);
    if (this.points.length > MAX_POINTS) this.points.shift();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.points));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}

module.exports = { History };
