export const SIDES = ['red', 'black'];
export const opposite = side => side === 'red' ? 'black' : 'red';
export const names = { red: { k: '帅', a: '仕', b: '相', n: '马', r: '车', c: '炮', p: '兵' }, black: { k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒' } };
export const label = piece => piece ? names[piece.side][piece.type] : '';
const inside = (r, c) => r >= 0 && r < 10 && c >= 0 && c < 9;
const palace = (r, c, side) => c >= 3 && c <= 5 && (side === 'red' ? r >= 7 && r <= 9 : r >= 0 && r <= 2);
export function initialBoard() {
  const board = Array(90).fill(null);
  const row = ['r', 'n', 'b', 'a', 'k', 'a', 'b', 'n', 'r'];
  for (const side of SIDES) {
    const base = side === 'red' ? 9 : 0;
    row.forEach((type, c) => { board[base * 9 + c] = { type, side }; });
    for (const c of [1, 7]) board[(side === 'red' ? 7 : 2) * 9 + c] = { type: 'c', side };
    for (const c of [0, 2, 4, 6, 8]) board[(side === 'red' ? 6 : 3) * 9 + c] = { type: 'p', side };
  }
  return board;
}
export function pseudoMoves(board, from) {
  const piece = board[from];
  if (!piece) return [];
  const { type, side } = piece, r = Math.floor(from / 9), c = from % 9, result = [];
  const add = (nr, nc) => {
    if (inside(nr, nc) && board[nr * 9 + nc]?.side !== side) result.push(nr * 9 + nc);
  };
  if (type === 'r' || type === 'c') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let screen = false;
      for (let nr = r + dr, nc = c + dc; inside(nr, nc); nr += dr, nc += dc) {
        const target = board[nr * 9 + nc];
        if (!screen) {
          if (!target) add(nr, nc);
          else {
            if (type === 'r') { add(nr, nc); break; }
            screen = true;
          }
        } else if (target) { add(nr, nc); break; }
      }
    }
  } else if (type === 'n') {
    for (const [dr, dc] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [-1, 2], [1, -2], [-1, -2]]) {
      if (!board[(r + (Math.abs(dr) === 2 ? Math.sign(dr) : 0)) * 9 + c + (Math.abs(dc) === 2 ? Math.sign(dc) : 0)]) add(r + dr, c + dc);
    }
  } else if (type === 'b') {
    for (const dr of [-2, 2]) for (const dc of [-2, 2]) {
      const nr = r + dr;
      if ((side === 'red' ? nr >= 5 : nr <= 4) && !board[(r + dr / 2) * 9 + c + dc / 2]) add(nr, c + dc);
    }
  } else if (type === 'a') {
    for (const dr of [-1, 1]) for (const dc of [-1, 1]) if (palace(r + dr, c + dc, side)) add(r + dr, c + dc);
  } else if (type === 'k') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (palace(r + dr, c + dc, side)) add(r + dr, c + dc);
    for (const dr of [-1, 1]) {
      for (let nr = r + dr; inside(nr, c); nr += dr) {
        const target = board[nr * 9 + c];
        if (target) { if (target.side !== side && target.type === 'k') add(nr, c); break; }
      }
    }
  } else if (type === 'p') {
    add(r + (side === 'red' ? -1 : 1), c);
    if (side === 'red' ? r <= 4 : r >= 5) { add(r, c - 1); add(r, c + 1); }
  }
  return result;
}
export function applyMove(board, move) {
  const next = board.slice();
  next[move.to] = next[move.from]; next[move.from] = null;
  return next;
}
export function inCheck(board, side) {
  const king = board.findIndex(p => p?.side === side && p.type === 'k');
  if (king < 0) return true;
  return board.some((p, i) => p && p.side !== side && pseudoMoves(board, i).includes(king));
}
export function legalMoves(board, side, from = null) {
  const result = [];
  for (let i = 0; i < 90; i++) {
    if ((from !== null && from !== i) || board[i]?.side !== side) continue;
    for (const to of pseudoMoves(board, i)) {
      const move = { from: i, to };
      if (!inCheck(applyMove(board, move), side)) result.push(move);
    }
  }
  return result;
}
export function positionKey(board, side) {
  return board.map(p => p ? (p.side === 'red' ? p.type.toUpperCase() : p.type) : '.').join('') + side;
}
export function outcome(board, side, repetitions = 1) {
  if (!board.some(p => p?.type === 'k' && p.side === side) || !legalMoves(board, side).length) {
    return { winner: opposite(side), reason: inCheck(board, side) ? '将死' : '困毙' };
  }
  if (repetitions >= 3) return { winner: null, reason: '三次重复局面，和棋' };
  return null;
}
const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export function notation(board, { from, to }) {
  const piece = board[from], fr = Math.floor(from / 9), tr = Math.floor(to / 9), fc = from % 9, tc = to % 9;
  const number = n => piece.side === 'red' ? numerals[n - 1] : String(n);
  const file = c => piece.side === 'red' ? 9 - c : c + 1;
  const direction = fr === tr ? '平' : ((tr - fr) * (piece.side === 'red' ? -1 : 1) > 0 ? '进' : '退');
  const end = fr === tr || ['n', 'b', 'a'].includes(piece.type) ? file(tc) : Math.abs(tr - fr);
  const same = board.map((p, i) => ({ p, i })).filter(({ p, i }) => p?.side === piece.side && p.type === piece.type && i % 9 === fc);
  let start = label(piece) + number(file(fc));
  if (same.length === 2) {
    const front = piece.side === 'red' ? Math.min(...same.map(x => x.i)) : Math.max(...same.map(x => x.i));
    start = (from === front ? '前' : '后') + label(piece);
  }
  return start + direction + number(end);
}
export function replay(moves) {
  let board = initialBoard(), side = 'red';
  const records = [], positions = [positionKey(board, side)];
  for (const move of moves) {
    if (!move || !Number.isInteger(move.from) || !Number.isInteger(move.to) || move.from < 0 || move.from > 89 || move.to < 0 || move.to > 89) throw new Error('棋谱坐标无效');
    if (outcome(board, side, positions.filter(p => p === positions.at(-1)).length)) throw new Error('棋谱在对局结束后仍有走子');
    if (!legalMoves(board, side, move.from).some(m => m.to === move.to)) throw new Error('棋谱包含不合法的走子');
    records.push({ ...move, side, text: notation(board, move), captured: board[move.to], piece: board[move.from] });
    board = applyMove(board, move); side = opposite(side); positions.push(positionKey(board, side));
  }
  return { board, side, records, positions };
}
