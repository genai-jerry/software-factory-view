ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "encrypted_oauth_refresh_token" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "oauth_token_expires_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "oauth_refresh_token_expires_at" timestamptz;
