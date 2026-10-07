import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GameSync, STORAGE_KEY } from '../src/sync.js';
import { freshState } from '../src/state.js';
import { replay } from '../src/engine.js';

const code = 'a'.repeat(32), otherCode = 'b'.repeat(32);
const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let memory;
beforeEach(() => {
  memory = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, String(value)),
  } });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

const opening = [{ from: 54, to: 45 }, { from: 27, to: 36 }, { from: 56, to: 47 }];
const stateAt = count => ({ ...freshState(), moves: opening.slice(0, count) });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
const remote = (state, revision) => ({ state, revision });
function client(state = stateAt(0), revision = 1, pending = false) {
  memory.set(STORAGE_KEY, JSON.stringify({ code, state, revision, pending }));
  const events = { remote: [], status: [], conflicts: 0 };
  const sync = new GameSync({ onRemote: value => events.remote.push(value), onStatus: (...value) => events.status.push(value), onConflict: () => events.conflicts++ });
  return { sync, events };
}
async function settled(sync) {
  for (let i = 0; i < 50; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (!sync.busy) return;
  }
  throw new Error('Mocked synchronization did not settle');
}

test('saved AI turn restores the exact history and black to move', () => {
  const { sync } = client(stateAt(1), 2);
  assert.equal(sync.recovered, true);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 1));
  assert.equal(sync.data.state.mode, 'ai');
  assert.equal(replay(sync.data.state.moves).side, 'black');
});

test('a corrupt primary save recovers the valid backup', () => {
  const backup = { code, state: stateAt(2), revision: 3, pending: false };
  memory.set(STORAGE_KEY, '{broken');
  memory.set(STORAGE_KEY + '.backup', JSON.stringify(backup));
  const sync = new GameSync({ onRemote() {}, onStatus() {}, onConflict() {} });
  assert.equal(sync.storageError, true);
  assert.equal(sync.recovered, true);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 2));
});

test('an invalid sync code never makes a request or replaces the saved game', async () => {
  const { sync } = client(stateAt(2), 3);
  const before = JSON.stringify(sync.data);
  globalThis.fetch = () => { throw new Error('Invalid code must not be sent'); };
  await assert.rejects(sync.join('not-a-valid-code'), /32 位/);
  assert.equal(JSON.stringify(sync.data), before);
});

test('network failure preserves the new move locally for a later retry', async () => {
  const { sync } = client();
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  sync.save(stateAt(1));
  await settled(sync);
  assert.equal(sync.data.pending, true);
  assert.deepEqual(JSON.parse(memory.get(STORAGE_KEY)).state.moves, opening.slice(0, 1));
  assert.equal(sync.conflict, null);
});

test('local edits made during a PUT are sent afterward using the acknowledged revision', async () => {
  const { sync } = client(stateAt(1), 1, true);
  const writes = [];
  let finishFirst;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(remote(stateAt(0), 1));
    const body = JSON.parse(options.body); writes.push(body);
    if (writes.length === 1) return new Promise(resolve => { finishFirst = resolve; });
    return response({ revision: 3 });
  };
  const flushing = sync.flush();
  while (!finishFirst) await new Promise(resolve => setImmediate(resolve));
  sync.save(stateAt(2));
  finishFirst(response({ revision: 2 }));
  await flushing;
  assert.deepEqual(writes.map(write => write.baseRevision), [1, 2]);
  assert.deepEqual(writes[1].state.moves, opening.slice(0, 2));
  assert.equal(sync.data.revision, 3);
  assert.equal(sync.data.pending, false);
});

test('a lost successful PUT response is acknowledged on retry without a duplicate write', async () => {
  const { sync, events } = client(stateAt(1), 1, true);
  let server = remote(stateAt(0), 1), writes = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(server);
    writes++;
    server = remote(JSON.parse(options.body).state, 2);
    throw new TypeError('response lost after commit');
  };
  await sync.flush();
  assert.equal(sync.data.pending, true);
  await sync.flush();
  assert.equal(sync.data.pending, false);
  assert.equal(sync.data.revision, 2);
  assert.equal(events.conflicts, 0);
  assert.equal(writes, 1);
});

