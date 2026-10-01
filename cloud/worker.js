import { validateState } from './state.js';
const allowed = new Set(['https://doctorabcdef.github.io', 'http://127.0.0.1:4173', 'http://localhost:4173']);
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const ownOrigin = new URL(request.url).origin;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' };
    if (origin && (allowed.has(origin) || origin === ownOrigin)) headers['Access-Control-Allow-Origin'] = origin;
    const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
    if (origin && !headers['Access-Control-Allow-Origin']) return json({ error: '来源不允许' }, 403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (new URL(request.url).pathname === '/api/health') return json({ ok: true, service: 'yijian-xiangqi-sync' });
    if (new URL(request.url).pathname !== '/api/game') return json({ service: '弈间象棋云同步', website: 'https://doctorabcdef.github.io/xiangqi/' });
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32})$/)?.[1];
    if (!token) return json({ error: '需要有效的同步码' }, 401);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const id = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    try {
      // Request a primary-backed session, avoiding stale conflict/read results.
      const db = env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
      const read = () => db.prepare('SELECT state, revision, updated_at FROM games WHERE id = ?').bind(id).first();
      const output = row => ({ state: JSON.parse(row.state), revision: row.revision, updatedAt: row.updated_at });
      if (request.method === 'GET') { const row = await read(); return row ? json(output(row)) : json({ error: '棋局不存在' }, 404); }
      if (request.method !== 'PUT') return json({ error: '不支持此操作' }, 405);
      if (Number(request.headers.get('Content-Length')) > 65536) return json({ error: '棋局文件过大' }, 413);
      // Bound streamed request bytes as well as Content-Length.
      const reader = request.body?.getReader();
      if (!reader) return json({ error: '缺少棋局' }, 400);
      let text = '', size = 0; const decoder = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 65536) { await reader.cancel(); return json({ error: '棋局文件过大' }, 413); } text += decoder.decode(value, { stream: true }); }
      text += decoder.decode();
      let state, baseRevision;
      try { const body = JSON.parse(text); baseRevision = body.baseRevision; if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error(); state = validateState(body.state); } catch { return json({ error: '棋局数据或走子记录无效' }, 400); }
      const now = new Date().toISOString();
      const result = baseRevision === 0
        ? await db.prepare('INSERT INTO games (id, state, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO NOTHING').bind(id, JSON.stringify(state), now).run()
        : await db.prepare('UPDATE games SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').bind(JSON.stringify(state), now, id, baseRevision).run();
      if (!result.meta.changes) { const row = await read(); return row ? json(output(row), 409) : json({ error: '棋局不存在' }, 404); }
      return json({ revision: baseRevision + 1, updatedAt: now });
    } catch { return json({ error: '云端存储暂时不可用，请稍后重试' }, 503); }
  }
};
