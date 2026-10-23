CREATE TABLE "employee_organization_settings" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- On a populated installation,
-- require moving live role prose to AGENTS.md through the existing instruction
-- editor first, then saving an empty prose Contract with identical machine
-- settings on the old build. Fail closed rather than lose or overwrite roles.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT DISTINCT ON (company_id, agent_id) contract
      FROM employee_contracts ORDER BY company_id, agent_id, version DESC
    ) latest,
    LATERAL jsonb_each(latest.contract - ARRAY['policy', 'serviceExposures',
      'capabilities', 'servicesProvided', 'servicesConsumed', 'eventSubscriptions',
      'scheduledReviewMinutes']) prose
    WHERE prose.value NOT IN ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb)
  ) THEN
    RAISE EXCEPTION 'Move employee Contract prose to AGENTS.md and clear the old prose fields before applying 0302. Machine settings must remain unchanged.';
  END IF;
END $$;
--> statement-breakpoint
-- Latest version only; the former immutable Context Packs already retain the
-- complete governing legacy Contract, including its version and text.
INSERT INTO employee_organization_settings (company_id, agent_id, version, config, created_at, updated_at)
SELECT DISTINCT ON (company_id, agent_id) company_id, agent_id, version,
  jsonb_build_object(
    'policy', coalesce(contract->'policy', '{"defaultMode":"allowed","permissions":{}}'::jsonb),
    'serviceExposures', coalesce(contract->'serviceExposures', '[]'::jsonb),
    'capabilities', coalesce(contract->'capabilities', '[]'::jsonb),
    'servicesProvided', coalesce(contract->'servicesProvided', '[]'::jsonb),
    'servicesConsumed', coalesce(contract->'servicesConsumed', '[]'::jsonb),
    'eventSubscriptions', coalesce(contract->'eventSubscriptions', '[]'::jsonb),
    'scheduledReviewMinutes', coalesce(contract->'scheduledReviewMinutes', 'null'::jsonb)
  ), created_at, created_at
FROM employee_contracts ORDER BY company_id, agent_id, version DESC;
--> statement-breakpoint
DROP TABLE "employee_contracts";--> statement-breakpoint
ALTER TABLE "employee_organization_settings" ADD CONSTRAINT "employee_organization_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_organization_settings" ADD CONSTRAINT "employee_organization_settings_company_id_agent_id_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_organization_settings_owner_uq" ON "employee_organization_settings" USING btree ("company_id","agent_id");--> statement-breakpoint
ALTER TABLE "organization_context_packs" DROP COLUMN "contract_version";