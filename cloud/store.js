import { validateState } from './state.js';

export function gameStore(env, id, beforeQuery = () => {}) {
  const database = () => { beforeQuery(); return env.DB.withSession ? env.DB.withSession('first-primary') : env.DB; };
  const output = row => row ? { state: JSON.parse(row.state), revision: row.revision, updatedAt: row.updated_at } : null;
  const read = async (after = -1) => output(await database().prepare('SELECT state, revision, updated_at FROM games WHERE id = ? AND revision > ?').bind(id, after).first());
  async function write(body) {
    let state, baseRevision;
    try {
      baseRevision = body?.baseRevision;
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error();
      state = validateState(body.state);
    } catch { return { status: 400, data: { error: '棋局数据或走子记录无效' } }; }
    const now = new Date().toISOString(), db = database();
    const result = baseRevision === 0
      ? await db.prepare('INSERT INTO games (id, state, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO NOTHING').bind(id, JSON.stringify(state), now).run()
      : await db.prepare('UPDATE games SET state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').bind(JSON.stringify(state), now, id, baseRevision).run();
    if (!result.meta.changes) {
      const row = await read();
      return row ? { status: 409, data: row } : { status: 404, data: { error: '棋局不存在' } };
    }
    return { status: 200, data: { revision: baseRevision + 1, updatedAt: now } };
  }
  return { read, write };
}
