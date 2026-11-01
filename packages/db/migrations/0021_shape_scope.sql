ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'repo';
