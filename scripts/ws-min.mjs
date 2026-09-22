// The smallest WebSocket client that can speak the DevTools protocol.
//
// Node has no built-in WebSocket client that works against a raw HTTP upgrade
// without a dependency, and the capture harness must not add one to the app's
// package.json. This is enough of RFC 6455 for CDP: a client handshake,
// masked text frames out, unmasked text frames in, and continuation frames,
// which matter because a screenshot arrives as a multi-megabyte base64 string.
//
// Development tooling only. It is never bundled into the app.

import crypto from 'node:crypto';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocket {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  open() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.url);
      const key = crypto.randomBytes(16).toString('base64');
      const req = http.request({
        host: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: {
          Host: `${u.hostname}:${u.port}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
          Origin: `http://${u.hostname}:${u.port}`
        }
      });
      req.on('upgrade', (res, socket, head) => {
        const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
        if (res.headers['sec-websocket-accept'] !== accept) return reject(new Error('bad websocket handshake'));
        this.socket = socket;
        socket.setNoDelay(true);
        socket.on('data', (d) => this.onData(d));
        socket.on('close', () => { this.closed = true; });
        socket.on('error', () => { this.closed = true; });
        if (head && head.length) this.onData(head);
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); offset = 10; }
      if (masked) offset += 4;   // a server must not mask, but be tolerant
      if (this.buf.length < offset + len) return;
      const payload = this.buf.subarray(offset, offset + len);
      this.buf = this.buf.subarray(offset + len);

      if (opcode === 0x8) { this.closed = true; return; }
      if (opcode === 0x9) { this.sendFrame(0xa, payload); continue; }   // ping -> pong
      if (opcode === 0xa) continue;                                     // pong

      this.frag.push(Buffer.from(payload));
      if (!fin) continue;
      const text = Buffer.concat(this.frag).toString('utf8');
      this.frag = [];
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }

  sendFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('the debug connection closed'));
    const id = this.nextId++;
    const body = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method} timed out`)); }
      }, 60000);
      this.sendFrame(0x1, body);
    });
  }
}
