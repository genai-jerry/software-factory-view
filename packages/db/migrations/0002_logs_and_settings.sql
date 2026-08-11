CREATE TABLE "runtime_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "log_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"service" text NOT NULL,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb
);
--> statement-breakpoint
CREATE INDEX "log_events_ts_idx" ON "log_events" ("ts");
--> statement-breakpoint
CREATE INDEX "log_events_level_idx" ON "log_events" ("level");
