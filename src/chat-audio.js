// One unlocked AudioContext per page lets later network messages play sound.
// The queue belongs to this page, not to a nickname or shared localStorage ID.
export class ChatAudio {
  constructor({ clips, enabled = true, onChange = () => {}, onError = () => {},
    createContext = () => new (window.AudioContext || window.webkitAudioContext)(),
    fetchClip = url => fetch(url, { signal: AbortSignal.timeout(10000) }), now = () => Date.now() }) {
    Object.assign(this, { clips, enabled, onChange, onError, createContext, fetchClip, now });
    this.context = null; this.buffers = new Map(); this.seen = new Set(); this.queue = []; this.active = null;
  }
  get state() {
    return { enabled: this.enabled, ready: this.context?.state === 'running', playing: this.active?.id ?? null, waiting: this.queue.length > 0 };
  }
  changed() { this.onChange(this.state); }
  unlock() {
    // Call resume synchronously inside the real user gesture, before any fetch.
    this.enabled = true;
    try {
      if (!this.context) {
        this.context = this.createContext();
        this.context.onstatechange = () => { this.changed(); void this.pump(); };
      }
      const resumed = this.context.resume();
      this.changed();
      void Promise.resolve(resumed).then(() => { this.changed(); void this.pump(); }).catch(() => this.changed());
    } catch { this.onError('此浏览器暂时无法开启声音'); this.changed(); }
  }
  mute() {
    this.enabled = false; this.queue = []; this.stop(); this.changed();
  }
  receive(clip, id) {
    if (!this.clips[clip] || this.seen.has(id)) return;
    this.seen.add(id);
    if (!this.enabled) return;
    this.queue.push({ clip, id, queuedAt: this.now() });
    // Do not build an unbounded backlog while a page is suspended or locked.
    this.queue = this.queue.slice(-20);
    this.changed(); void this.pump();
  }
  replay(clip, id) {
    if (!this.clips[clip]) return;
    this.seen.add(id);
    if (this.active?.id === id) { this.stop(); this.changed(); void this.pump(); return; }
    this.stop();
    this.queue = this.queue.filter(item => item.id !== id);
    this.queue.unshift({ clip, id, queuedAt: this.now() });
    this.unlock();
  }
  reset() {
    this.queue = []; this.seen.clear(); this.stop(); this.changed();
  }
  stop() {
    const previous = this.active; this.active = null;
    if (previous?.source) {
      previous.source.onended = null;
      try { previous.source.stop(); } catch {}
      previous.source.disconnect();
    }
  }
  async buffer(clip) {
    if (!this.buffers.has(clip)) {
      const promise = this.fetchClip(this.clips[clip].url).then(async response => {
        if (!response.ok) throw new Error('Audio unavailable');
        return this.context.decodeAudioData(await response.arrayBuffer());
      }).catch(error => { this.buffers.delete(clip); throw error; });
      this.buffers.set(clip, promise);
    }
    return this.buffers.get(clip);
  }
  async pump() {
    if (this.active || !this.enabled || !this.state.ready) return;
    // After a long interruption, leave old clips available for manual replay.
    this.queue = this.queue.filter(item => this.now() - item.queuedAt < 30000);
    const item = this.queue.shift();
    if (!item) { this.changed(); return; }
    const ticket = { ...item, source: null }; this.active = ticket; this.changed();
    try {
      const buffer = await this.buffer(item.clip);
      if (this.active !== ticket) return;
      if (this.now() - item.queuedAt >= 30000) {
        this.active = null; this.changed(); void this.pump(); return;
      }
      if (!this.state.ready) {
        this.active = null; this.queue.unshift(item); this.changed(); return;
      }
      const source = this.context.createBufferSource(); ticket.source = source;
      source.buffer = buffer; source.connect(this.context.destination);
      source.onended = () => {
        source.disconnect();
        if (this.active !== ticket) return;
        this.active = null; this.changed(); void this.pump();
      };
      source.start();
    } catch {
      if (this.active !== ticket) return;
      this.stop(); this.changed(); this.onError('语音暂时无法播放，可点击消息重试'); void this.pump();
    }
  }
}
