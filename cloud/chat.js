const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const output = row => ({ id: row.message_id, sequence: row.seq, senderId: row.sender_id, nickname: row.nickname, kind: row.kind, content: row.content, createdAt: row.created_at });
export async function chatRequest(request, env, room, json) {
  const database = () => env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
  if (request.method === 'GET') {
    const search = new URL(request.url).searchParams;
    const after = search.get('after'), before = search.get('before');
    if ((after !== null && before !== null) || [after, before].some(value => value !== null && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))) return json({ error: '聊天游标无效' }, 400);
    const statement = after !== null
      ? database().prepare('SELECT * FROM chat_messages WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT 51').bind(room, Number(after))
      : before !== null
        ? database().prepare('SELECT * FROM chat_messages WHERE room_id = ? AND seq < ? ORDER BY seq DESC LIMIT 51').bind(room, Number(before))
        : database().prepare('SELECT * FROM chat_messages WHERE room_id = ? ORDER BY seq DESC LIMIT 51').bind(room);
    const rows = (await statement.all()).results, hasMore = rows.length > 50;
    const messages = rows.slice(0, 50).map(output);
    if (after === null) messages.reverse();
    return json({ messages, hasMore });
  }
  if (request.method !== 'POST') return json({ error: '不支持此操作' }, 405);
  if (Number(request.headers.get('Content-Length')) > 4096) return json({ error: '消息过长' }, 413);
  const reader = request.body?.getReader();
  if (!reader) return json({ error: '缺少消息' }, 400);
  let text = '', size = 0; const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); return json({ error: '消息过长' }, 413); }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  let message;
  try {
    const value = JSON.parse(text);
    if (!uuid.test(value?.id) || !uuid.test(value?.senderId) || typeof value.nickname !== 'string' || typeof value.content !== 'string') throw new Error();
    const nickname = value.nickname.trim(), content = value.content.trim();
    if (!nickname || nickname.length > 20 || !content || content.length > 500 || !['text', 'voice'].includes(value.kind)) throw new Error();
    if (value.kind === 'voice' && !['too-slow', 'hurry-up'].includes(content)) throw new Error();
    message = { id: value.id, senderId: value.senderId, nickname, kind: value.kind, content };
  } catch { return json({ error: '昵称限 20 字，消息限 500 字，语音须为预设语音' }, 400); }
  const result = await database().prepare('INSERT INTO chat_messages (room_id, message_id, sender_id, nickname, kind, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(room_id, message_id) DO NOTHING')
    .bind(room, message.id, message.senderId, message.nickname, message.kind, message.content, new Date().toISOString()).run();
  const saved = output(await database().prepare('SELECT * FROM chat_messages WHERE room_id = ? AND message_id = ?').bind(room, message.id).first());
  if (['senderId', 'nickname', 'kind', 'content'].some(key => saved[key] !== message[key])) return json({ error: '消息标识已被使用' }, 409);
  return json({ message: saved }, result.meta.changes ? 201 : 200);
}
