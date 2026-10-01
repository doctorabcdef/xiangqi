import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const games = sqliteTable('games', {
  id: text('id').primaryKey(),
  state: text('state').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
});
