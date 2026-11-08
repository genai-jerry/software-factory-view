CREATE TABLE IF NOT EXISTS "telegram_links" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "chat_id" bigint NOT NULL,
  "tg_username" text,
  "paused" boolean DEFAULT false NOT NULL,
  "primed" boolean DEFAULT false NOT NULL,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_links_chat" ON "telegram_links" ("chat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "chat_id" bigint NOT NULL,
  "message_id" bigint NOT NULL,
  "epic_id" text NOT NULL,
  "repo" text NOT NULL,
  "ask" text NOT NULL,
  "item" jsonb NOT NULL,
  "sent_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_notifications_user_open" ON "telegram_notifications" ("user_id", "resolved_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_notifications_chat_msg" ON "telegram_notifications" ("chat_id", "message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "telegram_notifications_open_key" ON "telegram_notifications" ("user_id", "key") WHERE "resolved_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "notification_id" uuid REFERENCES "telegram_notifications"("id") ON DELETE SET NULL,
  "chat_id" bigint NOT NULL,
  "issue_id" text NOT NULL,
  "epic_id" text NOT NULL,
  "session" text,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "draft" text,
  "summary" text,
  "summary_comment_id" bigint,
  "message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_conversations_user" ON "telegram_conversations" ("user_id", "status", "updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_updates" (
  "update_id" bigint PRIMARY KEY NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "telegram_link_nonces" (
  "nonce" text PRIMARY KEY NOT NULL,
  "used_at" timestamp with time zone DEFAULT now() NOT NULL
);
