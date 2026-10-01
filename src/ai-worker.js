import { chooseMove } from './ai.js';
self.onmessage = ({ data }) => {
  try { self.postMessage({ id: data.id, move: chooseMove(data.board, data.side, data.difficulty, data.positions) }); }
  catch { self.postMessage({ id: data.id, error: true }); }
};