test('a lost PUT response followed by another local move rebases without a false conflict', async () => {
  const { sync, events } = client(stateAt(1), 1, true);
  let server = remote(stateAt(0), 1), writes = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(server);
    const body = JSON.parse(options.body); writes++;
    server = remote(body.state, body.baseRevision + 1);
    if (writes === 1) throw new TypeError('response lost after commit');
    return response({ revision: server.revision });
  };
  await sync.flush();
  sync.save(stateAt(2));
  await settled(sync);
  assert.equal(events.conflicts, 0);
  assert.equal(sync.conflict, null);
  assert.equal(sync.data.pending, false);
  assert.equal(sync.data.revision, 3);
  assert.deepEqual(server.state.moves, opening.slice(0, 2));
});

test('refresh preserves an unacknowledged write and newer local edits for safe retry', async () => {
  const { sync } = client(stateAt(1), 1, true);
  let server = remote(stateAt(0), 1);
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(server);
    const body = JSON.parse(options.body);
    server = remote(body.state, body.baseRevision + 1);
    throw new TypeError('response lost after commit');
  };
  await sync.flush();
  globalThis.fetch = async () => { throw new TypeError('offline'); };
  sync.save(stateAt(2));
  await settled(sync);
  const conflicts = [];
  const restored = new GameSync({ onRemote() {}, onStatus() {}, onConflict: () => conflicts.push(true) });
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(server);
    const body = JSON.parse(options.body);
    server = remote(body.state, body.baseRevision + 1);
    return response({ revision: server.revision });
  };
  await restored.flush();
  assert.equal(conflicts.length, 0);
  assert.equal(restored.data.pending, false);
  assert.equal(restored.data.revision, 3);
  assert.deepEqual(server.state.moves, opening.slice(0, 2));
});

test('409 acknowledging the submitted state preserves an edit made while that PUT was in flight', async () => {
  const { sync, events } = client(stateAt(1), 1, true);
  let finishFirst, writes = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(remote(stateAt(0), 1));
    writes++;
    if (writes === 1) return new Promise(resolve => { finishFirst = resolve; });
    const body = JSON.parse(options.body);
    assert.equal(body.baseRevision, 2);
    assert.deepEqual(body.state.moves, opening.slice(0, 2));
    return response({ revision: 3 });
  };
  const flushing = sync.flush();
  while (!finishFirst) await new Promise(resolve => setImmediate(resolve));
  sync.save(stateAt(2));
  finishFirst(response(remote(stateAt(1), 2), 409));
  await flushing;
  assert.equal(events.conflicts, 0);
  assert.equal(writes, 2);
  assert.equal(sync.data.pending, false);
  assert.equal(sync.data.revision, 3);
});

test('a genuine external conflict preserves local history until the cloud copy is chosen', async () => {
  const { sync, events } = client(stateAt(1), 1, true);
  const cloud = { ...stateAt(0), mode: 'local' };
  globalThis.fetch = async () => response(remote(cloud, 2));
  await sync.flush();
  assert.equal(events.conflicts, 1);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 1));
  sync.resolve(false);
  await settled(sync);
  assert.equal(sync.conflict, null);
  assert.equal(sync.data.state.mode, 'local');
  assert.deepEqual(sync.data.state.moves, []);
  assert.equal(events.remote.length, 1);
});

test('a remote side-only change updates the UI even when the move list is unchanged', async () => {
  const { sync, events } = client(stateAt(0), 1, false);
  const cloud = { ...stateAt(0), humanSide: 'black' };
  globalThis.fetch = async () => response(remote(cloud, 2));
  await sync.flush();
  assert.equal(sync.data.state.humanSide, 'black');
  assert.equal(events.remote.length, 1);
  assert.equal(events.remote[0].humanSide, 'black');
  assert.equal(events.conflicts, 0);
});

