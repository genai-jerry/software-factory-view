CREATE TABLE "artifact_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"path" text NOT NULL,
	"commit_sha" text NOT NULL,
	"encrypted_content" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"change_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"path" text NOT NULL,
	"latest_sha" text,
	"merged_sha" text
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"estate_id" uuid NOT NULL,
	"epic_issue_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"gh_node_id" text NOT NULL,
	"gh_id" bigint NOT NULL,
	"author" text,
	"body" text NOT NULL,
	"is_agent" boolean DEFAULT false NOT NULL,
	"is_approval" boolean DEFAULT false NOT NULL,
	"console_markers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"html_url" text DEFAULT '' NOT NULL,
	"gh_created_at" timestamp with time zone NOT NULL,
	"gh_updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"epic_issue_id" uuid NOT NULL,
	"thread_id" uuid,
	"title" text NOT NULL,
	"context" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen" text,
	"consequences" text,
	"decided_by" text,
	"gh_comment_node_id" text,
	"supersedes_id" uuid,
	"status" text DEFAULT 'decided' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"coordination_repo_id" uuid,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estate_id" uuid NOT NULL,
	"repo_id" uuid,
	"gate" text NOT NULL,
	"login" text NOT NULL,
	"synced_from_sha" text
);
--> statement-breakpoint
CREATE TABLE "gate_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"epic_issue_id" uuid NOT NULL,
	"gate" text NOT NULL,
	"last_viewed_sha" text,
	"last_viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_state_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"from_state" text,
	"to_state" text,
	"actor" text,
	"source_event_id" text,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"gh_node_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"state" text NOT NULL,
	"author" text,
	"kind" text DEFAULT 'plain' NOT NULL,
	"parent_issue_id" uuid,
	"factory_state" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"html_url" text DEFAULT '' NOT NULL,
	"gh_created_at" timestamp with time zone,
	"gh_updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"link" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"estate_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"step" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"plan" text DEFAULT 'solo' NOT NULL,
	"insight_budget_tokens" bigint DEFAULT 5000000 NOT NULL,
	"insight_used_tokens" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"gh_node_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"issue_number" integer,
	"head_ref" text NOT NULL,
	"head_sha" text,
	"base_ref" text NOT NULL,
	"state" text NOT NULL,
	"draft" boolean DEFAULT false NOT NULL,
	"merged_at" timestamp with time zone,
	"merge_commit_sha" text,
	"ci_status" text,
	"author" text,
	"html_url" text DEFAULT '' NOT NULL,
	"gh_updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"epic_issue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "qa_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"estate_id" uuid NOT NULL,
	"gh_node_id" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"staging_branch" text,
	"factory_enabled" boolean DEFAULT false NOT NULL,
	"profile_sha" text,
	"last_synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"gh_node_id" text NOT NULL,
	"gh_run_id" bigint NOT NULL,
	"workflow_name" text,
	"role" text,
	"trigger_event" text,
	"status" text,
	"conclusion" text,
	"head_branch" text,
	"html_url" text DEFAULT '' NOT NULL,
	"started_at" timestamp with time zone,
	"gh_updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"source" text NOT NULL,
	"comment_id" uuid,
	"body" text,
	"author" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"epic_issue_id" uuid NOT NULL,
	"topic_kind" text NOT NULL,
	"topic_ref" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gh_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"encrypted_oauth_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_guid" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"payload" jsonb
);
--> statement-breakpoint
ALTER TABLE "artifact_cache" ADD CONSTRAINT "artifact_cache_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_artifacts" ADD CONSTRAINT "change_artifacts_change_id_changes_id_fk" FOREIGN KEY ("change_id") REFERENCES "public"."changes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_epic_issue_id_issues_id_fk" FOREIGN KEY ("epic_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_epic_issue_id_issues_id_fk" FOREIGN KEY ("epic_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estates" ADD CONSTRAINT "estates_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_state_history" ADD CONSTRAINT "issue_state_history_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_conversations" ADD CONSTRAINT "qa_conversations_epic_issue_id_issues_id_fk" FOREIGN KEY ("epic_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_messages" ADD CONSTRAINT "qa_messages_conversation_id_qa_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."qa_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_estate_id_estates_id_fk" FOREIGN KEY ("estate_id") REFERENCES "public"."estates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_entries" ADD CONSTRAINT "thread_entries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_epic_issue_id_issues_id_fk" FOREIGN KEY ("epic_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_cache_key" ON "artifact_cache" USING btree ("repo_id","path","commit_sha");--> statement-breakpoint
CREATE INDEX "audit_org_at" ON "audit_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "change_artifacts_key" ON "change_artifacts" USING btree ("change_id","repo_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "changes_epic" ON "changes" USING btree ("epic_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_node_id" ON "comments" USING btree ("gh_node_id");--> statement-breakpoint
CREATE INDEX "comments_issue" ON "comments" USING btree ("issue_id","gh_created_at");--> statement-breakpoint
CREATE INDEX "decisions_epic" ON "decisions" USING btree ("epic_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_assignments_unique" ON "gate_assignments" USING btree ("estate_id","repo_id","gate","login");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_views_key" ON "gate_views" USING btree ("user_id","epic_issue_id","gate");--> statement-breakpoint
CREATE INDEX "ish_issue" ON "issue_state_history" USING btree ("issue_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ish_dedupe" ON "issue_state_history" USING btree ("issue_id","source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issues_node_id" ON "issues" USING btree ("gh_node_id");--> statement-breakpoint
CREATE INDEX "issues_repo_number" ON "issues" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "issues_org_state" ON "issues" USING btree ("org_id","factory_state");--> statement-breakpoint
CREATE INDEX "issues_parent" ON "issues" USING btree ("parent_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "notifications_user" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_step" ON "onboarding_runs" USING btree ("repo_id","step");--> statement-breakpoint
CREATE UNIQUE INDEX "prs_node_id" ON "pull_requests" USING btree ("gh_node_id");--> statement-breakpoint
CREATE INDEX "prs_repo_number" ON "pull_requests" USING btree ("repo_id","number");--> statement-breakpoint
CREATE INDEX "prs_issue" ON "pull_requests" USING btree ("org_id","issue_number");--> statement-breakpoint
CREATE INDEX "qa_conversations_epic" ON "qa_conversations" USING btree ("epic_issue_id");--> statement-breakpoint
CREATE INDEX "qa_messages_conv" ON "qa_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_node_id" ON "repos" USING btree ("gh_node_id");--> statement-breakpoint
CREATE INDEX "repos_estate" ON "repos" USING btree ("estate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_node_id" ON "runs" USING btree ("gh_node_id");--> statement-breakpoint
CREATE INDEX "runs_repo" ON "runs" USING btree ("repo_id","started_at");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "thread_entries_thread" ON "thread_entries" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_entries_comment" ON "thread_entries" USING btree ("comment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "threads_topic" ON "threads" USING btree ("epic_issue_id","topic_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "users_gh_user_id" ON "users" USING btree ("gh_user_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received" ON "webhook_deliveries" USING btree ("received_at");