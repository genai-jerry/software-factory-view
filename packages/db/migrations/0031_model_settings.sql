-- Compass → Models: the models each factory phase runs on, per org and per project.
CREATE TABLE IF NOT EXISTS "model_settings" (
	"org_id" uuid NOT NULL REFERENCES "orgs"("id") ON DELETE cascade,
	"scope" text NOT NULL,
	"chains" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_settings_org_scope" ON "model_settings" USING btree ("org_id","scope");
