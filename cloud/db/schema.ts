import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  state: text('state').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});
export const chatMessages = sqliteTable('chat_messages', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  roomId: text('room_id').notNull(),
  messageId: text('message_id').notNull(),
  senderId: text('sender_id').notNull(),
  nickname: text('nickname').notNull(),
  kind: text('kind').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
}, table => [
  uniqueIndex('chat_room_message').on(table.roomId, table.messageId),
  index('chat_room_sequence').on(table.roomId, table.seq),
]);
