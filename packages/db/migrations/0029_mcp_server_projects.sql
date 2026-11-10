ALTER TABLE "mcp_servers" ADD COLUMN IF NOT EXISTS "project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
