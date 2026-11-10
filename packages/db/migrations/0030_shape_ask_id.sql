-- The orchestrator's background ask (POST /asks) answering a pending assistant message.
ALTER TABLE "shape_messages" ADD COLUMN IF NOT EXISTS "ask_id" text;
