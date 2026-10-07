import { gameStore } from './store.js';

// Every socket checks shared primary storage; correctness never depends on
// clients being routed to the same Worker instance or in-memory broadcasting.
export function serveSocket(socket, env, id) {
  let closed = false, timer, revision = -1, queries = 0, queued = 0, chain = Promise.resolve(), lastReadAt = Date.now();
  const store = gameStore(env, id, () => { if (++queries > 40) throw new Error('Renew connection'); });
  const stop = (code = 1000) => { if (closed) return; closed = true; clearTimeout(timer); try { socket.close(code, 'Reconnect to resume'); } catch {} };
  const send = message => { if (!closed) socket.send(JSON.stringify(message)); };
  async function poll() {
    if (closed) return;
    if (queries >= 36) { stop(1012); return; }
    try {
      const value = await store.read(revision);
      lastReadAt = Date.now();
      if (value && value.revision > revision) { revision = value.revision; send({ type: 'snapshot', data: value }); }
      if (!closed) timer = setTimeout(poll, 100);
    } catch { stop(1011); }
  }
  socket.accept();
  socket.addEventListener('close', () => stop());
  socket.addEventListener('error', () => stop(1011));
  socket.addEventListener('message', event => {
    if (closed) return;
    if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 66560 || queued >= 4) { stop(1008); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { stop(1008); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { stop(1008); return; }
    if (message.type === 'ping') { if (Date.now() - lastReadAt > 4000) stop(1011); else send({ type: 'pong' }); return; }
    if (!Number.isSafeInteger(message.id) || !['GET', 'PUT'].includes(message.method)) { stop(1008); return; }
    queued++;
    chain = chain.then(async () => {
      if (closed) return;
      if (queries >= 36) { stop(1012); return; }
      const result = message.method === 'PUT' ? await store.write(message.body) : await store.read().then(data => ({ status: data ? 200 : 404, data }));
      send({ type: 'response', id: message.id, ...result });
      // Don't advance the push cursor on a PUT acknowledgement: another writer
      // may already have committed the next revision, which the next poll sees.
    }).catch(() => stop(1011)).finally(() => queued--);
  });
  void poll();
  return stop;
}
