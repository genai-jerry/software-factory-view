CREATE TABLE "github_app_config" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"app_id" text NOT NULL,
	"slug" text,
	"html_url" text,
	"encrypted_private_key" text NOT NULL,
	"encrypted_webhook_secret" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"configured_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
