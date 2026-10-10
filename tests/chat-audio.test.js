import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatAudio } from '../src/chat-audio.js';

const clips = { first: { url: 'memory:first' }, second: { url: 'memory:second' } };
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = url => ({ ok: true, arrayBuffer: async () => url });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup({ enabled = true, fetchClip = async url => response(url), decode = async url => ({ clip: url }) } = {}) {
  let time = 0, created = 0;
  const events = [], errors = [], changes = [], sources = [], fetched = [], decoded = [];
  const context = {
    state: 'suspended', destination: {},
    resume() { events.push('resume'); this.state = 'running'; return Promise.resolve(); },
    decodeAudioData(data) { decoded.push(data); return decode(data); },
    createBufferSource() {
      const source = {
        starts: 0, stops: 0, disconnects: 0, onended: null,
        connect(destination) { assert.equal(destination, context.destination); },
        start() { this.starts++; },
        stop() { this.stops++; },
        disconnect() { this.disconnects++; },
        finish() { this.onended?.(); },
      };
      sources.push(source);
      return source;
    },
  };
  const sound = new ChatAudio({
    clips, enabled,
    createContext() { created++; events.push('create'); return context; },
    fetchClip(url) { fetched.push(url); events.push('fetch'); return fetchClip(url); },
    now: () => time,
    onChange: state => changes.push(state),
    onError: message => errors.push(message),
  });
  return { sound, context, sources, fetched, decoded, errors, changes, events,
    advance(ms) { time += ms; }, get created() { return created; } };
}

test('chat audio waits for a gesture and resumes the context before fetching a clip', async () => {
  const run = setup();
  run.sound.receive('first', 'one');
  await settle();
  assert.equal(run.created, 0);
  assert.deepEqual(run.fetched, []);
  assert.deepEqual(run.sound.state, { enabled: true, ready: false, playing: null, waiting: true });

  run.sound.unlock();
  assert.deepEqual(run.events.slice(0, 2), ['create', 'resume']);
  await settle();
  assert.equal(run.sound.state.playing, 'one');
  assert.equal(run.sources[0].starts, 1);
  assert.ok(run.events.indexOf('resume') < run.events.indexOf('fetch'));
  run.sound.unlock();
  await settle();
  assert.equal(run.created, 1);
  assert.equal(run.sources.length, 1);
});

test('chat audio deduplicates message IDs and plays a batch in FIFO order', async () => {
  const run = setup();
  run.sound.receive('first', 'one');
  run.sound.receive('first', 'one');
  run.sound.receive('second', 'two');
  run.sound.receive('first', 'three');
  run.sound.unlock();
  await settle();
  assert.equal(run.sound.state.playing, 'one');
  assert.equal(run.sources.length, 1);
  run.sources[0].finish();
  await settle();
  assert.equal(run.sound.state.playing, 'two');
  run.sources[1].finish();
  await settle();
  assert.equal(run.sound.state.playing, 'three');
  run.sources[2].finish();
  run.sound.receive('first', 'one');
  await settle();
  assert.equal(run.sound.state.playing, null);
  assert.equal(run.sound.state.waiting, false);
  assert.equal(run.sources.length, 3);
  assert.deepEqual(run.fetched, ['memory:first', 'memory:second']);
});

test('muting drops the queue and ignores a buffer that finishes downloading later', async () => {
  const download = deferred();
  const run = setup({ fetchClip: () => download.promise });
  run.sound.unlock();
  run.sound.receive('first', 'loading');
  await settle();
  run.sound.mute();
  run.sound.receive('second', 'received-while-muted');
  download.resolve(response('memory:first'));
  await settle();
  assert.equal(run.sources.length, 0);
  assert.equal(run.sound.state.enabled, false);
  assert.equal(run.sound.state.waiting, false);
  assert.equal(run.sound.state.playing, null);

  run.sound.unlock();
  run.sound.receive('second', 'received-while-muted');
  await settle();
  assert.equal(run.sources.length, 0, 'unmuting must not replay messages received while muted');
  run.sound.receive('first', 'new-message');
  await settle();
  assert.equal(run.sound.state.playing, 'new-message');
  assert.equal(run.sources.length, 1);
});

