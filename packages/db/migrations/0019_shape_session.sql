ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "ask_session" text;
ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "ask_session_at" timestamptz;
