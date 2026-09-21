// EngineBridge — the Shell's single point of contact with the Engine.
//
// Protocol: newline-delimited JSON-RPC over TCP on 127.0.0.1:48916.
// If the native Go engine is listening there, every call is proxied to it.
// If not (development, or engine not yet shipped), the built-in JS engine
// takes over so the app remains fully functional. The UI cannot tell the
// difference — both implement the same contract.

const net = require('net');
const { EventEmitter } = require('events');
const { BuiltinEngine } = require('./builtin-engine');

const ENGINE_HOST = '127.0.0.1';
const ENGINE_PORT = 48916;
const CONNECT_TIMEOUT_MS = 1500;

class EngineBridge extends EventEmitter {
  constructor() {
    super();
    this.native = null;        // net.Socket when connected to the Go engine
    this.builtin = null;
    this.nextId = 1;
    this.pending = new Map();  // id -> {resolve, reject}
    this.buffer = '';
  }

  init(config) {
    this.builtin = new BuiltinEngine(config);
    this.builtin.on('state', (s) => {
      if (!this.native) this.emit('state', { ...s, engine: 'builtin' });
    });
    this.tryConnectNative();
  }

  tryConnectNative() {
    const sock = net.createConnection({ host: ENGINE_HOST, port: ENGINE_PORT });
    const timer = setTimeout(() => sock.destroy(), CONNECT_TIMEOUT_MS);

    sock.on('connect', () => {
      clearTimeout(timer);
      this.native = sock;
      console.log('[bridge] connected to native engine on', ENGINE_PORT);
      sock.setEncoding('utf8');
      sock.on('data', (chunk) => this.onNativeData(chunk));
    });

    sock.on('error', () => { /* no native engine — builtin handles it */ });
    sock.on('close', () => {
      clearTimeout(timer);
      if (this.native === sock) {
        console.log('[bridge] native engine disconnected, falling back to builtin');
        this.native = null;
        for (const { reject } of this.pending.values()) reject(new Error('engine disconnected'));
        this.pending.clear();
      }
      // Retry periodically so a later-started engine gets picked up.
      setTimeout(() => { if (!this.native) this.tryConnectNative(); }, 10000);
    });
  }

  onNativeData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error)) : resolve(msg.result);
      } else if (msg.method === 'state') {
        // Engine pushes live state updates without being asked.
        this.emit('state', { ...msg.params, engine: 'native' });
      }
    }
  }

  callNative(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.native.write(JSON.stringify({ id, method, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`engine call ${method} timed out`));
        }
      }, 15000);
    });
  }

  call(method, params) {
    if (this.native) {
      return this.callNative(method, params).catch((e) => {
        console.error('[bridge] native call failed, builtin fallback:', e.message);
        return this.builtin[method](params);
      });
    }
    return Promise.resolve(this.builtin[method](params));
  }

  // ---- engine interface contract ----
  getStatus() { return this.call('getStatus'); }
  getHardware() { return this.call('getHardware'); }
  getEarnings() { return this.call('getEarnings'); }
  scan() { return this.call('scan'); }
  start() { return this.call('start'); }
  stop() { return this.call('stop'); }
  pause() { return this.call('pause'); }
  resume() { return this.call('resume'); }
  getHistory() { return this.call('getHistory'); }
  getLogs() { return this.call('getLogs'); }
  getMachineId() { return this.call('getMachineId'); }
  setIdleOnly(v) { return this.call('setIdleOnly', v); }
  setThrottle(v) { return this.call('setThrottle', v); }
  setAccount(addr) { return this.call('setAccount', addr); }
  withdraw(addr) { return this.call('withdraw', addr); }
}

module.exports = { EngineBridge };
