ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "system_tests" boolean;
--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN IF NOT EXISTS "test_mode" text;
