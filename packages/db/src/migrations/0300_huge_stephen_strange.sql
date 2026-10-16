CREATE TABLE "context_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"summary" text NOT NULL,
	"mission_id" uuid,
	"project_id" uuid,
	"entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"causation_id" uuid,
	"correlation_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "context_events_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "employee_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"contract" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_entities_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provenance" text NOT NULL,
	"confidence" jsonb,
	"supersedes_id" uuid,
	"metadata" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "knowledge_relationships_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "mission_workstreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "organization_context_cursors" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"seen_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_context_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"mission_id" uuid,
	"contract_version" integer,
	"pack" jsonb NOT NULL,
	"event_ids" jsonb NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"receipt_id" uuid,
	"mission_id" uuid,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"mission_id" uuid NOT NULL,
	"project_id" uuid,
	"sender_agent_id" uuid NOT NULL,
	"recipient_agent_id" uuid NOT NULL,
	"capability" text,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb NOT NULL,
	"priority" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"parent_receipt_id" uuid,
	"status" text DEFAULT 'sent' NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "context_events" ADD CONSTRAINT "context_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_events" ADD CONSTRAINT "context_event_cause_company_fk" FOREIGN KEY ("company_id","causation_id") REFERENCES "public"."context_events"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_contracts" ADD CONSTRAINT "employee_contracts_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entities" ADD CONSTRAINT "knowledge_entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relationships" ADD CONSTRAINT "knowledge_relationships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relationships" ADD CONSTRAINT "knowledge_relationship_supersedes_fk" FOREIGN KEY ("company_id","supersedes_id") REFERENCES "public"."knowledge_relationships"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relationships" ADD CONSTRAINT "knowledge_relationship_source_fk" FOREIGN KEY ("company_id","source_id") REFERENCES "public"."knowledge_entities"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_relationships" ADD CONSTRAINT "knowledge_relationship_target_fk" FOREIGN KEY ("company_id","target_id") REFERENCES "public"."knowledge_entities"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_workstreams" ADD CONSTRAINT "mission_workstreams_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_workstreams" ADD CONSTRAINT "mission_workstreams_company_id_mission_id_missions_company_id_id_fk" FOREIGN KEY ("company_id","mission_id") REFERENCES "public"."missions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_context_cursors" ADD CONSTRAINT "organization_context_cursors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_context_cursors" ADD CONSTRAINT "organization_context_cursors_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_context_cursors" ADD CONSTRAINT "organization_context_cursors_company_id_mission_id_missions_company_id_id_fk" FOREIGN KEY ("company_id","mission_id") REFERENCES "public"."missions"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_context_packs" ADD CONSTRAINT "organization_context_packs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_context_packs" ADD CONSTRAINT "organization_pack_employee_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_deliveries" ADD CONSTRAINT "organization_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_deliveries" ADD CONSTRAINT "organization_delivery_receipt_fk" FOREIGN KEY ("company_id","receipt_id") REFERENCES "public"."organization_receipts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_deliveries" ADD CONSTRAINT "organization_deliveries_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_deliveries" ADD CONSTRAINT "organization_deliveries_company_id_event_id_context_events_company_id_id_fk" FOREIGN KEY ("company_id","event_id") REFERENCES "public"."context_events"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "organization_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "receipt_parent_company_fk" FOREIGN KEY ("company_id","parent_receipt_id") REFERENCES "public"."organization_receipts"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "organization_receipts_company_id_mission_id_missions_company_id_id_fk" FOREIGN KEY ("company_id","mission_id") REFERENCES "public"."missions"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "organization_receipts_company_id_sender_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","sender_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_receipts" ADD CONSTRAINT "organization_receipts_company_id_recipient_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","recipient_agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "context_events_scope_idx" ON "context_events" USING btree ("company_id","mission_id","created_at");--> statement-breakpoint
CREATE INDEX "context_events_cause_idx" ON "context_events" USING btree ("company_id","causation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_contract_version_uq" ON "employee_contracts" USING btree ("company_id","agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entity_key_uq" ON "knowledge_entities" USING btree ("company_id",("data"->>'kind'),("data"->>'key'));--> statement-breakpoint
CREATE INDEX "knowledge_relationships_source_idx" ON "knowledge_relationships" USING btree ("company_id","source_id");--> statement-breakpoint
CREATE INDEX "knowledge_relationships_target_idx" ON "knowledge_relationships" USING btree ("company_id","target_id");--> statement-breakpoint
CREATE INDEX "workstreams_mission_idx" ON "mission_workstreams" USING btree ("company_id","mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_cursor_uq" ON "organization_context_cursors" USING btree ("company_id","agent_id","mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_pack_run_uq" ON "organization_context_packs" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "organization_pack_settlement_idx" ON "organization_context_packs" USING btree ("settled_at");--> statement-breakpoint
CREATE INDEX "organization_pack_agent_mission_idx" ON "organization_context_packs" USING btree ("company_id","agent_id","mission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_delivery_event_agent_uq" ON "organization_deliveries" USING btree ("company_id","event_id","agent_id");--> statement-breakpoint
CREATE INDEX "organization_delivery_pending_idx" ON "organization_deliveries" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_sender_key_uq" ON "organization_receipts" USING btree ("company_id","sender_agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "receipts_inbox_idx" ON "organization_receipts" USING btree ("company_id","recipient_agent_id","created_at");