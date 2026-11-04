'use strict';

// The dashboard password. Only a salted scrypt hash is stored, in its own file so
// it never ends up in the settings download. Sessions are signed with a secret
// that changes with the password, so changing it signs every browser out.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const { BadRequest, check } = require('./check');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TRIES = 5;
const TRY_WINDOW_MS = 60000;
const MAX_TRACKED_ADDRESSES = 1000;

const hashOf = async (password, salt) => (await scrypt(password, Buffer.from(salt, 'hex'), KEY_LENGTH)).toString('hex');
const same = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

class Auth {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    this.tries = new Map();
    this.resetRequested = false;
    this.data = {};
    this.locked = false;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      // A damaged file must not reopen the dashboard to whoever visits next.
      if (error.code !== 'ENOENT') {
        this.locked = true;
        console.error(`extras: cannot read ${file}, so nobody can sign in until the password is reset: ${error.message}`);
      }
    }
  }

  get needsSetup() {
    return !this.locked && !this.data.password;
  }

  get resetOn() {
    return this.resetRequested;
  }

  // The setting stays on until someone turns it off, and restarting must not keep
  // wiping the new password, so each time it's turned on only clears once.
  applyReset(requested) {
    this.resetRequested = requested;
    if (requested && !this.data.resetDone) {
      this.data = { resetDone: true };
      this.locked = false;
      this.save();
      console.log('extras: dashboard password cleared by RESET_PASSWORD');
    } else if (!requested && this.data.resetDone) {
      this.data = { ...this.data, resetDone: false };
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  async store(password) {
    check(typeof password === 'string', 'Enter a password');
    check(password.length >= MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters`);
    check(password.length <= MAX_PASSWORD, `Use at most ${MAX_PASSWORD} characters`);
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: await hashOf(password, salt) };
  }

  commit(stored) {
    this.data = { ...this.data, password: stored, secret: crypto.randomBytes(32).toString('hex') };
    this.save();
  }

  async setup(password) {
    const stored = await this.store(password);
    // Checked after the slow hash, so two visitors can't both claim it.
    if (!this.needsSetup) throw new BadRequest('A password is already set');
    this.commit(stored);
  }

  async verify(password) {
    if (typeof password !== 'string' || password.length > MAX_PASSWORD || !this.data.password) return false;
    return same(await hashOf(password, this.data.password.salt), this.data.password.hash);
  }

  async change(current, password) {
    if (!(await this.verify(current))) throw new BadRequest('Current password is wrong');
    this.commit(await this.store(password));
  }

  sign(expires) {
    return crypto.createHmac('sha256', this.data.secret).update(String(expires)).digest('hex');
  }

  session() {
    const expires = this.now() + SESSION_MS;
    return `${expires}.${this.sign(expires)}`;
  }

  validSession(token) {
    if (!token || !this.data.password || !this.data.secret) return false;
    const [expires, signature] = String(token).split('.');
    return /^\d+$/.test(expires) && Number(expires) > this.now() && same(signature || '', this.sign(expires));
  }

  // Counted before the check runs, so parallel guesses can't slip past the limit.
  allowTry(address) {
    const now = this.now();
    if (this.tries.size > MAX_TRACKED_ADDRESSES) this.tries.clear();
    const entry = this.tries.get(address);
    if (!entry || entry.until <= now) {
      this.tries.set(address, { count: 1, until: now + TRY_WINDOW_MS });
      return true;
    }
    entry.count += 1;
    return entry.count <= MAX_TRIES;
  }

  clearTries(address) {
    this.tries.delete(address);
  }
}

module.exports = { Auth, SESSION_MS };
