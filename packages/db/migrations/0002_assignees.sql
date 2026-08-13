ALTER TABLE "issues" ADD COLUMN "assignees" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX "issues_assignees_gin" ON "issues" USING gin ("assignees" jsonb_path_ops);
