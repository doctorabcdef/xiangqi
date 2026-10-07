CREATE TABLE `chat_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`message_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`nickname` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_room_message` ON `chat_messages` (`room_id`,`message_id`);--> statement-breakpoint
CREATE INDEX `chat_room_sequence` ON `chat_messages` (`room_id`,`seq`);