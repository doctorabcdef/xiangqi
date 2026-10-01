import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBoard, pseudoMoves, legalMoves, applyMove, inCheck, outcome, positionKey, replay, notation } from '../src/engine.js';
import { chooseMove } from '../src/ai.js';

const square = (x, y) => y * 9 + x;
const move = (x1, y1, x2, y2) => ({ from: square(x1, y1), to: square(x2, y2) });
function position(...pieces) {
  const board = Array(90).fill(null);
  for (const [side, type, x, y] of pieces) board[square(x, y)] = { side, type };
  return board;
}
const can = (board, side, m) => legalMoves(board, side, m.from).some(candidate => candidate.to === m.to);
const destinations = (board, x, y) => pseudoMoves(board, square(x, y));

test('opening has 32 pieces, red and black each have 44 legal moves', () => {
  const board = initialBoard();
  assert.equal(board.filter(Boolean).length, 32);
  for (const side of ['red', 'black']) {
    assert.equal(board.filter(p => p?.side === side).length, 16);
    assert.equal(inCheck(board, side), false);
    assert.equal(legalMoves(board, side).length, 44);
  }
});

test('horse leg blocks only the corresponding direction, regardless of blocker color', () => {
  for (const side of ['red', 'black']) {
    const board = position(['red', 'n', 4, 5], [side, 'p', 4, 4]);
    const targets = destinations(board, 4, 5);
    assert.equal(targets.length, 6);
    assert.ok(!targets.includes(square(3, 3)));
    assert.ok(!targets.includes(square(5, 3)));
    assert.ok(targets.includes(square(2, 4)));
    assert.ok(targets.includes(square(6, 4)));
  }
});

test('horse cannot wrap around an edge', () => {
  assert.deepEqual(destinations(position(['red', 'n', 0, 0]), 0, 0).sort((a, b) => a - b), [square(2, 1), square(1, 2)]);
});

test('elephant cannot cross the river and its eye may be blocked by either side', () => {
  const board = position(['red', 'b', 2, 7]);
  assert.ok(destinations(board, 2, 7).includes(square(4, 5)));
  for (const side of ['red', 'black']) {
    board[square(3, 6)] = { side, type: 'p' };
    assert.ok(!destinations(board, 2, 7).includes(square(4, 5)));
  }
  assert.ok(!destinations(position(['red', 'b', 2, 5]), 2, 5).includes(square(4, 3)));
  assert.ok(!destinations(position(['black', 'b', 2, 4]), 2, 4).includes(square(4, 6)));
});

test('advisor and general stay in their palace and use different step directions', () => {
  assert.deepEqual(destinations(position(['red', 'a', 3, 9]), 3, 9), [square(4, 8)]);
  assert.deepEqual(destinations(position(['black', 'a', 4, 1]), 4, 1).sort((a, b) => a - b), [square(3, 0), square(5, 0), square(3, 2), square(5, 2)]);
  assert.deepEqual(destinations(position(['red', 'k', 3, 7]), 3, 7).sort((a, b) => a - b), [square(4, 7), square(3, 8)]);
});

test('rook stops at friendly blockers and may capture only the first enemy', () => {
  const board = position(['red', 'r', 0, 5], ['red', 'p', 0, 3], ['black', 'p', 3, 5], ['black', 'r', 5, 5]);
  const targets = destinations(board, 0, 5);
  assert.ok(targets.includes(square(0, 4)));
  assert.ok(!targets.includes(square(0, 3)));
  assert.ok(!targets.includes(square(0, 2)));
  assert.ok(targets.includes(square(3, 5)));
  assert.ok(!targets.includes(square(4, 5)));
  assert.ok(!targets.includes(square(5, 5)));
});