test('pending local and cloud games with different human sides require conflict resolution', async () => {
  const { sync, events } = client({ ...stateAt(0), humanSide: 'red' }, 1, true);
  globalThis.fetch = async () => response(remote({ ...stateAt(0), humanSide: 'black' }, 2));
  await sync.flush();
  assert.equal(events.conflicts, 1);
  assert.equal(sync.data.state.humanSide, 'red');
  assert.equal(sync.conflict.state.humanSide, 'black');
});

test('a side choice made during a PUT remains pending and is uploaded next', async () => {
  const { sync } = client({ ...stateAt(0), humanSide: 'red' }, 1, true);
  let finishFirst;
  const writes = [];
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(remote(stateAt(0), 1));
    const body = JSON.parse(options.body); writes.push(body);
    if (writes.length === 1) return new Promise(resolve => { finishFirst = resolve; });
    return response({ revision: 3 });
  };
  const flushing = sync.flush();
  while (!finishFirst) await new Promise(resolve => setImmediate(resolve));
  sync.save({ ...stateAt(0), humanSide: 'black' });
  finishFirst(response({ revision: 2 }));
  await flushing;
  assert.equal(writes.length, 2);
  assert.equal(writes[0].state.humanSide, 'red');
  assert.equal(writes[1].state.humanSide, 'black');
  assert.equal(writes[1].baseRevision, 2);
  assert.equal(sync.data.pending, false);
});

test('choosing local after a conflict uploads against the latest cloud revision', async () => {
  const { sync } = client(stateAt(1), 1, true);
  const cloud = { ...stateAt(0), mode: 'local' };
  let write;
  globalThis.fetch = async (_url, options) => {
    if (options.method === 'GET') return response(remote(cloud, 2));
    write = JSON.parse(options.body);
    return response({ revision: 3 });
  };
  await sync.flush();
  sync.resolve(true);
  await settled(sync);
  assert.equal(write.baseRevision, 2);
  assert.deepEqual(write.state.moves, opening.slice(0, 1));
  assert.equal(sync.data.pending, false);
});

test('an old request cannot overwrite the game after joining another sync code', async () => {
  const { sync } = client();
  let finishOld;
  const other = { ...stateAt(2), mode: 'local' };
  globalThis.fetch = async (_url, options) => {
    if (options.headers.Authorization === `Bearer ${otherCode}`) return response(remote(other, 7));
    return new Promise(resolve => { finishOld = resolve; });
  };
  const flushing = sync.flush();
  await sync.join(otherCode);
  finishOld(response(remote(stateAt(1), 2)));
  await flushing;
  await settled(sync);
  assert.equal(sync.data.code, otherCode);
  assert.equal(sync.data.revision, 7);
  assert.equal(sync.data.state.mode, 'local');
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 2));
});

test('a new move uploads immediately without a preliminary GET', async () => {
  const { sync } = client();
  const methods = [];
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method);
    assert.equal(JSON.parse(options.body).baseRevision, 1);
    return response({ revision: 2 });
  };
  sync.save(stateAt(1));
  await settled(sync);
  assert.deepEqual(methods, ['PUT']);
  assert.equal(sync.data.pending, false);
});

test('direct upload still detects a newer conflicting cloud move', async () => {
  const { sync, events } = client();
  const cloud = { ...stateAt(0), mode: 'local' };
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, 'PUT');
    return response(remote(cloud, 2), 409);
  };
  sync.save(stateAt(1));
  await settled(sync);
  assert.equal(events.conflicts, 1);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 1));
  assert.equal(sync.conflict.state.mode, 'local');
});

test('a move cancels an in-flight poll and uploads without waiting for that read', async () => {
  const { sync, events } = client();
  const methods = [];
  let cancelled = false;
  globalThis.fetch = async (_url, options) => {
    methods.push(options.method);
    if (options.method === 'GET') return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { cancelled = true; reject(options.signal.reason); });
    });
    return response({ revision: 2 });
  };
  const polling = sync.flush({ quiet: true });
  sync.save(stateAt(1));
  await polling;
  await settled(sync);
  assert.equal(cancelled, true);
  assert.deepEqual(methods, ['GET', 'PUT']);
  assert.equal(sync.data.pending, false);
  assert.equal(events.status.some(([kind]) => kind === 'error'), false);
});

