ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "avatar_asset_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agents_avatar_asset_id_assets_id_fk' AND conrelid = 'public.agents'::regclass) THEN
    ALTER TABLE "agents" ADD CONSTRAINT "agents_avatar_asset_id_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
