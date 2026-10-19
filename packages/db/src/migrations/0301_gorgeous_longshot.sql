ALTER TABLE "companies" ADD COLUMN "mission" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "organization_policy" jsonb DEFAULT '{"defaultMode":"allowed","permissions":{}}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "context_events" ADD COLUMN "sequence" bigserial NOT NULL;--> statement-breakpoint
ALTER TABLE "context_events" ADD COLUMN "origin" text DEFAULT 'employee' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_events" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "organization_context_cursors" ADD COLUMN "last_sequence" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "context_events_source_uq" ON "context_events" USING btree ("company_id","source_id");--> statement-breakpoint
CREATE INDEX "context_events_stream_idx" ON "context_events" USING btree ("company_id","mission_id","sequence");