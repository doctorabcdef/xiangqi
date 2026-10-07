import { CLOUD_URL } from './config.js';

export const VOICES = {
  'too-slow': { label: '太慢了太慢了', seconds: 2, url: new URL('../assets/voices/too-slow.m4a', import.meta.url).href },
  'hurry-up': { label: '搞快点好不', seconds: 2, url: new URL('../assets/voices/hurry-up.m4a', import.meta.url).href },
};
const $ = id => document.getElementById(id);
const readLocal = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const valid = message => message && uuid.test(message.id) && uuid.test(message.senderId) && typeof message.nickname === 'string' && typeof message.content === 'string' && ['text', 'voice'].includes(message.kind) && (message.kind !== 'voice' || VOICES[message.content]);

export function mountChat(getRoom) {
  const identity = readLocal('yijian.chat.identity') ?? {};
  const senderId = uuid.test(identity.senderId) ? identity.senderId : crypto.randomUUID();
  $('chat-name').value = typeof identity.nickname === 'string' ? identity.nickname.slice(0, 20) : '棋友' + senderId.slice(0, 4);
  const persistIdentity = () => { try { localStorage.setItem('yijian.chat.identity', JSON.stringify({ senderId, nickname: $('chat-name').value })); } catch {} };
  persistIdentity(); $('chat-name').addEventListener('input', persistIdentity);
  let room, generation = 0, messages = new Map(), pending = [], loaded = false, more = false, cursor = 0, oldestCursor = 0, reading, sending, nextRetry = 0, failures = 0, writable = true;
  let audio, playing = null;
  const status = (text, error = false) => { $('chat-status').textContent = text; $('chat-status').classList.toggle('error', error); };
  const outboxKey = id => 'yijian.chat.outbox.' + room + '.' + id;
  function readOutbox() {
    try {
      return Object.keys(localStorage).filter(key => key.startsWith(outboxKey(''))).map(readLocal).filter(valid);
    } catch { return []; }
  }
  function mergeOutbox() {
    for (const message of readOutbox()) if (!messages.has(message.id) && !pending.some(item => item.id === message.id)) pending.push(message);
  }
  function persist(queue = []) {
    try {
      const recent = [...messages.values()].sort((a, b) => a.sequence - b.sequence).slice(-200);
      // Each queued message owns a key, so another tab saving its empty queue
      // cannot erase this tab's unsent messages. Repeated uploads are idempotent.
      for (const message of queue) localStorage.setItem(outboxKey(message.id), JSON.stringify(message));
      localStorage.setItem('yijian.chat.' + room, JSON.stringify({ messages: recent })); writable = true;
    } catch { writable = false; }
  }
  function selectRoom() {
    const next = getRoom();
    if (next === room) return;
    if (room) persist();
    room = next; generation++; loaded = false; more = false; cursor = 0; oldestCursor = 0; failures = 0; nextRetry = 0;
    const saved = readLocal('yijian.chat.' + room);
    messages = new Map((Array.isArray(saved?.messages) ? saved.messages : []).filter(m => valid(m) && Number.isSafeInteger(m.sequence) && m.sequence > 0).map(m => [m.id, m]));
    pending = (Array.isArray(saved?.pending) ? saved.pending : []).filter(m => valid(m) && !messages.has(m.id)).slice(0, 20);
    if (pending.length) persist(pending);
    mergeOutbox();
    render(true); status('正在读取聊天记录…');
  }
  async function request(code, method = 'GET', body, query = '') {
    if (navigator.onLine === false) throw new Error('网络未连接');
    const response = await fetch(CLOUD_URL + '/api/chat' + query, {
      method, headers: { Authorization: 'Bearer ' + code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error ?? '聊天暂时无法连接'); error.status = response.status; throw error; }
    return result;
  }
  function merge(values, forceBottom = false) {
    let changed = false;
    for (const value of values) {
      if (!valid(value) || !Number.isSafeInteger(value.sequence) || value.sequence < 1) continue;
      if (!messages.has(value.id)) changed = true;
      messages.set(value.id, value);
      try { localStorage.removeItem(outboxKey(value.id)); } catch {}
    }
    const left = pending.filter(message => !messages.has(message.id));
    if (left.length !== pending.length) changed = true;
    pending = left; persist();
    if (changed) render(forceBottom);
  }
  function playbackState() {
    for (const button of document.querySelectorAll('[data-chat-play]')) {
      const active = button.dataset.chatPlay === playing;
      button.querySelector('.chat-play-icon').textContent = active ? 'Ⅱ' : '▶';
      button.querySelector('small').textContent = active ? '正在播放 · 点击暂停' : VOICES[button.dataset.clip].seconds + ' 秒 · 点击重播';
      button.setAttribute('aria-label', (active ? '暂停' : '播放') + VOICES[button.dataset.clip].label);
    }
  }
  function play(clip, id) {
    if (!VOICES[clip]) return;
    if (!audio) {
      audio = new Audio();
      audio.addEventListener('ended', () => { playing = null; playbackState(); });
      audio.addEventListener('error', () => { playing = null; playbackState(); status('语音暂时无法播放，请稍后重试', true); });
    }
    if (playing === id && !audio.paused) { audio.pause(); playing = null; playbackState(); return; }
    audio.pause(); audio.src = VOICES[clip].url; audio.currentTime = 0; playing = id; playbackState();
    audio.play().catch(() => { playing = null; playbackState(); status('语音暂时无法播放，请点击消息重试', true); });
  }
  function render(forceBottom = false) {
    const list = $('chat-messages'), atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 45;
    const values = [...messages.values()].sort((a, b) => a.sequence - b.sequence).concat(pending);
    list.replaceChildren();
    if (!values.length) {
      const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = '落子之间，也聊两句吧。'; list.append(empty);
    }
    for (const message of values) {
      const mine = message.senderId === senderId, saved = messages.has(message.id);
      const item = document.createElement('article'); item.className = 'chat-message' + (mine ? ' mine' : ''); item.dataset.messageId = message.id;
      const meta = document.createElement('div'); meta.className = 'chat-meta';
      const name = document.createElement('span'); name.textContent = (mine ? '我 · ' : '') + message.nickname;
      const time = document.createElement('time'); time.dateTime = message.createdAt;
      const date = new Date(message.createdAt);
      time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      meta.append(name, time); item.append(meta);
      const bubble = document.createElement(message.kind === 'voice' ? 'button' : 'div'); bubble.className = 'chat-bubble';
      if (message.kind === 'voice') {
        bubble.type = 'button'; bubble.dataset.chatPlay = message.id; bubble.dataset.clip = message.content;
        const icon = document.createElement('span'); icon.className = 'chat-play-icon'; icon.textContent = '▶'; icon.setAttribute('aria-hidden', 'true');
        const info = document.createElement('span'); info.className = 'chat-voice-info';
        const title = document.createElement('span'); title.textContent = VOICES[message.content].label;
        const hint = document.createElement('small'); hint.textContent = VOICES[message.content].seconds + ' 秒 · 点击重播';
        info.append(title, hint); bubble.append(icon, info); bubble.addEventListener('click', () => play(message.content, message.id));
      } else bubble.textContent = message.content;
      item.append(bubble);
      if (mine) {
        const delivery = document.createElement('div'); delivery.className = 'chat-delivery';
        if (!saved && message.failed) {
          const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'chat-retry'; retry.textContent = '未发送 · 点击重试'; retry.onclick = () => { nextRetry = 0; void sendPending(); }; delivery.append(retry);
        } else delivery.textContent = saved ? '已发送' : '发送中…';
        item.append(delivery);
      }
      list.append(item);
    }
    $('chat-more').hidden = !more;
    if (forceBottom || atBottom) list.scrollTop = list.scrollHeight;
    playbackState();
  }
  async function refresh(older = false) {
    selectRoom();
    if (reading?.generation === generation) return;
    const ticket = { generation, room }; reading = ticket;
    // Only fetched pages advance the read cursor. A POST acknowledgement can
    // otherwise jump over other visitors' messages posted since the last poll.
    const query = older ? '?before=' + oldestCursor : loaded ? '?after=' + cursor : '';
    const list = $('chat-messages'), previousHeight = list.scrollHeight, previousTop = list.scrollTop;
    if (older) $('chat-more').disabled = true;
    try {
      const result = await request(ticket.room, 'GET', undefined, query);
      if (ticket.generation !== generation) return;
      if (!Array.isArray(result.messages)) throw new Error('聊天记录暂时无法读取');
      if (!older) for (const message of result.messages) if (Number.isSafeInteger(message.sequence)) cursor = Math.max(cursor, message.sequence);
      const first = !loaded;
      if (older || first) more = Boolean(result.hasMore);
      // Only GET pages determine history boundaries; an acknowledged offline
      // retry may belong far before the currently loaded history window.
      if ((older || first) && result.messages.length) oldestCursor = Math.min(...result.messages.map(message => message.sequence));
      if (first) {
        // Start a contiguous history window at the newest cloud page. An old
        // cache can be separated from it by thousands of unseen messages;
        // retaining that cache would make "before" skip the missing interval.
        // Keep acknowledgements newer than this response's snapshot.
        const newest = Math.max(0, ...result.messages.map(message => message.sequence));
        messages = new Map([...messages].filter(([, message]) => message.sequence > newest));
      }
      loaded = true; merge(result.messages, first);
      $('chat-more').hidden = !more;
      if (older) list.scrollTop = previousTop + (list.scrollHeight - previousHeight);
      if (first) status(pending.length ? '正在发送待发送的消息…' : '聊天记录已同步');
    } catch {
      if (ticket.generation === generation && !loaded) status('聊天暂时未连接，可继续下棋，稍后自动重试', true);
    } finally { if (reading === ticket) reading = null; $('chat-more').disabled = false; }
  }
  async function sendPending() {
    selectRoom();
    mergeOutbox();
    if (sending?.generation === generation || Date.now() < nextRetry || !pending.length) return;
    const ticket = { generation, room }; sending = ticket;
    try {
      while (pending.length && ticket.generation === generation) {
        const message = pending[0]; message.failed = false; render();
        const { id, senderId, nickname, kind, content } = message;
        const result = await request(ticket.room, 'POST', { id, senderId, nickname, kind, content });
        if (ticket.generation !== generation) return;
        if (!valid(result.message) || result.message.id !== id || !Number.isSafeInteger(result.message.sequence)) throw new Error('保存未完成');
        merge([result.message], true); failures = 0; nextRetry = 0; status('消息已发送');
      }
    } catch (error) {
      if (ticket.generation !== generation) return;
      for (const message of pending) message.failed = true;
      nextRetry = Date.now() + Math.min(30000, 2000 * 2 ** Math.min(failures++, 4));
      persist(pending); render(); status(writable ? '未发送的消息已存本机，将自动重试' : '消息未发送，请保留页面并点击重试', true);
    } finally { if (sending === ticket) sending = null; }
  }
  function enqueue(kind, content) {
    selectRoom(); content = content.trim();
    mergeOutbox();
    const nickname = $('chat-name').value.trim();
    if (!nickname) { status('请先填写昵称', true); $('chat-name').focus(); return; }
    if (!content || content.length > 500 || nickname.length > 20) { status('消息不能为空，最多 500 字', true); return; }
    if (pending.length >= 20) { status('待发送消息较多，请联网后再发', true); return; }
    persistIdentity();
    const message = { id: crypto.randomUUID(), senderId, nickname, kind, content, createdAt: new Date().toISOString() };
    pending.push(message); persist([message]); render(true); nextRetry = 0; void sendPending(); return message.id;
  }
  const updateCount = () => { $('chat-count').textContent = $('chat-text').value.length + ' / 500'; };
  $('chat-text').addEventListener('input', updateCount);
  $('chat-text').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
  $('chat-form').addEventListener('submit', event => { event.preventDefault(); if (enqueue('text', $('chat-text').value)) { $('chat-text').value = ''; updateCount(); } });
  for (const button of document.querySelectorAll('[data-chat-text]')) button.onclick = () => enqueue('text', button.dataset.chatText);
  for (const button of document.querySelectorAll('[data-chat-voice]')) button.onclick = () => { const id = enqueue('voice', button.dataset.chatVoice); if (id) play(button.dataset.chatVoice, id); };
  for (const button of document.querySelectorAll('.chat-emojis button')) button.onclick = () => {
    const field = $('chat-text'), emoji = button.textContent;
    if (field.value.length - (field.selectionEnd - field.selectionStart) + emoji.length > 500) return;
    field.setRangeText(emoji, field.selectionStart, field.selectionEnd, 'end'); updateCount(); field.focus();
  };
  $('chat-more').onclick = () => void refresh(true);
  const tick = () => { if (!document.hidden) { void refresh(); void sendPending(); } };
  window.addEventListener('online', () => { nextRetry = 0; tick(); });
  document.addEventListener('visibilitychange', tick);
  selectRoom(); tick(); setInterval(tick, 1500);
}
