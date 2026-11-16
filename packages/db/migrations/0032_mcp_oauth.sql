-- Compass → Tools: MCP servers that sign in with OAuth instead of an API key.
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "auth_kind" text DEFAULT 'headers' NOT NULL;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "encrypted_oauth" text;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "oauth_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "oauth_by" text;