test('room reset ignores old decoding while allowing a new room to play', async () => {
  const decoding = deferred();
  const run = setup({ decode: url => url === 'memory:first' ? decoding.promise : Promise.resolve({ clip: url }) });
  run.sound.unlock();
  run.sound.receive('first', 'shared-id');
  await settle();
  assert.deepEqual(run.decoded, ['memory:first']);
  run.sound.reset();
  run.sound.receive('second', 'shared-id');
  await settle();
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0].buffer.clip, 'memory:second');
  decoding.resolve({ clip: 'memory:first' });
  await settle();
  assert.equal(run.sources.length, 1);
  assert.equal(run.sound.state.playing, 'shared-id');
  assert.deepEqual(run.errors, []);
});

test('an old ended callback cannot finish a newer source or advance its queue', async () => {
  const run = setup();
  run.sound.replay('first', 'old');
  await settle();
  const old = run.sources[0], lateEnded = old.onended;
  run.sound.reset();
  assert.equal(old.stops, 1);
  assert.equal(old.onended, null);
  run.sound.receive('second', 'current');
  run.sound.receive('first', 'next');
  await settle();
  lateEnded();
  await settle();
  assert.equal(run.sound.state.playing, 'current');
  assert.equal(run.sources.length, 2);
  assert.equal(run.sources[1].stops, 0);
  run.sources[1].finish();
  await settle();
  assert.equal(run.sound.state.playing, 'next');
  assert.equal(run.sources.length, 3);
});

test('manual replay unmutes, suppresses the GET echo, and supports stop and replay', async () => {
  const run = setup({ enabled: false });
  run.sound.replay('first', 'manual');
  await settle();
  assert.equal(run.sound.state.enabled, true);
  assert.equal(run.sound.state.playing, 'manual');
  run.sound.receive('first', 'manual');
  run.sound.receive('second', 'queued');
  run.sound.replay('second', 'queued');
  await settle();
  assert.equal(run.sources[0].stops, 1);
  assert.equal(run.sound.state.playing, 'queued');
  assert.equal(run.sound.state.waiting, false);

  run.sound.replay('second', 'queued');
  await settle();
  assert.equal(run.sources[1].stops, 1);
  assert.equal(run.sound.state.playing, null);
  run.sound.replay('second', 'queued');
  await settle();
  assert.equal(run.sources.length, 3);
  assert.equal(run.sound.state.playing, 'queued');
  assert.deepEqual(run.fetched, ['memory:first', 'memory:second']);
});

test('a decoding failure reports once, continues the queue, and permits a manual retry', async () => {
  let broken = true;
  const run = setup({ decode: async url => {
    if (broken && url === 'memory:first') throw new Error('invalid audio');
    return { clip: url };
  } });
  run.sound.receive('first', 'bad');
  run.sound.receive('second', 'good');
  run.sound.unlock();
  await settle();
  assert.equal(run.errors.length, 1);
  assert.equal(run.sound.state.playing, 'good');
  assert.equal(run.sources.length, 1);
  broken = false;
  run.sources[0].finish();
  run.sound.replay('first', 'bad');
  await settle();
  assert.equal(run.sound.state.playing, 'bad');
  assert.equal(run.sources.length, 2);
  assert.deepEqual(run.fetched, ['memory:first', 'memory:second', 'memory:first']);
  assert.equal(run.errors.length, 1);
});

test('clips queued for more than 30 seconds expire before the first gesture', async () => {
  const run = setup();
  run.sound.receive('first', 'stale');
  run.advance(30_001);
  run.sound.receive('second', 'fresh');
  run.sound.unlock();
  await settle();
  assert.equal(run.sound.state.playing, 'fresh');
  assert.deepEqual(run.fetched, ['memory:second']);
  run.sources[0].finish();
  run.sound.receive('first', 'stale');
  await settle();
  assert.equal(run.sources.length, 1, 'an expired ID must not reenter on another poll');
  run.sound.replay('first', 'stale');
  await settle();
  assert.equal(run.sound.state.playing, 'stale', 'expired messages remain available for manual replay');
});

test('a clip that expires while its buffer loads is skipped and the fresh queue continues', async () => {
  const download = deferred();
  const run = setup({ fetchClip: url => url === 'memory:first' ? download.promise : Promise.resolve(response(url)) });
  run.sound.unlock();
  run.sound.receive('first', 'stale');
  await settle();
  run.advance(30_001);
  run.sound.receive('second', 'fresh');
  download.resolve(response('memory:first'));
  await settle();
  assert.equal(run.sound.state.playing, 'fresh');
  assert.equal(run.sources.length, 1);
  assert.equal(run.sources[0].buffer.clip, 'memory:second');
});
