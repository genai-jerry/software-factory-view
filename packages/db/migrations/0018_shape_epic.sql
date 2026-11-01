ALTER TABLE "shape_conversations" ADD COLUMN IF NOT EXISTS "epic_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "shape_conversations_epic" ON "shape_conversations" ("epic_issue_id");
