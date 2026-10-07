import { label, legalMoves, inCheck, outcome, replay } from './engine.js';
import { freshState, validateState } from './state.js';
import { GameSync } from './sync.js?v=20261007-live';
const $ = id => document.getElementById(id);
let state, game, selected = null, targets = [], flipped = false, ready = false, thinking = false, worker = null, aiTimer = null, generation = 0, toastTimer;
function saveOrientation(next = state) {
  try { localStorage.setItem('yijian.flip', String(flipped)); localStorage.setItem('yijian.flip-side', next.humanSide); } catch {}
}
function orientFor(next, previous) {
  if (previous && next.humanSide === previous.humanSide && next.mode === previous.mode) return;
  flipped = next.mode === 'ai' && next.humanSide === 'black';
  if (!previous) {
    try {
      const stored = localStorage.getItem('yijian.flip');
      if (stored !== null && (localStorage.getItem('yijian.flip-side') ?? 'red') === next.humanSide) flipped = stored === 'true';
    } catch {}
  }
  saveOrientation(next);
}
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000); }
const sync = new GameSync({
  onStatus(kind, message) { $('save-label').textContent = message.split(' · ')[0]; $('save-indicator').className = 'status-dot ' + (kind === 'saved' ? '' : kind); $('sync-detail').textContent = message; },
  onRemote(next) { cancelAI(); orientFor(next, state); state = next; game = replay(state.moves); selected = null; targets = []; render(); maybeAI(); },
  onConflict() { cancelAI(); if (!$('conflict-dialog').open) $('conflict-dialog').showModal(); render(); },
});
state = sync.data.state; orientFor(state); game = replay(state.moves);
const grid = [];
for (let row = 0; row < 10; row++) grid.push(`<path d="M50 ${row * 100 + 50}H850"/>`);
for (let col = 0; col < 9; col++) grid.push(`<path d="M${col * 100 + 50} 50V${col === 0 || col === 8 ? 950 : 450}${col > 0 && col < 8 ? `M${col * 100 + 50} 550V950` : ''}"/>`);
grid.push('<rect x="38" y="38" width="824" height="924" fill="none" stroke-width="3"/><path d="M350 50 550 250M550 50 350 250M350 750 550 950M550 750 350 950"/>');
for (const [r, cols] of [[2, [1, 7]], [3, [0, 2, 4, 6, 8]], [6, [0, 2, 4, 6, 8]], [7, [1, 7]]]) {
  for (const c of cols) for (const dx of [-1, 1]) for (const dy of [-1, 1]) {
    if ((c === 0 && dx < 0) || (c === 8 && dx > 0)) continue;
    const x = c * 100 + 50, y = r * 100 + 50;
    grid.push(`<path d="M${x + dx * 10} ${y + dy * 26}V${y + dy * 10}H${x + dx * 26}"/>`);
  }
}
$('grid-lines').innerHTML = grid.join('');
const squares = [];
for (let i = 0; i < 90; i++) {
  const square = document.createElement('button'); square.type = 'button'; square.className = 'square'; square.dataset.index = i;
  square.addEventListener('click', () => selectSquare(i));
  square.addEventListener('keydown', event => {
    const offset = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (offset === undefined) { if (event.key === 'Escape') { selected = null; targets = []; render(); } return; }
    event.preventDefault(); const next = i + offset * (flipped ? -1 : 1);
    if (next >= 0 && next < 90 && (Math.abs(offset) === 9 || Math.floor(i / 9) === Math.floor(next / 9))) squares[next].focus();
  });
  squares.push(square); $('squares').append(square);
}
function result() { const key = game.positions.at(-1); return outcome(game.board, game.side, game.positions.filter(p => p === key).length); }
function sideName(side) { return side === 'red' ? '红方' : '黑方'; }
function undoTarget() { return state.mode === 'local' ? state.moves.length - 1 : game.records.findLastIndex(record => record.side === state.humanSide); }
function render() {
  const end = result(), checked = inCheck(game.board, game.side), last = state.moves.at(-1);
  const humanTurn = state.mode === 'local' || game.side === state.humanSide;
  for (let i = 0; i < 90; i++) {
    const visual = flipped ? 89 - i : i, piece = game.board[i], square = squares[i];
    square.style.left = ((visual % 9 + .5) / 9 * 100) + '%'; square.style.top = ((Math.floor(visual / 9) + .5) / 10 * 100) + '%';
    square.className = ['square', selected === i ? 'selected' : '', targets.includes(i) ? 'target' : '', last && (last.from === i || last.to === i) ? 'last-move' : '', piece?.type === 'k' && piece.side === game.side && checked ? 'checked' : ''].filter(Boolean).join(' ');
    square.innerHTML = piece ? `<span class="piece ${piece.side}">${label(piece)}</span>` : '';
    square.setAttribute('aria-label', `${piece ? sideName(piece.side) + label(piece) : '空位'}，第${Math.floor(i / 9) + 1}行第${i % 9 + 1}列${targets.includes(i) ? '，可落子' : ''}`);
    square.setAttribute('aria-pressed', String(selected === i));
    square.tabIndex = (selected === i || (selected === null && i === (flipped ? 4 : 85))) ? 0 : -1;
  }
  $('board').setAttribute('aria-label', `象棋棋盘，${flipped ? '黑' : '红'}方在下方，${sideName(game.side)}走棋`);
  $('round-label').textContent = `第 ${Math.floor(state.moves.length / 2) + 1} 回合`;
  $('turn-piece').textContent = end ? (end.winner === null ? '和' : end.winner === 'red' ? '帅' : '将') : game.side === 'red' ? '帅' : '将';
  $('turn-piece').classList.toggle('black', (end?.winner ?? game.side) === 'black');
  $('game-status').textContent = end ? end.winner ? sideName(end.winner) + '获胜' : '握手言和' : !ready ? '恢复棋局中' : thinking ? sideName(game.side) + '思考中' : checked ? sideName(game.side) + '被将军' : state.moves.length === 0 ? '红方先行' : sideName(game.side) + '行棋';
  $('game-detail').textContent = end ? end.reason + ' · 再来一局？' : !ready ? '正在读取已保存的进度…' : checked ? '请应将，保护好你的将帅。' : thinking ? '棋逢对手，静待好棋。' : state.moves.length === 0 ? '点选红方棋子，开始这盘棋。' : humanTurn ? '选择棋子，绿色标记为合法落点。' : '电脑正在选择下一步。';
  for (const [position, side] of [['top', flipped ? 'red' : 'black'], ['bottom', flipped ? 'black' : 'red']]) {
    const avatar = $(position + '-name').closest('.player-identity').querySelector('.player-avatar');
    avatar.textContent = side === 'red' ? '帅' : '将'; avatar.className = 'player-avatar ' + side + '-avatar';
    $(position + '-name').textContent = state.mode === 'ai' ? side === state.humanSide ? '我方棋手' : '电脑棋手' : sideName(side) + '棋手';
    $(position + '-description').textContent = sideName(side) + ' · ' + (side === 'red' ? '先手' : '后手');
    const active = !end && game.side === side;
    $(position + '-turn').textContent = end ? '对局结束' : active ? thinking ? '思考中…' : '正在行棋' : '等待落子';
    $(position + '-turn').classList.toggle('active', active);
  }
  // Derive captures from the current replay, so undo, imports and cloud restores
  // always restore both the board and the captured-piece trays together.
  for (const side of ['black', 'red']) {
    const captures = game.records.filter(record => record.side === side && record.captured);
    const tray = $(side + '-captured');
    tray.replaceChildren();
    $(side + '-capture-count').textContent = captures.length + ' 枚';
    if (!captures.length) {
      const empty = document.createElement('p'); empty.className = 'capture-empty'; empty.textContent = '暂无吃子'; tray.append(empty);
    }
    for (const { captured } of captures) {
      const piece = document.createElement('span');
      piece.className = 'piece ' + captured.side + ' captured-piece';
      piece.textContent = label(captured);
      piece.title = sideName(side) + '吃掉的' + sideName(captured.side) + label(captured);
      piece.setAttribute('role', 'listitem'); piece.setAttribute('aria-label', piece.title);
      tray.append(piece);
    }
  }
  $('mode-ai').classList.toggle('selected', state.mode === 'ai'); $('mode-ai').setAttribute('aria-pressed', state.mode === 'ai');
  $('mode-local').classList.toggle('selected', state.mode === 'local'); $('mode-local').setAttribute('aria-pressed', state.mode === 'local');
  $('difficulty-row').hidden = state.mode !== 'ai'; $('difficulty').value = state.difficulty;
  $('human-side-row').hidden = state.mode !== 'ai'; $('human-side').value = state.humanSide;
  $('human-side').disabled = !ready || Boolean(sync.conflict);
  $('undo').disabled = !ready || undoTarget() < 0 || Boolean(sync.conflict);
  $('undo-board').disabled = $('undo').disabled;
  const undoHint = state.mode === 'ai' ? undoTarget() < 0 ? '你落子后即可悔棋' : game.side !== state.humanSide ? '撤回刚走的一步，并取消电脑落子' : '人机悔棋撤回双方最近一轮' : '双人悔棋撤回最近一步';
  $('undo').title = $('undo-board').title = undoHint; $('undo-hint').textContent = undoHint;
  $('new-game').disabled = !ready || Boolean(sync.conflict);
  $('move-count').textContent = state.moves.length + ' 手';
  const list = $('move-list');
  if (game.records.length) {
    list.replaceChildren();
    for (let i = 0; i < game.records.length; i += 2) {
      const row = document.createElement('div'); row.className = 'move-row';
      for (const text of [String(i / 2 + 1).padStart(2, '0'), game.records[i].text, game.records[i + 1]?.text ?? '—']) { const span = document.createElement('span'); span.textContent = text; row.append(span); }
      list.append(row);
    }
    list.scrollTop = list.scrollHeight;
  } else list.innerHTML = '<div class="empty-moves"><span>棋</span><p>方寸棋盘，静候开局</p><small>落子后将在这里记录棋谱</small></div>';
  $('sync-code').value = sync.data.code;
}
function selectSquare(index) {
  if (!ready || sync.conflict) return;
  if (result()) { toast('对局已结束，可以开始新对局'); return; }
  if (thinking || (state.mode === 'ai' && game.side !== state.humanSide)) return;
  if (selected !== null && targets.includes(index)) { move({ from: selected, to: index }); return; }
  if (game.board[index]?.side === game.side) {
    selected = selected === index ? null : index;
    targets = selected === null ? [] : legalMoves(game.board, game.side, selected).map(m => m.to);
    render();
    if (selected !== null && !targets.length) toast('这枚棋子暂时没有合法落点');
  } else { selected = null; targets = []; render(); }
}
function commit(next) {
  cancelAI(); orientFor(next, state); state = { ...next, updatedAt: new Date().toISOString() }; game = replay(state.moves); selected = null; targets = [];
  sync.save(state); render(); maybeAI();
}
function move(value) {
  if (!ready || sync.conflict || result() || !legalMoves(game.board, game.side, value.from).some(m => m.to === value.to)) return false;
  if (state.moves.length >= 1000) { toast('棋谱已达 1000 手，请导出备份后开始新局'); return false; }
  commit({ ...state, moves: [...state.moves, value] });
  const end = result(); if (end) toast(end.winner ? sideName(end.winner) + '获胜 · ' + end.reason : end.reason); else if (inCheck(game.board, game.side)) toast('将军！');
  return true;
}
function cancelAI() { generation++; clearTimeout(aiTimer); worker?.terminate(); worker = null; thinking = false; }
function maybeAI() {
  if (!ready || thinking || sync.conflict || state.mode !== 'ai' || game.side === state.humanSide || result()) return;
  thinking = true; render(); const id = generation;
  aiTimer = setTimeout(() => {
    if (generation !== id) return;
    const fallback = () => {
      if (generation !== id) return;
      const candidate = legalMoves(game.board, game.side)[0];
      worker?.terminate(); worker = null; thinking = false;
      if (candidate) { toast('电脑已使用备用着法'); move(candidate); } else render();
    };
    try {
      worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (generation !== id || data.id !== id) return;
        if (data.error) { fallback(); return; }
        worker.terminate(); worker = null; thinking = false;
        if (data.move) move(data.move); else render();
      };
      worker.onerror = fallback;
      worker.postMessage({ id, board: game.board, side: game.side, difficulty: state.difficulty, positions: game.positions });
    } catch { fallback(); }
  }, 350);
}
async function confirmAction(title, message, action = '确认') {
  const dialog = $('confirm-dialog'); if (dialog.open) return false;
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-action').textContent = action;
  dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
async function changeMode(mode) {
  if (!ready || sync.conflict || mode === state.mode) return;
  if (state.moves.length && !await confirmAction('切换对弈模式？', '切换模式将开始新对局，并同步到其他设备。当前棋局可先导出备份。', '切换并开局')) return;
  commit(freshState(mode, state.difficulty, state.humanSide));
}
$('mode-ai').onclick = () => changeMode('ai'); $('mode-local').onclick = () => changeMode('local');
$('human-side').onchange = async () => {
  const humanSide = $('human-side').value;
  if (!ready || sync.conflict || humanSide === state.humanSide) { render(); return; }
  render();
  if (state.moves.length && !await confirmAction('更换执棋方并开局？', `你将执${humanSide === 'red' ? '红棋先行' : '黑棋，电脑执红先行'}。当前棋局会被替换并同步，可先导出备份。`, '换边并开局')) { render(); return; }
  if (sync.conflict) return;
  commit(freshState('ai', state.difficulty, humanSide));
};
$('difficulty').onchange = () => { if (ready && !sync.conflict) commit({ ...state, difficulty: $('difficulty').value }); else render(); };
$('new-game').onclick = async () => { if (await confirmAction('开始一盘新棋？', '当前棋局会被替换，并同步到其他设备。你可以先导出棋局留作备份。', '开始新局')) commit(freshState(state.mode, state.difficulty, state.humanSide)); };
function undoMove() {
  const target = undoTarget();
  if (!ready || sync.conflict || target < 0) return;
  commit({ ...state, moves: state.moves.slice(0, target) }); toast('已悔棋');
}
$('undo').onclick = undoMove; $('undo-board').onclick = undoMove;
$('flip').onclick = () => { flipped = !flipped; saveOrientation(); render(); };
$('help-open').onclick = () => $('help-dialog').showModal();
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
function openSync() { $('sync-code').value = sync.data.code; $('join-error').textContent = ''; $('sync-dialog').showModal(); }
$('sync-open').onclick = openSync; $('sync-card').onclick = openSync;
$('copy-code').onclick = async () => { try { await navigator.clipboard.writeText(sync.data.code); toast('棋局标识已复制'); } catch { $('sync-code').select(); toast('请长按或按 Ctrl+C 复制同步码'); } };
$('join-game').onclick = async () => {
  if (!ready || sync.conflict) return;
  if (state.moves.length && !await confirmAction('连接另一盘棋？', '本机当前棋局将被云端棋局替换。需要保留时，请先导出备份。', '连接棋局')) return;
  $('join-game').disabled = true; $('join-error').textContent = ''; cancelAI(); ready = false; render();
  try { await sync.join($('join-code').value); $('sync-dialog').close(); toast('已恢复云端棋局'); }
  catch (error) { $('join-error').textContent = error.message; }
  finally { ready = true; $('join-game').disabled = false; render(); maybeAI(); }
};
function exportGame() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = `弈间棋局-${new Date().toISOString().slice(0, 10)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export-game').onclick = exportGame; $('conflict-export').onclick = exportGame;
$('import-game').onclick = () => { if (ready && !sync.conflict) $('import-file').click(); };
$('import-file').onchange = async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  try {
    if (file.size > 65536) throw new Error('棋局文件过大');
    const imported = validateState(JSON.parse(await file.text()));
    if (await confirmAction('导入这盘棋？', `棋谱共有 ${imported.moves.length} 手，导入会替换并同步当前棋局。`, '导入棋局')) { commit(imported); toast('棋局已导入'); }
  } catch (error) { toast(error instanceof SyntaxError ? '文件不是有效的棋局 JSON' : error.message); }
};
$('conflict-dialog').addEventListener('cancel', event => event.preventDefault());
$('use-cloud').onclick = () => { sync.resolve(false); $('conflict-dialog').close(); render(); maybeAI(); };
$('use-local').onclick = () => { sync.resolve(true); $('conflict-dialog').close(); render(); maybeAI(); };
window.addEventListener('beforeunload', event => { if (sync.data.pending && !sync.localWritable) { event.preventDefault(); event.returnValue = ''; } });
render();
if (sync.storageError) toast('本机存档异常，请检查棋局或使用同步码恢复');
await sync.start(); ready = true; render(); maybeAI();
if (sync.recovered && state.moves.length) toast('已续上你的上一次棋局');
// Optional agent access uses exactly the same legal-move and persistence path.
if (document.modelContext?.registerTool) {
  try {
    await document.modelContext.registerTool({ name: 'xiangqi_get_position', description: '读取当前象棋局面及合法着法，不包含同步码。', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => ({ board: game.board, side: game.side, moves: legalMoves(game.board, game.side), outcome: result() }) });
    await document.modelContext.registerTool({ name: 'xiangqi_play_move', description: '走一步合法棋，并保存当前棋局。坐标为从上往下、从左往右的 0–89 索引。', inputSchema: { type: 'object', properties: { from: { type: 'integer', minimum: 0, maximum: 89 }, to: { type: 'integer', minimum: 0, maximum: 89 } }, required: ['from', 'to'], additionalProperties: false }, execute: input => { if (!Number.isInteger(input?.from) || !Number.isInteger(input?.to) || thinking || (state.mode === 'ai' && game.side !== state.humanSide) || !move({ from: input.from, to: input.to })) throw new Error('当前无法执行此着法'); return { side: game.side, moveCount: state.moves.length }; } });
  } catch { /* Regular browsers do not require WebMCP. */ }
}
