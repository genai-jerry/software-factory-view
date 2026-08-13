ALTER TABLE "issues" ADD COLUMN "milestone_title" text;
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "milestone_number" integer;
--> statement-breakpoint
CREATE INDEX "issues_org_milestone" ON "issues" ("org_id", "milestone_title");
