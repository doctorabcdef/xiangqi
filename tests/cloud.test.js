import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../cloud/dist/server/index.js';
import { freshState } from '../src/state.js';
import { serveSocket } from '../cloud/dist/server/live.js';

const migration = readFileSync(new URL('../cloud/drizzle/0000_wide_lightspeed.sql', import.meta.url), 'utf8');
const tokenA = 'a'.repeat(32), tokenB = 'b'.repeat(32);
const githubOrigin = 'https://doctorabcdef.github.io';
let database, env, sessions;
beforeEach(() => {
  database = new DatabaseSync(':memory:');
  database.exec(migration);
  sessions = [];
  const adapter = {
    withSession(constraint) { sessions.push(constraint); return this; },
    prepare(sql) {
      const statement = database.prepare(sql);
      return { bind(...values) { return {
        async first() { return statement.get(...values) ?? null; },
        async run() { const result = statement.run(...values); return { meta: { changes: Number(result.changes) } }; },
      }; } };
    },
  };
  env = { DB: adapter };
});
afterEach(() => database.close());

function request({ method = 'GET', token = tokenA, origin = githubOrigin, state, baseRevision = 0, body, headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (token !== null) requestHeaders.set('Authorization', `Bearer ${token}`);
  if (origin !== null) requestHeaders.set('Origin', origin);
  if (state !== undefined) { body = JSON.stringify({ state, baseRevision }); requestHeaders.set('Content-Type', 'application/json'); }
  return new Request('https://sync.example/api/game', { method, headers: requestHeaders, ...(body !== undefined ? { body } : {}) });
}
const perform = options => worker.fetch(request(options), env);
const played = () => ({ ...freshState(), moves: [{ from: 54, to: 45 }] });

test('cloud requires a correctly formed bearer code and leaves storage untouched', async () => {
  for (const token of [null, 'short', '/'.repeat(32)]) {
    const result = await perform({ token });
    assert.equal(result.status, 401);
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
});

test('CORS accepts the published frontend and own origin, rejects unrelated sites', async () => {
  for (const origin of [githubOrigin, 'https://sync.example']) {
    const result = await perform({ method: 'OPTIONS', token: null, origin });
    assert.equal(result.status, 204);
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(result.headers.get('Vary'), 'Origin');
  }
  const rejected = await perform({ origin: 'https://unrelated.example' });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
});

test('creating and retrieving a game preserves exact progress and uses primary-backed sessions', async () => {
  const state = played();
  assert.equal((await perform()).status, 404);
  const created = await perform({ method: 'PUT', state });
  assert.equal(created.status, 200);
  assert.equal((await created.json()).revision, 1);
  const loaded = await perform();
  assert.equal(loaded.status, 200);
  const data = await loaded.json();
  assert.equal(data.revision, 1);
  assert.deepEqual(data.state, state);
  assert.equal(loaded.headers.get('Cache-Control'), 'no-store');
  assert.ok(sessions.length >= 3);
  assert.ok(sessions.every(value => value === 'first-primary'));
});

test('invalid moves, malformed state and invalid revisions are rejected before any write', async () => {
  const invalid = [
    { state: { ...freshState(), moves: [{ from: 27, to: 36 }] }, baseRevision: 0 },
    { state: { ...freshState(), moves: [{ from: 54, to: 55 }] }, baseRevision: 0 },
    { state: { ...freshState(), version: 99 }, baseRevision: 0 },
    { state: { ...freshState(), humanSide: 'white' }, baseRevision: 0 },
    { state: { ...freshState(), humanSide: null }, baseRevision: 0 },
    { state: freshState(), baseRevision: -1 },
    { state: freshState(), baseRevision: 0.5 },
    { state: freshState(), baseRevision: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const value of invalid) assert.equal((await perform({ method: 'PUT', body: JSON.stringify(value) })).status, 400);
  assert.equal((await perform({ method: 'PUT', body: '{broken' })).status, 400);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
});

test('cloud preserves human black across saves and reads', async () => {
  const state = { ...played(), humanSide: 'black' };
  assert.equal((await perform({ method: 'PUT', state })).status, 200);
  const loaded = await (await perform()).json();
  assert.equal(loaded.state.humanSide, 'black');
  assert.deepEqual(loaded.state.moves, state.moves);
  const updated = { ...state, difficulty: 'hard' };
  assert.equal((await perform({ method: 'PUT', state: updated, baseRevision: 1 })).status, 200);
  assert.equal((await (await perform()).json()).state.humanSide, 'black');
});

test('cloud accepts an old save without humanSide and normalizes it to human red', async () => {
  const legacy = played();
  delete legacy.humanSide;
  assert.equal((await perform({ method: 'PUT', state: legacy })).status, 200);
  const loaded = await (await perform()).json();
  assert.equal(loaded.state.humanSide, 'red');
  assert.deepEqual(loaded.state.moves, legacy.moves);
});

test('compare-and-swap refuses a stale revision without overwriting the winning update', async () => {
  await perform({ method: 'PUT', state: freshState() });
  const accepted = await perform({ method: 'PUT', state: played(), baseRevision: 1 });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).revision, 2);
  const stale = await perform({ method: 'PUT', state: { ...freshState(), mode: 'local' }, baseRevision: 1 });
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.revision, 2);
  assert.deepEqual(conflict.state.moves, played().moves);
  const duplicateCreate = await perform({ method: 'PUT', state: freshState(), baseRevision: 0 });
  assert.equal(duplicateCreate.status, 409);
  const loaded = await (await perform()).json();
  assert.equal(loaded.revision, 2);
  assert.deepEqual(loaded.state.moves, played().moves);
});

