import { replay } from './engine.js';
export const freshState = (mode = 'ai', difficulty = 'medium', humanSide = 'red') => ({ version: 1, mode, difficulty, humanSide, moves: [], updatedAt: new Date().toISOString() });
export function validateState(value) {
  if (!value || value.version !== 1 || !['ai', 'local'].includes(value.mode) || !['easy', 'medium', 'hard'].includes(value.difficulty) || !Array.isArray(value.moves) || value.moves.length > 1000) throw new Error('无法识别此棋局文件');
  const humanSide = value.humanSide === undefined ? 'red' : value.humanSide;
  if (!['red', 'black'].includes(humanSide)) throw new Error('棋局执棋方无效');
  const moves = value.moves.map(m => ({ from: m?.from, to: m?.to }));
  replay(moves);
  return { version: 1, mode: value.mode, difficulty: value.difficulty, humanSide, moves, updatedAt: typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt)) ? value.updatedAt : new Date().toISOString() };
}
