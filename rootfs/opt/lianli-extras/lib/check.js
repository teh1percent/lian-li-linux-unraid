'use strict';

class BadRequest extends Error {}

function check(condition, message) {
  if (!condition) throw new BadRequest(message);
}

function isInt(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isNumber(value, min = -1e6, max = 1e6) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

const isText = (value, max = 4096) => typeof value === 'string' && Buffer.byteLength(value) <= max;

module.exports = { BadRequest, check, isInt, isNumber, isText };
