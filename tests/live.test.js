import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveConnection } from '../src/live.js';

class Socket extends EventTarget {
  static all = [];
  constructor(url, protocols) { super(); this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; Socket.all.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
function connection(t) {
  const snapshots = [], live = new LiveConnection((...args) => snapshots.push(args), Socket);
  live.start('a'.repeat(32)); const socket = Socket.all.at(-1); socket.open();
  t.after(() => live.stop());
  return { live, socket, snapshots };
}

test('live requests carry room auth outside URLs and match replies by request ID', async t => {
  const { live, socket, snapshots } = connection(t);
  assert.ok(!socket.url.includes('a'.repeat(32)));
  assert.deepEqual(socket.protocols, ['xiangqi-v1', 'room.' + 'a'.repeat(32)]);
  const request = live.request('PUT', { baseRevision: 3 });
  const sent = socket.sent.at(-1);
  socket.receive({ type: 'snapshot', data: { revision: 4 } });
  socket.receive({ type: 'response', id: sent.id + 1, status: 200, data: { revision: 99 } });
  socket.receive({ type: 'response', id: sent.id, status: 200, data: { revision: 4 } });
  assert.equal((await request).data.revision, 4);
  assert.equal(snapshots[0][0].revision, 4);
  assert.equal(live.pending.size, 0);
});

test('cancelling a live read preserves the connection and ignores its late reply', async t => {
  const { live, socket } = connection(t);
  const controller = new AbortController();
  const request = live.request('GET', undefined, controller.signal);
  const rejected = assert.rejects(request, /abort/i);
  controller.abort(); await rejected;
  socket.receive({ type: 'response', id: socket.sent[0].id, status: 200, data: { revision: 7 } });
  assert.equal(live.ready, true); assert.equal(live.pending.size, 0);
});

test('switching rooms rejects old requests and drops stale connection messages', async t => {
  const { live, socket, snapshots } = connection(t);
  const request = live.request('PUT', { baseRevision: 1 });
  const rejected = assert.rejects(request, /断开/);
  live.start('b'.repeat(32)); await rejected;
  socket.receive({ type: 'snapshot', data: { revision: 999 } });
  assert.equal(snapshots.length, 0);
  const next = Socket.all.at(-1); next.open();
  next.receive({ type: 'snapshot', data: { revision: 2 } });
  assert.equal(snapshots[0][1], 'b'.repeat(32));
});

test('a silent live connection times out requests so HTTP fallback can recover', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { live } = connection(t);
  const rejected = assert.rejects(live.request('PUT', { baseRevision: 1 }), /超时/);
  t.mock.timers.tick(2500); await rejected;
  assert.equal(live.ready, false); assert.equal(live.pending.size, 0);
});

test('a malformed null message closes the live transport cleanly', t => {
  const { live, socket } = connection(t);
  socket.receive(null);
  assert.equal(live.ready, false);
});
