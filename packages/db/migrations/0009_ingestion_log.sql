ALTER TABLE "webhook_deliveries" ADD COLUMN "error" text;
--> statement-breakpoint
CREATE TABLE "reconcile_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"estate_id" uuid,
	"trigger" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"repos_walked" integer DEFAULT 0 NOT NULL,
	"issues_seen" integer DEFAULT 0 NOT NULL,
	"pulls_seen" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reconcile_runs_started" ON "reconcile_runs" ("started_at");
