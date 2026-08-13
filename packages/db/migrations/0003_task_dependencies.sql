CREATE TABLE "task_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"blocked_issue_id" uuid NOT NULL,
	"blocker_issue_id" uuid NOT NULL,
	"source" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocked_issue_id_issues_id_fk" FOREIGN KEY ("blocked_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocker_issue_id_issues_id_fk" FOREIGN KEY ("blocker_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "task_deps_pair" ON "task_dependencies" ("blocked_issue_id", "blocker_issue_id");
--> statement-breakpoint
CREATE INDEX "task_deps_blocker" ON "task_dependencies" ("blocker_issue_id");
--> statement-breakpoint
CREATE INDEX "task_deps_org" ON "task_dependencies" ("org_id");
