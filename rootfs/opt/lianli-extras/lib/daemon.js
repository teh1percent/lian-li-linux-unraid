'use strict';

// Client for lianli-daemon's IPC socket: one JSON request per line, one JSON
// response per line. Everything except read-only requests must be wrapped in
// `Guarded` with a guard built from the daemon's current identity.

const net = require('net');

const PROTOCOL_VERSION = 1;
const GUARDED_WRITES = 'guarded_writes';
const MAX_RESPONSE = 32 * 1024 * 1024;

class DaemonClient {
  constructor(socketPath, { timeoutMs = 8000 } = {}) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  request(method, params) {
    const message = params === undefined ? { method } : { method, params };
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.setTimeout(this.timeoutMs, () => finish(new Error(`${method}: daemon did not answer in time`)));
      socket.on('error', (error) => finish(new Error(`daemon socket: ${error.message}`)));
      socket.on('close', () => finish(new Error(`${method}: daemon closed the connection`)));
      socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
      socket.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE) return finish(new Error(`${method}: response too large`));
        const newline = chunk.indexOf(10);
        if (newline === -1) return chunks.push(chunk);
        chunks.push(chunk.subarray(0, newline));
        let response;
        try {
          response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (error) {
          return finish(new Error(`${method}: unreadable response`));
        }
        if (response.status === 'ok') return finish(null, response.data);
        return finish(new Error(response.message || `${method} failed`));
      });
    });
  }

  async write(method, params) {
    const info = await this.request('GetDaemonInfo');
    if (info.protocol_version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported daemon protocol ${info.protocol_version}`);
    }
    if (!(info.capabilities || []).includes(GUARDED_WRITES)) {
      throw new Error('This daemon does not accept guarded writes');
    }
    const guard = {
      client_version: info.version,
      protocol_version: PROTOCOL_VERSION,
      instance_id: info.instance_id,
    };
    const request = params === undefined ? { method } : { method, params };
    return this.request('Guarded', { guard, request });
  }
}

module.exports = { DaemonClient };
