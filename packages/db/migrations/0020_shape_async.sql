ALTER TABLE "shape_messages" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'done';
ALTER TABLE "shape_messages" ADD COLUMN IF NOT EXISTS "error" text;
ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "spec_status" text NOT NULL DEFAULT 'idle';
ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "spec_error" text;