test('automatic polling is fast, silent, pauses when hidden and backs off after failure', async () => {
  const { sync, events } = client();
  const savedInterval = globalThis.setInterval;
  const savedDocument = globalThis.document, savedWindow = globalThis.window;
  let tick, interval, requests = 0, fail = false;
  const handlers = {};
  try {
    globalThis.setInterval = (callback, delay) => { tick = callback; interval = delay; return 1; };
    globalThis.document = { hidden: false, addEventListener: (name, fn) => { handlers[name] = fn; } };
    globalThis.window = { addEventListener: (name, fn) => { handlers[name] = fn; } };
    globalThis.fetch = async () => {
      requests++;
      if (fail) throw new TypeError('offline');
      return response(remote(stateAt(0), 1));
    };
    await sync.start();
    assert.equal(interval, 250);
    events.status.length = 0;
    tick(); await settled(sync);
    assert.equal(requests, 2);
    assert.equal(events.status.some(([kind]) => kind === 'pending'), false);
    document.hidden = true;
    tick(); assert.equal(requests, 2);
    document.hidden = false;
    fail = true;
    tick(); await settled(sync);
    assert.equal(requests, 3);
    assert.ok(sync.nextPollAt >= Date.now() + 1500);
    tick(); assert.equal(requests, 3);
    fail = false;
    handlers.online(); await settled(sync);
    assert.equal(requests, 4);
    assert.equal(sync.nextPollAt, 0);
  } finally {
    globalThis.setInterval = savedInterval;
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  }
});

test('live snapshot before a PUT acknowledgement cannot roll back a newer local edit', async () => {
  const { sync } = client(stateAt(0), 1);
  let finish;
  const writes = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); writes.push(body);
    if (writes.length === 1) return new Promise(resolve => { finish = resolve; });
    return response({ revision: 3 });
  };
  sync.save(stateAt(1));
  sync.receiveRemote(remote(stateAt(1), 2));
  sync.save(stateAt(2));
  finish(response({ revision: 2 }));
  await settled(sync);
  assert.deepEqual(writes.map(value => value.baseRevision), [1, 2]);
  assert.equal(sync.data.revision, 3);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 2));
  assert.equal(sync.queuedRemote, null);
  sync.receiveRemote(remote(stateAt(1), 2));
  assert.equal(sync.data.revision, 3);
});

test('queued live snapshot acknowledges a write even when its response is lost', async () => {
  const { sync, events } = client();
  let fail;
  globalThis.fetch = () => new Promise((_resolve, reject) => { fail = reject; });
  sync.save(stateAt(1));
  sync.receiveRemote(remote(stateAt(1), 2));
  fail(new Error('response lost'));
  await settled(sync);
  assert.equal(sync.data.pending, false);
  assert.equal(sync.data.revision, 2);
  assert.equal(events.conflicts, 0);
});

test('lost live PUT retries the identical payload over HTTP and accepts its CAS conflict acknowledgement', async () => {
  const { sync, events } = client();
  let submitted;
  sync.live = { ready: true, code, async request(method, body) { submitted = structuredClone(body); throw new Error('socket closed after commit'); } };
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), submitted);
    return response(remote(submitted.state, submitted.baseRevision + 1), 409);
  };
  sync.save(stateAt(1)); await settled(sync);
  assert.equal(sync.data.revision, 2);
  assert.equal(sync.data.pending, false);
  assert.equal(events.conflicts, 0);
});

test('a delayed HTTP read drains a newer live snapshot and never accepts a lower revision', async () => {
  const { sync } = client();
  let finish;
  globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
  const flushing = sync.flush();
  sync.receiveRemote(remote(stateAt(2), 3));
  sync.receiveRemote(remote(stateAt(1), 2));
  finish(response(remote(stateAt(1), 2))); await flushing;
  assert.equal(sync.data.revision, 3);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 2));
  globalThis.fetch = async () => response(remote(stateAt(0), 1));
  await sync.flush();
  assert.equal(sync.data.revision, 3);
  assert.deepEqual(sync.data.state.moves, opening.slice(0, 2));
});
