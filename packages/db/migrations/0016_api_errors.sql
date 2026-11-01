CREATE TABLE IF NOT EXISTS "api_errors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "at" timestamptz NOT NULL DEFAULT now(),
  "method" text NOT NULL,
  "path" text NOT NULL,
  "status" integer NOT NULL,
  "name" text,
  "message" text NOT NULL,
  "stack" text,
  "actor" text
);
CREATE INDEX IF NOT EXISTS "api_errors_at" ON "api_errors" ("at");