test('concurrent writes against one revision have exactly one winner', async () => {
  await perform({ method: 'PUT', state: freshState() });
  const values = [played(), { ...freshState(), mode: 'local' }];
  const results = await Promise.all(values.map(state => perform({ method: 'PUT', state, baseRevision: 1 })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results.findIndex(result => result.status === 200);
  const loser = await results.find(result => result.status === 409).json();
  const loaded = await (await perform()).json();
  assert.equal(loaded.revision, 2);
  assert.deepEqual(loaded.state, values[winner]);
  assert.deepEqual(loser.state, values[winner]);
});

test('sync codes isolate separate games and only their hash is stored', async () => {
  await perform({ method: 'PUT', token: tokenA, state: played() });
  assert.equal((await perform({ token: tokenB })).status, 404);
  const other = { ...freshState(), mode: 'local' };
  await perform({ method: 'PUT', token: tokenB, state: other });
  const gameA = await (await perform({ token: tokenA })).json();
  const gameB = await (await perform({ token: tokenB })).json();
  assert.deepEqual(gameA.state.moves, played().moves);
  assert.deepEqual(gameB.state, other);
  const rows = database.prepare('SELECT id FROM games').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.id) && row.id !== tokenA && row.id !== tokenB));
});

test('request size is bounded even when Content-Length is absent', async () => {
  const oversized = await perform({ method: 'PUT', body: 'x'.repeat(65537) });
  assert.equal(oversized.status, 413);
  const advertised = await perform({ method: 'PUT', body: '{}', headers: { 'Content-Length': '65537' } });
  assert.equal(advertised.status, 413);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM games').get().count, 0);
});

test('storage failures return a recoverable error instead of a successful acknowledgement', async () => {
  const failing = { DB: { prepare() { throw new Error('database unavailable'); } } };
  const result = await worker.fetch(request(), failing);
  assert.equal(result.status, 503);
  assert.match((await result.json()).error, /暂时不可用/);
});

class ServerSocket extends EventTarget {
  constructor() { super(); this.sent = []; this.closed = null; }
  accept() {}
  send(value) { this.sent.push(JSON.parse(value)); }
  close(code) { this.closed = code; }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
const drain = () => new Promise(resolve => setImmediate(resolve));
async function socketFor(t, token = tokenA) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const id = Buffer.from(digest).toString('hex'), socket = new ServerSocket();
  const stop = serveSocket(socket, env, id); t.after(stop); await drain(); return socket;
}

test('live connections read independent HTTP writes and enforce the same CAS rules', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await perform({ method: 'PUT', state: freshState() });
  const socket = await socketFor(t);
  assert.equal(socket.sent[0].data.revision, 1);
  await perform({ method: 'PUT', state: played(), baseRevision: 1 });
  t.mock.timers.tick(100); await drain();
  assert.equal(socket.sent.at(-1).data.revision, 2);
  socket.receive({ id: 1, method: 'PUT', body: { state: freshState(), baseRevision: 1 } });
  await drain();
  assert.equal(socket.sent.at(-1).status, 409);
  assert.equal(socket.sent.at(-1).data.revision, 2);
  socket.receive({ id: 2, method: 'PUT', body: { state: { ...played(), mode: 'local' }, baseRevision: 2 } });
  await drain();
  assert.equal(socket.sent.at(-1).status, 200);
  assert.equal((await (await perform()).json()).revision, 3);
  assert.ok(sessions.every(value => value === 'first-primary'));
});

test('live connections isolate rooms and renew before the database query limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await perform({ method: 'PUT', state: played() });
  const socket = await socketFor(t, tokenB);
  assert.equal(socket.sent.length, 0);
  for (let i = 0; i < 40; i++) { t.mock.timers.tick(100); await drain(); }
  assert.equal(socket.closed, 1012);
  assert.equal(socket.sent.length, 0);
  assert.ok(sessions.length < 50);
});

test('live failures close the connection instead of leaving clients subscribed to stale data', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const socket = new ServerSocket();
  const stop = serveSocket(socket, { DB: { prepare() { throw new Error('offline'); } } }, 'id');
  t.after(stop); await drain(); assert.equal(socket.closed, 1011);
});

test('live null and oversized messages close without changing saved progress', async t => {
  await perform({ method: 'PUT', state: played() });
  for (const message of [null, { id: 1, method: 'PUT', body: 'x'.repeat(67000) }]) {
    const socket = await socketFor(t);
    socket.receive(message); await drain();
    assert.equal(socket.closed, 1008);
  }
  assert.equal((await (await perform()).json()).revision, 1);
});
