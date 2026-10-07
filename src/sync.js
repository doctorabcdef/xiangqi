import { freshState, validateState } from './state.js';
import { CLOUD_URL, DEFAULT_ROOM_CODE } from './config.js';
export const STORAGE_KEY = 'yijian.xiangqi.v1';
export const POLL_INTERVAL_MS = 250;
const codePattern = /^[A-Za-z0-9_-]{32}$/;
export const validCode = value => codePattern.test(value);
const same = (a, b) => a.mode === b.mode && a.difficulty === b.difficulty && (a.humanSide ?? 'red') === (b.humanSide ?? 'red') && JSON.stringify(a.moves) === JSON.stringify(b.moves);
export class GameSync {
  constructor({ onRemote, onStatus, onConflict }) {
    this.onRemote = onRemote; this.onStatus = onStatus; this.onConflict = onConflict;
    this.busy = false; this.conflict = null; this.generation = 0; this.localWritable = true;
    this.readController = null; this.failures = 0; this.nextPollAt = 0;
    this.data = { code: DEFAULT_ROOM_CODE, revision: 0, pending: false, state: freshState() };
    this.recovered = false; this.storageError = false;
    try {
      let loaded = false;
      for (const key of [STORAGE_KEY, STORAGE_KEY + '.backup']) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        try {
          const value = JSON.parse(raw);
          if (!validCode(value.code) || !Number.isInteger(value.revision) || value.revision < 0) throw new Error();
          this.data = { code: value.code, revision: value.revision, pending: Boolean(value.pending), state: validateState(value.state) };
          if (value.attempt && Number.isInteger(value.attempt.baseRevision) && value.attempt.baseRevision >= 0) this.data.attempt = { baseRevision: value.attempt.baseRevision, state: validateState(value.attempt.state) };
          this.recovered = loaded = true; break;
        } catch { this.storageError = true; }
      }
      if (!loaded && this.storageError) this.onStatus('error', '本机存档损坏，可用同步码恢复');
    } catch { this.localWritable = false; }
  }
  status(kind, message) { this.onStatus(kind, message + (!this.localWritable ? ' · 本机无法保存，请保管同步码' : '')); }
  persist() {
    try {
      const old = localStorage.getItem(STORAGE_KEY);
      if (old) localStorage.setItem(STORAGE_KEY + '.backup', old);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
      this.localWritable = true;
    } catch { this.localWritable = false; }
  }
  async request(code, method = 'GET', body, signal) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('当前处于离线状态');
    const timeout = AbortSignal.timeout(20000);
    const response = await fetch(CLOUD_URL + '/api/game', { method, headers: { Authorization: `Bearer ${code}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, cache: 'no-store', credentials: 'omit' });
    if (response.status === 404) return null;
    let data;
    try { data = await response.json(); } catch { throw new Error('云端暂时不可用'); }
    if (response.status === 409) return { conflict: true, ...data };
    if (!response.ok) throw new Error(data.error ?? '同步失败');
    return data;
  }
  async start() {
    this.persist();
    await this.flush();
    this.timer = setInterval(() => { if (!document.hidden && Date.now() >= this.nextPollAt) this.flush({ quiet: true }); }, POLL_INTERVAL_MS);
    window.addEventListener('online', () => this.flush());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.flush(); });
  }
  save(state) {
    this.data.state = state; this.data.pending = true; this.persist();
    this.status('pending', '已存本机，正在同步');
    // A read is safe to cancel: prioritize the player's new move over polling.
    if (this.readController) this.readController.abort();
    else this.flush({ writeFirst: true });
  }
  async flush({ writeFirst = false, quiet = false } = {}) {
    if (this.busy || this.conflict) return;
    this.busy = true;
    const generation = this.generation, code = this.data.code;
    let readController, retryWrite = false;
    try {
      if (!quiet || this.data.pending) this.status('pending', this.data.pending ? '正在保存到云端' : '正在检查云端进度');
      // CAS on the server protects direct writes. Read first after a lost PUT
      // acknowledgement, so an already committed move is not submitted twice.
      if (!(writeFirst && this.data.pending && this.data.revision > 0 && !this.data.attempt)) {
        readController = new AbortController(); this.readController = readController;
        const remote = await this.request(code, 'GET', undefined, readController.signal);
        if (this.readController === readController) this.readController = null;
        if (generation !== this.generation) return;
        if (remote) {
          if (remote.revision !== this.data.revision) {
            remote.state = validateState(remote.state);
            if (!this.acknowledgeAttempt(remote)) {
              if (this.data.pending && !same(remote.state, this.data.state)) { this.setConflict(remote); return; }
              this.acceptRemote(remote);
            }
          }
        } else if (this.data.revision > 0) { throw new Error('云端棋局暂未找到，本机进度仍保留'); }
        else { this.data.pending = true; this.persist(); }
      }
      while (this.data.pending && generation === this.generation && !this.conflict) {
        const state = this.data.state;
        this.data.attempt = { state, baseRevision: this.data.revision }; this.persist();
        const result = await this.request(code, 'PUT', { state, baseRevision: this.data.revision });
        if (generation !== this.generation) return;
        if (result?.conflict) {
          result.state = validateState(result.state);
          if (this.acknowledgeAttempt(result)) continue;
          if (same(result.state, this.data.state)) { this.acceptRemote(result); break; }
          this.setConflict(result); return;
        }
        if (!result || !Number.isInteger(result.revision)) throw new Error('保存未完成');
        this.data.revision = result.revision;
        delete this.data.attempt;
        this.data.pending = !same(state, this.data.state);
        this.persist();
      }
      this.failures = 0; this.nextPollAt = 0;
      this.status('saved', '已同步到云端');
    } catch (error) {
      retryWrite = Boolean(readController?.signal.aborted && this.data.pending && generation === this.generation);
      if (!retryWrite && generation === this.generation) {
        this.nextPollAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(++this.failures, 5));
        this.status('error', this.data.pending ? '已存本机，等待联网同步' : '云端暂未连接，本机棋局已保留');
      }
    } finally {
      if (this.readController === readController) this.readController = null;
      this.busy = false;
      if (generation !== this.generation || retryWrite) this.flush({ writeFirst: retryWrite });
    }
  }
  acceptRemote(remote) {
    const changed = !same(this.data.state, remote.state);
    this.data.state = remote.state; this.data.revision = remote.revision; this.data.pending = false;
    delete this.data.attempt;
    this.persist(); if (changed) this.onRemote(remote.state);
  }
  acknowledgeAttempt(remote) {
    const attempt = this.data.attempt;
    if (!attempt || remote.revision !== attempt.baseRevision + 1 || !same(remote.state, attempt.state)) return false;
    this.data.revision = remote.revision; this.data.pending = !same(this.data.state, remote.state);
    delete this.data.attempt; this.persist(); return true;
  }
  setConflict(remote) { this.conflict = remote; this.status('error', '两台设备的进度冲突'); this.onConflict(); }
  resolve(useLocal) {
    if (!this.conflict) return;
    if (useLocal) { this.data.revision = this.conflict.revision; this.data.pending = true; delete this.data.attempt; this.persist(); }
    else this.acceptRemote(this.conflict);
    this.conflict = null;
    this.flush();
  }
  async join(code) {
    code = code.trim();
    if (!validCode(code)) throw new Error('同步码应为 32 位字母、数字、下划线或短横线');
    const remote = await this.request(code);
    if (!remote) throw new Error('找不到这个棋局，请检查同步码并确认原设备已完成云端保存');
    remote.state = validateState(remote.state);
    this.generation++; this.conflict = null;
    this.data = { code, revision: remote.revision, pending: false, state: remote.state };
    this.persist(); this.onRemote(remote.state); this.status('saved', '已同步到云端');
  }
}
