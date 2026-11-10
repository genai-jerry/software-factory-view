ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'shape' NOT NULL;
