import { legalMoves, applyMove, opposite, inCheck, positionKey } from './engine.js';
const values = { k: 20000, r: 900, c: 440, n: 410, b: 210, a: 210, p: 100 };
function evaluate(board, side) {
  let score = 0;
  board.forEach((p, index) => {
    if (!p) return;
    const row = Math.floor(index / 9), progress = p.side === 'red' ? 9 - row : row;
    const center = 4 - Math.abs(index % 9 - 4);
    const bonus = p.type === 'p' ? progress * 9 + (progress >= 5 ? 70 + center * 10 : 0) : ['n', 'c', 'r'].includes(p.type) ? center * 7 + Math.min(progress, 7) * 4 : 0;
    score += (values[p.type] + bonus) * (p.side === side ? 1 : -1);
  });
  return score;
}
export function chooseMove(board, side, difficulty = 'medium', previousPositions = []) {
  const budget = { easy: 180, medium: 650, hard: 1600 }[difficulty] ?? 650;
  const maxDepth = { easy: 1, medium: 3, hard: 5 }[difficulty] ?? 3;
  const deadline = performance.now() + budget, timeout = Symbol('timeout');
  const moves = legalMoves(board, side);
  if (!moves.length) return null;
  let best = moves[0], nodes = 0;
  const order = (b, list, first) => list.sort((a, z) => {
    const rank = m => (first?.from === m.from && first?.to === m.to ? 100000 : 0) + (b[m.to] ? values[b[m.to].type] * 10 - values[b[m.from].type] : 0);
    return rank(z) - rank(a);
  });
  function search(b, turn, depth, alpha, beta, ply, path) {
    if (++nodes % 64 === 0 && performance.now() > deadline) throw timeout;
    if (!b.some(p => p?.type === 'k' && p.side === turn)) return -100000 + ply;
    const key = positionKey(b, turn);
    if (path.filter(p => p === key).length >= 3) return 0;
    const list = legalMoves(b, turn);
    if (!list.length) return -100000 + ply;
    if (depth <= 0) return evaluate(b, turn) - (inCheck(b, turn) ? 35 : 0);
    for (const m of order(b, list)) {
      const next = applyMove(b, m), nextSide = opposite(turn);
      const value = -search(next, nextSide, depth - 1, -beta, -alpha, ply + 1, [...path, positionKey(next, nextSide)]);
      if (value >= beta) return value;
      alpha = Math.max(alpha, value);
    }
    return alpha;
  }
  for (let depth = 1; depth <= maxDepth; depth++) {
    let localBest = best, alpha = -Infinity;
    try {
      for (const m of order(board, moves, best)) {
        if (performance.now() > deadline) throw timeout;
        const next = applyMove(board, m), nextSide = opposite(side);
        const value = -search(next, nextSide, depth - 1, -Infinity, -alpha, 1, [...previousPositions, positionKey(next, nextSide)]);
        if (value > alpha) { alpha = value; localBest = m; }
      }
      best = localBest;
    } catch (error) { if (error !== timeout) throw error; break; }
  }
  return best;
}
