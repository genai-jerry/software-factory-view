ALTER TABLE "qa_conversations" ADD COLUMN "scope_issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "qa_conversations" ADD CONSTRAINT "qa_conversations_scope_issue_id_issues_id_fk" FOREIGN KEY ("scope_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "qa_conversations_scope" ON "qa_conversations" ("scope_issue_id");
