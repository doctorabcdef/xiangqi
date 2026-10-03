import test from 'node:test';
import assert from 'node:assert/strict';
import { freshState, validateState } from '../src/state.js';
import { replay } from '../src/engine.js';

test('new games default to human red and can explicitly choose human black', () => {
  assert.equal(freshState().humanSide, 'red');
  const black = freshState('ai', 'easy', 'black');
  assert.equal(black.humanSide, 'black');
  assert.equal(black.mode, 'ai');
  assert.equal(black.difficulty, 'easy');
  assert.deepEqual(black.moves, []);
  assert.equal(replay(black.moves).side, 'red');
});

test('legacy saves without humanSide remain human red without losing progress', () => {
  const legacy = { ...freshState(), moves: [{ from: 54, to: 45 }, { from: 27, to: 36 }] };
  delete legacy.humanSide;
  const loaded = validateState(legacy);
  assert.equal(loaded.humanSide, 'red');
  assert.deepEqual(loaded.moves, legacy.moves);
  assert.equal(loaded.updatedAt, legacy.updatedAt);
  assert.equal('humanSide' in legacy, false);
});

test('black-side saves retain the computer opening and human turn on JSON roundtrip', () => {
  const state = { ...freshState('ai', 'hard', 'black'), moves: [{ from: 54, to: 45 }] };
  const loaded = validateState(JSON.parse(JSON.stringify(state)));
  assert.equal(loaded.humanSide, 'black');
  assert.equal(replay(loaded.moves).side, 'black');
  assert.deepEqual(loaded.moves, state.moves);
  assert.equal(validateState({ ...state, mode: 'local' }).humanSide, 'black');
});

test('an explicitly invalid human side is rejected rather than silently reassigned', () => {
  for (const humanSide of [null, '', 'white', 'RED', 0, false, {}, []]) {
    assert.throws(() => validateState({ ...freshState(), humanSide }));
  }
});
