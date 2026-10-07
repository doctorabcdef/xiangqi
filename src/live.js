import { CLOUD_URL } from './config.js';

// Persistent transport only. The normal revision/CAS logic in GameSync remains
// the authority for saves, conflicts and recovery after a lost response.
export class LiveConnection {
  constructor(onSnapshot, WebSocketClass = WebSocket) {
    this.onSnapshot = onSnapshot; this.WebSocketClass = WebSocketClass;
    this.pending = new Map(); this.sequence = 0; this.active = false; this.failures = 0;
  }
  get ready() { return Boolean(this.socket?.readyState === 1); }
  start(code) {
    this.stop(); this.code = code; this.active = true; this.failures = 0; this.connect();
  }
  stop() {
    this.active = false; clearTimeout(this.retry); clearInterval(this.heartbeat);
    const socket = this.socket; this.socket = null;
    this.rejectPending();
    try { socket?.close(); } catch {}
  }
  rejectPending() {
    for (const pending of this.pending.values()) pending.reject(new Error('实时连接已断开'));
    this.pending.clear();
  }
  connect() {
    if (!this.active) return;
    let socket;
    try { socket = new this.WebSocketClass(CLOUD_URL.replace(/^http/, 'ws') + '/api/live', ['xiangqi-v1', 'room.' + this.code]); }
    catch { this.retry = setTimeout(() => this.connect(), 5000); return; }
    this.socket = socket; this.lastMessage = Date.now();
    const disconnect = (renew = false) => {
      if (this.socket !== socket) return;
      this.socket = null; clearInterval(this.heartbeat); this.rejectPending();
      try { socket.close(); } catch {}
      if (this.active) this.retry = setTimeout(() => this.connect(), renew ? 0 : Math.min(15000, 500 * 2 ** Math.min(this.failures++, 5)));
    };
    this.disconnect = disconnect;
    socket.addEventListener('open', () => { if (this.socket === socket) this.lastMessage = Date.now(); });
    socket.addEventListener('close', event => disconnect(event.code === 1012));
    socket.addEventListener('error', () => disconnect());
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      let message;
      try { message = JSON.parse(event.data); } catch { disconnect(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { disconnect(); return; }
      this.lastMessage = Date.now(); this.failures = 0;
      if (message.type === 'snapshot') this.onSnapshot(message.data, this.code);
      else if (message.type === 'response') this.pending.get(message.id)?.resolve(message);
    });
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessage > 5000) { disconnect(); return; }
      if (this.ready) try { socket.send(JSON.stringify({ type: 'ping' })); } catch { disconnect(); }
    }, 2000);
  }
  request(method, body, signal) {
    if (!this.ready) return Promise.reject(new Error('实时连接尚未就绪'));
    const id = ++this.sequence, socket = this.socket;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(id); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('实时连接响应超时')); if (this.socket === socket) this.disconnect(); }, 2500);
      this.pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      try { socket.send(JSON.stringify({ id, method, body })); }
      catch (error) { cleanup(); reject(error); }
    });
  }
}
