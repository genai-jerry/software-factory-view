CREATE TABLE IF NOT EXISTS "work_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "repo_id" uuid NOT NULL REFERENCES "repos"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "bytes_b64" text NOT NULL,
  "size" integer NOT NULL,
  "issue_url" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_attachments_user_created" ON "work_attachments" ("user_id", "created_at");