test('cannon captures with exactly one screen of either color, never with zero or two', () => {
  const board = position(['red', 'c', 0, 7], ['black', 'r', 0, 2]);
  assert.ok(!destinations(board, 0, 7).includes(square(0, 2)));
  for (const side of ['red', 'black']) {
    board[square(0, 5)] = { side, type: 'p' };
    const targets = destinations(board, 0, 7);
    assert.ok(targets.includes(square(0, 2)));
    assert.ok(!targets.includes(square(0, 5)));
    assert.ok(!targets.includes(square(0, 4)));
    assert.ok(!targets.includes(square(0, 1)));
  }
  board[square(0, 3)] = { side: 'red', type: 'p' };
  assert.ok(!destinations(board, 0, 7).includes(square(0, 2)));
});

test('soldiers gain sideways moves only after crossing and never move backwards or promote', () => {
  assert.deepEqual(destinations(position(['red', 'p', 4, 5]), 4, 5), [square(4, 4)]);
  assert.deepEqual(destinations(position(['black', 'p', 4, 4]), 4, 4), [square(4, 5)]);
  assert.deepEqual(destinations(position(['red', 'p', 4, 4]), 4, 4).sort((a, b) => a - b), [square(4, 3), square(3, 4), square(5, 4)]);
  assert.deepEqual(destinations(position(['black', 'p', 4, 5]), 4, 5).sort((a, b) => a - b), [square(3, 5), square(5, 5), square(4, 6)]);
  const board = position(['red', 'p', 0, 1]);
  const next = applyMove(board, move(0, 1, 0, 0));
  assert.equal(next[square(0, 0)].type, 'p');
  assert.deepEqual(destinations(next, 0, 0), [square(1, 0)]);
});

test('a lone piece between the generals cannot expose facing generals', () => {
  const board = position(['black', 'k', 4, 0], ['red', 'k', 4, 9], ['red', 'c', 4, 5]);
  assert.equal(inCheck(board, 'red'), false);
  assert.equal(inCheck(board, 'black'), false);
  assert.equal(can(board, 'red', move(4, 5, 5, 5)), false);
  assert.equal(can(board, 'red', move(4, 5, 4, 4)), true);
  board[square(4, 5)] = null;
  assert.equal(inCheck(board, 'red'), true);
  assert.equal(inCheck(board, 'black'), true);
});

test('check must be answered; blocking an attacking rook is a legal answer', () => {
  const board = position(['black', 'k', 3, 0], ['red', 'k', 4, 9], ['black', 'r', 4, 0], ['red', 'r', 0, 5]);
  assert.equal(inCheck(board, 'red'), true);
  assert.equal(can(board, 'red', move(0, 5, 4, 5)), true);
  assert.equal(can(board, 'red', move(0, 5, 0, 4)), false);
  assert.equal(can(board, 'red', move(4, 9, 3, 9)), false);
  assert.equal(can(board, 'red', move(4, 9, 5, 9)), true);
});

test('moving a cannon screen away can answer check; removing a second screen can expose check', () => {
  const board = position(['black', 'k', 3, 0], ['red', 'k', 4, 9], ['black', 'c', 4, 0], ['red', 'r', 4, 5]);
  assert.equal(inCheck(board, 'red'), true);
  assert.equal(can(board, 'red', move(4, 5, 5, 5)), true);
  board[square(4, 7)] = { side: 'red', type: 'p' };
  assert.equal(inCheck(board, 'red'), false);
  assert.equal(can(board, 'red', move(4, 5, 5, 5)), false);
});

test('checkmate accounts for a protected capture through the facing-generals rule', () => {
  const board = position(['black', 'k', 4, 0], ['red', 'k', 4, 9], ['red', 'r', 0, 0], ['red', 'r', 4, 1]);
  assert.equal(inCheck(board, 'black'), true);
  assert.deepEqual(legalMoves(board, 'black'), []);
  assert.deepEqual(outcome(board, 'black'), { winner: 'red', reason: '将死' });
});

test('stalemate is a loss rather than a draw', () => {
  const board = position(['black', 'k', 4, 0], ['red', 'k', 4, 9], ['red', 'n', 4, 2], ['red', 'r', 0, 1]);
  assert.equal(inCheck(board, 'black'), false);
  assert.deepEqual(legalMoves(board, 'black'), []);
  assert.deepEqual(outcome(board, 'black'), { winner: 'red', reason: '困毙' });
  assert.equal(chooseMove(board, 'black', 'easy'), null);
});

