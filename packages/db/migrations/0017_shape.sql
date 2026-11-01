CREATE TABLE IF NOT EXISTS "shape_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "spec" text,
  "spec_updated_at" timestamptz,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "issue_url" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "shape_conversations_user" ON "shape_conversations" ("user_id", "updated_at");
CREATE TABLE IF NOT EXISTS "shape_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "shape_conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "body" text NOT NULL,
  "attachments" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "model" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "shape_messages_conv" ON "shape_messages" ("conversation_id", "created_at");
CREATE TABLE IF NOT EXISTS "shape_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "shape_conversations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "bytes_b64" text NOT NULL,
  "size" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