test('move generation and applying captures leave the source board unchanged', () => {
  const board = position(['black', 'k', 3, 0], ['red', 'k', 4, 9], ['red', 'r', 0, 5], ['black', 'p', 0, 3]);
  const before = JSON.stringify(board);
  legalMoves(board, 'red');
  const next = applyMove(board, move(0, 5, 0, 3));
  assert.equal(JSON.stringify(board), before);
  assert.equal(next[square(0, 5)], null);
  assert.deepEqual(next[square(0, 3)], { side: 'red', type: 'r' });
});

test('replaying a saved game reconstructs turn, board, notation and repetition keys', () => {
  const moves = [move(1, 7, 4, 7), move(1, 0, 2, 2), move(1, 9, 2, 7)];
  const restored = replay(moves);
  assert.equal(restored.side, 'black');
  assert.equal(restored.records.length, 3);
  assert.equal(restored.positions.length, 4);
  assert.equal(restored.records[0].text, '炮八平五');
  assert.equal(restored.board[square(4, 7)].type, 'c');
  assert.equal(restored.positions.at(-1), positionKey(restored.board, 'black'));
  assert.notEqual(positionKey(restored.board, 'red'), positionKey(restored.board, 'black'));
  assert.equal(notation(initialBoard(), move(1, 0, 2, 2)), '马2进3');
});

test('replay rejects malformed, wrong-turn and illegal moves', () => {
  for (const invalid of [null, {}, { from: -1, to: 0 }, { from: 90, to: 0 }, { from: 54, to: 54.5 }, { from: '54', to: 45 }]) {
    assert.throws(() => replay([invalid]), /坐标无效/);
  }
  assert.throws(() => replay([move(0, 3, 0, 4)]), /不合法/);
  assert.throws(() => replay([move(0, 6, 1, 6)]), /不合法/);
  assert.throws(() => replay([move(1, 9, 3, 8)]), /不合法/);
});

test('third occurrence includes the initial position and terminates the casual game', () => {
  const cycle = [move(1, 9, 2, 7), move(1, 0, 2, 2), move(2, 7, 1, 9), move(2, 2, 1, 0)];
  const two = replay(cycle);
  const twice = two.positions.filter(key => key === two.positions.at(-1)).length;
  assert.equal(twice, 2);
  assert.equal(outcome(two.board, two.side, twice), null);
  const three = replay([...cycle, ...cycle]);
  const thrice = three.positions.filter(key => key === three.positions.at(-1)).length;
  assert.equal(thrice, 3);
  assert.deepEqual(outcome(three.board, three.side, thrice), { winner: null, reason: '三次重复局面，和棋' });
  assert.throws(() => replay([...cycle, ...cycle, cycle[0]]), /对局结束/);
});

test('AI finds mate in one and returns only legal moves without changing the board', () => {
  const board = position(['black', 'k', 4, 0], ['red', 'k', 4, 9], ['red', 'r', 0, 1], ['red', 'r', 4, 2]);
  const before = JSON.stringify(board);
  const selected = chooseMove(board, 'red', 'easy', [positionKey(board, 'red')]);
  assert.ok(selected);
  assert.ok(can(board, 'red', selected));
  assert.deepEqual(outcome(applyMove(board, selected), 'black'), { winner: 'red', reason: '将死' });
  assert.equal(JSON.stringify(board), before);
});

test('every AI difficulty returns a legal reply to check within a bounded time', { timeout: 15000 }, () => {
  const board = position(['black', 'k', 3, 0], ['red', 'k', 4, 9], ['black', 'r', 4, 0], ['red', 'r', 0, 5]);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const start = performance.now();
    const selected = chooseMove(board, 'red', difficulty, [positionKey(board, 'red')]);
    assert.ok(selected);
    assert.ok(can(board, 'red', selected));
    assert.equal(inCheck(applyMove(board, selected), 'red'), false);
    assert.ok(performance.now() - start < 7000);
  }
});
